import math

import numpy as np
import pytest

from qplat.credit import (
    CDS, HazardCurve, bootstrap_hazard, calibrate_merton, cds_legs, cds_risk, cds_value, implied_equity_vol,
    merton_cds_spreads, merton_equity, merton_fit, merton_hazard_curve,
)
from qplat.credit.cds import ACCRUAL
from qplat.curves import FlatCurve
from qplat.instruments import EuropeanOption
from qplat.pricers import BlackScholesPricer

CURVE = FlatCurve(0.03)
TENORS = [1, 2, 3, 5, 7, 10]
SPREADS = np.array([40, 55, 70, 95, 110, 120]) * 1e-4


# ----------------------------------------------------------------------------- hazard curve and legs

def test_hazard_curve_survival():
    h = HazardCurve((1.0, 3.0), (0.01, 0.03))
    assert h.survival(0.5) == pytest.approx(math.exp(-0.005))
    assert h.survival(2.0) == pytest.approx(math.exp(-0.01 - 0.03))
    assert h.survival(5.0) == pytest.approx(math.exp(-0.01 - 0.06 - 0.06))  # flat after the last pillar
    assert h.hazard(1.0) == 0.01 and h.hazard(1.5) == 0.03


def test_protection_leg_closed_form():
    lam, r, T, R = 0.02, 0.03, 5.0, 0.4
    legs = cds_legs(CDS(maturity=T, recovery=R), HazardCurve.flat(lam), FlatCurve(r))
    assert legs.protection == pytest.approx((1 - R) * lam / (lam + r) * (1 - math.exp(-(lam + r) * T)), rel=1e-12)


def test_credit_triangle():
    # flat hazard: par spread ~ lambda (1 - R), up to the ACT/360 accrual and the discrete schedule
    legs = cds_legs(CDS(maturity=5, recovery=0.4), HazardCurve.flat(0.02), FlatCurve(0.0))
    assert legs.par_spread == pytest.approx(0.02 * 0.6 / ACCRUAL, rel=2e-3)


def test_bootstrap_reprices_every_quote():
    h = bootstrap_hazard(TENORS, SPREADS, CURVE)
    for T, s in zip(TENORS, SPREADS):
        assert cds_legs(CDS(maturity=T), h, CURVE).par_spread == pytest.approx(s, abs=1e-12)
    assert all(x > 0 for x in h.hazards)
    # an upward sloping spread curve needs higher forward hazards than the spot spreads suggest
    assert h.hazards[3] > SPREADS[3] / 0.6


def test_bootstrap_rejects_arbitrageable_curve():
    with pytest.raises(ValueError):
        bootstrap_hazard([1, 5], [0.05, 0.001], CURVE)


def test_cds_at_par_is_worth_zero_and_upfront():
    h = bootstrap_hazard(TENORS, SPREADS, CURVE)
    assert cds_value(CDS(maturity=5, coupon=SPREADS[3]), h, CURVE) == pytest.approx(0.0, abs=1e-14)
    legs = cds_legs(CDS(maturity=5), h, CURVE)
    # standard coupon 100 bp above a 95 bp par spread: the buyer receives points upfront
    assert legs.upfront(0.01) == pytest.approx(-(0.01 - SPREADS[3]) * legs.rpv01)


def test_cds_risk():
    cds = CDS(maturity=5, coupon=0.01, notional=1e7)
    buy, _ = cds_risk(cds, TENORS, SPREADS, CURVE, buyer=True)
    sell, _ = cds_risk(cds, TENORS, SPREADS, CURVE, buyer=False)
    assert sell.value == pytest.approx(-buy.value) and sell.cs01 == pytest.approx(-buy.cs01)
    assert buy.cs01 == pytest.approx(buy.rpv01 * 1e7 * 1e-4, rel=0.02)     # CS01 ~ RPV01 x notional x 1 bp
    assert buy.jump_to_default == pytest.approx(0.6 * 1e7 - buy.value)
    assert buy.rec01 > 0      # spreads held: higher recovery means higher default probability, protection worth more
    assert buy.carry_1d == pytest.approx(-1e7 * 0.01 / 360)


# ----------------------------------------------------------------------------- Merton

def test_merton_round_trip():
    fit = calibrate_merton(100.0, 0.5, 120.0, T=2.0, r=0.03)
    E, se = merton_equity(fit.assets, fit.asset_vol, 120.0, 2.0, 0.03)
    assert E == pytest.approx(100.0, rel=1e-10) and se == pytest.approx(0.5, rel=1e-10)
    assert fit.default_probability == pytest.approx(0.5 * math.erfc(fit.d2 / math.sqrt(2)))


def test_merton_debt_is_riskless_minus_a_put():
    fit = merton_fit(150.0, 0.3, 100.0, 1.5, 0.04)
    put = BlackScholesPricer().price(EuropeanOption(spot=150.0, strike=100.0, expiry=1.5, vol=0.3, rate=0.04,
                                                    option_type="put"))
    assert fit.debt_value == pytest.approx(100.0 * math.exp(-0.06) - put, rel=1e-10)
    assert fit.spread > 0 and 0 < fit.recovery < 1


def test_merton_spread_increases_with_leverage_and_vol():
    low = calibrate_merton(100, 0.4, 50)
    high_lev = calibrate_merton(100, 0.4, 150)
    high_vol = calibrate_merton(100, 0.8, 50)
    assert high_lev.spread > low.spread and high_vol.spread > low.spread


def test_merton_hazard_curve_matches_survival():
    fit = calibrate_merton(100, 0.6, 120, T=1.0, r=0.03)
    h = merton_hazard_curve(fit, CURVE, horizon=5.0)
    for T in (1.0, 2.5, 5.0):
        direct = merton_fit(fit.assets, fit.asset_vol, 120, T, 0.03).default_probability
        assert 1 - h.survival(T) == pytest.approx(direct, rel=1e-8)


def test_implied_equity_vol_round_trip():
    fit = calibrate_merton(100, 0.55, 120, T=1.0, r=0.03)
    target = merton_cds_spreads(fit, CURVE, [5.0])[0]
    assert implied_equity_vol(100, 120, CURVE, target, 5.0) == pytest.approx(0.55, abs=1e-4)
