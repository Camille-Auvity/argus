"""Variance and volatility swaps: replication on the fitted smile, model comparison, VIX recomputation,
variance risk premium."""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Optional

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from api import services
from api.routers.models import _chain_version, _heston, _market, _surface
from qplat.data.market import VOL_INDEX_TICKERS
from qplat.models.heston import HestonPathModel
from qplat.models.svi import LocalVolPathModel
from qplat.pricers.paths import gbm_paths, standard_normals
from qplat.pricers.variance import (
    heston_expected_variance, heston_realized_variance_mc, listed_variance, path_realized_variance,
    realized_variance, replicate_variance, value_variance_swap, vix_from_chain, vol_swap_convexity,
)

router = APIRouter(prefix="/api/variance", tags=["variance swaps"])


def _vol_fn(surface, T: float):
    return lambda k: np.asarray(surface.implied_vol(np.asarray(k, float), T), float)


# ----------------------------------------------------------------------------- term structure

@lru_cache(maxsize=16)
def _term(ticker: str, asof: str) -> dict:
    smile, spot, q, curve = _market(ticker, asof)
    surface = _surface(ticker, asof)
    p = _heston(ticker, asof).result.params
    rows = []
    for s in surface.slices:
        T = float(s.T)
        rep = replicate_variance(_vol_fn(surface, T), T, float(surface.forward(T)))
        atm = float(surface.implied_vol(0.0, T))
        rows.append({"T": T, "days": int(round(T * 365)), "fair_vol": rep.vol, "fair_variance": rep.variance,
                     "atm_vol": atm, "skew_premium": rep.vol - atm, "put_share": rep.put_share,
                     "heston_vol": math.sqrt(heston_expected_variance(p.v0, p.kappa, p.theta, T))})
    return {"asof": asof, "spot": spot, "rows": rows}


@router.get("/{ticker}/term")
def term_structure(ticker: str):
    """Fair variance strike of every listed expiry (replication on the SVI surface) vs ATM vol and Heston."""
    return _term(ticker, _chain_version(ticker))


# ----------------------------------------------------------------------------- one swap

class SwapRequest(BaseModel):
    maturity_days: int = Field(91, ge=7, le=730)
    vega_notional: float = Field(100_000, gt=0, description="P&L per vol point of realised vol around the strike")
    strike_vol: Optional[float] = Field(None, gt=0, le=3, description="None = fair strike")
    elapsed_days: int = Field(0, ge=0, description="seasoned swap: days already elapsed of the total maturity")
    n_paths: int = Field(20_000, ge=2_000, le=100_000)


