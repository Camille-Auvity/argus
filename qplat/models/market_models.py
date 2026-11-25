"""Glue between market smiles and the volatility models: Heston calibration,
SVI surface / local vol, and exotic prices compared across models."""

from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
import pandas as pd

from qplat.curves.rate_curve import RateCurve
from qplat.instruments import Autocallable, BarrierOption
from qplat.models.heston import CalibrationResult, HestonParams, HestonPathModel, calibrate_heston, heston_implied_vols
from qplat.models.svi import LocalVolPathModel, VolSurface, build_surface
from qplat.pricers import AnalyticBarrierPricer, MonteCarloAutocallPricer, MonteCarloBarrierPricer


def calibration_points(smile: pd.DataFrame, min_days: float = 14.0, width: float = 0.35,
                       per_expiry: int = 25) -> pd.DataFrame:
    """Liquid part of the smile: T >= min_days, |ln K/S| <= max(0.08, width * sqrt(T)), evenly subsampled."""
    if smile.empty:
        return smile
    k = np.log(smile["moneyness"])
    keep = (smile["T"] >= min_days / 365) & (np.abs(k) <= np.maximum(0.08, width * np.sqrt(smile["T"])))
    pts = smile[keep]
    parts = []
    for _, g in pts.groupby("expiry"):
        idx = np.unique(np.linspace(0, len(g) - 1, min(len(g), per_expiry)).astype(int))
        parts.append(g.iloc[idx])
    return pd.concat(parts) if parts else pts


@dataclass
class HestonFit:
    result: CalibrationResult
    points: pd.DataFrame          # calibration points with model IV
    curves: list[dict]            # per expiry: market points and model smile on a fine grid
    elapsed_s: float


def fit_heston(smile: pd.DataFrame, spot: float, q: float, curve: RateCurve) -> HestonFit:
    pts = calibration_points(smile)
    if len(pts) < 10:
        raise ValueError("not enough liquid options to calibrate Heston")
    rates = np.array([float(curve.zero_rate(t)) for t in pts["T"]])
    t0 = time.perf_counter()
    res = calibrate_heston(spot, pts["strike"], pts["T"], pts["option_type"], pts["iv"], rates, q)
    elapsed = time.perf_counter() - t0
    pts = pts.assign(model_iv=pts["iv"].to_numpy() + res.errors_vol)

    curves = []
    for exp, g in pts.groupby("expiry"):
        T = float(g["T"].iloc[0])
        r = float(curve.zero_rate(T))
        all_mkt = smile[smile["expiry"] == exp]
        # model smile over every quoted strike: shows how Heston extrapolates beyond the calibration zone
        k_grid = np.linspace(all_mkt["strike"].min(), all_mkt["strike"].max(), 60)
        model = heston_implied_vols(spot, k_grid, T, r, q, res.params)
        curves.append({
            "expiry": exp, "T": T, "days": int(round(T * 365)),
            "market": {"strike": all_mkt["strike"].tolist(), "iv": all_mkt["iv"].tolist()},
            "calibrated_on": {"strike": g["strike"].tolist(), "iv": g["iv"].tolist()},
            "model": {"strike": k_grid.tolist(), "iv": [None if not np.isfinite(v) else float(v) for v in model]},
            "rmse_vol": float(np.sqrt(np.nanmean((g["model_iv"] - g["iv"]) ** 2))),
        })
    return HestonFit(res, pts, curves, elapsed)


def _finite_or_none(values) -> list:
    """JSON has no NaN: arbitrage holes in the local vol become null."""
    return [float(v) if np.isfinite(v) else None for v in np.asarray(values, float)]


