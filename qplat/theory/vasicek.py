"""Ornstein-Uhlenbeck short rate and the Vasicek (1977) term structure.

    dr = kappa (theta - r) dt + sigma dW

Estimation (real-world P): the exact discretisation of the OU process is an AR(1),
    r_{t+dt} = a + b r_t + e,   b = exp(-kappa dt),  a = theta (1 - b),  Var(e) = sigma^2 (1 - b^2) / (2 kappa),
so an OLS regression of r_{t+dt} on r_t gives kappa, theta and sigma. The OLS slope is biased downwards in
small samples (Kendall, 1954: E[b_hat] - b ~ -(1 + 3b) / n), so kappa is overestimated: rates look more
mean-reverting than they are.

Pricing (risk-neutral Q): P(t, t + tau) = A(tau) exp(-B(tau) r_t), with B = (1 - e^{-kappa tau}) / kappa and
    ln A = (theta - sigma^2 / (2 kappa^2)) (B - tau) - sigma^2 B^2 / (4 kappa).
Girsanov changes the drift, not the volatility: sigma is the same under P and Q, kappa and theta may differ.
"""

from __future__ import annotations

import math
from dataclasses import asdict, dataclass

import numpy as np
from scipy.optimize import least_squares
from scipy.stats import norm

LN2 = math.log(2.0)


# ----------------------------------------------------------------------------- the OU process

def ou_mean(r0: float, kappa: float, theta: float, t):
    t = np.asarray(t, dtype=float)
    return theta + (r0 - theta) * np.exp(-kappa * t)


def ou_var(kappa: float, sigma: float, t):
    t = np.asarray(t, dtype=float)
    if kappa <= 0:
        return sigma ** 2 * t
    return sigma ** 2 * (1.0 - np.exp(-2.0 * kappa * t)) / (2.0 * kappa)


def stationary_sd(kappa: float, sigma: float) -> float:
    return sigma / math.sqrt(2.0 * kappa) if kappa > 0 else float("inf")


def simulate_ou(r0: float, kappa: float, theta: float, sigma: float, dt: float, n_steps: int,
                n_paths: int = 1, seed: int | None = 0) -> np.ndarray:
    """Exact simulation on a regular grid (no discretisation error): shape (n_paths, n_steps + 1)."""
    rng = np.random.default_rng(seed)
    b = math.exp(-kappa * dt)
    sd = math.sqrt(float(ou_var(kappa, sigma, dt)))
    out = np.empty((n_paths, n_steps + 1))
    out[:, 0] = r0
    z = rng.standard_normal((n_paths, n_steps))
    for i in range(n_steps):
        out[:, i + 1] = theta + (out[:, i] - theta) * b + sd * z[:, i]
    return out


# ----------------------------------------------------------------------------- estimation (AR(1) regression)

@dataclass
class OUEstimate:
    n: int                  # number of transitions
    dt: float               # years between observations
    a: float
    b: float
    se_a: float
    se_b: float
    resid_sd: float
    r2: float
    mean_reverting: bool    # 0 < b < 1
    kappa: float
    theta: float
    sigma: float
    se_kappa: float
    se_theta: float
    half_life: float        # years, ln 2 / kappa
    half_life_low: float    # 95% interval from the interval on kappa
    half_life_high: float
    b_corrected: float      # Kendall bias correction b + (1 + 3b) / n
    kappa_corrected: float
    half_life_corrected: float

    def to_dict(self) -> dict:
        return {k: (None if isinstance(v, float) and not math.isfinite(v) else v) for k, v in asdict(self).items()}


def _ols(x: np.ndarray, y: np.ndarray):
    n = len(x)
    xm, ym = x.mean(), y.mean()
    sxx = float(((x - xm) ** 2).sum())
    b = float(((x - xm) * (y - ym)).sum() / sxx)
    a = float(ym - b * xm)
    e = y - a - b * x
    s2 = float((e ** 2).sum() / (n - 2))
    var_b = s2 / sxx
    var_a = s2 * (1.0 / n + xm ** 2 / sxx)
    cov_ab = -xm * s2 / sxx
    r2 = 1.0 - float((e ** 2).sum()) / float(((y - ym) ** 2).sum())
    return a, b, var_a, var_b, cov_ab, math.sqrt(s2), r2


