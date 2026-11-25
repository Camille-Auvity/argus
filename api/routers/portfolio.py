"""Book of positions: CRUD, valuation, risk (stress, VaR, P&L explain) and a demo book."""

from __future__ import annotations

import time
from datetime import date
from functools import lru_cache
from typing import Literal

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from qplat.data.market import FX_TICKERS, realized_vol
from qplat.risk.portfolio import (
    KINDS, MarketSnapshot, Position, aggregate, historical_var, pnl_explain, stress_grid, value_book,
)

router = APIRouter(prefix="/api/portfolio", tags=["portfolio"])

BASE = "EUR"


# ----------------------------------------------------------------------------- market snapshot from the database

def _atm_vol_function(ticker: str, history: pd.DataFrame):
    """ATM implied vol term structure from the fitted SVI surface when options exist, else 1y realised vol."""
    try:
        from api.routers.models import _chain_version, _surface

        surface = _surface(ticker, _chain_version(ticker))
        return (lambda T, s=surface: float(s.implied_vol(0.0, max(T, 1 / 365)))), "surface ATM"
    except Exception:
        rv = realized_vol(history.close) if len(history) > 30 else 0.2
        rv = rv if np.isfinite(rv) else 0.2
        return (lambda T, v=rv: v), "vol réalisée 1 an"


def build_snapshot(tickers: list[str], previous_close: bool = False) -> tuple[MarketSnapshot, dict]:
    db = services.get_db()
    meta = db.tickers().set_index("ticker")
    spots, vols, divs, ccys, vol_source, dates = {}, {}, {}, {}, {}, {}
    for t in tickers:
        h = db.spot_history(t)
        if h.empty:
            raise HTTPException(409, f"pas de cours en base pour {t}")
        row = -2 if previous_close and len(h) > 1 else -1
        spots[t] = float(h.close.iloc[row])
        dates[t] = h.date.iloc[row].date()
        vols[t], vol_source[t] = _atm_vol_function(t, h)
        divs[t] = float(meta.loc[t, "dividend_yield"]) if t in meta.index and pd.notna(meta.loc[t, "dividend_yield"]) else 0.0
        ccys[t] = services.ticker_currency(t, db.tickers())
    curves = {c: services.market_curve(c) for c in ("USD", "EUR")}
    curves = {c: cv for c, cv in curves.items() if cv is not None}
    eurusd = db.latest_spot(FX_TICKERS["EURUSD"]) or 1.0
    valuation_date = max(dates.values()) if previous_close and dates else date.today()
    snap = MarketSnapshot(valuation_date=valuation_date, spots=spots, vols=vols, dividends=divs, currencies=ccys,
                          curves=curves, fx_to_base={"EUR": 1.0, "USD": 1.0 / eurusd}, base_currency=BASE)
    return snap, {"vol_source": vol_source, "eurusd": eurusd}


def _positions() -> list[Position]:
    return [Position(id=r["id"], kind=r["kind"], quantity=float(r["quantity"]), ticker=r["ticker"], params=r["params"],
                     entry_price=r["entry_price"], book=r["book"], label=r["label"] or "")
            for r in services.get_db().positions()]


def _tickers(positions: list[Position]) -> list[str]:
    return sorted({p.ticker for p in positions if p.ticker})


def _valuation_rows(vals) -> list[dict]:
    rows = []
    for v in vals:
        p = v.position
        rows.append({
            "id": p.id, "book": p.book, "kind": p.kind, "ticker": p.ticker, "quantity": p.quantity, "params": p.params,
            "label": p.label, "description": v.description, "currency": v.currency, "unit_price": _f(v.unit_price),
            "entry_price": p.entry_price, "market_value": _f(v.market_value), "market_value_base": _f(v.market_value_base),
            "pnl_base": _f(v.pnl_base), "delta": _f(v.delta), "delta_cash": _f(v.delta_cash_base),
            "gamma_cash": _f(v.gamma_cash_base), "vega": _f(v.vega_base), "theta": _f(v.theta_base),
            "rho": _f(v.rho_base), "dv01": _f(v.dv01_base), "error": v.error,
        })
    return rows