def _swap(ticker: str, asof: str, req: SwapRequest) -> dict:
    smile, spot, q, curve = _market(ticker, asof)
    surface = _surface(ticker, asof)
    fit = _heston(ticker, asof).result.params
    T_total = req.maturity_days / 365.0
    elapsed = min(req.elapsed_days, req.maturity_days - 1)
    T = (req.maturity_days - elapsed) / 365.0          # remaining life
    F = float(surface.forward(T))
    rep = replicate_variance(_vol_fn(surface, T), T, F)
    atm = float(surface.implied_vol(0.0, T))

    # listed-strike replication (CBOE formula) on the expiry closest to the remaining maturity
    chain = services.get_db().latest_option_chain(ticker)
    listed = None
    if not chain.empty:
        exp_days = {e: (pd.Timestamp(e) - pd.Timestamp(asof[:10])).days for e in chain.expiry.unique()}
        e_best = min(exp_days, key=lambda e: abs(exp_days[e] - T * 365))
        Te = exp_days[e_best] / 365.0
        try:
            lr = listed_variance(chain[chain.expiry == e_best], Te, float(curve.zero_rate(Te)), spot)
            surf = replicate_variance(_vol_fn(surface, Te), Te, float(surface.forward(Te)))
            listed = {"expiry": e_best, "days": exp_days[e_best], "listed_vol": math.sqrt(max(lr.variance, 0.0)),
                      "surface_vol": surf.vol, "n_strikes": lr.n_strikes,
                      "strikes": lr.strikes.tolist(), "contributions": lr.contributions.tolist(), "forward": lr.forward}
        except ValueError:
            listed = None

    # models: Heston (closed-form expected variance + MC distribution of realised variance), local vol and BS (MC)
    rv_h = heston_realized_variance_mc(fit.v0, fit.kappa, fit.theta, fit.sigma, T, n_paths=req.n_paths)
    n_steps = max(int(round(T * 252)), 2)
    times = T * np.arange(1, n_steps + 1) / n_steps
    lv_paths = LocalVolPathModel(surface, steps_per_year=252).simulate(spot, q, curve, times, req.n_paths, 11, True)
    rv_lv = path_realized_variance(lv_paths, spot, T)
    hs_paths = HestonPathModel(fit, steps_per_year=252).simulate(spot, q, curve, times, req.n_paths, 13, True)
    rv_hd = path_realized_variance(hs_paths, spot, T)
    bs_paths = gbm_paths(spot, atm, q, curve, times, standard_normals(req.n_paths, n_steps, 17, True))
    rv_bs = path_realized_variance(bs_paths, spot, T)

    def row(name, var, samples=None, note=""):
        out = {"model": name, "fair_vol": math.sqrt(var), "note": note, "vol_swap": None, "convexity": None,
               "std_realized_vol": None}
        if samples is not None:
            out["vol_swap"] = float(np.sqrt(samples).mean())
            out["convexity"] = out["fair_vol"] - out["vol_swap"]
            out["std_realized_vol"] = float(np.sqrt(samples).std())
        return out

    models = [
        row("Réplication sur le smile (SVI)", rep.variance, note="sans modèle : seul le smile du jour"),
        row("Black-Scholes (vol ATM)", float(rv_bs.mean()), rv_bs, "vol constante : swap de vol = swap de variance"),
        row("Heston (formule fermée)", heston_expected_variance(fit.v0, fit.kappa, fit.theta, T), rv_h,
            "E[∫v dt]/T ; swap de vol par Monte Carlo"),
        row("Heston (MC, rendements quotidiens)", float(rv_hd.mean()), rv_hd, "variance réalisée échantillonnée"),
        row("Volatilité locale (MC)", float(rv_lv.mean()), rv_lv, "doit retrouver la réplication"),
    ]
    approx = vol_swap_convexity(float(rv_h.mean()), float(rv_h.var()))

    # realised part of a seasoned swap: the last `elapsed` trading days of the stored history
    hist = services.get_db().spot_history(ticker)
    realized_so_far = 0.0
    if elapsed > 0 and len(hist) > 2:
        n_obs = max(int(round(elapsed * 252 / 365)), 2)
        realized_so_far = math.sqrt(realized_variance(hist.close.astype(float).tail(n_obs + 1)))
    # default contract strike: the fair vol of the whole period, mixing what is realised and what is implied
    strike = req.strike_vol or (math.sqrt((elapsed / req.maturity_days) * realized_so_far**2
                                          + (1 - elapsed / req.maturity_days) * rep.variance) if elapsed else rep.vol)
    val = value_variance_swap(req.vega_notional, strike, rep.vol, T_total, elapsed / 365.0, realized_so_far,
                              float(curve.discount(T)))
    return {
        "asof": asof, "spot": spot, "T": T, "T_total": T_total, "atm_vol": atm,
        "fair_vol": rep.vol, "fair_variance": rep.variance, "put_share": rep.put_share,
        "replication": {"k": rep.k[::8].tolist(), "density": rep.density[::8].tolist(), "F": F},
        "listed": listed,
        "models": models,
        "heston": {"v0": fit.v0, "kappa": fit.kappa, "theta": fit.theta, "sigma": fit.sigma, "rho": fit.rho,
                   "convexity_approx_vol": approx},
        "realized_vol_distribution": {
            "heston": np.histogram(np.sqrt(rv_h), bins=40)[0].tolist(),
            "edges": np.histogram(np.sqrt(rv_h), bins=40)[1].tolist(),
        },
        "contract": {"strike_vol": strike, "realized_vol_so_far": realized_so_far, "elapsed_days": elapsed,
                     "variance_notional": val.variance_notional, "value": val.value, "vega": val.vega,
                     "expected_variance_pts": val.expected_variance_pts, "profile": val.payoff_profile},
    }


@lru_cache(maxsize=32)
def _swap_cached(ticker: str, asof: str, payload: str) -> dict:
    return _swap(ticker, asof, SwapRequest.model_validate_json(payload))


@router.post("/{ticker}/swap")
def price_swap(ticker: str, req: SwapRequest):
    """Fair variance strike by replication, listed-strike check, Heston / local vol / BS, vol swap convexity, MTM."""
    return _swap_cached(ticker, _chain_version(ticker), req.model_dump_json())


# ----------------------------------------------------------------------------- VIX and variance risk premium

def _history(ticker: str) -> pd.Series:
    h = services.get_db().spot_history(ticker)
    return pd.Series(h.close.astype(float).to_numpy(), index=h.date.dt.strftime("%Y-%m-%d").to_numpy())


