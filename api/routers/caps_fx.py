"""Interest rate options (caps / floors) and FX options (Garman-Kohlhagen, delta-quoted smile)."""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Literal, Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from qplat.data.market import FX_TICKERS, realized_vol
from qplat.fx import FXMarket, build_smile, delta_of_strike, gk_greeks, risk_neutral_density, strike_from_delta
from qplat.pricers.capfloor import CapFloor, capfloor_greeks, implied_flat_vol, price_capfloor, swap_value

router = APIRouter(prefix="/api", tags=["rate & fx options"])


def _curve(currency: str):
    curve = services.market_curve(currency)
    if curve is None:
        raise HTTPException(409, f"pas de courbe {currency} en base — lancez le rafraîchissement des taux")
    return curve


def _curves_version() -> str:
    parts = []
    for c in ("USD", "EUR"):
        q = services.latest_quotes(c)
        parts.append("" if q.empty else f"{q.source.iloc[0]}:{q['asof'].iloc[0]}")
    return "|".join(parts)


# ----------------------------------------------------------------------------- caps & floors

class CapRequest(BaseModel):
    currency: Literal["USD", "EUR"] = "USD"
    maturity: float = Field(5.0, gt=0.2, le=30)
    frequency: Literal[1, 2, 4, 12] = 4
    strike: Optional[float] = Field(None, description="None = ATM (forward swap rate)")
    kind: Literal["cap", "floor"] = "cap"
    model: Literal["black", "bachelier"] = "bachelier"
    vol: float = Field(0.01, gt=0, le=5, description="Black: lognormal vol; Bachelier: normal vol (0.01 = 100 bp)")
    notional: float = Field(10_000_000, gt=0)
    market_price: Optional[float] = Field(None, gt=0, description="to back out the flat vol")


def _caps(req: CapRequest) -> dict:
    curve = _curve(req.currency)
    probe = CapFloor(maturity=req.maturity, strike=0.01, kind=req.kind, frequency=req.frequency, notional=req.notional)
    try:
        start, end = probe.periods()
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    atm = price_capfloor(probe, curve, req.vol, "bachelier").atm_strike
    strike = atm if req.strike is None else req.strike
    cap = CapFloor(maturity=req.maturity, strike=strike, kind=req.kind, frequency=req.frequency, notional=req.notional)
    try:
        res = price_capfloor(cap, curve, req.vol, req.model)
        g = capfloor_greeks(cap, curve, req.vol, req.model)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    other = CapFloor(maturity=req.maturity, strike=strike, kind="floor" if req.kind == "cap" else "cap",
                     frequency=req.frequency, notional=req.notional)
    other_price = price_capfloor(other, curve, req.vol, req.model).price
    implied = None
    if req.market_price:
        try:
            implied = implied_flat_vol(cap, curve, req.market_price, req.model)
        except ValueError:
            implied = None

    # price of cap and floor across strikes (ATM +- 300 bp), same vol
    strikes = np.round(atm + np.linspace(-0.03, 0.03, 61), 6)
    profile = {"strike": [], "cap": [], "floor": []}
    for k in strikes:
        if req.model == "black" and k <= 0:
            continue
        profile["strike"].append(float(k))
        for kind in ("cap", "floor"):
            c = CapFloor(maturity=req.maturity, strike=float(k), kind=kind, frequency=req.frequency, notional=req.notional)
            profile[kind].append(price_capfloor(c, curve, req.vol, req.model).price)
    return {
        "strike": strike, "atm_strike": atm, "annuity": res.annuity * req.notional,
        "price": res.price, "price_pct": res.price / req.notional,
        "running_bp": res.price / (res.annuity * req.notional) * 1e4,
        "greeks": g.__dict__,
        "parity": {"other_kind": other.kind, "other_price": other_price, "swap_value": swap_value(cap, curve)},
        "implied_vol": implied,
        "caplets": [c.__dict__ for c in res.caplets],
        "profile": profile,
    }


@lru_cache(maxsize=128)
def _caps_cached(payload: str, _v: str) -> dict:
    return _caps(CapRequest.model_validate_json(payload))


@router.post("/caps/price")
def price_caps(req: CapRequest):
    """Cap or floor on the stored curve: caplet strip, Greeks, parity, price profile across strikes."""
    return _caps_cached(req.model_dump_json(), _curves_version())


# ----------------------------------------------------------------------------- FX

PAIR = "EURUSD"   # foreign EUR, domestic USD
TENORS = (("1M", 1 / 12), ("3M", 0.25), ("6M", 0.5), ("1A", 1.0), ("2A", 2.0))


def _fx_spot() -> tuple[float, str, np.ndarray]:
    h = services.get_db().spot_history(FX_TICKERS[PAIR])
    if h.empty:
        raise HTTPException(409, "pas de cours EUR/USD en base — lancez le rafraîchissement des taux")
    return float(h.close.iloc[-1]), h.date.iloc[-1].strftime("%Y-%m-%d"), h.close.astype(float).to_numpy()


