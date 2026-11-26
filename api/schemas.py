"""Request / response models of the REST API (validated by pydantic)."""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field

Currency = Literal["USD", "EUR"]


# ----------------------------------------------------------------------------- shared

class RateSpec(BaseModel):
    """Risk-free rate: a stored market curve, or a flat continuously compounded rate."""

    mode: Literal["curve", "flat"] = "curve"
    currency: Currency = "USD"
    flat_rate: float = Field(0.03, ge=-0.05, le=0.5)


class MarketParams(BaseModel):
    spot: float = Field(gt=0)
    vol: float = Field(gt=0, le=5)
    dividend_yield: float = Field(0.0, ge=-0.2, le=0.5)
    rate: RateSpec = RateSpec()


class Greeks(BaseModel):
    """Desk units: vega and rho per 1%, theta per calendar day."""

    price: float
    delta: float
    gamma: float
    vega: float
    theta: float
    rho: float


class MethodResult(BaseModel):
    method: str
    greeks: Greeks
    std_error: Optional[float] = None
    elapsed_ms: float


# ----------------------------------------------------------------------------- vanilla

class VanillaRequest(MarketParams):
    strike: float = Field(gt=0)
    expiry: float = Field(gt=0, le=30, description="years, ACT/365F")
    option_type: Literal["call", "put"] = "call"
    exercise: Literal["european", "american"] = "european"
    tree_steps: int = Field(500, ge=10, le=5000)
    mc_paths: int = Field(100_000, ge=1_000, le=1_000_000)


class VanillaResponse(BaseModel):
    results: list[MethodResult]


class ProfileResponse(BaseModel):
    spots: list[float]
    series: dict[str, list[float]]


# ----------------------------------------------------------------------------- structured

class BarrierRequest(MarketParams):
    strike: float = Field(gt=0)
    expiry: float = Field(gt=0, le=30)
    barrier: float = Field(gt=0)
    barrier_type: Literal["down-and-out", "down-and-in", "up-and-out", "up-and-in"]
    option_type: Literal["call", "put"] = "call"
    rebate: float = Field(0.0, ge=0)
    monitoring_per_year: Optional[int] = Field(None, ge=1, le=365)
    mc_paths: int = Field(50_000, ge=1_000, le=500_000)


class BarrierResponse(BaseModel):
    results: list[MethodResult]
    vanilla_price: float
    profile: ProfileResponse


class DigitalRequest(MarketParams):
    strike: float = Field(gt=0)
    expiry: float = Field(gt=0, le=30)
    option_type: Literal["call", "put"] = "call"
    kind: Literal["cash-or-nothing", "asset-or-nothing"] = "cash-or-nothing"
    cash: float = Field(1.0, gt=0)
    mc_paths: int = Field(100_000, ge=1_000, le=500_000)


class DigitalResponse(BaseModel):
    results: list[MethodResult]
    vanilla_price: float
    call_spread: list[dict]   # [{width, price}]: digital = limit of a tight call spread
    profile: ProfileResponse  # price / delta / gamma / vega vs spot (closed form)


class AsianRequest(MarketParams):
    strike: float = Field(gt=0)
    expiry: float = Field(gt=0, le=10)
    n_fixings: int = Field(12, ge=1, le=260)
    option_type: Literal["call", "put"] = "call"
    averaging: Literal["arithmetic", "geometric"] = "arithmetic"
    mc_paths: int = Field(50_000, ge=1_000, le=500_000)


class AsianResponse(BaseModel):
    results: list[MethodResult]
    vanilla_price: float
    variance_reduction: Optional[float] = None
    cv_beta: Optional[float] = None
    convergence: list[dict]   # [{n_paths, plain, plain_se, cv, cv_se}]
    profile: ProfileResponse


class CliquetRequest(MarketParams):
    maturity: float = Field(2.0, gt=0, le=10)
    frequency: Literal[1, 2, 4, 12] = 4
    local_floor: Optional[float] = Field(-0.05, ge=-1)
    local_cap: Optional[float] = Field(0.05, ge=-1)
    global_floor: Optional[float] = Field(0.0)
    global_cap: Optional[float] = None
    mc_paths: int = Field(50_000, ge=1_000, le=500_000)


class CliquetResponse(BaseModel):
    results: list[MethodResult]
    reset_times: list[float]
    floor_probability: float          # P(global floor binds)
    cap_hit_rate: Optional[float]     # share of periods capped
    floor_hit_rate: Optional[float]   # share of periods floored
    histogram: dict                   # {edges, counts} of the payoff
    vol_profile: ProfileResponse      # price vs flat vol (x = vol)


class AutocallRequest(MarketParams):
    maturity: float = Field(5.0, gt=0, le=15)
    frequency: Literal[1, 2, 4, 12] = 4
    coupon_rate: float = Field(0.02, ge=0, le=1)
    autocall_barrier: float = Field(1.0, gt=0)
    coupon_barrier: float = Field(0.7, ge=0)
    protection_barrier: float = Field(0.6, ge=0)
    memory: bool = True
    mc_paths: int = Field(50_000, ge=1_000, le=500_000)
    with_greeks: bool = True


class AutocallResponse(BaseModel):
    price: float
    std_error: float
    expected_life: float
    loss_probability: float
    observation_times: list[float]
    redemption_probabilities: list[float]
    coupon_probabilities: list[float]
    greeks: Optional[Greeks] = None


class FairCouponResponse(BaseModel):
    coupon_rate: Optional[float]


# ----------------------------------------------------------------------------- rates

class CurveSeries(BaseModel):
    zero: list[float]
    forward: list[Optional[float]]  # last grid point has no forward
    discount: list[float]


class CurveResponse(BaseModel):
    currency: Currency
    asof: str
    source: str
    quote_type: Literal["par", "zero"]
    quotes: list[dict]  # [{tenor, rate}]
    grid: list[float]
    curves: dict[str, CurveSeries]  # by interpolation


class BondRequest(BaseModel):
    currency: Currency = "USD"
    maturity: float = Field(gt=0, le=50)
    coupon_rate: float = Field(ge=0, le=1)
    frequency: Literal[1, 2, 4] = 2


class BondResponse(BaseModel):
    dirty_price: float
    clean_price: float
    accrued: float
    ytm: float
    macaulay_duration: float
    modified_duration: float
    convexity: float
    dv01: float
    cashflows: list[dict]  # [{time, amount, discount, pv}]


class EquityFutureRequest(BaseModel):
    ticker: str
    maturity: float = Field(gt=0, le=10)


class BondFutureRequest(BondRequest):
    delivery: float = Field(gt=0)
    conversion_factor: float = Field(1.0, gt=0)


class FuturePriceResponse(BaseModel):
    price: float
    basis: Optional[float] = None
    curve_currency: Currency
