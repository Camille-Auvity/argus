"""Walk-forward (out-of-sample) backtest of allocation rules.

At each rebalancing date t, the rule only sees the `window` daily returns strictly before t; the weights are
then held (and drift with prices) until the next rebalancing. Proportional costs are charged on the traded
amount sum |w_new - w_drifted|. This is the test of DeMiguel, Garlappi & Uppal (2009): does an optimised
portfolio beat 1/N out of sample once estimation error and costs are accounted for?
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd

from qplat.allocation.estimation import TRADING_DAYS, estimate
from qplat.allocation.optimize import Constraints, min_variance, optimize

Rule = Callable[[pd.DataFrame, np.ndarray], np.ndarray]   # (past returns, current weights) -> new weights


@dataclass(frozen=True)
class Strategy:
    name: str
    rule: Rule
    description: str = ""


def standard_strategies(gamma: float = 5.0, cost: float = 0.001, rebalance_days: int = 21,
                        short_max: float = 0.3, l1: float = 0.002, w_max: float = 0.4) -> list[Strategy]:
    holding = rebalance_days / TRADING_DAYS

    def equal(R, w):
        return np.full(R.shape[1], 1.0 / R.shape[1])

    def gmv_long(R, w):
        e = estimate(R, cov_method="ledoit-wolf")
        return min_variance(e.cov, Constraints(long_only=True, w_max=w_max)).weights

    def mv_sample_short(R, w):
        e = estimate(R, mean_method="sample", cov_method="sample")
        return optimize(e.mu, e.cov, gamma, Constraints(long_only=False, short_max=short_max)).weights

    def mv_long_shrunk(R, w):
        e = estimate(R, mean_method="shrunk", cov_method="ledoit-wolf")
        return optimize(e.mu, e.cov, gamma, Constraints(long_only=True, w_max=w_max)).weights

    def enet_gmv(R, w):
        e = estimate(R, cov_method="sample")
        return min_variance(e.cov, Constraints(long_only=False, short_max=short_max, l1=l1, l2=l1 / 2)).weights

    def mv_costs(R, w):
        e = estimate(R, mean_method="shrunk", cov_method="ledoit-wolf")
        return optimize(e.mu, e.cov, gamma, Constraints(long_only=True, w_max=w_max, cost=cost, holding=holding,
                                                       w0=tuple(w))).weights

    return [
        Strategy("1/N", equal, "équipondéré, aucune estimation"),
        Strategy("Min variance long-only", gmv_long, f"covariance Ledoit-Wolf, poids ≤ {w_max:.0%}"),
        Strategy("Moyenne-variance (moyennes empiriques, shorts)", mv_sample_short,
                 f"γ = {gamma:g}, short ≤ {short_max:.0%}, estimateurs empiriques : le cas d'école de l'erreur d'estimation"),
        Strategy("Moyenne-variance long-only (shrinkage)", mv_long_shrunk, "James-Stein + Ledoit-Wolf, poids plafonnés"),
        Strategy("Min variance elastic-net (shorts)", enet_gmv, f"λ₁ = {l1:g}, λ₂ = {l1 / 2:g}, short ≤ {short_max:.0%}"),
        Strategy("Moyenne-variance avec coûts", mv_costs, f"comme le long-only shrinké, coût {cost:.2%} pénalisé dans l'optimisation"),
    ]


@dataclass
class BacktestResult:
    name: str
    description: str
    dates: list
    wealth: np.ndarray            # net of costs, starts at 1
    weights_history: list         # (date, weights) at each rebalancing
    turnover: float               # average one-way turnover per rebalancing
    total_cost: float             # sum of costs paid (fraction of wealth)
    stats: dict


def performance(daily: np.ndarray, rf: float = 0.0) -> dict:
    wealth = np.cumprod(1 + daily)
    years = len(daily) / TRADING_DAYS
    ann_ret = wealth[-1] ** (1 / years) - 1 if years > 0 else float("nan")
    vol = float(daily.std(ddof=1) * np.sqrt(TRADING_DAYS))
    peak = np.maximum.accumulate(wealth)
    return {"annual_return": float(ann_ret), "volatility": vol,
            "sharpe": float((daily.mean() * TRADING_DAYS - rf) / vol) if vol > 0 else float("nan"),
            "max_drawdown": float((wealth / peak - 1).min()), "final_wealth": float(wealth[-1])}


def run_backtest(returns: pd.DataFrame, strategies: list[Strategy], window: int = 126, rebalance_days: int = 21,
                 cost: float = 0.001, rf: float = 0.0) -> list[BacktestResult]:
    R = returns.to_numpy(float)
    n, p = R.shape
    if n <= window + rebalance_days:
        raise ValueError("history too short for this estimation window")
    out = []
    for strat in strategies:
        w = np.full(p, 1.0 / p)
        held = w.copy()
        daily, history, turns, costs = [], [], [], 0.0
        for t in range(window, n):
            if (t - window) % rebalance_days == 0:
                past = returns.iloc[t - window:t]                     # strictly before t: no look-ahead
                try:
                    new = np.asarray(strat.rule(past, held), float)
                except Exception:
                    new = held.copy()
                trade = float(np.abs(new - held).sum())
                c = cost * trade
                costs += c
                turns.append(trade)
                history.append((str(returns.index[t]), new.tolist()))
                held = new
            else:
                c = 0.0
            r = float(held @ R[t])
            daily.append((1 + r) * (1 - c) - 1)
            held = held * (1 + R[t]) / (1 + r)                         # weights drift with prices
        daily = np.array(daily)
        out.append(BacktestResult(strat.name, strat.description, [str(d) for d in returns.index[window:]],
                                  np.cumprod(1 + daily), history,
                                  float(np.mean(turns[1:])) if len(turns) > 1 else 0.0, costs,
                                  performance(daily, rf)))
    return out
