"""Rate curves, bonds and futures."""

from __future__ import annotations

import numpy as np
from fastapi import APIRouter, HTTPException

from api import services
from api.schemas import (
    BondFutureRequest, BondRequest, BondResponse, CurveResponse, CurveSeries, EquityFutureRequest,
    FuturePriceResponse,
)
from qplat.curves import Interpolation
from qplat.instruments import BondFuture, EquityFuture, FixedRateBond
from qplat.pricers import DiscountingBondPricer, FuturesPricer

router = APIRouter(prefix="/api", tags=["rates"])

GRID = np.round(np.linspace(0.05, 30, 300), 4)


def _curve_or_404(currency: str, interpolation: str = Interpolation.LOGLINEAR_DF.value):
    curve = services.market_curve(currency, interpolation)
    if curve is None:
        raise HTTPException(404, f"no {currency} curve in database")
    return curve


@router.get("/curves/{currency}", response_model=CurveResponse)
def get_curve(currency: str):
    currency = currency.upper()
    q = services.latest_quotes(currency)
    if q.empty:
        raise HTTPException(404, f"no {currency} curve in database")
    curves = {}
    for interp in Interpolation:
        c = _curve_or_404(currency, interp.value)
        curves[interp.value] = CurveSeries(
            zero=c.zero_rate(GRID).tolist(),
            forward=c.forward_rate(GRID[:-1], GRID[1:]).tolist() + [None],
            discount=c.discount(GRID).tolist(),
        )
    return CurveResponse(
        currency=currency, asof=str(q["asof"].iloc[0]), source=str(q.source.iloc[0]),
        quote_type=str(q.quote_type.iloc[0]),
        quotes=[{"tenor": float(t), "rate": float(r)} for t, r in zip(q.tenor_years, q.rate)],
        grid=GRID.tolist(), curves=curves,
    )


@router.get("/curves/{currency}/history")
def curve_history(currency: str):
    h = services.get_db().rate_history(currency.upper())
    if h.empty:
        return {"dates": [], "series": {}}
    piv = h.pivot_table(index="asof", columns="tenor_years", values="rate").sort_index()
    return {
        "dates": piv.index.tolist(),
        "series": {f"{t:g}": [None if np.isnan(v) else float(v) for v in piv[t]] for t in piv.columns},
    }


def _bond(req: BondRequest) -> FixedRateBond:
    return FixedRateBond(maturity=req.maturity, coupon_rate=req.coupon_rate, frequency=req.frequency)


@router.post("/bonds/analytics", response_model=BondResponse)
def bond_analytics(req: BondRequest):
    curve = _curve_or_404(req.currency)
    bond = _bond(req)
    a = DiscountingBondPricer(curve).analytics(bond)
    times, amounts = bond.cashflows()
    dfs = curve.discount(times)
    return BondResponse(
        dirty_price=a.dirty_price, clean_price=a.clean_price, accrued=a.accrued, ytm=a.ytm,
        macaulay_duration=a.macaulay_duration, modified_duration=a.modified_duration, convexity=a.convexity,
        dv01=a.dv01,
        cashflows=[{"time": float(t), "amount": float(c), "discount": float(d), "pv": float(c * d)}
                   for t, c, d in zip(times, amounts, dfs)],
    )


@router.post("/futures/equity", response_model=FuturePriceResponse)
def equity_future(req: EquityFutureRequest):
    db = services.get_db()
    tickers = db.tickers()
    spot = db.latest_spot(req.ticker)
    if spot is None:
        raise HTTPException(404, f"no price for {req.ticker}")
    ccy = services.ticker_currency(req.ticker, tickers)
    row = tickers[tickers.ticker == req.ticker]
    q = float(row.dividend_yield.iloc[0]) if not row.empty and row.dividend_yield.notna().iloc[0] else 0.0
    price = FuturesPricer(_curve_or_404(ccy)).price(EquityFuture(spot=spot, maturity=req.maturity, dividend_yield=q))
    return FuturePriceResponse(price=price, basis=price - spot, curve_currency=ccy)


@router.post("/futures/bond", response_model=FuturePriceResponse)
def bond_future(req: BondFutureRequest):
    if req.delivery >= req.maturity:
        raise HTTPException(422, "delivery must be before bond maturity")
    fut = BondFuture(bond=_bond(req), delivery=req.delivery, conversion_factor=req.conversion_factor)
    return FuturePriceResponse(price=FuturesPricer(_curve_or_404(req.currency)).price(fut), curve_currency=req.currency)
