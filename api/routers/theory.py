"""Applied theory labs: binomial replication and the market maker's hedge, discrete delta hedging."""

from __future__ import annotations

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
