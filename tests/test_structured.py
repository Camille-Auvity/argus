import numpy as np
import pytest

from qplat.instruments import Autocallable, BarrierOption, BarrierType, EuropeanOption
from qplat.pricers import (
    AnalyticBarrierPricer, BlackScholesPricer, MonteCarloAutocallPricer, MonteCarloBarrierPricer,
)

ANALYTIC = AnalyticBarrierPricer()

# Haug, "The Complete Guide to Option Pricing Formulas", table 4-13:
# S=100, T=0.5, r=8%, b=4%, sigma=25%, rebate=3, H=95 (down) / 105 (up)
HAUG = {
    ("down-and-out", "call"): [9.0246, 6.7924, 4.8759],
    ("down-and-in", "call"): [7.7627, 4.0109, 2.0576],
    ("up-and-out", "call"): [2.6789, 2.3580, 2.3453],
    ("up-and-in", "call"): [14.1112, 8.4482, 4.5910],
    ("down-and-out", "put"): [2.2798, 2.2947, 2.6252],
    ("down-and-in", "put"): [2.9586, 6.5677, 11.9752],
    ("up-and-out", "put"): [3.7760, 5.4932, 7.5187],
    ("up-and-in", "put"): [1.4653, 3.3721, 7.0846],
}


def barrier(bt, ot, k=100.0, rebate=0.0, monitoring=None, **kw):
    params = dict(spot=100, strike=k, expiry=0.5, rate=0.08, dividend_yield=0.04, vol=0.25,
                  barrier=95 if bt.startswith("down") else 105, barrier_type=bt, option_type=ot,
                  rebate=rebate, monitoring_per_year=monitoring)
    params.update(kw)
    return BarrierOption(**params)


@pytest.mark.parametrize("key", list(HAUG))
def test_reiner_rubinstein_matches_haug(key):
    bt, ot = key
    for k, expected in zip((90, 100, 110), HAUG[key]):
        assert ANALYTIC.price(barrier(bt, ot, k, rebate=3.0)) == pytest.approx(expected, abs=1e-4)


@pytest.mark.parametrize("direction", ["down", "up"])
@pytest.mark.parametrize("ot", ["call", "put"])
def test_in_out_parity(direction, ot):
    vanilla = BlackScholesPricer().price(EuropeanOption(spot=100, strike=100, expiry=0.5, rate=0.08,
                                                        dividend_yield=0.04, vol=0.25, option_type=ot))
    out = ANALYTIC.price(barrier(f"{direction}-and-out", ot))
    in_ = ANALYTIC.price(barrier(f"{direction}-and-in", ot))
    assert out + in_ == pytest.approx(vanilla, abs=1e-10)


@pytest.mark.parametrize("bt", [b.value for b in BarrierType])
def test_monte_carlo_bridge_matches_continuous_closed_form(bt):
    opt = barrier(bt, "call")
    price, se = MonteCarloBarrierPricer(n_paths=100_000, steps_per_year=100).price_with_error(opt)
    assert abs(price - ANALYTIC.price(opt)) < 4 * se + 1e-3


def test_discrete_monitoring_bgk_vs_monte_carlo():
    opt = barrier("down-and-out", "call", rebate=2.0, monitoring=52)
    price, se = MonteCarloBarrierPricer(n_paths=200_000).price_with_error(opt)
    assert abs(price - ANALYTIC.price(opt)) < 4 * se + 0.02


def test_breached_barrier():
    knocked = barrier("down-and-out", "call", spot=90, rebate=1.5)
    assert ANALYTIC.price(knocked) == 1.5
    activated = barrier("down-and-in", "call", spot=90)
    vanilla = BlackScholesPricer().price(EuropeanOption(spot=90, strike=100, expiry=0.5, rate=0.08,
                                                        dividend_yield=0.04, vol=0.25))
    assert ANALYTIC.price(activated) == pytest.approx(vanilla)


def autocall(**kw):
    params = dict(spot=100, vol=0.2, rate=0.03, dividend_yield=0.02, coupon_rate=0.02)
    params.update(kw)
    return Autocallable.regular(3, 4, **params)


def test_autocall_probabilities_consistent():
    a = MonteCarloAutocallPricer(n_paths=50_000).analyze(autocall())
    assert a.redemption_probabilities.sum() == pytest.approx(1.0)
    assert 0 < a.expected_life <= 3.0
    assert 0 <= a.loss_probability < 1


def test_autocall_degenerate_cases():
    pr = MonteCarloAutocallPricer(n_paths=200_000)
    # never calls, no coupons, full protection => zero-coupon bond
    zc = pr.analyze(autocall(autocall_barrier=1e9, coupon_barrier=1e9, protection_barrier=0.0))
    assert zc.price == pytest.approx(100 * np.exp(-0.03 * 3))
    # never calls, no coupons, never protected => notional * S_T/S_0, i.e. a prepaid forward
    fwd = pr.analyze(autocall(autocall_barrier=1e9, coupon_barrier=1e9, protection_barrier=1e9))
    assert abs(fwd.price - 100 * np.exp(-0.02 * 3)) < 4 * fwd.std_error


def test_autocall_certain_first_call():
    # barrier at 0 => redeemed at first date with one coupon
    inst = autocall(autocall_barrier=0.0, coupon_barrier=0.0)
    a = MonteCarloAutocallPricer(n_paths=10_000).analyze(inst)
    assert a.price == pytest.approx(102 * np.exp(-0.03 * 0.25))
    assert a.redemption_probabilities[0] == 1.0


def test_autocall_memory_worth_more():
    pr = MonteCarloAutocallPricer(n_paths=50_000)
    assert pr.price(autocall(memory=True)) > pr.price(autocall(memory=False))


def test_autocall_greeks_signs():
    g = MonteCarloAutocallPricer(n_paths=50_000).greeks(autocall())
    assert g.delta > 0     # long the underlying through the down-and-in put
    assert g.vega < 0      # short volatility
    assert g.rho < 0       # long a bond-like payoff


def test_initial_level_frozen_under_spot_bump():
    inst = autocall()
    assert inst.with_spot(110).initial_level == 100
