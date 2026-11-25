"""Volatility models fitted on the latest option chain: Heston calibration, SVI surface, local vol."""

from __future__ import annotations

from functools import lru_cache
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from qplat import config
from qplat.analytics import compute_smile
from qplat.models.market_models import compare_exotics, fit_heston, fit_surface, surface_payload

router = APIRouter(prefix="/api/models", tags=["models"])


def _chain_version(ticker: str) -> str:
    df = services.get_db().query("SELECT MAX(asof) AS asof FROM option_quotes WHERE ticker=?", (ticker,))
    asof = df["asof"].iloc[0]
    if asof is None:
        reason = ("Yahoo Finance ne diffuse pas de chaînes d'options pour ce marché"
                  if config.market_of(ticker).name == "EU" else "aucune chaîne d'options en base")
        raise HTTPException(404, reason)
    return asof


@lru_cache(maxsize=16)
def _market(ticker: str, _asof: str):
    db = services.get_db()
    chain = db.latest_option_chain(ticker)
    ccy = services.ticker_currency(ticker)
    curve = services.market_curve(ccy)
    if curve is None:
        raise HTTPException(409, f"pas de courbe {ccy} en base")
    tickers = db.tickers()
    row = tickers[tickers.ticker == ticker]
    q = float(row.dividend_yield.iloc[0]) if not row.empty and row.dividend_yield.notna().iloc[0] else 0.0
    spot = float(chain.spot.dropna().iloc[0])
    return compute_smile(chain, q, curve), spot, q, curve


@lru_cache(maxsize=16)
def _heston(ticker: str, asof: str):
    smile, spot, q, curve = _market(ticker, asof)
    try:
        return fit_heston(smile, spot, q, curve)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@lru_cache(maxsize=16)
def _surface(ticker: str, asof: str):
    smile, spot, q, curve = _market(ticker, asof)
    try:
        return fit_surface(smile, spot, q, curve)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc


@router.get("/{ticker}/heston")
def heston(ticker: str):
    """Heston parameters calibrated on the liquid part of the smile, fit quality per expiry."""
    asof = _chain_version(ticker)
    fit = _heston(ticker, asof)
    _, spot, q, _ = _market(ticker, asof)
    p = fit.result.params
    return {
        "asof": asof, "spot": spot, "dividend_yield": q,
        "params": {"v0": p.v0, "kappa": p.kappa, "theta": p.theta, "sigma": p.sigma, "rho": p.rho},
        "derived": {"vol_initiale": p.v0 ** 0.5, "vol_long_terme": p.theta ** 0.5, "feller": p.feller(),
                    "demi_vie_ans": 0.6931 / p.kappa},
        "quality": {"rmse_vol": fit.result.rmse_vol, "max_error_vol": fit.result.max_error_vol,
                    "n_points": fit.result.n_points, "n_evaluations": fit.result.n_evaluations,
                    "elapsed_s": fit.elapsed_s, "success": fit.result.success},
        "curves": fit.curves,
    }


@router.get("/{ticker}/surface")
def surface(ticker: str):
    """SVI slices, no-arbitrage report, implied and Dupire local vol grids."""
    asof = _chain_version(ticker)
    smile, spot, q, _ = _market(ticker, asof)
    return {"asof": asof, "spot": spot, **surface_payload(_surface(ticker, asof), smile)}


class BarrierSpec(BaseModel):
    expiry: float = Field(1.0, gt=0.05, le=3)
    strike_pct: float = Field(1.0, gt=0)
    barrier_pct: float = Field(0.8, gt=0)
    barrier_type: Literal["down-and-out", "down-and-in", "up-and-out", "up-and-in"] = "down-and-out"
    option_type: Literal["call", "put"] = "call"


class AutocallSpec(BaseModel):
    maturity: float = Field(3.0, gt=0.25, le=5)
    frequency: Literal[1, 2, 4, 12] = 4
    coupon_rate: float = Field(0.02, ge=0, le=0.5)
    autocall_barrier: float = Field(1.0, gt=0)
    coupon_barrier: float = Field(0.7, ge=0)
    protection_barrier: float = Field(0.6, ge=0)
    memory: bool = True


class ExoticsRequest(BaseModel):
    barrier: BarrierSpec = BarrierSpec()
    autocall: AutocallSpec = AutocallSpec()
    n_paths: int = Field(40_000, ge=5_000, le=200_000)


@lru_cache(maxsize=32)
def _exotics(ticker: str, asof: str, payload: str):
    req = ExoticsRequest.model_validate_json(payload)
    _, spot, q, curve = _market(ticker, asof)
    b = req.barrier
    return compare_exotics(
        spot, q, curve, _heston(ticker, asof).result.params, _surface(ticker, asof),
        {"expiry": b.expiry, "strike": b.strike_pct * spot, "barrier": b.barrier_pct * spot,
         "barrier_type": b.barrier_type, "option_type": b.option_type},
        req.autocall.model_dump(), n_paths=req.n_paths)


@router.post("/{ticker}/exotics")
def exotics(ticker: str, req: ExoticsRequest):
    """The same barrier and autocall priced under flat BS vol, Heston and Dupire local vol."""
    asof = _chain_version(ticker)
    return _exotics(ticker, asof, req.model_dump_json())
