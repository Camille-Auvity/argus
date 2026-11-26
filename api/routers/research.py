"""Research: volatility-managed portfolios (Moreira & Muir, 2017) on the Fama-French factors since 1926."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from qplat.research.vol_managed import FACTOR_LABELS, Panels, analyse, subperiods, volatility_buckets

router = APIRouter(prefix="/api/research", tags=["research"])

EPISODES = [
    ("Krach de 1929", "1929-09", "1932-06"),
    ("Krach de 1987", "1987-09", "1987-12"),
    ("Bulle internet", "2000-03", "2002-09"),
    ("Crise financière", "2007-10", "2009-03"),
    ("Covid", "2020-02", "2020-04"),
    ("Krach du momentum 2009", "2009-03", "2009-09"),
]


def _stamp() -> str:
    df = services.get_db().query("SELECT MAX(date) AS d, COUNT(*) AS n FROM factor_returns")
    if not df["n"].iloc[0]:
        raise HTTPException(409, "facteurs Fama-French absents de la base : lancez le rafraîchissement des taux")
    return f"{df['d'].iloc[0]}:{df['n'].iloc[0]}"


@lru_cache(maxsize=2)
def _panels(_stamp_: str) -> Panels:
    return Panels(services.get_db().factors())


def _clean(x):
    if isinstance(x, dict):
        return {k: _clean(v) for k, v in x.items()}
    if isinstance(x, list):
        return [_clean(v) for v in x]
    if isinstance(x, float) and not np.isfinite(x):
        return None
    return x


class VolManagedRequest(BaseModel):
    factor: Literal["mkt_rf", "smb", "hml", "mom", "rmw", "cma"] = "mkt_rf"
    mode: Literal["full", "realtime"] = "full"
    leverage_cap: Optional[float] = Field(None, gt=0, le=50)
    cost_bp: float = Field(0.0, ge=0, le=100)
    start: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}$")
    end: Optional[str] = Field(None, pattern=r"^\d{4}-\d{2}$")


@lru_cache(maxsize=64)
def _summary(stamp: str, mode: str, cap: Optional[float], cost: float, start: Optional[str], end: Optional[str]) -> dict:
    panels = _panels(stamp)
    rows = []
    for k, label in FACTOR_LABELS.items():
        try:
            r = analyse(panels, k, mode, cap, cost, start, end)
        except (ValueError, KeyError):
            continue
        rows.append({"factor": k, "label": label, **{key: r.stats[key] for key in (
            "start", "end", "months", "alpha", "alpha_t", "beta", "r2", "appraisal", "sharpe_original", "sharpe_managed",
            "weight_max", "alpha_ff3")}})
    return _clean({"rows": rows, "data_end": stamp.split(":")[0]})


@router.get("/vol-managed/summary")
def summary(mode: Literal["full", "realtime"] = "full", leverage_cap: Optional[float] = None, cost_bp: float = 0.0,
            start: Optional[str] = None, end: Optional[str] = None):
    """Moreira-Muir Table I on every factor: alpha of f^sigma on f, appraisal ratio, Sharpe ratios."""
    return _summary(_stamp(), mode, leverage_cap, cost_bp, start, end)


@lru_cache(maxsize=64)
def _detail(stamp: str, payload: str) -> dict:
    req = VolManagedRequest.model_validate_json(payload)
    panels = _panels(stamp)
    try:
        r = analyse(panels, req.factor, req.mode, req.leverage_cap, req.cost_bp, req.start, req.end)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    idx = pd.PeriodIndex(r.dates, freq="M")
    orig = pd.Series(r.original, index=idx)
    man = pd.Series(r.managed, index=idx)
    episodes = []
    for name, a, b in EPISODES:
        sel = (idx >= pd.Period(a, "M")) & (idx <= pd.Period(b, "M"))
        if sel.sum() >= 2:
            episodes.append({"episode": name, "start": a, "end": b,
                             "original": float(np.prod(1 + orig[sel]) - 1), "managed": float(np.prod(1 + man[sel]) - 1)})
    return _clean({
        "factor": req.factor, "label": FACTOR_LABELS[req.factor], "stats": r.stats,
        "series": {"dates": r.dates,
                   "log_wealth_original": np.cumsum(np.log1p(r.original)).round(5).tolist(),
                   "log_wealth_managed": np.cumsum(np.log1p(r.managed)).round(5).tolist(),
                   "weight": np.round(r.weights, 4).tolist(),
                   "lagged_vol": np.round(np.sqrt(r.rv * 12), 5).tolist()},
        "buckets": volatility_buckets(panels, req.factor),
        "subperiods": subperiods(panels, req.factor, req.mode, req.leverage_cap, req.cost_bp),
        "episodes": episodes,
    })


@router.post("/vol-managed")
def vol_managed(req: VolManagedRequest):
    """One factor in detail: cumulative returns, exposure, volatility buckets, decades, crisis episodes."""
    return _detail(_stamp(), req.model_dump_json())