def _kappa(b: float, dt: float) -> float:
    return -math.log(b) / dt if 0 < b < 1 else float("nan")


def estimate_ou(rates, dt: float) -> OUEstimate:
    """OLS of r_{t+dt} on r_t, mapped to (kappa, theta, sigma) through the exact discretisation."""
    r = np.asarray(rates, dtype=float)
    r = r[np.isfinite(r)]
    if len(r) < 20:
        raise ValueError("série trop courte pour estimer le processus")
    x, y = r[:-1], r[1:]
    n = len(x)
    a, b, var_a, var_b, cov_ab, s, r2 = _ols(x, y)
    se_a, se_b = math.sqrt(var_a), math.sqrt(var_b)
    ok = 0 < b < 1
    kappa = _kappa(b, dt)
    if ok:
        theta = a / (1.0 - b)
        sigma = s * math.sqrt(2.0 * kappa / (1.0 - b * b))
        se_kappa = se_b / (b * dt)                                   # delta method on -ln(b) / dt
        g = np.array([1.0 / (1.0 - b), a / (1.0 - b) ** 2])         # gradient of a / (1 - b) in (a, b)
        se_theta = math.sqrt(float(g @ np.array([[var_a, cov_ab], [cov_ab, var_b]]) @ g))
        half_life = LN2 / kappa
        # interval on b, mapped to kappa then to the half-life (monotonic transforms)
        b_lo, b_hi = b - 1.96 * se_b, b + 1.96 * se_b
        hl_low = LN2 / _kappa(max(b_lo, 1e-12), dt)
        hl_high = LN2 / _kappa(b_hi, dt) if b_hi < 1 else float("inf")  # a unit root is not rejected
    else:
        theta = sigma = se_kappa = se_theta = half_life = hl_low = hl_high = float("nan")
    b_c = b + (1.0 + 3.0 * b) / n
    k_c = _kappa(b_c, dt)
    return OUEstimate(n=n, dt=dt, a=a, b=b, se_a=se_a, se_b=se_b, resid_sd=s, r2=r2, mean_reverting=ok,
                      kappa=kappa, theta=theta, sigma=sigma, se_kappa=se_kappa, se_theta=se_theta,
                      half_life=half_life, half_life_low=hl_low, half_life_high=hl_high,
                      b_corrected=b_c, kappa_corrected=k_c,
                      half_life_corrected=LN2 / k_c if math.isfinite(k_c) and k_c > 0 else float("inf"))


def estimator_distribution(r0: float, kappa: float, theta: float, sigma: float, dt: float, n: int,
                           n_sims: int = 500, seed: int = 0) -> dict:
    """Monte Carlo of the OLS estimator: simulate n_sims paths of the same length with known parameters,
    re-estimate kappa on each. Shows the small-sample bias (kappa_hat > kappa on average) and the dispersion."""
    paths = simulate_ou(r0, kappa, theta, sigma, dt, n, n_sims, seed)
    x, y = paths[:, :-1], paths[:, 1:]
    xm, ym = x.mean(axis=1, keepdims=True), y.mean(axis=1, keepdims=True)
    b = ((x - xm) * (y - ym)).sum(axis=1) / ((x - xm) ** 2).sum(axis=1)
    with np.errstate(invalid="ignore", divide="ignore"):
        k = np.where((b > 0) & (b < 1), -np.log(b) / dt, np.nan)
    finite = k[np.isfinite(k)]
    b_true = math.exp(-kappa * dt)
    return {
        "kappa_true": kappa, "b_true": b_true, "n": n, "n_sims": n_sims,
        "b_mean": float(b.mean()), "b_bias": float(b.mean() - b_true), "b_bias_kendall": -(1.0 + 3.0 * b_true) / n,
        "kappa_mean": float(finite.mean()) if len(finite) else None,
        "kappa_median": float(np.median(finite)) if len(finite) else None,
        "kappa_q05": float(np.quantile(finite, 0.05)) if len(finite) else None,
        "kappa_q95": float(np.quantile(finite, 0.95)) if len(finite) else None,
        "share_no_reversion": float(1.0 - len(finite) / n_sims),
        "kappa_samples": np.sort(finite).tolist(),
    }


