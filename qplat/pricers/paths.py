"""Risk-neutral GBM path generation shared by every Monte Carlo pricer."""

from __future__ import annotations

import numpy as np

from qplat.curves.rate_curve import RateCurve


def standard_normals(n_paths: int, n_steps: int, seed: int | None, antithetic: bool) -> np.ndarray:
    """(n_paths, n_steps) N(0,1) draws; antithetic pairs stacked as [Z, -Z]."""
    rng = np.random.default_rng(seed)
    if antithetic:
        half = (n_paths + 1) // 2
        z = rng.standard_normal((half, n_steps))
        return np.vstack([z, -z])[:n_paths]
    return rng.standard_normal((n_paths, n_steps))


def gbm_paths(spot: float, vol: float, dividend_yield: float, curve: RateCurve,
              times: np.ndarray, normals: np.ndarray) -> np.ndarray:
    """Exact GBM simulation at `times` (excluding t=0), returns (n_paths, len(times)).

    Drift between t_{i-1} and t_i is the curve forward rate minus the dividend
    yield, so E[S_t] = S_0 e^{-qt} / P(0,t) for any curve.
    """
    times = np.asarray(times, dtype=float)
    grid = np.concatenate([[0.0], times])
    dt = np.diff(grid)
    dfs = curve.discount(grid)
    log_growth = np.log(dfs[:-1] / dfs[1:]) - dividend_yield * dt  # int (f - q) dt
    increments = log_growth - 0.5 * vol**2 * dt + vol * np.sqrt(dt) * normals
    return spot * np.exp(np.cumsum(increments, axis=1))


def importance_shift(normals: np.ndarray, times: np.ndarray, theta: float) -> tuple[np.ndarray, np.ndarray]:
    """Girsanov change of measure for importance sampling.

    Under the sampling measure Q the Brownian motion gets a drift theta: each increment sqrt(dt) z becomes
    sqrt(dt) (z + theta sqrt(dt)). Returns the shifted normals and the likelihood ratio of each path

        dP/dQ = exp(-theta W_T + theta^2 T / 2),     W_T = sum sqrt(dt) z_shifted,

    so that E_P[f(W)] = E_Q[f(W) dP/dQ] for any payoff f.
    """
    times = np.asarray(times, dtype=float)
    dt = np.diff(np.concatenate([[0.0], times]))
    shifted = normals + theta * np.sqrt(dt)
    w_T = shifted @ np.sqrt(dt)
    T = float(times[-1])
    return shifted, np.exp(-theta * w_T + 0.5 * theta * theta * T)


def auto_theta(spot: float, target: float, vol: float, dividend_yield: float, curve: RateCurve, T: float) -> float:
    """Drift shift that moves the median of S_T to `target` (strike or barrier): rare payoffs become typical."""
    fwd = spot * np.exp(-dividend_yield * T) / float(curve.discount(T))
    return float((np.log(target / fwd) + 0.5 * vol * vol * T) / (vol * T))
