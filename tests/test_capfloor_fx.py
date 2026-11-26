import math

import numpy as np
import pytest
from scipy.stats import norm

from qplat.curves import FlatCurve
from qplat.fx import (
    FXMarket, VannaVolga, atm_dns_strike, build_smile, delta_of_strike, gk_greeks, gk_price, risk_neutral_density,
    strike_from_delta,
)
from qplat.instruments import EuropeanOption
from qplat.pricers import BlackScholesPricer
from qplat.pricers.capfloor import (
    CapFloor, capfloor_greeks, forward_rates, implied_flat_vol, price_capfloor, swap_value,
)

CURVE = FlatCurve(0.04)


# ----------------------------------------------------------------------------- caps and floors

def test_cap_floor_parity_and_atm():
    for model, vol in (("black", 0.25), ("bachelier", 0.01)):
        cap = CapFloor(maturity=5, strike=0.045, notional=1e6)
        floor = CapFloor(maturity=5, strike=0.045, kind="floor", notional=1e6)
        diff = price_capfloor(cap, CURVE, vol, model).price - price_capfloor(floor, CURVE, vol, model).price
        assert diff == pytest.approx(swap_value(cap, CURVE), abs=1e-8)
    # at the forward swap rate the swap is worth zero, so cap = floor
    atm = price_capfloor(CapFloor(maturity=5, strike=0.04), CURVE, 0.2).atm_strike
    c = price_capfloor(CapFloor(maturity=5, strike=atm), CURVE, 0.2).price
    f = price_capfloor(CapFloor(maturity=5, strike=atm, kind="floor"), CURVE, 0.2).price
    assert c == pytest.approx(f, abs=1e-14)


def test_caplet_is_black_76():
    cap = CapFloor(maturity=1.0, strike=0.04, frequency=2)       # one caplet: fixes at 0.5, pays at 1.0
    r = price_capfloor(cap, CURVE, 0.3)
    F = (math.exp(0.02) - 1) / 0.5
    d1 = (math.log(F / 0.04) + 0.5 * 0.09 * 0.5) / (0.3 * math.sqrt(0.5))
    expected = 0.5 * math.exp(-0.04) * (F * norm.cdf(d1) - 0.04 * norm.cdf(d1 - 0.3 * math.sqrt(0.5)))
    assert len(r.caplets) == 1 and r.price == pytest.approx(expected, rel=1e-12)
    assert forward_rates(CURVE, np.array([0.5]), np.array([1.0]))[0] == pytest.approx(F)


def test_bachelier_and_black_agree_near_the_money():
    cap = CapFloor(maturity=3, strike=0.04)
    black = price_capfloor(cap, CURVE, 0.2).price
    # normal vol ~ lognormal vol x forward at the money
    normal = price_capfloor(cap, CURVE, 0.2 * 0.0404, "bachelier").price
    assert normal == pytest.approx(black, rel=0.02)


def test_black_rejects_negative_rates():
    with pytest.raises(ValueError):
        price_capfloor(CapFloor(maturity=2, strike=0.01), FlatCurve(-0.005), 0.3)
    assert price_capfloor(CapFloor(maturity=2, strike=0.0), FlatCurve(-0.005), 0.005, "bachelier").price > 0


def test_cap_greeks_and_implied_vol():
    cap = CapFloor(maturity=5, strike=0.04, notional=1e6)
    g = capfloor_greeks(cap, CURVE, 0.25)
    assert g.dv01 > 0 and g.vega > 0 and g.gamma_1bp > 0 and g.theta < 0
    floor = capfloor_greeks(CapFloor(maturity=5, strike=0.04, kind="floor", notional=1e6), CURVE, 0.25)
    assert floor.dv01 < 0 and floor.vega == pytest.approx(g.vega, rel=1e-6)    # same vega (parity)
    assert implied_flat_vol(cap, CURVE, g.price) == pytest.approx(0.25, abs=1e-10)


# ----------------------------------------------------------------------------- FX

S, T, RD, RF = 1.10, 0.75, 0.045, 0.025