# ----------------------------------------------------------------------------- Vasicek bond prices

def vasicek_B(kappa: float, tau):
    tau = np.asarray(tau, dtype=float)
    return (1.0 - np.exp(-kappa * tau)) / kappa


def vasicek_discount(r0: float, kappa: float, theta: float, sigma: float, tau):
    tau = np.asarray(tau, dtype=float)
    B = vasicek_B(kappa, tau)
    lnA = (theta - sigma ** 2 / (2.0 * kappa ** 2)) * (B - tau) - sigma ** 2 * B ** 2 / (4.0 * kappa)
    return np.exp(lnA - B * r0)


def vasicek_yield(r0: float, kappa: float, theta: float, sigma: float, tau):
    """Continuously compounded zero rate -ln P / tau (r0 as tau -> 0)."""
    tau = np.asarray(tau, dtype=float)
    safe = np.where(tau > 1e-10, tau, 1e-10)
    y = -np.log(vasicek_discount(r0, kappa, theta, sigma, safe)) / safe
    return np.where(tau > 1e-10, y, r0)


def vasicek_forward(r0: float, kappa: float, theta: float, sigma: float, t):
    """Instantaneous forward f(0, t) = E_Q[r_t] - sigma^2 B(t)^2 / 2 (convexity)."""
    t = np.asarray(t, dtype=float)
    return ou_mean(r0, kappa, theta, t) - 0.5 * sigma ** 2 * vasicek_B(kappa, t) ** 2


def long_yield(kappa: float, theta: float, sigma: float) -> float:
    return theta - sigma ** 2 / (2.0 * kappa ** 2)


def calibrate_vasicek(tenors, zero_rates, r0: float, sigma: float, kappa0: float = 0.2,
                      theta0: float | None = None) -> dict:
    """Risk-neutral (kappa_Q, theta_Q) fitted to a zero curve by least squares, r0 and sigma held fixed
    (sigma comes from the time series: Girsanov leaves it unchanged)."""
    t = np.asarray(tenors, dtype=float)
    z = np.asarray(zero_rates, dtype=float)
    theta0 = float(z[-1]) if theta0 is None else theta0

    def resid(p):
        return vasicek_yield(r0, p[0], p[1], sigma, t) - z

    # the problem is nearly flat in some directions (small kappa trades off against large theta):
    # several starting points, keep the best
    fits = [least_squares(resid, x0=[k0, theta0], bounds=([5e-3, -0.05], [3.0, 0.20]), xtol=1e-14, ftol=1e-14)
            for k0 in (kappa0, 0.05, 0.5, 1.5)]
    fit = min(fits, key=lambda f: f.cost)
    res = resid(fit.x)
    return {"kappa": float(fit.x[0]), "theta": float(fit.x[1]), "sigma": sigma, "r0": r0,
            "rmse": float(np.sqrt(np.mean(res ** 2))), "max_abs_error": float(np.max(np.abs(res))),
            "residuals": res.tolist()}


def prob_negative(kappa: float, theta: float, sigma: float, r0: float | None = None, t: float | None = None) -> float:
    """P(r < 0): stationary law, or the law of r_t given r0."""
    if r0 is None or t is None:
        return float(norm.cdf(-theta / stationary_sd(kappa, sigma)))
    return float(norm.cdf(-float(ou_mean(r0, kappa, theta, t)) / math.sqrt(float(ou_var(kappa, sigma, t)))))
