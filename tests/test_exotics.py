import math

import numpy as np
import pytest
from scipy.stats import norm

from qplat.curves import FlatCurve
from qplat.instruments import AsianOption, CliquetOption, DigitalOption, EuropeanOption
from qplat.models.market_models import smile_digital
from qplat.pricers import (
    AnalyticDigitalPricer, BlackScholesPricer, CliquetSpreadPricer, GeometricAsianPricer, LevyAsianPricer,
    MonteCarloExoticPricer,
)

DIGITAL = AnalyticDigitalPricer()
BS = BlackScholesPricer()


# ----------------------------------------------------------------------------- digital

def test_digital_matches_haug():
    # Haug, "The Complete Guide to Option Pricing Formulas", sections 4.19.2 and 4.19.3
    cash_put = DigitalOption(spot=100, strike=80, expiry=0.75, vol=0.35, rate=0.06, dividend_yield=0.06,
                             option_type="put", cash=10)
    assert DIGITAL.price(cash_put) == pytest.approx(2.6710, abs=1e-4)
    asset_put = DigitalOption(spot=70, strike=65, expiry=0.5, vol=0.27, rate=0.07, dividend_yield=0.05,
                              option_type="put", kind="asset-or-nothing")
    assert DIGITAL.price(asset_put) == pytest.approx(20.2069, abs=1e-4)


def test_digital_parities():
    kw = dict(spot=100, strike=105, expiry=1.3, vol=0.22, rate=0.04, dividend_yield=0.015)
    df, dq = math.exp(-0.04 * 1.3), math.exp(-0.015 * 1.3)
    cc, cp = (DIGITAL.price(DigitalOption(option_type=o, cash=5, **kw)) for o in ("call", "put"))
    ac, ap = (DIGITAL.price(DigitalOption(option_type=o, kind="asset-or-nothing", **kw)) for o in ("call", "put"))
    assert cc + cp == pytest.approx(5 * df, abs=1e-12)
    assert ac + ap == pytest.approx(100 * dq, abs=1e-12)
    # vanilla call = asset-or-nothing call - K x cash-or-nothing call
    call = BS.price(EuropeanOption(option_type="call", **kw))
    assert ac - 105 * cc / 5 == pytest.approx(call, abs=1e-10)


def test_digital_is_the_limit_of_a_call_spread():
    kw = dict(spot=100, expiry=1, vol=0.3, rate=0.02)
    h = 1e-3
    spread = (BS.price(EuropeanOption(strike=100 - h, **kw)) - BS.price(EuropeanOption(strike=100 + h, **kw))) / (2 * h)
    assert DIGITAL.price(DigitalOption(strike=100, **kw)) == pytest.approx(spread, rel=1e-6)


def test_digital_finite_difference_greeks_match_closed_form():
    s, k, t, r, sig = 100.0, 95.0, 0.8, 0.03, 0.25
    opt = DigitalOption(spot=s, strike=k, expiry=t, vol=sig, rate=r)
    d2 = (math.log(s / k) + (r - 0.5 * sig * sig) * t) / (sig * math.sqrt(t))
    delta = math.exp(-r * t) * norm.pdf(d2) / (s * sig * math.sqrt(t))
    vega = -math.exp(-r * t) * norm.pdf(d2) * (d2 + sig * math.sqrt(t)) / sig
    g = DIGITAL.greeks(opt)
    assert g.delta == pytest.approx(delta, rel=1e-3)
    assert g.vega == pytest.approx(vega, rel=5e-3)  # central bump of 1 vol point


@pytest.mark.parametrize("kind", ["cash-or-nothing", "asset-or-nothing"])
@pytest.mark.parametrize("ot", ["call", "put"])
def test_digital_monte_carlo(kind, ot):
    opt = DigitalOption(spot=100, strike=102, expiry=0.7, vol=0.2, rate=FlatCurve(0.03), dividend_yield=0.01,
                        option_type=ot, kind=kind)
    price, se = MonteCarloExoticPricer(n_paths=200_000).price_with_error(opt)
    assert abs(price - DIGITAL.price(opt)) < 4 * se


def test_smile_digital_reduces_to_black_scholes_on_a_flat_smile():
    opt = DigitalOption(spot=100, strike=110, expiry=1, vol=0.2, rate=0.03, dividend_yield=0.01, cash=100)
    for phi, ot in ((1, "call"), (-1, "put")):
        flat = smile_digital(100, 110, 1, 0.03, 0.01, lambda k: 0.2, phi, 100)
        assert flat == pytest.approx(DIGITAL.price(DigitalOption(**{**opt.__dict__, "option_type": ot})), rel=1e-5)
    # negative skew: the call digital is dearer than with the strike's vol alone
    skew = smile_digital(100, 110, 1, 0.03, 0.01, lambda k: 0.2 - 0.3 * math.log(k / 100), 1, 100)
    assert skew > DIGITAL.price(opt.with_vol(0.2 - 0.3 * math.log(1.1)))


