import math

import numpy as np
import pytest

from qplat.curves import FlatCurve, InterpolatedCurve
from qplat.instruments import AmericanOption, EuropeanOption, OptionType
from qplat.pricers import BinomialTreePricer, BlackScholesPricer, MonteCarloPricer, implied_volatility

BS = BlackScholesPricer()


def hull_call(**kw):
    # Hull, Options Futures & Other Derivatives, example 15.6: c = 4.76, p = 0.81
    params = dict(spot=42, strike=40, expiry=0.5, rate=0.10, vol=0.20)
    params.update(kw)
    return EuropeanOption(**params)


def test_black_scholes_textbook_values():
    assert BS.price(hull_call()) == pytest.approx(4.7594, abs=1e-4)
    assert BS.price(hull_call(option_type="put")) == pytest.approx(0.8086, abs=1e-4)


def test_put_call_parity_with_dividends():
    c = hull_call(dividend_yield=0.03)
    p = hull_call(dividend_yield=0.03, option_type=OptionType.PUT)
    lhs = BS.price(c) - BS.price(p)
    rhs = 42 * math.exp(-0.03 * 0.5) - 40 * math.exp(-0.10 * 0.5)
    assert lhs == pytest.approx(rhs, abs=1e-10)


@pytest.mark.parametrize("option_type", ["call", "put"])
def test_closed_form_greeks_match_finite_differences(option_type):
    opt = hull_call(option_type=option_type, dividend_yield=0.02)
    from qplat.pricers.base import FiniteDifferencePricer

    class BumpedBS(FiniteDifferencePricer):
        def price(self, inst):
            return BS.price(inst)

    fd = BumpedBS(spot_bump=1e-4, vol_bump=1e-4, time_bump=1e-5).greeks(opt)
    cf = BS.greeks(opt)
    assert cf.delta == pytest.approx(fd.delta, rel=1e-5)
    assert cf.gamma == pytest.approx(fd.gamma, rel=1e-3)
    assert cf.vega == pytest.approx(fd.vega, rel=1e-5)
    assert cf.theta == pytest.approx(fd.theta, rel=1e-3)
    assert cf.rho == pytest.approx(fd.rho, rel=1e-5)


@pytest.mark.parametrize("option_type", ["call", "put"])
def test_binomial_converges_to_black_scholes(option_type):
    opt = hull_call(option_type=option_type, dividend_yield=0.01)
    assert BinomialTreePricer(steps=2000).price(opt) == pytest.approx(BS.price(opt), abs=2e-3)


@pytest.mark.parametrize("option_type", ["call", "put"])
def test_monte_carlo_within_three_standard_errors(option_type):
    opt = hull_call(option_type=option_type)
    price, se = MonteCarloPricer(n_paths=200_000).price_with_error(opt)
    assert abs(price - BS.price(opt)) < 3 * se


def test_numerical_greeks_close_to_closed_form():
    opt = hull_call()
    cf = BS.greeks(opt)
    for pricer in (BinomialTreePricer(steps=800), MonteCarloPricer(n_paths=200_000)):
        g = pricer.greeks(opt)
        assert g.delta == pytest.approx(cf.delta, abs=0.01)
        assert g.gamma == pytest.approx(cf.gamma, abs=0.005)
        assert g.vega == pytest.approx(cf.vega, rel=0.03)
        assert g.theta == pytest.approx(cf.theta, rel=0.03)
        assert g.rho == pytest.approx(cf.rho, rel=0.03)


def test_term_structure_consistent_across_methods():
    curve = InterpolatedCurve([0.25, 1.0, 2.0], [0.99, 0.96, 0.92])
    opt = hull_call(rate=curve, expiry=1.5)
    bs = BS.price(opt)
    assert BinomialTreePricer(steps=2000).price(opt) == pytest.approx(bs, abs=3e-3)
    mc, se = MonteCarloPricer(n_paths=200_000).price_with_error(opt)
    assert abs(mc - bs) < 3 * se


def test_american_put_reference_value():
    # Longstaff-Schwartz (2001), table 1: S=36, K=40, r=6%, sigma=20%, T=1 -> 4.478
    opt = AmericanOption(spot=36, strike=40, expiry=1.0, rate=0.06, vol=0.2, option_type="put")
    assert BinomialTreePricer(steps=2000).price(opt) == pytest.approx(4.4867, abs=2e-3)
    assert MonteCarloPricer(n_paths=100_000).price(opt) == pytest.approx(4.4867, abs=0.03)


