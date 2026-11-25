import math
from datetime import date

import numpy as np
import pytest

from qplat.core.conventions import DayCount, year_fraction
from qplat.curves import (
    DepositQuote, FlatCurve, InterpolatedCurve, Interpolation, ParRateQuote, bootstrap_curve,
)
from qplat.instruments import BondFuture, EquityFuture, FixedRateBond, ZeroCouponBond
from qplat.pricers import DiscountingBondPricer, FuturesPricer


def test_day_counts():
    d1, d2 = date(2026, 1, 15), date(2026, 7, 15)
    assert year_fraction(d1, d2, DayCount.ACT_365F) == pytest.approx(181 / 365)
    assert year_fraction(d1, d2, DayCount.ACT_360) == pytest.approx(181 / 360)
    assert year_fraction(d1, d2, DayCount.THIRTY_360) == pytest.approx(0.5)
    assert year_fraction(date(2027, 12, 31), date(2028, 12, 31), DayCount.ACT_ACT_ISDA) == pytest.approx(1.0, abs=1e-3)


@pytest.mark.parametrize("interp", list(Interpolation))
def test_interpolated_curve_hits_pillars(interp):
    times, dfs = [0.5, 1, 2, 5], [0.98, 0.96, 0.92, 0.80]
    c = InterpolatedCurve(times, dfs, interp)
    assert np.allclose(c.discount(np.array(times)), dfs)
    assert c.discount(0.0) == pytest.approx(1.0)
    assert 0.92 > c.discount(3.0) > 0.80


def test_loglinear_gives_piecewise_flat_forwards():
    c = InterpolatedCurve([1, 2], [0.96, 0.90], Interpolation.LOGLINEAR_DF)
    assert c.forward_rate(1.1, 1.3) == pytest.approx(c.forward_rate(1.5, 1.9))
    assert c.forward_rate(2.5, 3.0) == pytest.approx(math.log(0.96 / 0.90))


def test_shifted_curve():
    c = InterpolatedCurve([1, 2], [0.96, 0.90])
    s = c.shifted(0.01)
    assert s.zero_rate(1.5) == pytest.approx(c.zero_rate(1.5) + 0.01)
    assert FlatCurve(0.03).shifted(0.01).rate == pytest.approx(0.04)


QUOTES = [
    DepositQuote(0.25, 0.040),
    DepositQuote(0.5, 0.041),
    ParRateQuote(1.0, 0.042, 2),
    ParRateQuote(2.0, 0.043, 2),
    ParRateQuote(5.0, 0.045, 2),
    ParRateQuote(10.0, 0.047, 2),
    ParRateQuote(30.0, 0.049, 2),
]


@pytest.mark.parametrize("interp", list(Interpolation))
def test_bootstrap_reprices_all_quotes(interp):
    curve = bootstrap_curve(QUOTES, interp)
    for q in QUOTES:
        assert abs(q.residual(curve)) < 1e-10


def test_par_bond_prices_at_par_on_bootstrapped_curve():
    curve = bootstrap_curve(QUOTES)
    bond = FixedRateBond(maturity=10.0, coupon_rate=0.047, frequency=2)
    a = DiscountingBondPricer(curve).analytics(bond)
    assert a.dirty_price == pytest.approx(100.0, abs=1e-8)
    assert a.ytm == pytest.approx(0.047, abs=1e-8)
    assert a.dv01 > 0


def test_bond_analytics_flat_yield():
    # flat continuous rate r <=> semi-annual yield 2(e^{r/2}-1)
    r = 0.05
    bond = FixedRateBond(maturity=5.0, coupon_rate=0.05, frequency=2)
    a = DiscountingBondPricer(FlatCurve(r)).analytics(bond)
    assert a.ytm == pytest.approx(2 * (math.exp(r / 2) - 1), abs=1e-10)
    assert a.modified_duration == pytest.approx(a.macaulay_duration / (1 + a.ytm / 2))
    # duration approximation of a 1bp yield move
    p0 = DiscountingBondPricer.price_from_yield(bond, a.ytm)
    p1 = DiscountingBondPricer.price_from_yield(bond, a.ytm + 1e-4)
    assert (p0 - p1) / p0 == pytest.approx(a.modified_duration * 1e-4, rel=1e-3)


def test_zero_coupon_bond():
    z = ZeroCouponBond(maturity=3.0)
    assert DiscountingBondPricer(FlatCurve(0.04)).dirty_price(z) == pytest.approx(100 * math.exp(-0.12))


def test_accrued_interest_mid_period():
    bond = FixedRateBond(maturity=4.75, coupon_rate=0.06, frequency=2)  # next coupon in 0.25y
    assert bond.accrued_interest() == pytest.approx(100 * 0.03 * 0.5)
    pricer = DiscountingBondPricer(FlatCurve(0.05))
    assert pricer.clean_price(bond) == pytest.approx(pricer.dirty_price(bond) - 1.5)


def test_equity_future_cost_of_carry():
    f = FuturesPricer(FlatCurve(0.05)).price(EquityFuture(spot=100, maturity=0.5, dividend_yield=0.02))
    assert f == pytest.approx(100 * math.exp(0.03 * 0.5))


def test_bond_future_no_arbitrage():
    curve = bootstrap_curve(QUOTES)
    bond = FixedRateBond(maturity=10.0, coupon_rate=0.05, frequency=2)
    fut = BondFuture(bond=bond, delivery=0.25, conversion_factor=1.0)
    price = FuturesPricer(curve).price(fut)
    # cash-and-carry: buy bond now, receive no coupon before 0.25 (first at 0.5), deliver
    dirty_now = DiscountingBondPricer(curve).dirty_price(bond)
    expected = dirty_now / curve.discount(0.25) - bond.accrued_interest(0.25)
    assert price == pytest.approx(expected)
