"""Applied theory labs: binomial replication and the market maker's hedge, discrete delta hedging."""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Literal, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from qplat.allocation.estimation import daily_closes
from qplat.data.market import VOL_INDEX_TICKERS
from qplat.theory.hedging import backtest_short_options, bs_value_delta_gamma, derman_kamal_sd, simulate_hedge
from qplat.theory.replication import build_tree, market_maker

router = APIRouter(prefix="/api/theory", tags=["theory"])


# ----------------------------------------------------------------------------- binomial replication

class TreeRequest(BaseModel):
    S0: float = Field(100.0, gt=0)
    u: float = Field(1.2, gt=1)
    d: float = Field(0.8, gt=0, lt=1)
    R: float = Field(1.05, gt=0)
    K: float = Field(110.0, gt=0)
    option_type: Literal["call", "put"] = "put"
    steps: int = Field(2, ge=1, le=8)
    american: bool = False
    ask: float = Field(12.0, ge=0)
    path: Optional[str] = Field(None, pattern=r"^[ud]*$")


@router.post("/tree")
def tree(req: TreeRequest):
    """Replication at every node (Delta, B, pi), self-financing check, path probabilities, market maker's hedge."""
    try:
        t = build_tree(req.S0, req.u, req.d, req.R, req.K, req.option_type, req.steps, req.american)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    nodes = [n.__dict__ for level in t.nodes for n in level]
    path = req.path if req.path and len(req.path) == req.steps else "ud" * (req.steps // 2) + "u" * (req.steps % 2)
    return {"pi": t.pi, "price": t.price, "direct_value": t.direct_value() if not req.american else None,
            "nodes": nodes, "steps": req.steps, "market_maker": market_maker(t, path, req.ask)}


# ----------------------------------------------------------------------------- delta hedging (simulation)

class HedgeRequest(BaseModel):
    S0: float = Field(100.0, gt=0)
    K: float = Field(100.0, gt=0)
    T: float = Field(0.25, gt=0.01, le=3)
    r: float = Field(0.03, ge=-0.05, le=0.3)
    q: float = Field(0.0, ge=0, le=0.2)
    sigma_implied: float = Field(0.2, gt=0.01, le=2)
    sigma_real: float = Field(0.2, gt=0.01, le=2)
    mu: float = Field(0.08, ge=-1, le=1)
    n_rebalance: int = Field(52, ge=1, le=1000)
    n_paths: int = Field(10_000, ge=1_000, le=50_000)
    option_type: Literal["call", "put"] = "call"
    hedge_vol: Literal["implied", "realized"] = "implied"


def _hedge(req: HedgeRequest) -> dict:
    hv = req.sigma_implied if req.hedge_vol == "implied" else req.sigma_real
    args = (req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, req.sigma_real)
    main = simulate_hedge(*args, req.mu, req.n_rebalance, req.n_paths, req.option_type, hv, keep_path=True)
    pnl = main["pnl"]
    counts, edges = np.histogram(pnl, bins=50)
    phi = 1 if req.option_type == "call" else -1
    locked = float(bs_value_delta_gamma(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, phi)[0]
                   - bs_value_delta_gamma(req.S0, req.K, req.T, req.r, req.q, req.sigma_real, phi)[0])

    # convergence of the hedging error with the rebalancing frequency (same vol, as in the theory)
    conv = []
    for n in (4, 13, 26, 52, 126, 252):
        o = simulate_hedge(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, req.sigma_implied, req.mu, n,
                           min(req.n_paths, 5_000), req.option_type, seed=11)
        conv.append({"n": n, "sd": float(o["pnl"].std(ddof=1)), "mean": float(o["pnl"].mean()),
                     "derman_kamal": derman_kamal_sd(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, n)})
    # the drift does not matter
    drift = [{"mu": m, "mean": float(simulate_hedge(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied,
                                                    req.sigma_implied, m, 52, 4_000, req.option_type, seed=13)["pnl"].mean())}
             for m in (-0.3, -0.1, 0.0, 0.1, 0.3)]
    # realised vs implied: mean P&L of the seller for each realised vol, hedged at implied or at realised vol
    mismatch = []
    for sr in np.round(np.linspace(0.5, 1.5, 9) * req.sigma_implied, 4):
        a = simulate_hedge(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, float(sr), req.mu, 52, 3_000,
                           req.option_type, seed=17)
        b = simulate_hedge(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, float(sr), req.mu, 52, 3_000,
                           req.option_type, hedge_vol=float(sr), seed=17)
        mismatch.append({"sigma_real": float(sr), "implied_hedge_mean": float(a["pnl"].mean()),
                         "implied_hedge_sd": float(a["pnl"].std(ddof=1)), "realized_hedge_mean": float(b["pnl"].mean()),
                         "realized_hedge_sd": float(b["pnl"].std(ddof=1)),
                         "locked": float(bs_value_delta_gamma(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, phi)[0]
                                         - bs_value_delta_gamma(req.S0, req.K, req.T, req.r, req.q, float(sr), phi)[0])})
    return {
        "premium": main["premium"], "vega": main["vega"],
        "pnl": {"mean": float(pnl.mean()), "sd": float(pnl.std(ddof=1)), "p05": float(np.quantile(pnl, 0.05)),
                "p95": float(np.quantile(pnl, 0.95)), "histogram": {"edges": edges.tolist(), "counts": counts.tolist()}},
        "gamma_theta_mean": float(main["gamma_theta"].mean()),
        "locked": locked,
        "derman_kamal": derman_kamal_sd(req.S0, req.K, req.T, req.r, req.q, req.sigma_implied, req.n_rebalance),
        "path": main["path"], "convergence": conv, "drift": drift, "mismatch": mismatch,
    }


@lru_cache(maxsize=64)
def _hedge_cached(payload: str) -> dict:
    return _hedge(HedgeRequest.model_validate_json(payload))


@router.post("/hedge")
def hedge(req: HedgeRequest):
    """Monte Carlo of a delta-hedged short option: error vs rebalancing, drift independence, vol mismatch."""
    return _hedge_cached(req.model_dump_json())


# ----------------------------------------------------------------------------- real-data backtest

@lru_cache(maxsize=16)
def _backtest(horizon: int, moneyness: float, option_type: str, _stamp: str) -> dict:
    db = services.get_db()
    spy = daily_closes(db.spot_history("SPY"))
    vix = daily_closes(db.spot_history(VOL_INDEX_TICKERS["VIX"]))
    df = pd.DataFrame({"s": spy, "v": vix}).dropna()
    if len(df) < horizon * 3:
        raise HTTPException(409, "historique SPY / VIX insuffisant — lancez le rafraîchissement")
    curve = services.market_curve("USD")
    r = float(curve.zero_rate(horizon / 252)) if curve is not None else 0.0
    meta = db.tickers().set_index("ticker")
    q = float(meta.loc["SPY", "dividend_yield"]) if "SPY" in meta.index and pd.notna(meta.loc["SPY", "dividend_yield"]) else 0.0
    rows = backtest_short_options(df["s"].to_numpy(), [str(x) for x in df.index], df["v"].to_numpy() / 100, r, q,
                                  horizon, moneyness, option_type)
    p = np.array([x["pnl_pct"] for x in rows])
    g = np.array([x["gamma_theta_pct"] for x in rows])
    imp = np.array([x["implied"] for x in rows])
    rv = np.array([x["realized"] for x in rows])
    return {"rows": rows, "rate": r, "dividend_yield": q,
            "summary": {"n": len(rows), "mean_pnl_pct": float(p.mean()), "hit_rate": float((p > 0).mean()),
                        "worst_pct": float(p.min()), "best_pct": float(p.max()),
                        "corr_gamma_theta": float(np.corrcoef(p, g)[0, 1]) if len(p) > 2 else None,
                        "mean_implied": float(imp.mean()), "mean_realized": float(rv.mean())}}


@router.get("/hedge-backtest")
def hedge_backtest(horizon: int = 21, moneyness: float = 1.0, option_type: Literal["call", "put"] = "call"):
    """Sell an option on SPY at the VIX every month, delta-hedge daily with the actual closes, record the P&L."""
    if not 5 <= horizon <= 63 or not 0.8 <= moneyness <= 1.2:
        raise HTTPException(422, "horizon 5-63 jours, moneyness 0,8-1,2")
    db = services.get_db()
    stamp = f"{db.latest_spot('SPY')}|{db.latest_spot(VOL_INDEX_TICKERS['VIX'])}"
    return _backtest(horizon, moneyness, option_type, stamp)


# ----------------------------------------------------------------------------- stochastic calculus and Girsanov

@lru_cache(maxsize=1)
def _brownian() -> dict:
    from qplat.theory.stochastic import ito_sums, martingales, sample_paths, variations

    return {"paths": sample_paths(), "variations": variations(), "ito": ito_sums(), "martingales": martingales()}


@router.get("/brownian")
def brownian():
    """Brownian paths, total vs quadratic variation, Ito vs right-point sums, martingale checks."""
    return _brownian()


@lru_cache(maxsize=32)
def _girsanov(theta: float, T: float) -> dict:
    from qplat.theory.stochastic import girsanov

    return girsanov(theta, T)


@router.get("/girsanov")
def girsanov_view(theta: float = 1.0, T: float = 1.0):
    """Law of B_T under P and under Q (Radon-Nikodym weight exp(theta B_T - theta^2 T / 2))."""
    if not (-3 <= theta <= 3 and 0.1 <= T <= 5):
        raise HTTPException(422, "theta dans [-3, 3], T dans [0,1 ; 5]")
    return _girsanov(round(theta, 4), round(T, 4))


class ImportanceRequest(BaseModel):
    S0: float = Field(100.0, gt=0)
    K: float = Field(150.0, gt=0)
    T: float = Field(0.5, gt=0.01, le=5)
    r: float = Field(0.03, ge=-0.05, le=0.3)
    q: float = Field(0.0, ge=0, le=0.2)
    vol: float = Field(0.2, gt=0.01, le=2)
    product: Literal["call", "put", "digital"] = "call"
    n_paths: int = Field(20_000, ge=1_000, le=100_000)


@lru_cache(maxsize=64)
def _importance(payload: str) -> dict:
    from qplat.theory.stochastic import importance_sampling

    req = ImportanceRequest.model_validate_json(payload)
    return importance_sampling(req.S0, req.K, req.T, req.r, req.q, req.vol, req.product, req.n_paths)


@router.post("/importance")
def importance(req: ImportanceRequest):
    """Plain vs importance-sampled Monte Carlo (Girsanov drift shift) on a far out-of-the-money payoff."""
    return _importance(req.model_dump_json())


# ----------------------------------------------------------------------------- real world P vs risk-neutral Q

@lru_cache(maxsize=32)
def _measures(ticker: str, days: int, mu_source: str, mu_custom: float, asof: str) -> dict:
    from api.routers.models import _market, _surface
    from qplat.theory.measures import beta, compare_measures, empirical_terminal, historical_drift

    _, spot, q, curve = _market(ticker, asof)
    surface = _surface(ticker, asof)
    T = days / 365
    D = float(curve.discount(T))
    r = -math.log(D) / T
    sigma = float(surface.implied_vol(0.0, T))
    db = services.get_db()
    closes = daily_closes(db.spot_history(ticker))
    hist = historical_drift(closes.to_numpy())
    # CAPM: mu = r + beta * equity premium, the premium from the Fama-French market factor since 1926
    f = db.factors()
    erp = float(f["mkt_rf"].mean() * 252) if not f.empty else 0.06
    spy = daily_closes(db.spot_history("SPY"))
    both = pd.DataFrame({"a": closes, "m": spy}).dropna()
    b = 1.0 if ticker == "SPY" or len(both) < 60 else beta(np.diff(np.log(both["a"])), np.diff(np.log(both["m"])))
    candidates = {"history": hist["mu"] + q, "capm": r + b * erp, "custom": mu_custom}
    mu = float(candidates[mu_source])
    emp = empirical_terminal(closes.to_numpy(), spot, max(1, round(days * 252 / 365)))
    out = compare_measures(spot, T, r, q, mu, sigma, lambda K: surface.implied_vol_strike(K, T),
                           empirical=emp, vol_at=lambda h: (lambda K: surface.implied_vol_strike(K, h)))
    out.update({"ticker": ticker, "asof": asof, "days": days, "mu_source": mu_source,
                "drift": {"history": candidates["history"], "history_se": hist["se"], "history_years": hist["years"],
                          "realized_vol": hist["sigma"], "capm": candidates["capm"], "beta": b, "equity_premium": erp,
                          "custom": mu_custom},
                "last_expiry_days": int(round(float(surface.times[-1]) * 365))})
    return out


@router.get("/measures/{ticker}")
def measures(ticker: str, days: int = 91, mu_source: Literal["history", "capm", "custom"] = "capm", mu: float = 0.08):
    """S_T under the real-world P (GBM with drift mu), the risk-neutral Q (drift r) and the market's Q
    (Breeden-Litzenberger on the SVI smile); quantile fan and pricing kernel."""
    from api.routers.models import _chain_version

    if not 7 <= days <= 730 or not -1 <= mu <= 1:
        raise HTTPException(422, "horizon 7-730 jours, μ dans [-100 %, 100 %]")
    return _measures(ticker, days, mu_source, round(mu, 4), _chain_version(ticker))


# ----------------------------------------------------------------------------- Ornstein-Uhlenbeck and Vasicek

VASICEK_SERIES = {"USD": "USD_3M", "EUR": "EUR_3M"}
VASICEK_STARTS = {"USD": (1990, 2000, 2009, 2016), "EUR": (2004, 2009, 2016)}
VASICEK_FREQ = {"monthly": ("ME", 1 / 12), "weekly": ("W-FRI", 1 / 52), "daily": (None, 1 / 252)}
VASICEK_TENORS = np.array([0.25, 0.5, 1, 2, 3, 5, 7, 10, 15, 20, 30], dtype=float)


def _short_rate_series(currency: str) -> pd.Series:
    """Continuously compounded 3-month rate: Treasury bills are quoted as simple yields (ACT/365F accrual,
    like the deposits of the curve bootstrap), the ECB rate is already continuous."""
    s = services.get_db().short_rates(VASICEK_SERIES[currency])
    if s.empty:
        return s
    s.index = pd.to_datetime(s.index)
    return np.log1p(s * 0.25) / 0.25 if currency == "USD" else s


def _sample(s: pd.Series, freq: str) -> pd.Series:
    """Last observation of each month / week, kept at its actual date (daily: every observation)."""
    s = s.dropna()
    period = {"monthly": "M", "weekly": "W-FRI"}.get(freq)
    return s.groupby(s.index.to_period(period)).tail(1) if period else s


@lru_cache(maxsize=32)
def _vasicek(currency: str, start: int, freq: str, version: str) -> dict:
    from qplat.theory.vasicek import (calibrate_vasicek, estimate_ou, estimator_distribution, long_yield, ou_mean,
                                      ou_var, prob_negative, stationary_sd, vasicek_forward, vasicek_yield)

    raw = _short_rate_series(currency)
    dt = VASICEK_FREQ[freq][1]
    s = _sample(raw[raw.index.year >= start], freq)
    try:
        est = estimate_ou(s.to_numpy(), dt)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    e = est.to_dict()
    if est.mean_reverting:
        e["stationary_sd"] = stationary_sd(est.kappa, est.sigma)
        e["prob_negative_stationary"] = prob_negative(est.kappa, est.theta, est.sigma)

    windows = []
    for w in VASICEK_STARTS[currency]:
        sw = _sample(raw[raw.index.year >= w], freq)
        ew = estimate_ou(sw.to_numpy(), dt)
        windows.append({"start": w, "first": sw.index[0].strftime("%Y-%m-%d"), "n": ew.n, "mean": float(sw.mean()),
                        "mean_reverting": ew.mean_reverting, "b": ew.b, "se_b": ew.se_b,
                        **{k: (v if ew.mean_reverting else None) for k, v in
                           (("kappa", ew.kappa), ("theta", ew.theta), ("sigma", ew.sigma), ("half_life", ew.half_life))},
                        "half_life_high": None if not ew.mean_reverting or not math.isfinite(ew.half_life_high) else ew.half_life_high})

    # Monte Carlo of the estimator, the estimated parameters taken as the truth
    sims = None
    if est.mean_reverting:
        dist = estimator_distribution(float(s.iloc[0]), est.kappa, est.theta, est.sigma, dt, est.n, n_sims=400, seed=7)
        samples = np.asarray(dist.pop("kappa_samples"))
        hi = float(np.quantile(samples, 0.98)) if len(samples) else 1.0
        counts, edges = np.histogram(samples, bins=40, range=(0, hi))  # the top 2% are left off the chart
        sims = {**dist, "hist": {"edges": edges.tolist(), "counts": counts.tolist(),
                                 "beyond": int((samples > hi).sum())}}

    # today's curve: market zero rates vs Vasicek under P (expectations only) and under Q (calibrated)
    curve = services.market_curve(currency)
    term = None
    if curve is not None:
        grid = np.round(np.linspace(0.25, 30, 120), 4)
        z_mkt = np.asarray(curve.zero_rate(VASICEK_TENORS), dtype=float)
        r0 = float(z_mkt[0])
        sigma = est.sigma if est.mean_reverting else float(np.std(np.diff(s.to_numpy()), ddof=1) / math.sqrt(dt))
        cal = calibrate_vasicek(VASICEK_TENORS, z_mkt, r0, sigma, kappa0=est.kappa if est.mean_reverting else 0.2)
        yq = vasicek_yield(r0, cal["kappa"], cal["theta"], sigma, grid)
        yp = vasicek_yield(r0, est.kappa, est.theta, est.sigma, grid) if est.mean_reverting else None
        t_fan = np.round(np.linspace(0, 10 - 1 / 12, 120), 4)  # one-month forwards f(t, t + 1/12) up to 10 years
        fwd_mkt = [float(curve.forward_rate(t, t + 1 / 12)) for t in t_fan]
        fan = {"t": t_fan.tolist(), "market_forward": fwd_mkt,
               "q_forward": vasicek_forward(r0, cal["kappa"], cal["theta"], sigma, t_fan).tolist(),
               "q_mean": ou_mean(r0, cal["kappa"], cal["theta"], t_fan).tolist()}
        if est.mean_reverting:
            m, sd = ou_mean(r0, est.kappa, est.theta, t_fan), np.sqrt(ou_var(est.kappa, est.sigma, t_fan))
            fan.update({"p_mean": m.tolist(), "p_low": (m - 1.645 * sd).tolist(), "p_high": (m + 1.645 * sd).tolist()})
        y10q = float(vasicek_yield(r0, cal["kappa"], cal["theta"], sigma, 10.0))
        y10p = float(vasicek_yield(r0, est.kappa, est.theta, est.sigma, 10.0)) if est.mean_reverting else None
        term = {
            "r0": r0, "sigma": sigma, "asof": str(services.latest_quotes(currency)["asof"].iloc[0]),
            "pillars": VASICEK_TENORS.tolist(), "market_pillars": z_mkt.tolist(),
            "grid": grid.tolist(), "market": np.asarray(curve.zero_rate(grid), dtype=float).tolist(),
            "vasicek_q": yq.tolist(), "vasicek_p": None if yp is None else yp.tolist(),
            "calibration": {**cal, "residuals": cal["residuals"],
                            "long_yield": long_yield(cal["kappa"], cal["theta"], sigma),
                            "half_life": math.log(2) / cal["kappa"]},
            "theta_gap": cal["theta"] - est.theta if est.mean_reverting else None,
            "term_premium_10y": None if y10p is None else y10q - y10p,
            "p_rmse": None if yp is None else float(np.sqrt(np.mean(
                (vasicek_yield(r0, est.kappa, est.theta, est.sigma, VASICEK_TENORS) - z_mkt) ** 2))),
            "prob_negative": {f"{h:g}": prob_negative(est.kappa, est.theta, est.sigma, r0, h) for h in (1, 5)}
            if est.mean_reverting else None,
            "fan": fan,
        }

    return {"currency": currency, "series": VASICEK_SERIES[currency], "start": start, "freq": freq, "dt": dt,
            "starts": list(VASICEK_STARTS[currency]),
            "first": s.index[0].strftime("%Y-%m-%d"), "last": s.index[-1].strftime("%Y-%m-%d"),
            "history": {"dates": s.index.strftime("%Y-%m-%d").tolist(), "rates": s.round(6).tolist()},
            "estimate": e, "windows": windows, "simulation": sims, "term_structure": term}


@router.get("/vasicek")
def vasicek(currency: Literal["USD", "EUR"] = "USD", start: Optional[int] = None,
            freq: Literal["monthly", "weekly", "daily"] = "monthly"):
    """Ornstein-Uhlenbeck short rate estimated by AR(1) regression on decades of 3-month rates (real-world P),
    the estimator's small-sample bias by Monte Carlo, and the Vasicek zero curve against today's market curve
    (risk-neutral Q calibrated with the same sigma)."""
    start = start or VASICEK_STARTS[currency][0]
    if start not in VASICEK_STARTS[currency]:
        raise HTTPException(422, f"début possible : {', '.join(map(str, VASICEK_STARTS[currency]))}")
    s = services.get_db().short_rates(VASICEK_SERIES[currency])
    if s.empty:
        raise HTTPException(409, "historique des taux courts indisponible (lancer scripts/refresh.py --jobs rates --force)")
    q = services.latest_quotes(currency)
    version = f"{s.index[-1]}|{q['asof'].iloc[0] if not q.empty else ''}"
    return _vasicek(currency, start, freq, version)
