"""Implied-volatility surface (raw SVI per expiry) and Dupire local volatility.

Notation (Gatheral): k = ln(K / F_T) log-moneyness against the forward,
w(k, T) = sigma_imp(k, T)^2 * T total implied variance.

Raw SVI slice:   w(k) = a + b ( rho (k - m) + sqrt((k - m)^2 + s^2) )

Dupire in total variance (Gatheral, *The Volatility Surface*, eq. 1.10):

    sigma_loc^2(k, T) = (dw/dT) / g(k, T),
    g = (1 - k w' / (2w))^2 - (w'^2 / 4) (1/w + 1/4) + w'' / 2,

where ' denotes d/dk. g >= 0 is also the butterfly no-arbitrage condition and
dw/dT >= 0 the calendar one.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.interpolate import RegularGridInterpolator
from scipy.optimize import least_squares

from qplat.curves.rate_curve import RateCurve


@dataclass(frozen=True)
class SviSlice:
    T: float
    a: float
    b: float
    rho: float
    m: float
    s: float
    rmse_vol: float = float("nan")   # fit quality in implied vol

    def w(self, k):
        k = np.asarray(k, float)
        x = k - self.m
        return self.a + self.b * (self.rho * x + np.sqrt(x * x + self.s * self.s))

    def dw(self, k):
        x = np.asarray(k, float) - self.m
        return self.b * (self.rho + x / np.sqrt(x * x + self.s * self.s))

    def d2w(self, k):
        x = np.asarray(k, float) - self.m
        return self.b * self.s * self.s / (x * x + self.s * self.s) ** 1.5

    def implied_vol(self, k):
        return np.sqrt(np.maximum(self.w(k), 0.0) / self.T)

    def params(self) -> dict:
        return {"T": self.T, "a": self.a, "b": self.b, "rho": self.rho, "m": self.m, "s": self.s,
                "rmse_vol": self.rmse_vol}


def durrleman_g(w, dw, d2w, k):
    """Butterfly-arbitrage function; local-vol denominator."""
    w = np.maximum(w, 1e-12)
    return (1 - k * dw / (2 * w)) ** 2 - dw * dw / 4 * (1 / w + 0.25) + d2w / 2


ARB_GRID = np.linspace(-0.5, 0.5, 41)   # where the no-arbitrage penalties are enforced


def fit_svi_slice(k, iv, T: float, previous: SviSlice | None = None, arb_weight: float = 50.0) -> SviSlice:
    """Least squares on total variance with soft no-arbitrage penalties on ARB_GRID:

    * positivity  a + b s sqrt(1 - rho^2) >= 0,
    * butterfly   g(k) >= 0 (Durrleman),
    * calendar    w(k) >= w_previous(k) when the previous (shorter) slice is given.
    """
    k = np.asarray(k, float)
    w_mkt = np.asarray(iv, float) ** 2 * T
    atm = float(np.interp(0.0, np.sort(k), w_mkt[np.argsort(k)]))
    x0 = np.array([max(atm * 0.8, 1e-5), 0.1, -0.5, 0.0, 0.1])
    lo = np.array([-1.0, 1e-4, -0.999, -1.0, 1e-3])
    hi = np.array([max(w_mkt.max(), 1e-3) * 2, 5.0, 0.999, 1.0, 2.0])

    w_prev = previous.w(ARB_GRID) if previous is not None else None

    def residuals(x):
        a, b, rho, m, s = x
        sl = SviSlice(T, a, b, rho, m, s)
        fit = (sl.w(k) - w_mkt) / max(T, 1e-3)
        positivity = [max(0.0, -(a + b * s * math.sqrt(1 - rho * rho))) * 100]
        g = durrleman_g(sl.w(ARB_GRID), sl.dw(ARB_GRID), sl.d2w(ARB_GRID), ARB_GRID)
        butterfly = arb_weight * np.maximum(0.0, -g)
        calendar = (arb_weight * np.maximum(0.0, w_prev - sl.w(ARB_GRID)) / max(T, 1e-3)
                    if w_prev is not None else np.array([]))
        return np.concatenate([fit, positivity, butterfly, calendar])

    sol = least_squares(residuals, np.clip(x0, lo + 1e-9, hi - 1e-9), bounds=(lo, hi), max_nfev=2000)
    a, b, rho, m, s = sol.x
    sl = SviSlice(T, a, b, rho, m, s)
    rmse = float(np.sqrt(np.mean((sl.implied_vol(k) - iv) ** 2)))
    return SviSlice(T, a, b, rho, m, s, rmse)


class VolSurface:
    """SVI slices interpolated linearly in total variance across maturities (flat implied vol outside)."""

    def __init__(self, slices: list[SviSlice], spot: float, dividend_yield: float, curve: RateCurve):
        if not slices:
            raise ValueError("need at least one SVI slice")
        self.slices = sorted(slices, key=lambda s: s.T)
        self.times = np.array([s.T for s in self.slices])
        self.spot, self.q, self.curve = spot, dividend_yield, curve

    def forward(self, T):
        T = np.asarray(T, float)
        return self.spot * np.exp(-self.q * T) / self.curve.discount(T)

    def _bracket(self, T: float):
        """(slice_lo, slice_hi, weight on hi, scale) such that w(k,T) = scale * [(1-a) w_lo(k) + a w_hi(k)]."""
        ts = self.times
        if T <= ts[0]:
            return self.slices[0], self.slices[0], 0.0, T / ts[0]
        if T >= ts[-1]:
            return self.slices[-1], self.slices[-1], 0.0, T / ts[-1]
        i = int(np.searchsorted(ts, T)) - 1
        alpha = (T - ts[i]) / (ts[i + 1] - ts[i])
        return self.slices[i], self.slices[i + 1], alpha, 1.0

    def total_variance(self, k, T: float):
        lo, hi, a, scale = self._bracket(T)
        return scale * ((1 - a) * lo.w(k) + a * hi.w(k))

    def implied_vol(self, k, T: float):
        return np.sqrt(np.maximum(self.total_variance(k, T), 0.0) / T)

    def implied_vol_strike(self, K, T: float):
        return self.implied_vol(np.log(np.asarray(K, float) / self.forward(T)), T)

    def dw_dT(self, k, T: float):
        ts = self.times
        if T <= ts[0]:
            return self.slices[0].w(k) / ts[0]
        if T >= ts[-1]:
            return self.slices[-1].w(k) / ts[-1]
        i = int(np.searchsorted(ts, T)) - 1
        return (self.slices[i + 1].w(k) - self.slices[i].w(k)) / (ts[i + 1] - ts[i])

    def local_vol(self, k, T: float):
        """Dupire local vol; NaN where the surface is not arbitrage-free (dw/dT <= 0 or g <= 0)."""
        k = np.asarray(k, float)
        lo, hi, a, scale = self._bracket(T)
        w = scale * ((1 - a) * lo.w(k) + a * hi.w(k))
        dw = scale * ((1 - a) * lo.dw(k) + a * hi.dw(k))
        d2w = scale * ((1 - a) * lo.d2w(k) + a * hi.d2w(k))
        g = durrleman_g(w, dw, d2w, k)
        wt = self.dw_dT(k, T)
        with np.errstate(invalid="ignore", divide="ignore"):
            lv2 = np.where((g > 1e-8) & (wt > 0), wt / g, np.nan)
        return np.sqrt(lv2)

    # --- diagnostics ------------------------------------------------------------

    def arbitrage_report(self, k_grid=None) -> dict:
        k_grid = ARB_GRID if k_grid is None else k_grid
        butterfly = []
        for s in self.slices:
            g = durrleman_g(s.w(k_grid), s.dw(k_grid), s.d2w(k_grid), k_grid)
            butterfly.append({"T": s.T, "min_g": float(g.min()), "ok": bool(g.min() >= -1e-5)})
        calendar = []
        for s0, s1 in zip(self.slices, self.slices[1:]):
            gap = s1.w(k_grid) - s0.w(k_grid)
            calendar.append({"T1": s0.T, "T2": s1.T, "min_gap": float(gap.min()), "ok": bool(gap.min() >= -1e-5)})
        return {"butterfly": butterfly, "calendar": calendar}

    def grid(self, k_grid, t_grid, kind: str = "implied"):
        f = self.implied_vol if kind == "implied" else self.local_vol
        return np.array([f(k_grid, float(t)) for t in t_grid])


def build_surface(smile, spot: float, dividend_yield: float, curve: RateCurve, min_points: int = 6,
                  min_days: float = 7.0, max_abs_k: float = 0.5) -> VolSurface:
    """Fit one SVI slice per expiry of a smile table (columns: expiry, T, strike, iv)."""
    slices: list[SviSlice] = []
    for _, g in sorted(smile.groupby("expiry"), key=lambda kv: kv[1]["T"].iloc[0]):
        T = float(g["T"].iloc[0])
        if T < min_days / 365:
            continue
        fwd = spot * math.exp(-dividend_yield * T) / float(curve.discount(T))
        k = np.log(g["strike"].to_numpy(float) / fwd)
        keep = np.abs(k) <= max_abs_k
        if keep.sum() < min_points:
            continue
        # fitting in increasing maturity lets each slice be constrained to lie above the previous one
        slices.append(fit_svi_slice(k[keep], g["iv"].to_numpy(float)[keep], T, slices[-1] if slices else None))
    return VolSurface(slices, spot, dividend_yield, curve)


# ----------------------------------------------------------------------------- simulation

@dataclass(frozen=True)
class LocalVolPathModel:
    """Euler scheme on ln S with sigma_loc(ln(S/F_t), t) read from a precomputed grid."""

    surface: VolSurface
    steps_per_year: int = 252
    name: str = "Volatilité locale"

    def _interpolator(self, horizon: float):
        k_grid = np.linspace(-1.0, 1.0, 81)
        t_grid = np.unique(np.concatenate([np.linspace(1 / 365, max(horizon, self.surface.times[-1]), 60),
                                           self.surface.times]))
        lv = self.surface.grid(k_grid, t_grid, "local")
        # fill arbitrage holes with the implied vol at the same point, then cap extreme values
        iv = self.surface.grid(k_grid, t_grid, "implied")
        lv = np.clip(np.where(np.isfinite(lv), lv, iv), 0.01, 3.0)
        return RegularGridInterpolator((t_grid, k_grid), lv, bounds_error=False, fill_value=None)

    def simulate(self, spot: float, dividend_yield: float, curve: RateCurve, times: np.ndarray, n_paths: int,
                 seed: int | None, antithetic: bool = True) -> np.ndarray:
        times = np.asarray(times, float)
        horizon = times[-1]
        interp = self._interpolator(horizon)
        n_sub = max(int(math.ceil(horizon * self.steps_per_year)), len(times))
        grid = np.union1d(np.linspace(0.0, horizon, n_sub + 1), times)
        dfs = curve.discount(grid)
        fwd = spot * np.exp(-dividend_yield * grid) / dfs
        rng = np.random.default_rng(seed)
        half = (n_paths + 1) // 2 if antithetic else n_paths
        log_s = np.full(half * (2 if antithetic else 1), math.log(spot))
        out = np.empty((len(log_s), len(times)))
        targets = {float(t): j for j, t in enumerate(times)}
        k_max = 1.0
        for i in range(1, len(grid)):
            dt = grid[i] - grid[i - 1]
            t_mid = max(grid[i - 1], 1 / 365)
            k = np.clip(log_s - math.log(fwd[i - 1]), -k_max, k_max)
            sig = interp(np.column_stack([np.full_like(k, t_mid), k]))
            z = rng.standard_normal(half)
            if antithetic:
                z = np.concatenate([z, -z])
            drift = math.log(dfs[i - 1] / dfs[i]) - dividend_yield * dt
            log_s += drift - 0.5 * sig * sig * dt + sig * math.sqrt(dt) * z
            j = targets.get(float(grid[i]))
            if j is not None:
                out[:, j] = np.exp(log_s)
        return out[:n_paths]
