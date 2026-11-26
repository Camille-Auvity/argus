"""Inputs of portfolio optimisation: daily returns in a common currency, expected returns, covariance.

Estimation error dominates mean-variance optimisation (Michaud, 1989; DeMiguel et al., 2009). Two classical
remedies are implemented:
  * expected returns shrunk toward the cross-sectional mean (James-Stein / Jorion, 1986);
  * covariance shrunk toward a scaled identity (Ledoit & Wolf, 2004), with the optimal intensity
        delta* = min(1, pi_hat / (gamma_hat))   estimated from the data.
All quantities are annualised with 252 trading days.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def daily_closes(history: pd.DataFrame) -> pd.Series:
    """One close per calendar day (the stored history mixes daily closes and intraday snapshots)."""
    s = pd.Series(history["close"].astype(float).to_numpy(), index=pd.to_datetime(history["date"], utc=True).dt.date)
    return s[~s.index.duplicated(keep="last")]


def returns_in_base(closes: dict[str, pd.Series], currencies: dict[str, str], fx_eurusd: pd.Series | None,
                    base: str = "EUR") -> pd.DataFrame:
    """Daily simple returns of each asset converted to the base currency, on the dates where all are observed.

    A USD asset seen by a EUR investor: P_EUR = P_USD / EURUSD, so its EUR return includes the currency move.
    """
    prices = {}
    for t, s in closes.items():
        ccy = currencies.get(t, base)
        if ccy != base:
            if fx_eurusd is None or base != "EUR" or ccy != "USD":
                raise ValueError(f"no conversion {ccy} -> {base}")
            fx = fx_eurusd.reindex(s.index).ffill()
            s = s / fx
        prices[t] = s
    frame = pd.DataFrame(prices).sort_index().dropna()
    return frame.pct_change().dropna()


@dataclass(frozen=True)
class Estimates:
    tickers: list[str]
    mu: np.ndarray          # annualised expected returns
    cov: np.ndarray         # annualised covariance
    mean_method: str
    cov_method: str
    shrinkage: float        # covariance shrinkage intensity (0 = sample)
    mean_shrinkage: float   # James-Stein weight on the grand mean (0 = sample means)


def ledoit_wolf(returns: np.ndarray) -> tuple[np.ndarray, float]:
    """Ledoit-Wolf (2004) shrinkage of the sample covariance toward m I, m = average variance (daily units)."""
    X = returns - returns.mean(axis=0)
    n, p = X.shape
    S = X.T @ X / n
    m = np.trace(S) / p
    F = m * np.eye(p)
    d2 = np.sum((S - F) ** 2) / p                                     # dispersion of S around the target
    b_bar2 = sum(np.sum((np.outer(x, x) - S) ** 2) for x in X) / (n * n * p)
    b2 = min(b_bar2, d2)
    delta = b2 / d2 if d2 > 0 else 1.0
    return delta * F + (1 - delta) * S, float(delta)


def estimate(returns: pd.DataFrame, mean_method: str = "sample", cov_method: str = "ledoit-wolf") -> Estimates:
    R = returns.to_numpy(float)
    n, p = R.shape
    if n < p + 2:
        raise ValueError("not enough observations for the number of assets")
    sample_mu = R.mean(axis=0)
    if cov_method == "ledoit-wolf":
        cov_d, delta = ledoit_wolf(R)
    else:
        cov_d, delta = np.cov(R, rowvar=False, ddof=1), 0.0
    w_js = 0.0
    if mean_method == "shrunk":
        # James-Stein toward the grand mean: w = min(1, (p - 2) / (n (mu - mu0)' S^-1 (mu - mu0)))
        target = np.full(p, sample_mu.mean())
        diff = sample_mu - target
        q = n * diff @ np.linalg.solve(cov_d, diff)
        w_js = float(min(1.0, max(0.0, (p - 2) / q))) if q > 0 else 1.0
        mu_d = w_js * target + (1 - w_js) * sample_mu
    elif mean_method == "zero":
        mu_d = np.zeros(p)
    else:
        mu_d = sample_mu
    return Estimates(list(returns.columns), mu_d * TRADING_DAYS, cov_d * TRADING_DAYS, mean_method, cov_method,
                     delta, w_js)
