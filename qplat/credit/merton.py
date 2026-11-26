"""Merton (1974) structural model: equity is a call on the firm's assets.

Firm value V follows a GBM with volatility sigma_V; the debt is a zero-coupon of face D due at T.
Default happens at T if V_T < D. Then

    E = V N(d1) - D e^{-rT} N(d2),        d1 = [ln(V/D) + (r + sigma_V^2/2) T] / (sigma_V sqrt T),  d2 = d1 - sigma_V sqrt T
    sigma_E E = N(d1) sigma_V V           (Ito: equity vol from asset vol)

V and sigma_V are not observed: they are solved from the observed equity value E and equity vol sigma_E.
Outputs: distance to default d2, risk-neutral default probability N(-d2), debt value B = V - E,
credit spread s = -ln(B / (D e^{-rT})) / T, recovery implied by the model.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
from scipy.optimize import brentq, least_squares
from scipy.stats import norm

from qplat.credit.cds import CDS, HazardCurve, cds_legs
from qplat.curves.rate_curve import RateCurve


def _d1d2(V: float, sigma_v: float, D: float, T: float, r: float) -> tuple[float, float]:
    s = sigma_v * math.sqrt(T)
    d1 = (math.log(V / D) + (r + 0.5 * sigma_v * sigma_v) * T) / s
    return d1, d1 - s


def merton_equity(V: float, sigma_v: float, D: float, T: float, r: float) -> tuple[float, float]:
    """(equity value, equity volatility) implied by the asset value and volatility."""
    d1, d2 = _d1d2(V, sigma_v, D, T, r)
    E = V * norm.cdf(d1) - D * math.exp(-r * T) * norm.cdf(d2)
    return E, norm.cdf(d1) * sigma_v * V / E


@dataclass(frozen=True)
class MertonFit:
    equity: float
    equity_vol: float
    debt_face: float
    T: float
    r: float
    assets: float              # V
    asset_vol: float           # sigma_V
    d1: float
    d2: float                  # risk-neutral distance to default
    default_probability: float # Q(V_T < D) = N(-d2)
    debt_value: float          # B = V - E
    spread: float              # continuously compounded yield spread of the debt
    recovery: float            # E_Q[V_T | default] / D
    leverage: float            # D e^{-rT} / V (quasi market leverage)
    equity_delta: float        # dE/dV = N(d1)

    @property
    def distance_to_default(self) -> float:
        return self.d2


def merton_fit(V: float, sigma_v: float, D: float, T: float, r: float) -> MertonFit:
    d1, d2 = _d1d2(V, sigma_v, D, T, r)
    E, sigma_e = merton_equity(V, sigma_v, D, T, r)
    B = V - E
    risk_free = D * math.exp(-r * T)
    pd = float(norm.cdf(-d2))
    recovery = V * math.exp(r * T) * norm.cdf(-d1) / (D * pd) if pd > 1e-300 else 1.0
    return MertonFit(E, sigma_e, D, T, r, V, sigma_v, d1, d2, pd, B, max(-math.log(B / risk_free) / T, 0.0),
                     float(recovery), risk_free / V, float(norm.cdf(d1)))


def calibrate_merton(equity: float, equity_vol: float, debt_face: float, T: float = 1.0, r: float = 0.03) -> MertonFit:
    """Solve (V, sigma_V) from the two Merton equations, in log variables scaled by E."""
    if equity <= 0 or equity_vol <= 0 or debt_face <= 0:
        raise ValueError("equity, equity vol and debt must be > 0")

    def residuals(x):
        V, sv = math.exp(x[0]) * equity, math.exp(x[1])
        E, se = merton_equity(V, sv, debt_face, T, r)
        return [E / equity - 1.0, se / equity_vol - 1.0]

    V0 = equity + debt_face * math.exp(-r * T)
    x0 = [math.log(V0 / equity), math.log(equity_vol * equity / V0)]
    sol = least_squares(residuals, x0, xtol=1e-14, ftol=1e-14, gtol=1e-14)
    if np.max(np.abs(sol.fun)) > 1e-8:
        raise ValueError("Merton calibration did not converge (equity vol too low for this leverage?)")
    return merton_fit(math.exp(sol.x[0]) * equity, math.exp(sol.x[1]), debt_face, T, r)


# ----------------------------------------------------------------------------- term structure and CDS bridge

def term_structure(fit: MertonFit, curve: RateCurve, maturities) -> dict[str, list[float]]:
    """Spread and default probability for debt of face D maturing at each T (V and sigma_V held fixed)."""
    out = {"T": [], "spread": [], "default_probability": [], "distance_to_default": []}
    for T in maturities:
        r = float(curve.zero_rate(T))
        f = merton_fit(fit.assets, fit.asset_vol, fit.debt_face, float(T), r)
        out["T"].append(float(T))
        out["spread"].append(f.spread)
        out["default_probability"].append(f.default_probability)
        out["distance_to_default"].append(f.d2)
    return out


def merton_hazard_curve(fit: MertonFit, curve: RateCurve, horizon: float = 10.0, step: float = 0.25) -> HazardCurve:
    """Piecewise-constant hazard matching the Merton survival Q(T) = N(d2(T)) on a quarterly grid."""
    times = np.arange(step, horizon + 1e-9, step)
    surv = np.array([1.0 - merton_fit(fit.assets, fit.asset_vol, fit.debt_face, float(t),
                                      float(curve.zero_rate(t))).default_probability for t in times])
    surv = np.minimum.accumulate(np.clip(surv, 1e-300, 1.0))
    lam = -np.diff(np.log(np.concatenate([[1.0], surv]))) / step
    return HazardCurve(tuple(times), tuple(np.maximum(lam, 0.0)))


def merton_cds_spreads(fit: MertonFit, curve: RateCurve, tenors, recovery: float = 0.4) -> list[float]:
    """Par CDS spreads implied by the structural model (its survival curve, a market recovery)."""
    h = merton_hazard_curve(fit, curve, horizon=max(tenors))
    return [cds_legs(CDS(maturity=float(T), recovery=recovery), h, curve).par_spread for T in tenors]


def implied_equity_vol(equity: float, debt_face: float, curve: RateCurve, market_spread: float, tenor: float = 5.0,
                       recovery: float = 0.4, T: float = 1.0) -> float | None:
    """Equity volatility for which Merton reproduces a market CDS spread (capital-structure consistency)."""
    r = float(curve.zero_rate(T))

    def gap(vol):
        fit = calibrate_merton(equity, vol, debt_face, T, r)
        return merton_cds_spreads(fit, curve, [tenor], recovery)[0] - market_spread

    try:
        return float(brentq(gap, 0.02, 3.0, xtol=1e-6))
    except ValueError:
        return None