def test_garman_kohlhagen_is_black_scholes_with_foreign_yield():
    for phi, ot in ((1, "call"), (-1, "put")):
        bs = BlackScholesPricer().price(EuropeanOption(spot=S, strike=1.12, expiry=T, vol=0.08, rate=RD,
                                                       dividend_yield=RF, option_type=ot))
        assert gk_price(S, 1.12, T, RD, RF, 0.08, phi) == pytest.approx(bs, rel=1e-12)
    c, p = gk_price(S, 1.12, T, RD, RF, 0.08, 1), gk_price(S, 1.12, T, RD, RF, 0.08, -1)
    assert c - p == pytest.approx(S * math.exp(-RF * T) - 1.12 * math.exp(-RD * T), abs=1e-14)


def test_gk_greeks_by_finite_differences():
    g = gk_greeks(S, 1.12, T, RD, RF, 0.08, 1)
    f = lambda **kw: gk_price(**{**dict(spot=S, strike=1.12, T=T, rd=RD, rf=RF, vol=0.08, phi=1), **kw})  # noqa: E731
    h = 1e-5
    assert g.delta_spot == pytest.approx((f(spot=S + h) - f(spot=S - h)) / (2 * h), rel=1e-6)
    assert g.vega == pytest.approx((f(vol=0.08 + h) - f(vol=0.08 - h)) / (2 * h), rel=1e-6)
    assert g.rho_domestic == pytest.approx((f(rd=RD + h) - f(rd=RD - h)) / (2 * h), rel=1e-6)
    assert g.rho_foreign == pytest.approx((f(rf=RF + h) - f(rf=RF - h)) / (2 * h), rel=1e-6)
    assert g.theta == pytest.approx(-(f(T=T + h) - f(T=T - h)) / (2 * h), rel=1e-6)
    assert g.delta_forward == pytest.approx(g.delta_spot * math.exp(RF * T))


def test_delta_strike_round_trip_and_atm():
    m = FXMarket(S, T, RD, RF)
    for conv in ("spot", "forward"):
        for phi in (1, -1):
            K = strike_from_delta(m, 0.25, 0.09, phi, conv)
            assert abs(delta_of_strike(m, K, 0.09, phi, conv)) == pytest.approx(0.25, abs=1e-12)
    # delta-neutral straddle: call and put spot deltas cancel
    K = atm_dns_strike(m, 0.08)
    assert gk_greeks(S, K, T, RD, RF, 0.08, 1).delta_spot + gk_greeks(S, K, T, RD, RF, 0.08, -1).delta_spot == pytest.approx(0, abs=1e-12)


def test_vanna_volga_reprices_pillars_and_flat_smile():
    m = FXMarket(S, T, RD, RF)
    vv = VannaVolga(m, [1.05, 1.12, 1.19], [0.095, 0.08, 0.088])
    for K, s in zip(vv.K, vv.vols):
        assert vv.vol(K) == pytest.approx(s, abs=1e-10)
    flat = build_smile(m, 0.08, 0.0, 0.0)
    assert flat.bf25_smile == pytest.approx(0.0, abs=1e-10)
    assert flat.vol(1.0) == pytest.approx(0.08, abs=1e-10)


def test_smile_reprices_market_strangle_and_risk_reversal():
    m = FXMarket(S, T, RD, RF)
    sm = build_smile(m, 0.075, 0.006, 0.003)
    ms = sm.market_strangle
    assert sm.vv.price(ms["call_strike"], 1) + sm.vv.price(ms["put_strike"], -1) == pytest.approx(ms["value"], abs=1e-12)
    p = sm.pillars
    assert p["25D call"]["vol"] - p["25D put"]["vol"] == pytest.approx(0.006, abs=1e-12)
    assert sm.bf25_smile != pytest.approx(0.003, abs=1e-6)                  # smile fly differs from the broker fly
    q = risk_neutral_density(sm, np.linspace(0.95, 1.3, 15))
    assert np.all(q > 0)
