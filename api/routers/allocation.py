"""Portfolio allocation: estimates, constrained mean-variance optimisation, frontier, LASSO path, backtest."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from qplat import config
from qplat.allocation import (
    Constraints, daily_closes, describe, estimate, frontier, max_sharpe, min_variance, optimize, returns_in_base,
    unconstrained_frontier,
)
from qplat.allocation.backtest import run_backtest, standard_strategies
from qplat.data.market import FX_TICKERS

router = APIRouter(prefix="/api/allocation", tags=["allocation"])
BASE = "EUR"


def _data_stamp() -> str:
    db = services.get_db()
    return f"{db.latest_spot('SPY')}|{db.latest_spot('^STOXX50E')}|{db.latest_spot(FX_TICKERS['EURUSD'])}"


@lru_cache(maxsize=8)
def _returns(tickers: tuple[str, ...], _stamp: str) -> pd.DataFrame:
    db = services.get_db()
    meta = db.tickers()
    closes = {}
    for t in tickers:
        h = db.spot_history(t)
        if h.empty:
            raise HTTPException(409, f"pas d'historique pour {t}")
        closes[t] = daily_closes(h)
    fx = daily_closes(db.spot_history(FX_TICKERS["EURUSD"]))
    try:
        return returns_in_base(closes, {t: services.ticker_currency(t, meta) for t in tickers}, fx, BASE)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


def _finite(x):
    """JSON has no NaN / inf: replace them by null (e.g. a Sharpe ratio of a zero-volatility point)."""
    if isinstance(x, dict):
        return {k: _finite(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_finite(v) for v in x]
    if isinstance(x, float) and not np.isfinite(x):
        return None
    return x


def _rf() -> float:
    curve = services.market_curve(BASE)
    return float(curve.zero_rate(0.25)) if curve is not None else 0.0


@router.get("/universe")
def universe():
    db = services.get_db()
    meta = db.tickers().set_index("ticker")
    rows = []
    for t in config.TICKERS:
        h = db.spot_history(t)
        rows.append({"ticker": t, "name": meta.loc[t, "name"] if t in meta.index else t,
                     "currency": services.ticker_currency(t), "days": int(len(daily_closes(h))) if not h.empty else 0})
    return {"base_currency": BASE, "assets": rows, "risk_free": _rf()}


# ----------------------------------------------------------------------------- optimisation

class OptimizeRequest(BaseModel):
    tickers: list[str] = Field(default_factory=lambda: list(config.TICKERS), min_length=2, max_length=30)
    lookback_days: int = Field(504, ge=60, le=2000)
    mean_method: Literal["sample", "shrunk", "zero"] = "sample"
    cov_method: Literal["sample", "ledoit-wolf"] = "ledoit-wolf"
    objective: Literal["mean-variance", "min-variance", "max-sharpe"] = "mean-variance"
    gamma: float = Field(5.0, gt=0, le=200)
    long_only: bool = True
    short_max: float = Field(0.3, ge=0, le=2)
    w_max: float = Field(1.0, gt=0, le=1)
    l1: float = Field(0.0, ge=0, le=1)
    l2: float = Field(0.0, ge=0, le=10)
    cost: float = Field(0.0, ge=0, le=0.05)
    holding_days: int = Field(21, ge=1, le=504)


def _cons(req: OptimizeRequest, w0=None, **over) -> Constraints:
    kw = dict(long_only=req.long_only, short_max=req.short_max, w_max=req.w_max, l1=req.l1, l2=req.l2,
              cost=req.cost, holding=req.holding_days / 252, w0=w0)
    kw.update(over)
    return Constraints(**kw)


def _pf(r, tickers) -> dict:
    return {"weights": dict(zip(tickers, np.round(r.weights, 6).tolist())),
            "risk_contributions": dict(zip(tickers, np.round(r.risk_contributions, 6).tolist())),
            "expected_return": r.expected_return, "volatility": r.volatility, "sharpe": r.sharpe,
            "effective_n": r.effective_n, "gross_exposure": r.gross_exposure, "n_active": r.n_active,
            "turnover": r.turnover, "success": r.success}


def _optimize(req: OptimizeRequest) -> dict:
    tickers = list(dict.fromkeys(req.tickers))
    R = _returns(tuple(tickers), _data_stamp()).tail(req.lookback_days)
    try:
        e = estimate(R, req.mean_method, req.cov_method)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    rf = _rf()
    p = len(tickers)
    w_eq = np.full(p, 1.0 / p)
    cons = _cons(req, tuple(w_eq))
    if req.objective == "min-variance":
        best = min_variance(e.cov, cons, e.mu, rf)
    elif req.objective == "max-sharpe":
        best = None   # computed below from the frontier of the same constraints
    else:
        best = optimize(e.mu, e.cov, req.gamma, cons, rf=rf)

    long_cons = Constraints(long_only=True, w_max=req.w_max)
    short_cons = Constraints(long_only=False, short_max=req.short_max, w_max=req.w_max)
    fr_long = frontier(e.mu, e.cov, long_cons, 20, rf)
    fr_short = frontier(e.mu, e.cov, short_cons, 20, rf)
    if best is None:
        same = fr_long if req.long_only else fr_short
        best = max_sharpe(e.mu, e.cov, long_cons if req.long_only else short_cons, rf, points=same)
    targets = np.linspace(min(r.expected_return for r in fr_long + fr_short),
                          max(r.expected_return for r in fr_long + fr_short), 40)
    # closed form needs distinct expected returns (a c - b^2 > 0)
    unc = unconstrained_frontier(e.mu, e.cov, targets) if np.ptp(e.mu) > 1e-10 else np.array([])

    # LASSO / elastic-net path on the minimum-variance problem with shorts: in-sample on the first 60%,
    # out-of-sample volatility on the remaining 40%
    split = int(len(R) * 0.6)
    e_in = estimate(R.iloc[:split], "zero", "sample")
    oos = R.iloc[split:].to_numpy(float)
    path = []
    for lam in [0.0, 1e-4, 3e-4, 1e-3, 2e-3, 3e-3, 5e-3, 1e-2, 2e-2]:
        r = min_variance(e_in.cov, Constraints(long_only=False, short_max=max(req.short_max, 0.3), w_max=1.0, l1=lam))
        path.append({"lambda": lam, "n_active": r.n_active, "gross_exposure": r.gross_exposure,
                     "in_sample_vol": r.volatility, "out_of_sample_vol": float((oos @ r.weights).std(ddof=1) * np.sqrt(252)),
                     "weights": dict(zip(tickers, np.round(r.weights, 5).tolist()))})

    vols = np.sqrt(np.diag(e.cov))
    corr = e.cov / np.outer(vols, vols)
    return {
        "base_currency": BASE, "risk_free": rf, "n_obs": len(R), "start": str(R.index[0]), "end": str(R.index[-1]),
        "estimates": {"tickers": tickers, "mu": e.mu.tolist(), "vol": vols.tolist(), "corr": np.round(corr, 4).tolist(),
                      "cov_shrinkage": e.shrinkage, "mean_shrinkage": e.mean_shrinkage,
                      "sample_mu": (R.mean().to_numpy() * 252).tolist()},
        "optimal": _pf(best, tickers),
        "min_variance": _pf(min_variance(e.cov, long_cons, e.mu, rf), tickers),
        "tangency": _pf(max_sharpe(e.mu, e.cov, long_cons, rf, points=fr_long), tickers),
        "equal_weight": _pf(describe(w_eq, e.mu, e.cov, rf, None), tickers),
        "frontier": {"long_only": [{"ret": r.expected_return, "vol": r.volatility} for r in fr_long if r.success],
                     "with_shorts": [{"ret": r.expected_return, "vol": r.volatility} for r in fr_short if r.success],
                     "unconstrained": [{"ret": float(t), "vol": float(v)} for t, v in zip(targets, unc)]},
        "lasso_path": path,
    }


@lru_cache(maxsize=32)
def _optimize_cached(payload: str, _stamp: str) -> dict:
    return _finite(_optimize(OptimizeRequest.model_validate_json(payload)))


@router.post("/optimize")
def optimize_portfolio(req: OptimizeRequest):
    """Estimates (shrinkage), optimal weights under constraints, frontiers, risk contributions, LASSO path."""
    return _optimize_cached(req.model_dump_json(), _data_stamp())


# ----------------------------------------------------------------------------- backtest

class BacktestRequest(BaseModel):
    tickers: list[str] = Field(default_factory=lambda: list(config.TICKERS), min_length=2, max_length=30)
    window: int = Field(126, ge=40, le=500)
    rebalance_days: int = Field(21, ge=5, le=126)
    cost: float = Field(0.001, ge=0, le=0.05)
    gamma: float = Field(5.0, gt=0, le=200)
    short_max: float = Field(0.3, ge=0, le=2)
    w_max: float = Field(0.4, gt=0, le=1)
    l1: float = Field(0.002, ge=0, le=1)


@lru_cache(maxsize=16)
def _backtest(payload: str, _stamp: str) -> dict:
    req = BacktestRequest.model_validate_json(payload)
    tickers = list(dict.fromkeys(req.tickers))
    R = _returns(tuple(tickers), _stamp)
    rf = _rf()
    strategies = standard_strategies(req.gamma, req.cost, req.rebalance_days, req.short_max, req.l1, req.w_max)
    try:
        res = run_backtest(R, strategies, req.window, req.rebalance_days, req.cost, rf)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    step = max(1, len(res[0].dates) // 300)
    return _finite({
        "base_currency": BASE, "risk_free": rf, "tickers": tickers,
        "dates": res[0].dates[::step],
        "strategies": [{"name": r.name, "description": r.description, "stats": r.stats, "turnover": r.turnover,
                        "total_cost": r.total_cost, "wealth": r.wealth[::step].round(5).tolist(),
                        "last_weights": dict(zip(tickers, np.round(r.weights_history[-1][1], 4).tolist())),
                        "n_rebalances": len(r.weights_history)} for r in res],
    })


@router.post("/backtest")
def backtest(req: BacktestRequest):
    """Walk-forward comparison: 1/N, minimum variance, mean-variance (sample / shrunk), elastic-net, with costs."""
    return _backtest(req.model_dump_json(), _data_stamp())
