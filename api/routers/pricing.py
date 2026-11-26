"""Pricing endpoints. Results are cached on (request, curve snapshot) so repeated
UI interactions with the same inputs are instant."""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from fastapi import APIRouter
from scipy.optimize import brentq

from api import services
from api.schemas import (
    AsianRequest, AsianResponse, AutocallRequest, AutocallResponse, BarrierRequest, BarrierResponse, CliquetRequest,
    CliquetResponse, DigitalRequest, DigitalResponse, FairCouponResponse, ProfileResponse, RateSpec, VanillaRequest,
    VanillaResponse,
)
from qplat.instruments import (
    AmericanOption, AsianOption, Autocallable, BarrierOption, CliquetOption, DigitalOption, EuropeanOption,
)
from qplat.pricers import (
    AnalyticBarrierPricer, AnalyticDigitalPricer, BinomialTreePricer, BlackScholesPricer, CliquetSpreadPricer,
    GeometricAsianPricer, LevyAsianPricer, MonteCarloAutocallPricer, MonteCarloBarrierPricer, MonteCarloExoticPricer,
    MonteCarloPricer,
)

router = APIRouter(prefix="/api/price", tags=["pricing"])


def _curve_version(spec: RateSpec) -> str:
    if spec.mode == "flat":
        return "flat"
    q = services.latest_quotes(spec.currency)
    return "" if q.empty else f"{q.source.iloc[0]}:{q['asof'].iloc[0]}"


def _cache_key(req) -> tuple[str, str]:
    return req.model_dump_json(), _curve_version(req.rate)


GREEK_SERIES = ("price", "delta", "gamma", "vega", "theta", "rho")


def _greek_profile(pricer, inst, spots: np.ndarray, keys=GREEK_SERIES) -> ProfileResponse:
    """Price and Greeks (desk units) of `inst` for each spot of the grid, by the given pricer."""
    series: dict[str, list[float]] = {k: [] for k in keys}
    for s in spots:
        g = services.scaled_greeks(pricer.greeks(inst.with_spot(float(s))))
        for k in keys:
            series[k].append(getattr(g, k))
    return ProfileResponse(spots=spots.tolist(), series=series)


def _european(req, curve, strike: float | None = None, option_type: str | None = None) -> EuropeanOption:
    return EuropeanOption(spot=req.spot, strike=strike or req.strike, expiry=req.expiry, vol=req.vol,
                          dividend_yield=req.dividend_yield, rate=curve, option_type=option_type or req.option_type)


# ----------------------------------------------------------------------------- vanilla

def _vanilla(req: VanillaRequest, spot: float | None = None):
    cls = EuropeanOption if req.exercise == "european" else AmericanOption
    return cls(spot=spot or req.spot, strike=req.strike, expiry=req.expiry, vol=req.vol,
               dividend_yield=req.dividend_yield, rate=services.resolve_rate(req.rate), option_type=req.option_type)


@lru_cache(maxsize=256)
def _price_vanilla(payload: str, _curve: str) -> VanillaResponse:
    req = VanillaRequest.model_validate_json(payload)
    opt = _vanilla(req)
    results = []
    if req.exercise == "european":
        results.append(services.run_pricer(BlackScholesPricer(), opt))
    results.append(services.run_pricer(BinomialTreePricer(steps=req.tree_steps), opt))
    results.append(services.run_pricer(MonteCarloPricer(n_paths=req.mc_paths), opt, with_error=True))
    return VanillaResponse(results=results)


@router.post("/vanilla", response_model=VanillaResponse)
def price_vanilla(req: VanillaRequest):
    """Price + Greeks by every applicable method (BS / CRR tree / Monte Carlo or LSM)."""
    return _price_vanilla(*_cache_key(req))


