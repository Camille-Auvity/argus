"""Real-world probability P vs risk-neutral probability Q for the terminal price S_T of a real stock.

  * Black-Scholes world: under P, ln S_T ~ N(ln S0 + (mu - q - sigma^2/2) T, sigma^2 T); under Q, mu is replaced by r.
    Girsanov changes the drift, not the volatility: dQ/dP = exp(-lambda W_T - lambda^2 T / 2), lambda = (mu - r) / sigma
    is the market price of risk. Mean S0 e^{(mu-q)T} > median S0 e^{(mu-q-sigma^2/2)T} > mode S0 e^{(mu-q-3sigma^2/2)T}.
  * Market's Q: Breeden-Litzenberger (1978). The call price C(K) = D E_Q[(S_T - K)^+] gives
        Q(S_T <= K) = 1 + (1/D) dC/dK,        q(K) = (1/D) d^2C/dK^2,
    computed by finite differences on the fitted SVI smile. The skew fattens the left tail of q relative to the
    lognormal of the same ATM vol: crashes are expensive in the risk-neutral world.
  * Pricing kernel: the ratio q / p (risk-neutral over real-world density) is the state-price density up to the
    discount factor. Decreasing in S_T: a unit of payoff in the bad states costs more than its probability.
"""

from __future__ import annotations

import math
from typing import Callable

import numpy as np
from scipy.stats import norm

QUANTILES = (0.05, 0.25, 0.5, 0.75, 0.95)


# ----------------------------------------------------------------------------- lognormal laws

def lognormal_stats(S0: float, drift: float, q: float, sigma: float, T: float, levels=(1.0, 0.9, 0.8)) -> dict:
    """Mean, median, mode, quantiles of S_T for a GBM with total drift `drift` (mu under P, r under Q)."""
    m = math.log(S0) + (drift - q - 0.5 * sigma**2) * T
    s = sigma * math.sqrt(T)
    return {
        "mean": S0 * math.exp((drift - q) * T), "median": math.exp(m), "mode": math.exp(m - s * s),
        "quantiles": {f"{p:.2f}": math.exp(m + s * norm.ppf(p)) for p in QUANTILES},
        "prob_below": {f"{lv:.2f}": float(norm.cdf((math.log(lv * S0) - m) / s)) for lv in levels},
        "sd": S0 * math.exp((drift - q) * T) * math.sqrt(math.exp(s * s) - 1),
    }


def lognormal_pdf(K, S0: float, drift: float, q: float, sigma: float, T: float):
    K = np.asarray(K, float)
    m = math.log(S0) + (drift - q - 0.5 * sigma**2) * T
    s = sigma * math.sqrt(T)
    return norm.pdf((np.log(K) - m) / s) / (K * s)


# ----------------------------------------------------------------------------- Breeden-Litzenberger

def _bs_call_forward(F, K, T, vol, D):
    sq = vol * math.sqrt(T) if np.ndim(vol) == 0 else vol * np.sqrt(T)
    d1 = (np.log(F / K) + 0.5 * sq * sq) / sq
    return D * (F * norm.cdf(d1) - K * norm.cdf(d1 - sq))


def risk_neutral_density(vol_of_strike: Callable, F: float, T: float, D: float, K_min: float, K_max: float,
                         n: int = 1201) -> dict:
    """Risk-neutral density and CDF of S_T from the call prices of a smile (Breeden-Litzenberger).

    `vol_of_strike(K)` returns the Black implied vol at strike K for maturity T; F is the forward, D the discount
    factor. Uniform strike grid; negative densities (butterfly arbitrage in the smile) are reported, then clipped."""
    K = np.linspace(K_min, K_max, n)
    h = K[1] - K[0]
    vol = np.asarray(vol_of_strike(K), float)
    C = _bs_call_forward(F, K, T, vol, D)
    dC = np.gradient(C, h)
    d2C = np.zeros_like(C)
    d2C[1:-1] = (C[2:] - 2 * C[1:-1] + C[:-2]) / (h * h)
    d2C[0], d2C[-1] = d2C[1], d2C[-2]
    dens = d2C / D
    negative_mass = max(-_trapezoid(np.minimum(dens, 0.0), K), 0.0)
    dens = np.maximum(dens, 0.0)
    cdf = np.clip(1.0 + dC / D, 0.0, 1.0)
    cdf = np.maximum.accumulate(cdf)
    # mean: E[S_T] = int_0^inf Q(S_T > K) dK, the mass below K_min (a few 1e-12) counted at K_min
    mean = K[0] * (1 - cdf[0]) + _trapezoid(1 - cdf, K)
    return {"K": K, "density": dens, "cdf": cdf, "vol": vol, "mass": float(_trapezoid(dens, K)), "mean": mean,
            "negative_mass": negative_mass, "below_grid": float(cdf[0]), "above_grid": float(1 - cdf[-1])}


def _trapezoid(y, x) -> float:
    y, x = np.asarray(y, float), np.asarray(x, float)
    if len(x) < 2:
        return 0.0
    return float(np.sum(0.5 * (y[1:] + y[:-1]) * np.diff(x)))


def density_stats(rn: dict, S0: float, levels=(1.0, 0.9, 0.8)) -> dict:
    K, cdf, dens = rn["K"], rn["cdf"], rn["density"]
    quant = lambda p: float(np.interp(p, cdf, K))  # noqa: E731  (cdf made non-decreasing)
    return {
        "mean": rn["mean"], "median": quant(0.5), "mode": float(K[int(np.argmax(dens))]),
        "quantiles": {f"{p:.2f}": quant(p) for p in QUANTILES},
        "prob_below": {f"{lv:.2f}": float(np.interp(lv * S0, K, cdf)) for lv in levels},
        "sd": float(math.sqrt(max(_trapezoid((K - rn["mean"]) ** 2 * dens, K), 0.0))),
    }