def surface_payload(surface: VolSurface, smile: pd.DataFrame) -> dict:
    """Everything the UI needs: slices, fits vs market, arbitrage report, implied & local vol grids."""
    k_grid = np.round(np.linspace(-0.3, 0.3, 61), 4)
    t_grid = np.round(np.unique(np.concatenate([np.linspace(surface.times[0], surface.times[-1], 40), surface.times])), 5)
    implied = surface.grid(k_grid, t_grid, "implied")
    local = surface.grid(k_grid, t_grid, "local")
    slices = []
    for s in surface.slices:
        fwd = float(surface.forward(s.T))
        mkt = smile[np.isclose(smile["T"], s.T)]
        k_mkt = np.log(mkt["strike"].to_numpy(float) / fwd)
        kk = np.linspace(min(k_mkt.min(), -0.2) if len(k_mkt) else -0.2, max(k_mkt.max(), 0.2) if len(k_mkt) else 0.2, 80)
        slices.append({
            **s.params(), "days": int(round(s.T * 365)), "forward": fwd,
            "market": {"k": k_mkt.tolist(), "iv": mkt["iv"].tolist()},
            "fit": {"k": kk.tolist(), "iv": _finite_or_none(s.implied_vol(kk)), "local": _finite_or_none(surface.local_vol(kk, s.T))},
        })
    clean = lambda a: [[None if not np.isfinite(v) else round(float(v), 5) for v in row] for row in a]  # noqa: E731
    return {
        "slices": slices,
        "arbitrage": surface.arbitrage_report(),
        "grid": {"k": k_grid.tolist(), "T": t_grid.tolist(), "implied": clean(implied), "local": clean(local)},
    }


# ----------------------------------------------------------------------------- exotics under each model

def compare_exotics(spot: float, q: float, curve: RateCurve, heston: HestonParams, surface: VolSurface,
                    barrier: dict, autocall: dict, n_paths: int = 40_000) -> dict:
    """Same products priced under flat Black-Scholes vol, Heston and Dupire local vol.

    The Black-Scholes vol is the surface's ATM implied vol at the product maturity, so the
    differences isolate the smile / vol dynamics effect."""
    hm = HestonPathModel(heston, steps_per_year=252)
    lm = LocalVolPathModel(surface, steps_per_year=252)

    # barrier
    T = barrier["expiry"]
    atm_vol = float(surface.implied_vol(0.0, T))
    b = BarrierOption(spot=spot, vol=atm_vol, rate=curve, dividend_yield=q, strike=barrier["strike"], expiry=T,
                      barrier=barrier["barrier"], barrier_type=barrier["barrier_type"],
                      option_type=barrier["option_type"], monitoring_per_year=252)
    barrier_rows = []
    for label, pricer in [
        ("Black-Scholes (vol ATM)", MonteCarloBarrierPricer(n_paths=n_paths)),
        ("Heston", MonteCarloBarrierPricer(n_paths=n_paths, model=hm)),
        ("Volatilité locale", MonteCarloBarrierPricer(n_paths=n_paths, model=lm)),
    ]:
        t0 = time.perf_counter()
        price, se = pricer.price_with_error(b)
        barrier_rows.append({"model": label, "price": price, "std_error": se, "elapsed_ms": (time.perf_counter() - t0) * 1000})
    barrier_rows.insert(0, {"model": "BS formule fermée (BGK)", "price": AnalyticBarrierPricer().price(b),
                            "std_error": None, "elapsed_ms": None})

    # autocall
    a = Autocallable.regular(autocall["maturity"], autocall["frequency"], spot=spot, vol=float(surface.implied_vol(0.0, autocall["maturity"])),
                             rate=curve, dividend_yield=q, coupon_rate=autocall["coupon_rate"],
                             autocall_barrier=autocall["autocall_barrier"], coupon_barrier=autocall["coupon_barrier"],
                             protection_barrier=autocall["protection_barrier"], memory=autocall.get("memory", True))
    autocall_rows = []
    for label, model in [("Black-Scholes (vol ATM)", None), ("Heston", hm), ("Volatilité locale", lm)]:
        t0 = time.perf_counter()
        an = MonteCarloAutocallPricer(n_paths=n_paths, model=model).analyze(a)
        autocall_rows.append({"model": label, "price": an.price, "std_error": an.std_error,
                              "loss_probability": an.loss_probability, "expected_life": an.expected_life,
                              "redemption_probabilities": an.redemption_probabilities.tolist(),
                              "elapsed_ms": (time.perf_counter() - t0) * 1000})
    return {"barrier": {"atm_vol": atm_vol, "rows": barrier_rows},
            "autocall": {"atm_vol": float(surface.implied_vol(0.0, autocall["maturity"])),
                         "observation_times": list(a.observation_times), "rows": autocall_rows}}


def fit_surface(smile: pd.DataFrame, spot: float, q: float, curve: RateCurve) -> VolSurface:
    return build_surface(smile, spot, q, curve)

