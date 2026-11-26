"""Constrained mean-variance optimisation (Markowitz, 1952) with elastic-net penalties and transaction costs.

    max_w   mu'w - (gamma/2) w'Sigma w - lambda_1 ||w||_1 - lambda_2 ||w||_2^2 - c ||w - w0||_1
    s.t.    sum w = 1,   -short_max <= w_i <= w_max,   (optionally mu'w = target)

The non-smooth terms are made smooth by splitting variables: w = u - v and w - w0 = b - s with u, v, b, s >= 0,
so ||w||_1 = sum(u + v) at the optimum and the problem is a quadratic programme solved by SLSQP with exact
gradients. With long-only weights summing to one, ||w||_1 = 1 is constant: the LASSO penalty only bites when
short positions are allowed (Brodie et al., 2009; DeMiguel et al., 2009).
"""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
from scipy.optimize import minimize


@dataclass(frozen=True)
class Constraints:
    long_only: bool = True
    short_max: float = 0.3        # largest short per asset when shorting is allowed
    w_max: float = 1.0            # largest long per asset
    l1: float = 0.0               # LASSO penalty (annualised return units per unit of gross exposure)
    l2: float = 0.0               # ridge penalty
    cost: float = 0.0             # proportional transaction cost (fraction of traded amount)
    holding: float = 1.0          # holding period in years: the one-off cost is spread over it (c / holding per year)
    w0: tuple[float, ...] | None = None   # current portfolio (transaction costs, turnover)


@dataclass
class PortfolioResult:
    weights: np.ndarray
    expected_return: float
    volatility: float
    sharpe: float
    risk_contributions: np.ndarray      # share of the variance coming from each asset (sums to 1)
    effective_n: float                  # 1 / sum w^2
    gross_exposure: float
    n_active: int
    turnover: float                     # sum |w - w0|
    success: bool
    extra: dict = field(default_factory=dict)


def describe(w: np.ndarray, mu: np.ndarray, cov: np.ndarray, rf: float, w0: np.ndarray | None,
             success: bool = True) -> PortfolioResult:
    var = float(w @ cov @ w)
    vol = float(np.sqrt(max(var, 0.0)))
    ret = float(mu @ w)
    rc = w * (cov @ w) / var if var > 0 else np.zeros_like(w)
    return PortfolioResult(
        weights=w, expected_return=ret, volatility=vol, sharpe=(ret - rf) / vol if vol > 0 else float("nan"),
        risk_contributions=rc, effective_n=float(1.0 / np.sum(w * w)), gross_exposure=float(np.abs(w).sum()),
        n_active=int(np.sum(np.abs(w) > 1e-4)),
        turnover=float(np.abs(w - w0).sum()) if w0 is not None else float(np.abs(w).sum()), success=success)


def optimize(mu: np.ndarray, cov: np.ndarray, gamma: float = 5.0, cons: Constraints = Constraints(),
             target_return: float | None = None, rf: float = 0.0, risk_only: bool = False) -> PortfolioResult:
    """Mean-variance with risk aversion gamma. `risk_only`: minimise variance (+ penalties) without the return
    term, e.g. on the frontier where the return is fixed by `target_return`."""
    p = len(mu)
    mu_obj = np.zeros(p) if risk_only else mu
    c = cons.cost / cons.holding
    w0 = np.asarray(cons.w0, float) if cons.w0 is not None else np.full(p, 1.0 / p)
    short = 0.0 if cons.long_only else cons.short_max
    # variables x = [u, (v), (b, s)]: w = u - v, w - w0 = b - s; v only when shorting, (b, s) only with costs
    use_v, use_t = short > 0, c > 0
    blocks = 1 + use_v + 2 * use_t
    I = np.eye(p)
    W = np.hstack([I] + ([-I] if use_v else []) + ([np.zeros((p, 2 * p))] if use_t else []))   # w = W x
    l1_vec = np.concatenate([np.full(p, cons.l1)] + ([np.full(p, cons.l1)] if use_v else [])
                            + ([np.zeros(2 * p)] if use_t else []))
    cost_vec = np.concatenate([np.zeros(p * (1 + use_v))] + ([np.full(2 * p, c)] if use_t else []))
    lin = l1_vec + cost_vec

    def objective(x):
        w = W @ x
        Sw = cov @ w
        f = -mu_obj @ w + 0.5 * gamma * w @ Sw + cons.l2 * w @ w + lin @ x
        gw = -mu_obj + gamma * Sw + 2 * cons.l2 * w
        return f, W.T @ gw + lin

    A_budget = np.ones(p) @ W
    constraints = [{"type": "eq", "fun": lambda x: A_budget @ x - 1.0, "jac": lambda x: A_budget}]
    if use_t:
        A_trade = np.hstack([I] + ([-I] if use_v else []) + [-I, I])
        constraints.append({"type": "eq", "fun": lambda x: A_trade @ x - w0, "jac": lambda x: A_trade})
    if target_return is not None:
        a_ret = mu @ W
        constraints.append({"type": "eq", "fun": lambda x: a_ret @ x - target_return, "jac": lambda x: a_ret})
    bounds = [(0.0, cons.w_max)] * p + ([(0.0, short)] * p if use_v else []) + ([(0.0, None)] * (2 * p) if use_t else [])

    start_w = np.clip(w0, -short, cons.w_max)
    start_w = start_w / start_w.sum() if abs(start_w.sum()) > 1e-9 else np.full(p, 1.0 / p)
    parts = [np.maximum(start_w, 0)] + ([np.maximum(-start_w, 0)] if use_v else [])
    if use_t:
        parts += [np.maximum(start_w - w0, 0), np.maximum(w0 - start_w, 0)]
    x0 = np.concatenate(parts)
    assert len(x0) == blocks * p
    res = minimize(objective, x0, jac=True, method="SLSQP", bounds=bounds, constraints=constraints,
                   options={"maxiter": 500, "ftol": 1e-12})
    w = W @ res.x
    w[np.abs(w) < 1e-7] = 0.0
    return describe(w, mu, cov, rf, w0, bool(res.success))