def _f(x):
    return None if x is None or not np.isfinite(x) else float(x)


# ----------------------------------------------------------------------------- endpoints

@router.get("")
def portfolio():
    """Positions valued at the latest market data, with totals and exposures by underlying / kind / book."""
    positions = _positions()
    if not positions:
        return {"base_currency": BASE, "positions": [], "totals": None, "by_underlying": [], "by_kind": [], "by_book": []}
    t0 = time.perf_counter()
    snap, info = build_snapshot(_tickers(positions))
    vals = value_book(positions, snap)
    tot = aggregate(vals, lambda v: "total")
    return {
        "base_currency": BASE, "valuation_date": snap.valuation_date.isoformat(), "eurusd": info["eurusd"],
        "vol_source": info["vol_source"], "elapsed_ms": (time.perf_counter() - t0) * 1000,
        "positions": _valuation_rows(vals),
        "totals": tot[0] if tot else None,
        "by_underlying": aggregate(vals, lambda v: v.position.ticker or f"Taux {v.currency}"),
        "by_kind": aggregate(vals, lambda v: v.position.kind),
        "by_book": aggregate(vals, lambda v: v.position.book),
    }


@lru_cache(maxsize=8)
def _risk(version: str):
    positions = _positions()
    tickers = _tickers(positions)
    snap, _ = build_snapshot(tickers)
    vals = value_book(positions, snap)
    db = services.get_db()

    # aligned daily log-returns for historical VaR (last 2 years, common dates)
    closes = {}
    for t in tickers:
        h = db.spot_history(t)
        closes[t] = h.set_index(h.date.dt.date).close.astype(float)
    frame = pd.DataFrame(closes).dropna()
    rets = np.log(frame).diff().dropna()
    var = historical_var(vals, {t: rets[t].to_numpy() for t in rets.columns}, snap.spots)
    if var.get("worst_scenarios"):
        for w in var["worst_scenarios"]:
            w["date"] = str(rets.index[w["index"]])

    prev, _ = build_snapshot(tickers, previous_close=True)
    explain = pnl_explain(positions, prev, snap)
    return {"stress": stress_grid(positions, snap), "var": var, "pnl_explain": explain,
            "history_days": int(len(rets)), "base_currency": BASE}


@router.get("/risk")
def risk():
    """Full-revaluation stress grid (spot x vol, rates), historical & parametric 1-day VaR, P&L explain."""
    positions = _positions()
    if not positions:
        raise HTTPException(404, "portefeuille vide")
    db = services.get_db()
    stamp = db.query("SELECT MAX(date) AS d FROM spot_prices")["d"].iloc[0]
    version = f"{[(p.id, p.quantity) for p in positions]}|{stamp}"
    return _risk(version)


class PositionIn(BaseModel):
    kind: Literal["equity", "option", "barrier", "autocall", "bond", "future"]
    quantity: float
    ticker: str | None = None
    params: dict = Field(default_factory=dict)
    entry_price: float | None = None
    book: str = "Principal"
    label: str = ""


@router.post("/positions")
def add_position(p: PositionIn):
    """Add a position. Without an entry price, the current model price is used (P&L starts at 0)."""
    if p.kind != "bond" and not p.ticker:
        raise HTTPException(422, "ticker requis")
    if p.kind == "autocall":
        p.params.setdefault("start_date", date.today().isoformat())
        if "initial_level" not in p.params:
            snap, _ = build_snapshot([p.ticker])
            p.params["initial_level"] = snap.spots[p.ticker]
    entry = p.entry_price
    if entry is None:
        tickers = [p.ticker] if p.ticker else []
        snap, _ = build_snapshot(tickers)
        val = value_book([Position(None, p.kind, p.quantity, p.ticker, p.params)], snap)[0]
        if val.error:
            raise HTTPException(422, val.error)
        entry = val.unit_price
    pid = services.get_db().add_position(p.kind, p.quantity, p.params, p.ticker, entry, p.book, p.label)
    _risk.cache_clear()
    return {"id": pid, "entry_price": entry}