@lru_cache(maxsize=256)
def _vanilla_profile(payload: str, _curve: str) -> ProfileResponse:
    req = VanillaRequest.model_validate_json(payload)
    spots = np.linspace(0.6 * req.spot, 1.4 * req.spot, 49)
    pricer = BlackScholesPricer() if req.exercise == "european" else BinomialTreePricer(steps=150)
    series: dict[str, list[float]] = {k: [] for k in ("price", "delta", "gamma", "vega", "theta", "rho", "payoff")}
    for s in spots:
        opt = _vanilla(req, float(s))
        g = services.scaled_greeks(pricer.greeks(opt))
        for k in ("price", "delta", "gamma", "vega", "theta", "rho"):
            series[k].append(getattr(g, k))
        series["payoff"].append(float(opt.payoff(s)))
    return ProfileResponse(spots=spots.tolist(), series=series)


@router.post("/vanilla/profile", response_model=ProfileResponse)
def vanilla_profile(req: VanillaRequest):
    """Price and Greeks as a function of spot (±40%), plus the payoff at expiry."""
    return _vanilla_profile(*_cache_key(req))


# ----------------------------------------------------------------------------- barrier

@lru_cache(maxsize=128)
def _price_barrier(payload: str, _curve: str) -> BarrierResponse:
    req = BarrierRequest.model_validate_json(payload)
    curve = services.resolve_rate(req.rate)
    opt = BarrierOption(spot=req.spot, strike=req.strike, expiry=req.expiry, barrier=req.barrier,
                        barrier_type=req.barrier_type, option_type=req.option_type, rebate=req.rebate,
                        monitoring_per_year=req.monitoring_per_year, vol=req.vol,
                        dividend_yield=req.dividend_yield, rate=curve)
    vanilla = BlackScholesPricer().price(EuropeanOption(
        spot=req.spot, strike=req.strike, expiry=req.expiry, vol=req.vol, dividend_yield=req.dividend_yield,
        rate=curve, option_type=req.option_type))
    analytic = AnalyticBarrierPricer()
    results = [services.run_pricer(analytic, opt)]
    mc_supported = not (req.rebate and req.monitoring_per_year is None) and not opt.is_breached(req.spot)
    if mc_supported:
        results.append(services.run_pricer(MonteCarloBarrierPricer(n_paths=req.mc_paths), opt, with_error=True))
    spots = np.linspace(0.5 * req.spot, 1.5 * req.spot, 81)
    return BarrierResponse(results=results, vanilla_price=vanilla,
                           profile=_greek_profile(analytic, opt, spots, ("price", "delta", "gamma", "vega")))


@router.post("/barrier", response_model=BarrierResponse)
def price_barrier(req: BarrierRequest):
    """Closed form (Reiner-Rubinstein, BGK for discrete monitoring) vs Monte Carlo."""
    return _price_barrier(*_cache_key(req))


# ----------------------------------------------------------------------------- digital

@lru_cache(maxsize=128)
def _price_digital(payload: str, _curve: str) -> DigitalResponse:
    req = DigitalRequest.model_validate_json(payload)
    curve = services.resolve_rate(req.rate)
    opt = DigitalOption(spot=req.spot, strike=req.strike, expiry=req.expiry, vol=req.vol, rate=curve,
                        dividend_yield=req.dividend_yield, option_type=req.option_type, kind=req.kind, cash=req.cash)
    analytic = AnalyticDigitalPricer()
    results = [services.run_pricer(analytic, opt),
               services.run_pricer(MonteCarloExoticPricer(n_paths=req.mc_paths), opt, with_error=True)]
    bs = BlackScholesPricer()
    vanilla = bs.price(_european(req, curve))
    # cash digital = limit of a call (put) spread of width w scaled by cash / w
    spreads = []
    if req.kind == "cash-or-nothing":
        for w in (0.2, 0.1, 0.05, 0.02, 0.01, 0.005):
            lo, hi = req.strike * (1 - w / 2), req.strike * (1 + w / 2)
            c_lo, c_hi = (bs.price(_european(req, curve, k)) for k in (lo, hi))
            spread = (c_lo - c_hi) if req.option_type == "call" else (c_hi - c_lo)
            spreads.append({"width": w, "price": req.cash * spread / (hi - lo)})
    spots = np.linspace(0.5 * req.spot, 1.5 * req.spot, 101)
    return DigitalResponse(results=results, vanilla_price=vanilla, call_spread=spreads,
                           profile=_greek_profile(analytic, opt, spots, ("price", "delta", "gamma", "vega")))


