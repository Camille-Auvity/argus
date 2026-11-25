"""Glue between the HTTP layer and the engine / database (with in-process caches)."""

from __future__ import annotations

import time
from functools import lru_cache

import numpy as np
import pandas as pd

from api.schemas import Greeks, MethodResult, RateSpec
from qplat import config
from qplat.curves import FlatCurve, Interpolation, RateCurve
from qplat.data.db import Database
from qplat.data.market import curve_from_quotes, realized_vol
from qplat.pricers.base import Pricer


@lru_cache(maxsize=1)
def get_db() -> Database:
    return Database()


# ----------------------------------------------------------------------------- curves

@lru_cache(maxsize=64)
def _build_curve(tenors: tuple, rates: tuple, quote_type: str, interpolation: str) -> RateCurve:
    return curve_from_quotes(tenors, rates, quote_type, Interpolation(interpolation))


def latest_quotes(currency: str) -> pd.DataFrame:
    return get_db().latest_rates(currency)


def market_curve(currency: str, interpolation: str = Interpolation.LOGLINEAR_DF.value) -> RateCurve | None:
    """Curve from the latest stored quotes; cached on the quote values themselves."""
    q = latest_quotes(currency)
    if q.empty:
        return None
    return _build_curve(tuple(q.tenor_years), tuple(q.rate), q.quote_type.iloc[0], interpolation)


class MissingDataError(LookupError):
    pass


def resolve_rate(spec: RateSpec) -> RateCurve:
    if spec.mode == "flat":
        return FlatCurve(spec.flat_rate)
    curve = market_curve(spec.currency)
    if curve is None:
        raise MissingDataError(f"no {spec.currency} curve in database — run the rates refresh")
    return curve


# ----------------------------------------------------------------------------- tickers

def ticker_currency(ticker: str, tickers: pd.DataFrame | None = None) -> str:
    tickers = get_db().tickers() if tickers is None else tickers
    row = tickers[tickers.ticker == ticker]
    if not row.empty and pd.notna(row.currency.iloc[0]):
        return str(row.currency.iloc[0])
    return config.market_of(ticker).currency


def ticker_snapshot(ticker: str, tickers: pd.DataFrame, history: pd.DataFrame,
                    sentiment: dict[str, float] | None = None) -> dict:
    row = tickers[tickers.ticker == ticker]
    closes = history.close.astype(float) if not history.empty else pd.Series(dtype=float)
    last = float(closes.iloc[-1]) if len(closes) else None
    prev = float(closes.iloc[-2]) if len(closes) > 1 else None
    rv = realized_vol(closes) if len(closes) > 30 else float("nan")
    rv21 = realized_vol(closes, 21) if len(closes) > 22 else float("nan")
    get = (lambda col: row[col].iloc[0] if not row.empty and pd.notna(row[col].iloc[0]) else None)
    return {
        "ticker": ticker,
        "name": get("name") or ticker,
        "sector": get("sector"),
        "currency": ticker_currency(ticker, tickers),
        "market": config.market_of(ticker).name,
        "last": last,
        "last_date": history.date.iloc[-1].strftime("%Y-%m-%d") if len(closes) else None,
        "change": (last - prev) if last is not None and prev is not None else None,
        "change_pct": (last / prev - 1) if last is not None and prev else None,
        "dividend_yield": float(get("dividend_yield") or 0.0),
        "realized_vol_1y": None if np.isnan(rv) else rv,
        "realized_vol_1m": None if np.isnan(rv21) else rv21,
        "sparkline": closes.tail(60).round(4).tolist(),
        "sentiment": (sentiment or {}).get(ticker),
    }


# ----------------------------------------------------------------------------- pricing helpers

def run_pricer(pricer: Pricer, instrument, with_error: bool = False) -> MethodResult:
    t0 = time.perf_counter()
    g = pricer.greeks(instrument)
    std_error = pricer.price_with_error(instrument)[1] if with_error else None
    elapsed = (time.perf_counter() - t0) * 1000
    s = g.scaled()
    return MethodResult(
        method=pricer.name,
        greeks=Greeks(price=s["price"], delta=s["delta"], gamma=s["gamma"], vega=s["vega (1%)"],
                      theta=s["theta (1d)"], rho=s["rho (1%)"]),
        std_error=std_error,
        elapsed_ms=round(elapsed, 1),
    )


def scaled_greeks(g) -> Greeks:
    s = g.scaled()
    return Greeks(price=s["price"], delta=s["delta"], gamma=s["gamma"], vega=s["vega (1%)"],
                  theta=s["theta (1d)"], rho=s["rho (1%)"])