def min_variance(cov: np.ndarray, cons: Constraints = Constraints(), mu: np.ndarray | None = None,
                 rf: float = 0.0) -> PortfolioResult:
    p = cov.shape[0]
    r = optimize(np.zeros(p), cov, gamma=2.0, cons=cons, rf=rf, risk_only=True)
    return describe(r.weights, mu if mu is not None else np.zeros(p), cov, rf,
                    np.asarray(cons.w0, float) if cons.w0 is not None else np.full(p, 1.0 / p), r.success)


def _min_var_at(mu: np.ndarray, cov: np.ndarray, cons: Constraints, target: float, rf: float) -> PortfolioResult:
    """Minimum-variance portfolio with expected return `target`."""
    r = optimize(mu, cov, 2.0, cons, target, rf, risk_only=True)
    return describe(r.weights, mu, cov, rf, None, r.success)


def max_sharpe(mu: np.ndarray, cov: np.ndarray, cons: Constraints = Constraints(), rf: float = 0.0,
               n_grid: int = 20, points: list[PortfolioResult] | None = None) -> PortfolioResult:
    """Tangency portfolio: best Sharpe ratio on the frontier (grid, then golden-section search on the target)."""
    pts = points if points is not None else frontier(mu, cov, cons, n_grid, rf)
    ok = [r for r in pts if r.success and r.volatility > 0]
    if len(ok) < 3:      # degenerate frontier (e.g. identical expected returns): the minimum-variance portfolio
        return min_variance(cov, cons, mu, rf)
    i = int(np.argmax([r.sharpe for r in ok]))
    lo = ok[max(i - 1, 0)].expected_return
    hi = ok[min(i + 1, len(ok) - 1)].expected_return
    for _ in range(12):
        a, b = hi - 0.618 * (hi - lo), lo + 0.618 * (hi - lo)
        if _min_var_at(mu, cov, cons, a, rf).sharpe > _min_var_at(mu, cov, cons, b, rf).sharpe:
            hi = b
        else:
            lo = a
    best = _min_var_at(mu, cov, cons, 0.5 * (lo + hi), rf)
    best = best if best.success and best.sharpe >= ok[i].sharpe else ok[i]
    w0 = np.asarray(cons.w0, float) if cons.w0 is not None else None
    return describe(best.weights, mu, cov, rf, w0, best.success)


def frontier(mu: np.ndarray, cov: np.ndarray, cons: Constraints = Constraints(), n: int = 30,
             rf: float = 0.0) -> list[PortfolioResult]:
    """Minimum-variance portfolios for target returns from the minimum-variance return to the highest attainable one."""
    gmv = min_variance(cov, cons, mu, rf)
    lo = gmv.expected_return
    if np.ptp(mu) < 1e-10:
        return [gmv]
    if cons.long_only:
        # highest attainable return: fill the best assets up to w_max
        order = np.argsort(-mu)
        w, left = np.zeros_like(mu), 1.0
        for i in order:
            w[i] = min(cons.w_max, left)
            left -= w[i]
            if left <= 1e-12:
                break
        hi = float(mu @ w)
    else:
        hi = float(lo + 3 * (mu.max() - lo))
    return [_min_var_at(mu, cov, cons, float(t), rf) for t in np.linspace(lo, hi - 1e-6 * abs(hi), n)]


def unconstrained_frontier(mu: np.ndarray, cov: np.ndarray, targets: np.ndarray) -> np.ndarray:
    """Closed-form Markowitz frontier (budget constraint only, shorting unlimited): volatility for each target."""
    inv = np.linalg.inv(cov)
    one = np.ones(len(mu))
    a, b, c = one @ inv @ one, one @ inv @ mu, mu @ inv @ mu
    d = a * c - b * b
    return np.sqrt((a * targets**2 - 2 * b * targets + c) / d)
