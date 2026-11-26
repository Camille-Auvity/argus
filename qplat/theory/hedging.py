"""Discrete delta hedging of a Black-Scholes option: from the binomial replication to continuous time.

A dealer sells one option at the Black-Scholes price with implied vol sigma_i and rebalances a delta hedge n times
until expiry. The stock follows a GBM under the REAL-WORLD measure (drift mu, volatility sigma_r).

  * sigma_r = sigma_i: the hedging error has mean ~ 0 whatever mu (the option price does not depend on mu: it is
    the replication cost) and a standard deviation that decreases like 1/sqrt(n): with a continuous hedge
    (quadratic variation (dS)^2 = sigma^2 S^2 dt) the error vanishes. Derman & Kamal's approximation:
        sd(P&L) ~ sqrt(pi / 4) * vega * sigma / sqrt(n)
  * sigma_r != sigma_i: over each step the hedged short position earns ~ 1/2 Gamma S^2 (sigma_i^2 dt - (dS/S)^2):
    theta paid by the option buyer against gamma losses. Hedging at the implied vol gives a path-dependent P&L
    of mean ~ 1/2 int Gamma S^2 (sigma_i^2 - sigma_r^2) dt; hedging at the realised vol locks in
    BS(sigma_i) - BS(sigma_r) (Carr, 2005; Ahmad & Wilmott, 2005).
"""

from __future__ import annotations

import math

import numpy as np
from scipy.stats import norm


def bs_value_delta_gamma(S, K, tau, r, q, vol, phi):
    """Vectorised Black-Scholes value, delta and gamma; tau = 0 gives the payoff."""
    S = np.asarray(S, float)
    tau = np.maximum(tau, 0.0)
    if np.all(tau == 0):
        payoff = np.maximum(phi * (S - K), 0.0)
        delta = np.where(phi * (S - K) > 0, float(phi), 0.0)
        return payoff, delta, np.zeros_like(S)
    sq = vol * np.sqrt(tau)
    d1 = (np.log(S / K) + (r - q + 0.5 * vol * vol) * tau) / sq
    d2 = d1 - sq
    value = phi * (S * np.exp(-q * tau) * norm.cdf(phi * d1) - K * np.exp(-r * tau) * norm.cdf(phi * d2))
    delta = phi * np.exp(-q * tau) * norm.cdf(phi * d1)
    gamma = np.exp(-q * tau) * norm.pdf(d1) / (S * sq)
    return value, delta, gamma


def bs_vega(S, K, tau, r, q, vol):
    d1 = (math.log(S / K) + (r - q + 0.5 * vol * vol) * tau) / (vol * math.sqrt(tau))
    return S * math.exp(-q * tau) * norm.pdf(d1) * math.sqrt(tau)