@router.get("/fx/market")
def fx_market():
    """EUR/USD spot, realised vols, domestic / foreign rates and forward points by tenor."""
    spot, asof, closes = _fx_spot()
    usd, eur = _curve("USD"), _curve("EUR")
    rows = []
    for label, T in TENORS:
        rd, rf = float(usd.zero_rate(T)), float(eur.zero_rate(T))
        fwd = spot * math.exp((rd - rf) * T)
        rows.append({"tenor": label, "T": T, "rd": rd, "rf": rf, "forward": fwd, "points": (fwd - spot) * 1e4})
    series = pd.Series(closes)
    rv = {k: (float(realized_vol(series, n)) if len(closes) > n else None) for k, n in (("1M", 21), ("3M", 63), ("1A", 252))}
    return {"pair": PAIR, "spot": spot, "asof": asof, "realized_vol": rv, "tenors": rows,
            "history": closes[-260:].tolist()}


class FXRequest(BaseModel):
    expiry: float = Field(0.5, gt=1 / 365, le=5)
    atm: float = Field(0.075, gt=0, le=1)
    rr25: float = Field(0.003, ge=-0.2, le=0.2)
    bf25: float = Field(0.0025, ge=-0.05, le=0.2)
    convention: Optional[Literal["spot", "forward"]] = None
    # option
    option_type: Literal["call", "put"] = "call"
    strike_mode: Literal["strike", "delta", "atm"] = "delta"
    strike: Optional[float] = Field(None, gt=0)
    delta: float = Field(0.25, gt=0, lt=1)
    notional: float = Field(10_000_000, gt=0, description="in EUR")
    spot: Optional[float] = Field(None, gt=0, description="override of the stored spot")


def _fx(req: FXRequest) -> dict:
    spot = req.spot or _fx_spot()[0]
    usd, eur = _curve("USD"), _curve("EUR")
    T = req.expiry
    m = FXMarket(spot, T, float(usd.zero_rate(T)), float(eur.zero_rate(T)))
    try:
        smile = build_smile(m, req.atm, req.rr25, req.bf25, req.convention)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    phi = 1 if req.option_type == "call" else -1
    conv = smile.convention

    # strike: given, from a delta (solved on the smile: delta and vol depend on each other) or ATM
    if req.strike_mode == "strike" and req.strike:
        K = req.strike
    elif req.strike_mode == "atm":
        K = smile.pillars["ATM"]["strike"]
    else:
        vol = req.atm
        for _ in range(50):
            K = strike_from_delta(m, req.delta, vol, phi, conv)
            new = smile.vol(K) or vol
            if abs(new - vol) < 1e-12:
                break
            vol = new
    vol_smile = smile.vol(K)
    if vol_smile is None:
        raise HTTPException(422, "strike trop éloigné : le smile Vanna-Volga n'y est pas défini")
    g = gk_greeks(spot, K, T, m.rd, m.rf, vol_smile, phi)
    g_atm = gk_greeks(spot, K, T, m.rd, m.rf, req.atm, phi)
    N = req.notional
    greeks = {
        "price_usd": g.price * N, "price_pips": g.price * 1e4, "price_pct_eur": g.price / spot,
        "price_atm_vol_usd": g_atm.price * N,
        "delta_spot_eur": g.delta_spot * N, "delta_forward_eur": g.delta_forward * N,
        "delta_pa_eur": g.delta_premium_adjusted * N, "delta_spot": g.delta_spot,
        "gamma_eur_1pct": g.gamma * spot * 0.01 * N,        # change of EUR delta for a 1% spot move
        "vega_usd": g.vega * 0.01 * N, "vanna_usd": g.vanna * 0.01 * spot * 0.01 * N, "volga_usd": g.volga * 1e-4 * N,
        "theta_usd": g.theta / 365 * N, "rho_usd": g.rho_domestic * 0.01 * N, "rho_eur": g.rho_foreign * 0.01 * N,
    }
    # smile on a strike grid from the 5-delta put to the 5-delta call
    lo = strike_from_delta(m, 0.05, smile.atm + smile.bf25_smile, -1, conv)
    hi = strike_from_delta(m, 0.05, smile.atm + smile.bf25_smile, 1, conv)
    grid = np.linspace(lo, hi, 81)
    vv = [smile.vol(float(k)) for k in grid]
    curve = {
        "strike": grid.tolist(), "vol": vv,
        "vol_first_order": [smile.vv.vol_first_order(float(k)) for k in grid],
        "call_delta": [None if v is None else delta_of_strike(m, float(k), v, 1, conv) for k, v in zip(grid, vv)],
        "density": risk_neutral_density(smile, grid).tolist(),
    }
    return {
        "market": {"spot": spot, "forward": m.forward, "rd": m.rd, "rf": m.rf, "T": T, "convention": conv},
        "smile": {"atm": smile.atm, "rr25": smile.rr25, "bf25_market": smile.bf25_market, "bf25_smile": smile.bf25_smile,
                  "pillars": smile.pillars, "market_strangle": smile.market_strangle, "curve": curve},
        "option": {"strike": K, "vol": vol_smile, "atm_vol": req.atm, "option_type": req.option_type,
                   "delta": delta_of_strike(m, K, vol_smile, phi, conv), "greeks": greeks,
                   "smile_effect_usd": greeks["price_usd"] - greeks["price_atm_vol_usd"]},
    }


@lru_cache(maxsize=128)
def _fx_cached(payload: str, _v: str, _spot: str) -> dict:
    return _fx(FXRequest.model_validate_json(payload))


@router.post("/fx/price")
def price_fx(req: FXRequest):
    """EUR/USD smile from ATM / 25D RR / 25D BF (Vanna-Volga) and one option priced on it, with Greeks."""
    spot_key = "" if req.spot else _fx_spot()[1]
    return _fx_cached(req.model_dump_json(), _curves_version(), spot_key)
