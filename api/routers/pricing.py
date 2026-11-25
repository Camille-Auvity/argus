"""Pricing endpoints. Results are cached on (request, curve snapshot) so repeated
UI interactions with the same inputs are instant."""

from __future__ import annotations

from functools import lru_cache

import numpy as np
from fastapi import APIRouter
from scipy.optimize import brentq

from api import services
from api.schemas import (
    AutocallRequest, AutocallResponse, BarrierRequest, BarrierResponse, FairCouponResponse, ProfileResponse,
    RateSpec, VanillaRequest, VanillaResponse,
)
from qplat.instruments import AmericanOption, Autocallable, BarrierOption, EuropeanOption
from qplat.pricers import (
    AnalyticBarrierPricer, BinomialTreePricer, BlackScholesPricer, MonteCarloAutocallPricer,
    MonteCarloBarrierPricer, MonteCarloPricer,
)

router = APIRouter(prefix="/api/price", tags=["pricing"])


def _curve_version(spec: RateSpec) -> str:
    if spec.mode == "flat":
        return "flat"
    q = services.latest_quotes(spec.currency)
    return "" if q.empty else f"{q.source.iloc[0]}:{q['asof'].iloc[0]}"


def _cache_key(req) -> tuple[str, str]:
    return req.model_dump_json(), _curve_version(req.rate)


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
    prices = [analytic.price(opt.with_spot(float(s))) for s in spots]
    return BarrierResponse(results=results, vanilla_price=vanilla,
                           profile=ProfileResponse(spots=spots.tolist(), series={"price": prices}))


@router.post("/barrier", response_model=BarrierResponse)
def price_barrier(req: BarrierRequest):
    """Closed form (Reiner-Rubinstein, BGK for discrete monitoring) vs Monte Carlo."""
    return _price_barrier(*_cache_key(req))


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