@router.post("/digital", response_model=DigitalResponse)
def price_digital(req: DigitalRequest):
    """Black-Scholes closed form vs Monte Carlo, call-spread replication, Greeks vs spot."""
    return _price_digital(*_cache_key(req))


# ----------------------------------------------------------------------------- Asian

@lru_cache(maxsize=128)
def _price_asian(payload: str, _curve: str) -> AsianResponse:
    req = AsianRequest.model_validate_json(payload)
    curve = services.resolve_rate(req.rate)
    opt = AsianOption.regular(req.expiry, req.n_fixings, spot=req.spot, strike=req.strike, vol=req.vol, rate=curve,
                              dividend_yield=req.dividend_yield, option_type=req.option_type, averaging=req.averaging)
    geometric = req.averaging == "geometric"
    analytic = GeometricAsianPricer() if geometric else LevyAsianPricer()
    plain = MonteCarloExoticPricer(n_paths=req.mc_paths, control_variate=False)
    results = [services.run_pricer(analytic, opt), services.run_pricer(plain, opt, with_error=True)]
    cv = MonteCarloExoticPricer(n_paths=req.mc_paths, control_variate=True)
    a = cv.analyze(opt)
    if not geometric:
        cv.name = "MC + control variate"
        results.append(services.run_pricer(cv, opt, with_error=True))
    convergence = []
    for n in sorted({1_000, 2_000, 5_000, 10_000, 20_000, 50_000, req.mc_paths}):
        if n > req.mc_paths:
            continue
        an = MonteCarloExoticPricer(n_paths=n, seed=101).analyze(opt)
        convergence.append({"n_paths": n, "plain": an["plain_price"], "plain_se": an["plain_std_error"],
                            "cv": an["price"], "cv_se": an["std_error"]})
    spots = np.linspace(0.6 * req.spot, 1.4 * req.spot, 61)
    return AsianResponse(results=results, vanilla_price=BlackScholesPricer().price(_european(req, curve)),
                         variance_reduction=a["variance_reduction"], cv_beta=a["cv_beta"], convergence=convergence,
                         profile=_greek_profile(analytic, opt, spots))


@router.post("/asian", response_model=AsianResponse)
def price_asian(req: AsianRequest):
    """Closed form (geometric) or Lévy approximation (arithmetic) vs Monte Carlo with control variate."""
    return _price_asian(*_cache_key(req))


# ----------------------------------------------------------------------------- cliquet

def _cliquet(req: CliquetRequest, curve, **overrides) -> CliquetOption:
    params = dict(spot=req.spot, vol=req.vol, rate=curve, dividend_yield=req.dividend_yield,
                  local_floor=req.local_floor, local_cap=req.local_cap, global_floor=req.global_floor,
                  global_cap=req.global_cap)
    params.update(overrides)
    return CliquetOption.regular(req.maturity, req.frequency, **params)


