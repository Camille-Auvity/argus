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