def test_american_call_without_dividends_equals_european():
    am = AmericanOption(spot=42, strike=40, expiry=0.5, rate=0.1, vol=0.2)
    assert BinomialTreePricer(steps=1000).price(am) == pytest.approx(BS.price(hull_call()), abs=5e-3)


def test_american_put_worth_more_than_european():
    eu = hull_call(option_type="put", spot=36)
    am = AmericanOption(spot=36, strike=40, expiry=0.5, rate=0.1, vol=0.2, option_type="put")
    assert BinomialTreePricer().price(am) > BS.price(eu) + 0.1


def test_deep_itm_american_put_exercised_immediately():
    am = AmericanOption(spot=10, strike=40, expiry=1.0, rate=0.06, vol=0.2, option_type="put")
    assert MonteCarloPricer(n_paths=20_000).price(am) == pytest.approx(30.0)


def test_black_scholes_rejects_american():
    am = AmericanOption(spot=36, strike=40, expiry=1.0, rate=0.06, vol=0.2, option_type="put")
    with pytest.raises(ValueError):
        BS.price(am)


@pytest.mark.parametrize("vol", [0.05, 0.2, 0.8])
@pytest.mark.parametrize("option_type", ["call", "put"])
def test_implied_vol_round_trip(vol, option_type):
    opt = hull_call(vol=vol, option_type=option_type, dividend_yield=0.01)
    iv = implied_volatility(BS.price(opt), 42, 40, 0.5, 0.10, 0.01, option_type)
    assert iv == pytest.approx(vol, abs=1e-7)


def test_implied_vol_nan_below_intrinsic():
    assert math.isnan(implied_volatility(0.5, 42, 40, 0.5, 0.10, 0.0, "call"))


def test_flat_rate_and_flat_curve_identical():
    assert BS.price(hull_call(rate=FlatCurve(0.1))) == pytest.approx(BS.price(hull_call()))


def test_lattice_matches_price_and_backward_induction():
    am = AmericanOption(spot=36, strike=40, expiry=1.0, rate=0.06, vol=0.2, option_type="put")
    pricer = BinomialTreePricer(steps=8)
    lat = pricer.lattice(am)
    assert lat.values[0][0] == pytest.approx(pricer.price(am))
    prm = lat.params
    # one node by hand: V = max(discounted expectation, exercise)
    i, j = 3, 1
    cont = prm.step_disc[i] * (prm.p[i] * lat.values[i + 1][j] + (1 - prm.p[i]) * lat.values[i + 1][j + 1])
    assert lat.values[i][j] == pytest.approx(max(cont, am.payoff(lat.spots[i][j])))
    assert lat.exercised[8].sum() == 0  # no "early" exercise flag at maturity


def test_vectorised_implied_vol_matches_scalar():
    from qplat.pricers.black_scholes import bs_price, implied_volatility_vec

    rng = np.random.default_rng(1)
    n = 200
    k = rng.uniform(60, 140, n)
    t = rng.uniform(0.02, 2.0, n)
    vol = rng.uniform(0.05, 1.2, n)
    types = np.where(rng.random(n) < 0.5, "call", "put")
    phi = np.where(types == "call", 1, -1)
    prices = bs_price(100, k, t, 0.03, 0.01, vol, phi)
    iv = implied_volatility_vec(prices, 100, k, t, 0.03, 0.01, types)
    # the implied price is recovered exactly everywhere ...
    assert np.allclose(bs_price(100, k, t, 0.03, 0.01, iv, phi), prices, atol=1e-8)
    # ... and the vol wherever it is identifiable (deep ITM / tiny vol: vega ~ 0, the vol is ill-defined)
    from scipy.stats import norm
    d1 = (np.log(100 / k) + (0.03 - 0.01 + 0.5 * vol**2) * t) / (vol * np.sqrt(t))
    vega = 100 * np.exp(-0.01 * t) * norm.pdf(d1) * np.sqrt(t)
    ok = vega > 1e-2
    assert np.allclose(iv[ok], vol[ok], atol=1e-7)
    assert np.isnan(implied_volatility_vec([0.5], 42, [40], 0.5, 0.10, 0.0, ["call"])[0])  # below intrinsic