@lru_cache(maxsize=4)
def _vrp(_stamp: str) -> dict:
    vix = _history(VOL_INDEX_TICKERS["VIX"])
    spy = _history("SPY")
    if vix.empty or spy.empty:
        raise HTTPException(409, "pas d'historique VIX / SPY en base — lancez le rafraîchissement des taux")
    # daily closes only (intraday snapshots share the date of the last close)
    vix = vix[~vix.index.duplicated(keep="last")]
    spy = spy[~spy.index.duplicated(keep="last")]
    rets = np.log(spy).diff()
    fwd = 21
    # realised variance over the NEXT 21 trading days, annualised (what a 1-month variance swap struck today pays)
    rv_next = (rets.pow(2).rolling(fwd).sum().shift(-fwd) * 252 / fwd).dropna()
    rv_past = (rets.pow(2).rolling(fwd).sum() * 252 / fwd)
    dates = [d for d in vix.index if d in rv_next.index]
    implied = np.array([vix[d] / 100 for d in dates])
    realized = np.array([math.sqrt(rv_next[d]) for d in dates])
    pnl_pts = (implied * 100) ** 2 - (realized * 100) ** 2           # short variance swap, per unit variance notional
    # monthly short variance swap with 1 vol point of vega notional at inception: N_var = 1 / (2 K)
    monthly = []
    for i in range(0, len(dates), fwd):
        k = implied[i] * 100
        monthly.append({"date": dates[i], "strike": k, "realized": realized[i] * 100,
                        "pnl": (k**2 - (realized[i] * 100) ** 2) / (2 * k)})
    m = np.array([x["pnl"] for x in monthly])
    return {
        "series": {"date": list(vix.index), "vix": vix.round(3).tolist(),
                   "realized_past": [None if not np.isfinite(rv_past.get(d, np.nan)) else round(100 * math.sqrt(rv_past[d]), 3)
                                     for d in vix.index]},
        "aligned": {"date": dates, "implied": (100 * implied).round(3).tolist(), "realized_next": (100 * realized).round(3).tolist(),
                    "premium_pts2": pnl_pts.round(2).tolist()},
        "monthly": monthly,
        "summary": {
            "n_days": len(dates), "mean_implied": float(100 * implied.mean()), "mean_realized": float(100 * realized.mean()),
            "share_implied_above": float((implied > realized).mean()),
            "mean_premium_vol_pts": float(100 * (implied - realized).mean()),
            "monthly_hit_rate": float((m > 0).mean()) if len(m) else None,
            "monthly_mean_pnl": float(m.mean()) if len(m) else None,
            "monthly_worst_pnl": float(m.min()) if len(m) else None,
        },
    }


@router.get("/vrp")
def variance_risk_premium():
    """VIX (30-day implied) vs the realised vol of SPY over the following 21 trading days, on the stored history."""
    db = services.get_db()
    stamp = str(db.latest_spot(VOL_INDEX_TICKERS["VIX"])) + str(db.latest_spot("SPY"))
    return _vrp(stamp)


@lru_cache(maxsize=4)
def _vix_check(asof_key: str) -> dict:
    db = services.get_db()
    q = db.query("SELECT * FROM option_quotes WHERE ticker='SPY'")
    if q.empty:
        raise HTTPException(404, "aucune chaîne SPY en base")
    q["day"] = q["asof"].str[:10]
    curve = services.market_curve("USD")
    if curve is None:
        raise HTTPException(409, "pas de courbe USD")
    vix = _history(VOL_INDEX_TICKERS["VIX"])
    vix = vix[~vix.index.duplicated(keep="last")]
    rows = []
    for day, asof in q.groupby("day")["asof"].max().items():
        try:
            res = vix_from_chain(q[q["asof"] == asof], pd.Timestamp(asof), lambda T: float(curve.zero_rate(T)))
        except ValueError:
            res = None
        if res:
            rows.append({"date": day, "argus": res["vix"], "vix": float(vix[day]) if day in vix.index else None,
                         "near_days": res["near_days"], "next_days": res["next_days"],
                         "strikes": res["near_strikes"] + res["next_strikes"]})
    diffs = np.array([r["argus"] - r["vix"] for r in rows if r["vix"] is not None])
    return {"rows": rows, "summary": {"n": int(len(diffs)), "mean_abs_gap": float(np.abs(diffs).mean()) if len(diffs) else None,
                                      "median_abs_gap": float(np.median(np.abs(diffs))) if len(diffs) else None}}


@router.get("/vix-check")
def vix_check():
    """The CBOE VIX formula applied to each stored SPY option chain, against the official VIX close."""
    return _vix_check(_chain_version("SPY"))
