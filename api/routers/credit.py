"""Credit endpoints: CDS bootstrap / pricing / risk, Merton structural model and the bridge between them."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from api.schemas import RateSpec
from qplat.credit import (
    CDS, bootstrap_hazard, calibrate_merton, cds_legs, cds_risk, implied_equity_vol, merton_cds_spreads,
    merton_hazard_curve, term_structure,
)
from qplat.data.market import FX_TICKERS, realized_vol

router = APIRouter(prefix="/api/credit", tags=["credit"])

STANDARD_TENORS = (0.5, 1.0, 2.0, 3.0, 4.0, 5.0, 7.0, 10.0)


def _curve(spec: RateSpec):
    try:
        return services.resolve_rate(spec)
    except services.MissingDataError as exc:
        raise HTTPException(409, str(exc)) from exc


def _bad(exc: Exception):
    return HTTPException(422, str(exc))


# ----------------------------------------------------------------------------- CDS

class CDSRequest(BaseModel):
    tenors: list[float] = Field(default=[1, 2, 3, 5, 7, 10], min_length=1, max_length=12)
    spreads_bp: list[float] = Field(default=[40, 55, 70, 95, 110, 120], min_length=1, max_length=12)
    recovery: float = Field(0.4, ge=0, lt=1)
    rate: RateSpec = RateSpec()
    maturity: float = Field(5.0, gt=0, le=30)
    coupon_bp: float = Field(100.0, ge=0, le=5000)
    notional: float = Field(10_000_000, gt=0)
    side: Literal["buyer", "seller"] = "buyer"


def _cds(req: CDSRequest) -> dict:
    if len(req.tenors) != len(req.spreads_bp):
        raise HTTPException(422, "un spread par maturité")
    order = np.argsort(req.tenors)
    tenors = [float(req.tenors[i]) for i in order]
    spreads = np.array([req.spreads_bp[i] for i in order]) * 1e-4
    curve = _curve(req.rate)
    cds = CDS(maturity=req.maturity, coupon=req.coupon_bp * 1e-4, recovery=req.recovery, notional=req.notional)
    try:
        risk, hazard = cds_risk(cds, tenors, spreads, curve, buyer=req.side == "buyer")
    except ValueError as exc:
        raise _bad(exc) from exc

    table = []
    for T, s in zip(tenors, spreads):
        legs = cds_legs(CDS(maturity=T, recovery=req.recovery), hazard, curve)
        q = float(hazard.survival(T))
        table.append({"tenor": T, "quoted_bp": s * 1e4, "model_bp": legs.par_spread * 1e4,
                      "hazard": float(hazard.hazard(T)), "survival": q, "default_probability": 1 - q,
                      "rpv01": legs.rpv01, "upfront_100": legs.upfront(0.01), "upfront_500": legs.upfront(0.05)})
    grid = np.round(np.linspace(0, max(tenors[-1], req.maturity), 121), 6)
    surv = hazard.survival(grid)
    term = [{"maturity": float(T), "par_bp": cds_legs(CDS(maturity=float(T), recovery=req.recovery), hazard, curve).par_spread * 1e4}
            for T in np.arange(0.5, max(tenors[-1], req.maturity) + 1e-9, 0.5)]
    return {
        "risk": {k: float(v) for k, v in risk.__dict__.items()},
        "table": table,
        "curves": {"t": grid.tolist(), "survival": surv.tolist(), "default_probability": (1 - surv).tolist(),
                   "hazard": hazard.hazard(np.maximum(grid, 1e-9)).tolist()},
        "par_curve": term,
        "pillars": list(hazard.pillars),
        "hazards": list(hazard.hazards),
    }


@lru_cache(maxsize=128)
def _cds_cached(payload: str, _curve_version: str) -> dict:
    return _cds(CDSRequest.model_validate_json(payload))


@router.post("/cds")
def price_cds(req: CDSRequest):
    """Bootstrap of the hazard curve from par spreads, then MTM, upfront and risk of one CDS."""
    from api.routers.pricing import _curve_version

    return _cds_cached(req.model_dump_json(), _curve_version(req.rate))


# ----------------------------------------------------------------------------- Merton inputs from the database

def _equity_vol(ticker: str, history: pd.DataFrame) -> tuple[float, str]:
    try:
        from api.routers.models import _chain_version, _surface

        surface = _surface(ticker, _chain_version(ticker))
        return float(surface.implied_vol(0.0, 1.0)), "vol implicite ATM 1 an (surface SVI)"
    except Exception:
        rv = realized_vol(history.close) if len(history) > 30 else float("nan")
        if not np.isfinite(rv):
            raise HTTPException(409, f"pas assez d'historique pour estimer la volatilité de {ticker}")
        return float(rv), "volatilité réalisée 1 an"


@router.get("/merton/{ticker}/inputs")
def merton_inputs(ticker: str):
    """Market value of equity, debt (balance sheet) and equity vol for the Merton model, from the database."""
    db = services.get_db()
    meta = db.tickers().set_index("ticker")
    if ticker not in meta.index or pd.isna(meta.loc[ticker].get("shares_outstanding")):
        raise HTTPException(404, f"pas de bilan pour {ticker} : le modèle de Merton s'applique aux entreprises, "
                                 "pas aux indices ni aux ETF")
    row = meta.loc[ticker]
    history = db.spot_history(ticker)
    if history.empty:
        raise HTTPException(409, f"pas de cours pour {ticker}")
    spot = float(history.close.iloc[-1])
    ccy = services.ticker_currency(ticker)
    fin = row.get("financial_currency") or ccy
    fx = 1.0
    if fin != ccy:
        eurusd = db.latest_spot(FX_TICKERS["EURUSD"])
        if not eurusd or {fin, ccy} != {"EUR", "USD"}:
            raise HTTPException(409, f"conversion {fin} → {ccy} indisponible")
        fx = 1 / eurusd if fin == "USD" else eurusd   # balance sheet currency -> quote currency
    std = float(row.get("short_term_debt") or 0.0) * fx
    ltd = float(row.get("long_term_debt") or 0.0) * fx
    total = float(row.get("total_debt") or std + ltd) * fx
    vol, vol_source = _equity_vol(ticker, history)
    return {
        "ticker": ticker, "name": row.get("name"), "currency": ccy, "spot": spot,
        "shares_outstanding": float(row["shares_outstanding"]),
        "equity": spot * float(row["shares_outstanding"]),
        "short_term_debt": std, "long_term_debt": ltd, "total_debt": total,
        "kmv_default_point": std + 0.5 * ltd,
        "equity_vol": vol, "equity_vol_source": vol_source,
        "financial_currency": fin, "fundamentals_at": row.get("fundamentals_at"),
    }


# ----------------------------------------------------------------------------- Merton model

class MertonRequest(BaseModel):
    equity: float = Field(gt=0)
    equity_vol: float = Field(gt=0, le=5)
    debt_face: float = Field(gt=0)
    horizon: float = Field(1.0, gt=0, le=30)
    currency: Literal["USD", "EUR"] = "USD"
    recovery: float = Field(0.4, ge=0, lt=1)
    market_spread_bp: Optional[float] = Field(None, gt=0, description="CDS 5 ans de marché, pour la vol implicite")


def _merton(req: MertonRequest) -> dict:
    curve = _curve(RateSpec(mode="curve", currency=req.currency))
    r = float(curve.zero_rate(req.horizon))
    try:
        fit = calibrate_merton(req.equity, req.equity_vol, req.debt_face, req.horizon, r)
    except ValueError as exc:
        raise _bad(exc) from exc
    mats = np.round(np.arange(0.25, 10.0001, 0.25), 4)
    ts = term_structure(fit, curve, mats)
    cds_tenors = [1.0, 2.0, 3.0, 5.0, 7.0, 10.0]
    cds_bp = [s * 1e4 for s in merton_cds_spreads(fit, curve, cds_tenors, req.recovery)]
    hz = merton_hazard_curve(fit, curve, horizon=10.0)

    # sensitivity of the horizon spread / PD to equity vol and to the equity value (capital structure)
    vols = np.round(np.linspace(0.1, 1.0, 19), 3)
    by_vol = []
    for v in vols:
        try:
            f = calibrate_merton(req.equity, float(v), req.debt_face, req.horizon, r)
            by_vol.append({"equity_vol": float(v), "spread_bp": f.spread * 1e4, "pd": f.default_probability,
                           "asset_vol": f.asset_vol})
        except ValueError:
            continue
    moves = np.round(np.linspace(-0.6, 0.6, 25), 3)
    by_equity = []
    for m in moves:
        # equity falls with the asset value (the debt does not move): solve again at the new equity level
        try:
            f = calibrate_merton(req.equity * (1 + m), req.equity_vol, req.debt_face, req.horizon, r)
            by_equity.append({"move": float(m), "spread_bp": f.spread * 1e4, "pd": f.default_probability,
                              "distance_to_default": f.d2})
        except ValueError:
            continue
    down = calibrate_merton(req.equity * 0.99, req.equity_vol, req.debt_face, req.horizon, r)
    implied = (implied_equity_vol(req.equity, req.debt_face, curve, req.market_spread_bp * 1e-4, 5.0, req.recovery, req.horizon)
               if req.market_spread_bp else None)
    return {
        "rate": r,
        "fit": {k: float(v) for k, v in fit.__dict__.items()},
        "spread_bp": fit.spread * 1e4,
        "spread_change_for_equity_down_1pct_bp": (down.spread - fit.spread) * 1e4,
        "term_structure": {"T": ts["T"], "spread_bp": [s * 1e4 for s in ts["spread"]],
                           "default_probability": ts["default_probability"],
                           "distance_to_default": ts["distance_to_default"]},
        "cds": {"tenors": cds_tenors, "spreads_bp": cds_bp, "recovery": req.recovery},
        "hazard": {"pillars": list(hz.pillars), "hazards": list(hz.hazards)},
        "by_vol": by_vol,
        "by_equity": by_equity,
        "implied_equity_vol": implied,
    }


@lru_cache(maxsize=64)
def _merton_cached(payload: str, _curve_version: str) -> dict:
    return _merton(MertonRequest.model_validate_json(payload))


@router.post("/merton")
def merton(req: MertonRequest):
    """Calibration of (V, sigma_V), default probability, spread term structure, implied CDS curve, sensitivities."""
    from api.routers.pricing import _curve_version

    return _merton_cached(req.model_dump_json(), _curve_version(RateSpec(mode="curve", currency=req.currency)))
