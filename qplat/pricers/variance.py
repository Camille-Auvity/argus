"""Variance and volatility swaps.

A variance swap pays N_var (sigma_R^2 - K_var) at T, with the realised variance of daily log returns

    sigma_R^2 = (252 / n) sum_i ln^2(S_i / S_{i-1})          (no mean subtracted: market convention)

Fair strike by static replication (Demeterfi, Derman, Kamal & Zou, 1999). For a continuous price path,
the realised variance is (2/T)[int dS/S - ln(S_T/S_0)]: a delta-hedged log contract. The log contract is a
strip of out-of-the-money options weighted by 1/K^2, so with F the forward and P(0,T) the discount factor

    K_var = 2 / (T P(0,T)) [ int_0^F Put(K) / K^2 dK + int_F^inf Call(K) / K^2 dK ]

This is model-free (given continuous paths): only today's smile enters. The CBOE VIX applies the same formula
to listed strikes; vols are quoted in vol points (100 x sigma), variance notional N_var = N_vega / (2 K_vol).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Callable

import numpy as np
import pandas as pd
from scipy.stats import norm

TRADING_DAYS = 252


def _trapezoid(y: np.ndarray, x: np.ndarray) -> float:
    """Trapezoidal rule (np.trapz / np.trapezoid differ between numpy 1 and 2, Pyodide ships numpy 1)."""
    return float(np.sum(0.5 * (y[1:] + y[:-1]) * np.diff(x)))


# ----------------------------------------------------------------------------- realised variance

def realized_variance(closes, annualization: int = TRADING_DAYS) -> float:
    """Annualised realised variance of daily log returns, zero mean (variance-swap convention)."""
    c = np.asarray(closes, dtype=float)
    r = np.diff(np.log(c))
    return float(annualization * np.mean(r * r)) if len(r) else float("nan")


# ----------------------------------------------------------------------------- replication on a smile

def _black_forward(F: float, K: np.ndarray, T: float, vol: np.ndarray, phi: np.ndarray) -> np.ndarray:
    """Undiscounted Black price (on the forward)."""
    sq = vol * math.sqrt(T)
    d1 = (np.log(F / K) + 0.5 * sq * sq) / sq
    return phi * (F * norm.cdf(phi * d1) - K * norm.cdf(phi * (d1 - sq)))


@dataclass(frozen=True)
class Replication:
    variance: float           # K_var (annualised variance, as a fraction)
    k: np.ndarray             # log-moneyness grid ln(K/F)
    density: np.ndarray       # contribution to K_var per unit of k: (2/T) OTM_fwd(K) / K
    put_share: float          # share of K_var coming from puts (K < F)

    @property
    def vol(self) -> float:
        return math.sqrt(self.variance)


def replicate_variance(vol_of_k: Callable[[np.ndarray], np.ndarray], T: float, F: float,
                       width: float = 10.0, n: int = 4001) -> Replication:
    """K_var from an implied vol smile sigma(k), k = ln(K/F), by integration over k (dK / K^2 = e^{-k} dk / F).

    The grid spans +- `width` ATM standard deviations, far enough for the OTM prices to vanish.
    """
    atm = float(np.asarray(vol_of_k(np.array([0.0])))[0])
    span = width * max(atm, 0.05) * math.sqrt(T)
    k = np.linspace(-span, span, n)
    K = F * np.exp(k)
    vol = np.asarray(vol_of_k(k), dtype=float)
    phi = np.where(k < 0, -1.0, 1.0)
    otm = _black_forward(F, K, T, vol, phi)
    density = 2.0 / T * otm / K            # (2/T) OTM(K)/K^2 dK  ==  (2/T) OTM(K)/K dk
    variance = _trapezoid(density, k)
    put = _trapezoid(np.where(k < 0, density, 0.0), k)
    return Replication(variance, k, density, put / variance if variance > 0 else float("nan"))


# ----------------------------------------------------------------------------- CBOE VIX methodology on listed strikes

@dataclass(frozen=True)
class ListedReplication:
    variance: float
    T: float
    forward: float
    k0: float
    strikes: np.ndarray
    contributions: np.ndarray   # (2/T) e^{rT} dK Q(K) / K^2 per strike
    n_strikes: int


def listed_variance(chain: pd.DataFrame, T: float, r: float, spot: float | None = None) -> ListedReplication:
    """CBOE VIX formula for one expiry: sigma^2 = (2/T) sum dK/K^2 e^{rT} Q(K) - (1/T)(F/K0 - 1)^2.

    `chain` has columns strike, option_type, bid, ask; only quotes with bid > 0 and ask >= bid are used. F from
    put-call parity (median of the implied forwards within 10% of spot), K0 the first strike below F, Q the out-of-the-money mid (average of call and put at K0), and the
    strike strip stops after two consecutive zero bids, as in the CBOE white paper.
    """
    c = chain[(chain["bid"] > 0) & (chain["ask"] >= chain["bid"])]
    c = c.assign(mid=(c["bid"] + c["ask"]) / 2)
    calls = c[c.option_type == "call"].drop_duplicates("strike").set_index("strike")
    puts = c[c.option_type == "put"].drop_duplicates("strike").set_index("strike")
    both = calls.index.intersection(puts.index)
    if len(both) < 3:
        raise ValueError("not enough strikes quoted on both sides")
    growth = math.exp(r * T)
    gap = calls.loc[both, "mid"] - puts.loc[both, "mid"]
    implied_fwd = both.to_numpy(float) + growth * gap.to_numpy(float)
    # forward: median of the put-call parity forwards near the money (robust to stale far-strike quotes);
    # the CBOE rule (strike minimising |C - P|) is the fallback
    near = np.abs(both.to_numpy(float) / spot - 1) < 0.1 if spot else np.zeros(len(both), bool)
    F = float(np.median(implied_fwd[near])) if near.sum() >= 3 else float(implied_fwd[np.argmin(np.abs(gap.to_numpy()))])
    below = [k for k in sorted(set(calls.index) | set(puts.index)) if k <= F]
    if not below:
        raise ValueError("no strike below the forward")
    k0 = max(below)

    def strip(side: pd.DataFrame, ks: list[float]) -> list[tuple[float, float]]:
        out, zeros = [], 0
        for k in ks:
            bid = float(side.loc[k, "bid"]) if k in side.index else 0.0
            if bid <= 0:
                zeros += 1
                if zeros >= 2:
                    break
                continue
            zeros = 0
            out.append((k, float(side.loc[k, "mid"])))
        return out

    put_side = strip(puts, sorted([k for k in puts.index if k < k0], reverse=True))
    call_side = strip(calls, sorted([k for k in calls.index if k > k0]))
    if k0 in both:
        q0 = 0.5 * (float(puts.loc[k0, "mid"]) + float(calls.loc[k0, "mid"]))
    else:
        q0 = float(puts.loc[k0, "mid"] if k0 in puts.index else calls.loc[k0, "mid"])
    pts = sorted(put_side + [(k0, q0)] + call_side)
    K = np.array([p[0] for p in pts])
    Q = np.array([p[1] for p in pts])
    dK = np.empty_like(K)
    dK[1:-1] = (K[2:] - K[:-2]) / 2
    dK[0], dK[-1] = K[1] - K[0], K[-1] - K[-2]
    contrib = 2.0 / T * growth * dK * Q / K**2
    variance = float(contrib.sum() - (F / k0 - 1.0) ** 2 / T)
    return ListedReplication(variance, T, F, k0, K, contrib, len(K))


def vix_from_chain(chain: pd.DataFrame, asof: pd.Timestamp, rate_of_T: Callable[[float], float],
                   target_days: int = 30, min_strikes: int = 40) -> dict | None:
    """30-day model-free implied vol (VIX methodology) from a full option chain: the two expiries around 30 days
    (at least 7 days out), total variances interpolated linearly in time."""
    asof = pd.Timestamp(asof).tz_localize(None) if pd.Timestamp(asof).tzinfo else pd.Timestamp(asof)
    spot = float(chain["spot"].dropna().iloc[0]) if "spot" in chain and chain["spot"].notna().any() else None
    valid = chain[(chain["bid"] > 0) & (chain["ask"] >= chain["bid"])]
    counts = valid.groupby("expiry").strike.nunique()
    # an expiry needs a real strip of quotes (after-hours snapshots can be almost empty)
    days = {e: (pd.Timestamp(e) - asof.normalize()).days for e in counts[counts >= min_strikes].index}
    eligible = sorted((d, e) for e, d in days.items() if d >= 7)
    near = [x for x in eligible if x[0] <= target_days]
    nxt = [x for x in eligible if x[0] > target_days]
    if not near or not nxt:
        return None
    (d1, e1), (d2, e2) = near[-1], nxt[0]
    out = []
    for d, e in ((d1, e1), (d2, e2)):
        T = d / 365.0
        out.append(listed_variance(chain[chain.expiry == e], T, rate_of_T(T), spot))
    a, b = out
    w = (d2 - target_days) / (d2 - d1)
    var30 = (a.T * a.variance * w + b.T * b.variance * (1 - w)) * 365.0 / target_days
    return {"vix": 100 * math.sqrt(max(var30, 0.0)), "near_days": d1, "next_days": d2,
            "near_strikes": a.n_strikes, "next_strikes": b.n_strikes}


# ----------------------------------------------------------------------------- models

def heston_expected_variance(v0: float, kappa: float, theta: float, T: float) -> float:
    """E[(1/T) int_0^T v_t dt] = theta + (v0 - theta)(1 - e^{-kappa T}) / (kappa T)."""
    return theta + (v0 - theta) * (1.0 - math.exp(-kappa * T)) / (kappa * T)


def heston_realized_variance_mc(v0: float, kappa: float, theta: float, sigma: float, T: float,
                                n_paths: int = 50_000, steps_per_year: int = 252, seed: int = 5) -> np.ndarray:
    """Samples of the integrated variance (1/T) int v dt (full-truncation Euler on v)."""
    n = max(int(math.ceil(T * steps_per_year)), 2)
    dt = T / n
    rng = np.random.default_rng(seed)
    v = np.full(n_paths, v0)
    acc = np.zeros(n_paths)
    for _ in range(n):
        vp = np.maximum(v, 0.0)
        acc += vp * dt
        v = v + kappa * (theta - vp) * dt + sigma * np.sqrt(vp * dt) * rng.standard_normal(n_paths)
    return acc / T


def path_realized_variance(paths: np.ndarray, spot: float, T: float) -> np.ndarray:
    """Annualised realised variance of each simulated path sampled on an even grid (n steps over T)."""
    full = np.hstack([np.full((paths.shape[0], 1), spot), paths])
    r = np.diff(np.log(full), axis=1)
    return (r * r).sum(axis=1) / T


def vol_swap_convexity(mean_var: float, var_of_var: float) -> float:
    """Second-order approximation E[sqrt V] ~ sqrt(E V) - Var(V) / (8 E[V]^{3/2})."""
    return math.sqrt(mean_var) - var_of_var / (8.0 * mean_var**1.5)


# ----------------------------------------------------------------------------- contract

@dataclass(frozen=True)
class VarSwapValue:
    variance_notional: float   # per vol point squared
    value: float               # MTM for the variance buyer (long realised variance)
    expected_variance_pts: float
    vega: float                # value change for +1 vol point of implied vol on the remaining period
    payoff_profile: dict       # realised vol (pts) -> payoff, for the variance and the vol swap


def value_variance_swap(vega_notional: float, strike_vol: float, implied_vol_remaining: float, T: float,
                        elapsed: float = 0.0, realized_vol_so_far: float = 0.0, discount: float = 1.0) -> VarSwapValue:
    """MTM of a variance swap (vols in decimals): the expected total variance mixes the realised part and the
    implied part, weighted by time: E[sigma_R^2] = (t/T) RV(0,t) + ((T-t)/T) K_var(t,T)."""
    k_pts = 100 * strike_vol
    n_var = vega_notional / (2 * k_pts)
    w = elapsed / T
    exp_var = w * (100 * realized_vol_so_far) ** 2 + (1 - w) * (100 * implied_vol_remaining) ** 2
    value = discount * n_var * (exp_var - k_pts**2)
    vega = discount * n_var * (1 - w) * 2 * 100 * implied_vol_remaining
    grid = np.linspace(0.3, 2.0, 35) * k_pts
    profile = {"realized_vol": grid.tolist(),
               "variance_swap": (n_var * (grid**2 - k_pts**2)).tolist(),
               "volatility_swap": (vega_notional * (grid - k_pts)).tolist()}
    return VarSwapValue(n_var, value, exp_var, vega, profile)