# ----------------------------------------------------------------------------- Asian

def asian(averaging="arithmetic", n=12, **kw):
    params = dict(spot=100, strike=100, vol=0.3, rate=0.05, dividend_yield=0.01, averaging=averaging)
    params.update(kw)
    return AsianOption.regular(1.0, n, **params)


def test_single_fixing_asian_is_a_european():
    for ot in ("call", "put"):
        euro = BS.price(EuropeanOption(spot=100, strike=95, expiry=1, vol=0.3, rate=0.05, dividend_yield=0.01, option_type=ot))
        assert GeometricAsianPricer().price(asian("geometric", 1, strike=95, option_type=ot)) == pytest.approx(euro, abs=1e-10)
        assert LevyAsianPricer().price(asian("arithmetic", 1, strike=95, option_type=ot)) == pytest.approx(euro, abs=1e-10)


def test_geometric_closed_form_converges_to_kemna_vorst():
    s, k, t, r, q, v = 100, 100, 1.0, 0.05, 0.01, 0.3
    va, b = v / math.sqrt(3), 0.5 * (r - q - v * v / 6)
    d1 = (math.log(s / k) + (b + 0.5 * va * va) * t) / (va * math.sqrt(t))
    kv = s * math.exp((b - r) * t) * norm.cdf(d1) - k * math.exp(-r * t) * norm.cdf(d1 - va * math.sqrt(t))
    assert GeometricAsianPricer().price(asian("geometric", 5000)) == pytest.approx(kv, abs=2e-3)


@pytest.mark.parametrize("ot", ["call", "put"])
def test_geometric_closed_form_vs_monte_carlo(ot):
    opt = asian("geometric", option_type=ot)
    price, se = MonteCarloExoticPricer(n_paths=200_000, seed=3).price_with_error(opt)
    assert abs(price - GeometricAsianPricer().price(opt)) < 4 * se


def test_arithmetic_control_variate():
    opt = asian()
    a = MonteCarloExoticPricer(n_paths=50_000).analyze(opt)
    assert a["variance_reduction"] > 50
    assert a["std_error"] < a["plain_std_error"] / 5
    assert abs(a["price"] - a["plain_price"]) < 4 * a["plain_std_error"]
    # AM-GM: arithmetic call >= geometric call; Lévy within 1% of the MC price
    assert a["price"] > GeometricAsianPricer().price(asian("geometric"))
    assert LevyAsianPricer().price(opt) == pytest.approx(a["price"], rel=0.01)


def test_asian_is_cheaper_than_the_european():
    euro = BS.price(EuropeanOption(spot=100, strike=100, expiry=1, vol=0.3, rate=0.05, dividend_yield=0.01))
    assert MonteCarloExoticPricer(n_paths=20_000).price(asian()) < euro


# ----------------------------------------------------------------------------- cliquet

def cliquet(**kw):
    params = dict(spot=100, vol=0.2, rate=FlatCurve(0.03), dividend_yield=0.01, local_floor=-0.05, local_cap=0.05)
    params.update(kw)
    return CliquetOption.regular(2.0, 4, **params)


def test_cliquet_closed_form_vs_monte_carlo():
    opt = cliquet()
    price, se = MonteCarloExoticPricer(n_paths=200_000).price_with_error(opt)
    assert abs(price - CliquetSpreadPricer().price(opt)) < 4 * se


def test_uncapped_cliquet_is_the_sum_of_forward_returns():
    opt = cliquet(local_floor=None, local_cap=None)
    expected = 100 * math.exp(-0.03 * 2) * 8 * (math.exp(0.02 * 0.25) - 1)
    assert CliquetSpreadPricer().price(opt) == pytest.approx(expected, rel=1e-10)


def test_cliquet_does_not_depend_on_spot():
    g = MonteCarloExoticPricer(n_paths=20_000).greeks(cliquet(global_floor=0.0))
    assert g.delta == pytest.approx(0.0, abs=1e-9)
    assert g.gamma == pytest.approx(0.0, abs=1e-6)


def test_global_floor():
    mc = MonteCarloExoticPricer(n_paths=50_000)
    local = mc.price(cliquet())
    floored = mc.price(cliquet(global_floor=0.0))
    assert floored > max(local, 0.0)
    # a floor above every achievable sum pays it for sure
    assert mc.price(cliquet(global_floor=0.5)) == pytest.approx(50 * math.exp(-0.06), rel=1e-12)


def test_cliquet_payoff_on_a_known_path():
    opt = CliquetOption(spot=100, vol=0.2, reset_times=(1, 2, 3), local_floor=-0.02, local_cap=0.03,
                        global_floor=0.0, notional=100)
    paths = np.array([[110.0, 99.0, 100.0]])  # returns +10%, -10%, +1.01% -> 3% - 2% + 1.0101%
    assert opt.path_payoff(paths)[0] == pytest.approx(100 * (0.03 - 0.02 + 1 / 99))
