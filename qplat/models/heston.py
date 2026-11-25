"""Heston stochastic volatility model.

    dS/S = (f(t) - q) dt + sqrt(v) dW1
    dv   = kappa (theta - v) dt + sigma sqrt(v) dW2,     d<W1, W2> = rho dt

* European prices by the Lewis (2001) single-integral formula on the
  characteristic function ("little Heston trap" form of Albrecher et al., 2007,
  which avoids branch-cut discontinuities).
* Calibration to an implied-volatility smile by least squares on vega-scaled
  price errors (~ implied-vol errors).
* Path simulation by full-truncation Euler on log S, for exotics.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass

import numpy as np
from scipy.optimize import least_squares
from scipy.special import roots_legendre
from scipy.stats import norm

from qplat.curves.rate_curve import RateCurve
from qplat.instruments.options import ExerciseStyle, VanillaOption
from qplat.pricers.base import FiniteDifferencePricer
from qplat.pricers.black_scholes import implied_volatility_vec


@dataclass(frozen=True)
class HestonParams:
    v0: float      # initial variance
    kappa: float   # mean-reversion speed
    theta: float   # long-run variance
    sigma: float   # vol of variance ("vol of vol")
    rho: float     # spot / variance correlation

    def feller(self) -> float:
        """2*kappa*theta - sigma^2 (> 0 means the variance never touches zero)."""
        return 2 * self.kappa * self.theta - self.sigma**2

    def as_array(self) -> np.ndarray:
        return np.array([self.v0, self.kappa, self.theta, self.sigma, self.rho])

    @classmethod
    def from_array(cls, x) -> "HestonParams":
        return cls(*map(float, x))


# ----------------------------------------------------------------------------- characteristic function

def heston_cf(u: np.ndarray, t: float, p: HestonParams) -> np.ndarray:
    """E[exp(i u X_T)] with X_T = ln(S_T / S_0) - (r - q) T (drift removed). u may be complex."""
    iu = 1j * u
    a = p.kappa - p.rho * p.sigma * iu
    d = np.sqrt(a * a + p.sigma**2 * (iu + u * u))
    g = (a - d) / (a + d)
    edt = np.exp(-d * t)
    c = p.kappa * p.theta / p.sigma**2 * ((a - d) * t - 2.0 * np.log((1 - g * edt) / (1 - g)))
    dd = (a - d) / p.sigma**2 * (1 - edt) / (1 - g * edt)
    return np.exp(c + dd * p.v0)


_GL_NODES, _GL_WEIGHTS = roots_legendre(400)


def _lewis_grid(t: float, p: HestonParams) -> tuple[np.ndarray, np.ndarray]:
    # the integrand decays like exp(-v T u^2 / 2): pick the cut-off from the smallest plausible variance
    v_min = max(min(p.v0, p.theta), 1e-4)
    upper = float(np.clip(math.sqrt(2 * 40 / (v_min * t)), 100.0, 3000.0))
    u = 0.5 * upper * (_GL_NODES + 1)
    w = 0.5 * upper * _GL_WEIGHTS
    return u, w


def heston_call_prices(spot: float, strikes, t: float, r: float, q: float, p: HestonParams) -> np.ndarray:
    """Lewis formula, vectorised over strikes:

    C = S e^{-qT} - sqrt(S K) e^{-(r+q)T/2} / pi * int_0^inf Re[e^{i u x} phi(u - i/2)] / (u^2 + 1/4) du,
    x = ln(S/K) + (r - q) T.
    """
    strikes = np.atleast_1d(np.asarray(strikes, dtype=float))
    u, w = _lewis_grid(t, p)
    phi = heston_cf(u - 0.5j, t, p)                      # depends on T only: computed once per maturity
    x = np.log(spot / strikes) + (r - q) * t
    integrand = np.real(np.exp(1j * np.outer(x, u)) * phi) / (u * u + 0.25)
    integral = integrand @ w
    calls = spot * math.exp(-q * t) - np.sqrt(spot * strikes) * math.exp(-0.5 * (r + q) * t) / math.pi * integral
    lower = np.maximum(spot * math.exp(-q * t) - strikes * math.exp(-r * t), 0.0)
    return np.maximum(calls, lower)


def heston_prices(spot, strikes, t, r, q, p: HestonParams, option_types) -> np.ndarray:
    """Calls by Lewis, puts by call-put parity."""
    calls = heston_call_prices(spot, strikes, t, r, q, p)
    strikes = np.atleast_1d(np.asarray(strikes, dtype=float))
    puts = calls - spot * math.exp(-q * t) + strikes * math.exp(-r * t)
    is_put = np.asarray([str(o) == "put" for o in np.atleast_1d(option_types)])
    return np.where(is_put, puts, calls)


class HestonPricer(FiniteDifferencePricer):
    """European vanilla under Heston. The instrument's flat `vol` is ignored; Heston parameters drive the smile.

    `vega` is redefined as the sensitivity to a parallel shift of sqrt(v0) and sqrt(theta)."""

    name = "Heston (Lewis)"

    def __init__(self, params: HestonParams, **bumps):
        super().__init__(**bumps)
        self.params = params

    def price(self, opt: VanillaOption) -> float:
        if opt.exercise is not ExerciseStyle.EUROPEAN:
            raise ValueError("HestonPricer prices European exercise only")
        r = float(opt.curve.zero_rate(opt.expiry))
        return float(heston_prices(opt.spot, [opt.strike], opt.expiry, r, opt.dividend_yield, self.params,
                                   [opt.option_type.value])[0])

    def vega(self, opt):
        h = 0.01
        p = self.params

        def shifted(dv):
            return dataclasses.replace(p, v0=(math.sqrt(p.v0) + dv) ** 2, theta=(math.sqrt(p.theta) + dv) ** 2)

        up, dn = HestonPricer(shifted(h)).price(opt), HestonPricer(shifted(-h)).price(opt)
        return (up - dn) / (2 * h)


# ----------------------------------------------------------------------------- calibration

BOUNDS_LO = np.array([1e-4, 0.05, 1e-4, 0.01, -0.99])
BOUNDS_HI = np.array([1.5, 15.0, 1.5, 3.0, 0.99])


@dataclass
class CalibrationResult:
    params: HestonParams
    rmse_vol: float               # root-mean-square implied-vol error (absolute, e.g. 0.01 = 1 vol point)
    max_error_vol: float
    n_points: int
    n_evaluations: int
    success: bool
    message: str
    errors_vol: np.ndarray        # model IV - market IV per point


def calibrate_heston(spot: float, strikes, maturities, option_types, market_ivs, rates, q: float,
                     initial: HestonParams | None = None, max_nfev: int = 300) -> CalibrationResult:
    """Least squares on (model price - market price) / BS vega, i.e. first-order implied-vol errors."""
    strikes = np.asarray(strikes, float)
    maturities = np.asarray(maturities, float)
    market_ivs = np.asarray(market_ivs, float)
    rates = np.asarray(rates, float)
    types = np.asarray([str(o) for o in option_types])
    phi = np.where(types == "call", 1, -1)

    sqrt_t = np.sqrt(maturities)
    d1 = (np.log(spot / strikes) + (rates - q + 0.5 * market_ivs**2) * maturities) / (market_ivs * sqrt_t)
    d2 = d1 - market_ivs * sqrt_t
    market = phi * (spot * np.exp(-q * maturities) * norm.cdf(phi * d1) - strikes * np.exp(-rates * maturities) * norm.cdf(phi * d2))
    vega = np.maximum(spot * np.exp(-q * maturities) * norm.pdf(d1) * sqrt_t, 1e-3 * spot * np.sqrt(maturities))

    groups = [(t, np.flatnonzero(maturities == t)) for t in np.unique(maturities)]

    def model_prices(x):
        p = HestonParams.from_array(x)
        out = np.empty_like(strikes)
        for t, idx in groups:
            out[idx] = heston_prices(spot, strikes[idx], t, rates[idx][0], q, p, types[idx])
        return out

    def residuals(x):
        return (model_prices(x) - market) / vega

    if initial is None:
        short = market_ivs[maturities == maturities.min()]
        long_ = market_ivs[maturities == maturities.max()]
        initial = HestonParams(v0=float(np.median(short)) ** 2, kappa=2.0, theta=float(np.median(long_)) ** 2,
                               sigma=0.6, rho=-0.6)
    x0 = np.clip(initial.as_array(), BOUNDS_LO + 1e-6, BOUNDS_HI - 1e-6)
    sol = least_squares(residuals, x0, bounds=(BOUNDS_LO, BOUNDS_HI), x_scale="jac", max_nfev=max_nfev,
                        diff_step=1e-4)
    params = HestonParams.from_array(sol.x)

    # exact implied-vol errors at the solution (not the first-order proxy)
    prices = model_prices(sol.x)
    model_ivs = implied_volatility_vec(prices, spot, strikes, maturities, rates, q, types)
    err = model_ivs - market_ivs
    ok = np.isfinite(err)
    return CalibrationResult(
        params=params,
        rmse_vol=float(np.sqrt(np.mean(err[ok] ** 2))) if ok.any() else float("nan"),
        max_error_vol=float(np.max(np.abs(err[ok]))) if ok.any() else float("nan"),
        n_points=int(len(strikes)), n_evaluations=int(sol.nfev), success=bool(sol.success),
        message=str(sol.message), errors_vol=err,
    )


def heston_implied_vols(spot: float, strikes, t: float, r: float, q: float, p: HestonParams) -> np.ndarray:
    """Model smile: OTM prices (puts below the forward, calls above) inverted with Black-Scholes."""
    strikes = np.atleast_1d(np.asarray(strikes, float))
    fwd = spot * math.exp((r - q) * t)
    types = np.where(strikes < fwd, "put", "call")
    prices = heston_prices(spot, strikes, t, r, q, p, types)
    return implied_volatility_vec(prices, spot, strikes, t, r, q, types)


# ----------------------------------------------------------------------------- simulation

@dataclass(frozen=True)
class HestonPathModel:
    """Path generator plugged into the Monte Carlo exotic pricers (barrier, autocall)."""

    params: HestonParams
    steps_per_year: int = 252
    name: str = "Heston"

    def simulate(self, spot: float, dividend_yield: float, curve: RateCurve, times: np.ndarray, n_paths: int,
                 seed: int | None, antithetic: bool = True) -> np.ndarray:
        """Spot at `times` (excluding 0), shape (n_paths, len(times)). Full-truncation Euler on (ln S, v)."""
        p = self.params
        times = np.asarray(times, float)
        horizon = times[-1]
        n_sub = max(int(math.ceil(horizon * self.steps_per_year)), len(times))
        grid = np.union1d(np.linspace(0.0, horizon, n_sub + 1), times)
        rng = np.random.default_rng(seed)
        half = (n_paths + 1) // 2 if antithetic else n_paths
        dfs = curve.discount(grid)
        log_s = np.full(half * (2 if antithetic else 1), math.log(spot))
        v = np.full_like(log_s, p.v0)
        out = np.empty((len(log_s), len(times)))
        targets = {float(t): j for j, t in enumerate(times)}
        rho_c = math.sqrt(1 - p.rho**2)
        for i in range(1, len(grid)):
            dt = grid[i] - grid[i - 1]
            z1 = rng.standard_normal(half)
            z2 = rng.standard_normal(half)
            if antithetic:
                z1, z2 = np.concatenate([z1, -z1]), np.concatenate([z2, -z2])
            vp = np.maximum(v, 0.0)
            sq = np.sqrt(vp * dt)
            drift = math.log(dfs[i - 1] / dfs[i]) - dividend_yield * dt   # int (f - q) dt
            log_s += drift - 0.5 * vp * dt + sq * z1
            v += p.kappa * (p.theta - vp) * dt + p.sigma * sq * (p.rho * z1 + rho_c * z2)
            j = targets.get(float(grid[i]))
            if j is not None:
                out[:, j] = np.exp(log_s)
        return out[:n_paths]