# ----------------------------------------------------------------------------- real-world drift

def historical_drift(closes: np.ndarray, periods_per_year: float = 252.0) -> dict:
    """Annualised arithmetic drift and vol of the price from daily closes, with the standard error of the drift."""
    lr = np.diff(np.log(np.asarray(closes, float)))
    n = len(lr)
    sigma = float(lr.std(ddof=1) * math.sqrt(periods_per_year))
    years = n / periods_per_year
    mu = float(lr.mean() * periods_per_year + 0.5 * sigma**2)
    return {"mu": mu, "sigma": sigma, "years": years, "n": n, "se": sigma / math.sqrt(years)}


def beta(asset: np.ndarray, market: np.ndarray) -> float:
    a, m = np.asarray(asset, float), np.asarray(market, float)
    return float(np.cov(a, m, ddof=1)[0, 1] / np.var(m, ddof=1))


def empirical_terminal(closes: np.ndarray, S0: float, horizon_days: int) -> np.ndarray:
    """S0 times the overlapping `horizon_days` gross returns of the history (a model-free, very autocorrelated P)."""
    c = np.asarray(closes, float)
    if len(c) <= horizon_days + 20:
        return np.array([])
    return S0 * c[horizon_days:] / c[:-horizon_days]


# ----------------------------------------------------------------------------- the lab

def compare_measures(S0: float, T: float, r: float, q: float, mu: float, sigma: float, vol_of_strike: Callable,
                     empirical: np.ndarray | None = None, vol_at: Callable | None = None,
                     horizons: np.ndarray | None = None) -> dict:
    """S_T under P (GBM, drift mu), under Q (GBM, drift r) and under the market's Q (SVI smile, Breeden-Litzenberger).

    sigma is the ATM implied vol used for both lognormals (Girsanov: same vol). `vol_at(T)` returns a
    vol_of_strike function for another maturity (for the quantile fan)."""
    D = math.exp(-r * T)
    F = S0 * math.exp((r - q) * T)
    s = sigma * math.sqrt(T)
    K_min = max(F * math.exp(-12 * s), 0.02 * S0)
    K_max = F * math.exp(6 * s)
    rn = risk_neutral_density(vol_of_strike, F, T, D, K_min, K_max, n=2001)
    K = rn["K"]
    pP = lognormal_pdf(K, S0, mu, q, sigma, T)
    pQ = lognormal_pdf(K, S0, r, q, sigma, T)
    stats = {"P": lognormal_stats(S0, mu, q, sigma, T), "Q": lognormal_stats(S0, r, q, sigma, T),
             "Q_smile": density_stats(rn, S0)}
    if empirical is not None and len(empirical) > 30:
        e = np.sort(empirical)
        stats["P_empirical"] = {
            "mean": float(e.mean()), "median": float(np.median(e)), "mode": None,
            "quantiles": {f"{p:.2f}": float(np.quantile(e, p)) for p in QUANTILES},
            "prob_below": {f"{lv:.2f}": float((e < lv * S0).mean()) for lv in (1.0, 0.9, 0.8)},
            "sd": float(e.std(ddof=1)), "n": int(len(e))}

    lam = (mu - r) / sigma
    # pricing kernel where the real-world density is not negligible
    keep = (pP > 1e-2 * pP.max()) & (rn["density"] > 1e-3 * rn["density"].max())
    kernel = {"K": K[keep][::4].tolist(), "smile": (rn["density"][keep] / pP[keep])[::4].tolist(),
              "lognormal": (pQ[keep] / pP[keep])[::4].tolist()}

    fan = None
    if vol_at is not None:
        hs = np.linspace(T / 12, T, 12) if horizons is None else np.asarray(horizons, float)
        rows = []
        for h in hs:
            row = {"T": float(h)}
            for key, drift in (("P", mu), ("Q", r)):
                st = lognormal_stats(S0, drift, q, sigma, float(h))
                row[key] = [st["quantiles"][f"{p:.2f}"] for p in QUANTILES]
            Fh = S0 * math.exp((r - q) * h)
            sh = sigma * math.sqrt(h)
            rh = risk_neutral_density(vol_at(float(h)), Fh, float(h), math.exp(-r * h), max(Fh * math.exp(-12 * sh), 0.02 * S0),
                                      Fh * math.exp(6 * sh), n=801)
            row["Q_smile"] = [float(np.interp(p, rh["cdf"], rh["K"])) for p in QUANTILES]
            rows.append(row)
        fan = {"quantiles": list(QUANTILES), "rows": [{"T": 0.0, "P": [S0] * 5, "Q": [S0] * 5, "Q_smile": [S0] * 5}] + rows}

    step = max(1, len(K) // 300)
    out = {
        "S0": S0, "T": T, "r": r, "q": q, "mu": mu, "sigma": sigma, "forward": F, "market_price_of_risk": lam,
        "density": {"K": K[::step].tolist(), "P": pP[::step].tolist(), "Q": pQ[::step].tolist(),
                    "Q_smile": rn["density"][::step].tolist(), "smile_vol": rn["vol"][::step].tolist()},
        "checks": {"mass": rn["mass"], "mean": rn["mean"], "forward": F, "negative_mass": rn["negative_mass"],
                   "below_grid": rn["below_grid"], "above_grid": rn["above_grid"]},
        "stats": stats, "kernel": kernel, "fan": fan,
    }
    if empirical is not None and len(empirical) > 30:
        counts, edges = np.histogram(empirical, bins=40)
        width = np.diff(edges)
        out["empirical_hist"] = {"edges": edges.tolist(), "density": (counts / (counts.sum() * width)).tolist()}
    return out