@lru_cache(maxsize=128)
def _price_cliquet(payload: str, _curve: str) -> CliquetResponse:
    req = CliquetRequest.model_validate_json(payload)
    curve = services.resolve_rate(req.rate)
    opt = _cliquet(req, curve)
    mc = MonteCarloExoticPricer(n_paths=req.mc_paths)
    results = [services.run_pricer(mc, opt, with_error=True)]
    local_only = _cliquet(req, curve, global_floor=None, global_cap=None)
    spread_pricer = CliquetSpreadPricer()
    if req.global_floor is None and req.global_cap is None:
        results.insert(0, services.run_pricer(spread_pricer, opt))
    else:
        r = services.run_pricer(spread_pricer, local_only)
        r.method = "Sans bornes globales (formule fermée)"
        results.append(r)

    a = mc.analyze(opt)
    returns = opt.period_returns(a["paths"])
    payoff = a["payoffs"]
    total_local = payoff if req.global_floor is None else local_only.path_payoff(a["paths"])
    counts, edges = np.histogram(payoff, bins=40)
    vols = np.round(np.arange(0.05, 0.61, 0.05), 2)
    quick = MonteCarloExoticPricer(n_paths=min(req.mc_paths, 20_000))
    vol_prices = [quick.price(opt.with_vol(float(v))) for v in vols]
    return CliquetResponse(
        results=results,
        reset_times=list(opt.reset_times),
        floor_probability=float((total_local < opt.notional * req.global_floor).mean()) if req.global_floor is not None else 0.0,
        cap_hit_rate=float((returns > req.local_cap).mean()) if req.local_cap is not None else None,
        floor_hit_rate=float((returns < req.local_floor).mean()) if req.local_floor is not None else None,
        histogram={"edges": edges.tolist(), "counts": counts.tolist()},
        vol_profile=ProfileResponse(spots=vols.tolist(), series={"price": vol_prices}),
    )


@router.post("/cliquet", response_model=CliquetResponse)
def price_cliquet(req: CliquetRequest):
    """Monte Carlo price + Greeks, payoff distribution, price as a function of volatility."""
    return _price_cliquet(*_cache_key(req))


# ----------------------------------------------------------------------------- autocall

def _autocall(req: AutocallRequest, coupon: float | None = None) -> Autocallable:
    return Autocallable.regular(
        req.maturity, req.frequency, spot=req.spot, vol=req.vol, dividend_yield=req.dividend_yield,
        rate=services.resolve_rate(req.rate), coupon_rate=req.coupon_rate if coupon is None else coupon,
        autocall_barrier=req.autocall_barrier, coupon_barrier=req.coupon_barrier,
        protection_barrier=req.protection_barrier, memory=req.memory)


@lru_cache(maxsize=128)
def _price_autocall(payload: str, _curve: str) -> AutocallResponse:
    req = AutocallRequest.model_validate_json(payload)
    inst = _autocall(req)
    pricer = MonteCarloAutocallPricer(n_paths=req.mc_paths)
    a = pricer.analyze(inst)
    return AutocallResponse(
        price=a.price, std_error=a.std_error, expected_life=a.expected_life, loss_probability=a.loss_probability,
        observation_times=list(inst.observation_times),
        redemption_probabilities=a.redemption_probabilities.tolist(),
        coupon_probabilities=a.coupon_probabilities.tolist(),
        greeks=services.scaled_greeks(pricer.greeks(inst)) if req.with_greeks else None,
    )


@router.post("/autocall", response_model=AutocallResponse)
def price_autocall(req: AutocallRequest):
    """Monte Carlo price, redemption / coupon probabilities, expected life, loss probability, Greeks."""
    return _price_autocall(*_cache_key(req))


@lru_cache(maxsize=64)
def _fair_coupon(payload: str, _curve: str) -> FairCouponResponse:
    req = AutocallRequest.model_validate_json(payload)
    pricer = MonteCarloAutocallPricer(n_paths=req.mc_paths)
    try:
        c = brentq(lambda c: pricer.price(_autocall(req, c)) - 100.0, 0.0, 0.5, xtol=1e-6)
    except ValueError:
        c = None
    return FairCouponResponse(coupon_rate=c)


@router.post("/autocall/fair-coupon", response_model=FairCouponResponse)
def fair_coupon(req: AutocallRequest):
    """Coupon per period that makes the note worth exactly 100% of notional."""
    return _fair_coupon(*_cache_key(req))