def simulate_hedge(S0: float, K: float, T: float, r: float, q: float, sigma_implied: float, sigma_real: float,
                   mu: float, n_rebalance: int, n_paths: int = 20_000, option_type: str = "call",
                   hedge_vol: float | None = None, seed: int = 7, keep_path: bool = False) -> dict:
    """Short one option sold at BS(sigma_implied), delta-hedged n times with `hedge_vol` (default: implied).

    Returns the terminal P&L of the hedged short position, discounted to today (per option)."""
    phi = 1 if option_type == "call" else -1
    hv = sigma_implied if hedge_vol is None else hedge_vol
    dt = T / n_rebalance
    rng = np.random.default_rng(seed)
    z = rng.standard_normal((n_paths, n_rebalance))
    log_steps = (mu - q - 0.5 * sigma_real**2) * dt + sigma_real * math.sqrt(dt) * z    # real-world GBM, total return mu
    S = np.empty((n_paths, n_rebalance + 1))
    S[:, 0] = S0
    S[:, 1:] = S0 * np.exp(np.cumsum(log_steps, axis=1))

    premium, _, _ = bs_value_delta_gamma(S0, K, T, r, q, sigma_implied, phi)
    _, delta, gamma = bs_value_delta_gamma(np.full(n_paths, S0), K, T, r, q, hv, phi)
    cash = premium - delta * S0
    gamma_theta = np.zeros(n_paths)
    path = {"spot": [S0], "delta": [float(delta[0])], "pnl": [0.0], "gamma_theta": [0.0]} if keep_path else None
    for k in range(1, n_rebalance + 1):
        tau = T - k * dt
        Sk = S[:, k]
        # dividends received on the shares held, interest on the cash
        cash = cash * math.exp(r * dt) + delta * S[:, k - 1] * (math.exp(q * dt) - 1)
        ret = Sk / S[:, k - 1] - 1
        # gamma-theta approximation of the step P&L of the hedged short (at the implied vol, as seen by the seller)
        gamma_theta += 0.5 * gamma * S[:, k - 1] ** 2 * (sigma_implied**2 * dt - ret**2) * math.exp(-r * k * dt)
        new_value, new_delta, new_gamma = bs_value_delta_gamma(Sk, K, tau, r, q, hv, phi)
        if keep_path:
            mtm = cash[0] + delta[0] * Sk[0] - bs_value_delta_gamma(Sk[:1], K, tau, r, q, sigma_implied, phi)[0][0]
            path["spot"].append(float(Sk[0]))
            path["delta"].append(float(new_delta[0]))
            path["pnl"].append(float(mtm * math.exp(-r * k * dt)))
            path["gamma_theta"].append(float(gamma_theta[0]))
        if k < n_rebalance:
            cash -= (new_delta - delta) * Sk
            delta, gamma = new_delta, new_gamma
    payoff = np.maximum(phi * (S[:, -1] - K), 0.0)
    pnl = (cash + delta * S[:, -1] - payoff) * math.exp(-r * T)
    out = {"pnl": pnl, "premium": float(premium), "gamma_theta": gamma_theta,
           "vega": bs_vega(S0, K, T, r, q, sigma_implied)}
    if keep_path:
        out["path"] = path
    return out


def derman_kamal_sd(S0, K, T, r, q, sigma, n_rebalance) -> float:
    """Approximate standard deviation of the discrete hedging error: sqrt(pi/4) vega sigma / sqrt(n)."""
    return math.sqrt(math.pi / 4) * bs_vega(S0, K, T, r, q, sigma) * sigma / math.sqrt(n_rebalance)


def backtest_short_options(closes: np.ndarray, dates: list[str], implied: np.ndarray, r: float, q: float,
                           horizon: int = 21, moneyness: float = 1.0, option_type: str = "call") -> list[dict]:
    """Sell, every `horizon` trading days, an option of `horizon` days at the implied vol of that day, delta-hedge
    it daily with the actual closes until expiry. P&L per option as a percentage of the initial spot."""
    phi = 1 if option_type == "call" else -1
    out = []
    dt = 1 / 252
    for start in range(0, len(closes) - horizon, horizon):
        S = closes[start:start + horizon + 1]
        vol = float(implied[start])
        K = S[0] * moneyness
        T = horizon * dt
        premium, delta, gamma = bs_value_delta_gamma(np.array([S[0]]), K, T, r, q, vol, phi)
        cash = premium[0] - delta[0] * S[0]
        d, g = delta[0], gamma[0]
        gamma_theta = 0.0
        for k in range(1, horizon + 1):
            cash = cash * math.exp(r * dt) + d * S[k - 1] * (math.exp(q * dt) - 1)
            ret = S[k] / S[k - 1] - 1
            gamma_theta += 0.5 * g * S[k - 1] ** 2 * (vol**2 * dt - ret**2)
            if k < horizon:
                _, nd, ng = bs_value_delta_gamma(np.array([S[k]]), K, T - k * dt, r, q, vol, phi)
                cash -= (nd[0] - d) * S[k]
                d, g = nd[0], ng[0]
        pnl = cash + d * S[-1] - max(phi * (S[-1] - K), 0.0)
        rv = math.sqrt(252 * np.mean(np.diff(np.log(S)) ** 2))
        out.append({"date": dates[start], "spot": float(S[0]), "implied": vol, "realized": rv,
                    "premium_pct": float(premium[0] / S[0]), "pnl_pct": float(pnl / S[0]),
                    "gamma_theta_pct": float(gamma_theta / S[0])})
    return out