@router.delete("/positions/{position_id}")
def delete_position(position_id: int):
    if not services.get_db().delete_position(position_id):
        raise HTTPException(404, "position introuvable")
    _risk.cache_clear()
    return {"deleted": position_id}


@router.delete("")
def clear():
    n = services.get_db().clear_positions()
    _risk.cache_clear()
    return {"deleted": n}


def _in_months(m: int) -> str:
    d = date.today()
    y, mo = divmod(d.month - 1 + m, 12)
    return date(d.year + y, mo + 1, min(d.day, 28)).isoformat()


@router.post("/demo")
def load_demo():
    """A diversified demo book across both markets (entry prices = today's model prices)."""
    db = services.get_db()
    db.clear_positions()
    spot = {t: db.latest_spot(t) for t in ("SPY", "AAPL", "NVDA", "MC.PA", "^STOXX50E", "^FCHI")}
    missing = [t for t, s in spot.items() if s is None]
    if missing:
        raise HTTPException(409, f"cours manquants : {missing} — lancez un rafraîchissement")
    r = lambda x: float(round(x, 0))  # noqa: E731
    demo = [
        dict(kind="equity", ticker="AAPL", quantity=300, book="Actions US", label="Ligne cœur"),
        dict(kind="equity", ticker="MC.PA", quantity=150, book="Actions EU", label="Luxe"),
        dict(kind="option", ticker="SPY", quantity=2, book="Couvertures", label="Protection indice",
             params={"strike": r(0.95 * spot["SPY"]), "expiry": _in_months(3), "option_type": "put", "exercise": "european", "multiplier": 100}),
        dict(kind="equity", ticker="NVDA", quantity=200, book="Actions US", label="Ligne semi-conducteurs"),
        dict(kind="option", ticker="NVDA", quantity=-2, book="Actions US", label="Vente de call couvert",
             params={"strike": r(1.10 * spot["NVDA"]), "expiry": _in_months(2), "option_type": "call", "exercise": "european", "multiplier": 100}),
        dict(kind="option", ticker="AAPL", quantity=3, book="Actions US", label="Put américain",
             params={"strike": r(spot["AAPL"]), "expiry": _in_months(6), "option_type": "put", "exercise": "american", "multiplier": 100}),
        dict(kind="barrier", ticker="^STOXX50E", quantity=-40, book="Structurés", label="Put down-and-in vendu",
             params={"strike": r(spot["^STOXX50E"]), "barrier": r(0.8 * spot["^STOXX50E"]), "barrier_type": "down-and-in",
                     "option_type": "put", "expiry": _in_months(12), "monitoring_per_year": 252}),
        dict(kind="autocall", ticker="^STOXX50E", quantity=1000, book="Structurés", label="Phoenix 5 ans",
             params={"maturity_years": 5, "frequency": 4, "coupon_rate": 0.02, "autocall_barrier": 1.0,
                     "coupon_barrier": 0.7, "protection_barrier": 0.6, "memory": True}),
        dict(kind="bond", quantity=200, book="Taux", label="Treasury 10 ans",
             params={"currency": "USD", "maturity": _in_months(120), "coupon_rate": 0.045, "frequency": 2}),
        dict(kind="bond", quantity=300, book="Taux", label="OAT 5 ans",
             params={"currency": "EUR", "maturity": _in_months(60), "coupon_rate": 0.03, "frequency": 1}),
        dict(kind="future", ticker="^FCHI", quantity=-1, book="Couvertures", label="Vente future CAC 40",
             params={"expiry": _in_months(3), "multiplier": 10}),
    ]
    ids = [add_position(PositionIn(**d))["id"] for d in demo]
    return {"created": len(ids)}


@router.get("/kinds")
def kinds():
    return {"kinds": list(KINDS)}
