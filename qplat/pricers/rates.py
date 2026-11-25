"""Discounting pricers for bonds and futures off a ``RateCurve``."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
from scipy.optimize import brentq

from qplat.curves.rate_curve import RateCurve
from qplat.instruments.fixed_income import BondFuture, EquityFuture, FixedRateBond


@dataclass(frozen=True)
class BondAnalytics:
    dirty_price: float
    clean_price: float
    accrued: float
    ytm: float                 # compounded at the bond frequency
    macaulay_duration: float
    modified_duration: float
    convexity: float
    dv01: float                # price change for -1bp parallel curve shift


class DiscountingBondPricer:
    def __init__(self, curve: RateCurve):
        self.curve = curve

    def dirty_price(self, bond: FixedRateBond, curve: RateCurve | None = None) -> float:
        times, amounts = bond.cashflows()
        return float(np.sum(amounts * (curve or self.curve).discount(times)))

    def clean_price(self, bond: FixedRateBond) -> float:
        return self.dirty_price(bond) - bond.accrued_interest()

    @staticmethod
    def price_from_yield(bond: FixedRateBond, ytm: float) -> float:
        times, amounts = bond.cashflows()
        return float(np.sum(amounts * (1 + ytm / bond.frequency) ** (-bond.frequency * times)))

    def yield_to_maturity(self, bond: FixedRateBond, dirty_price: float | None = None) -> float:
        target = self.dirty_price(bond) if dirty_price is None else dirty_price
        return brentq(lambda y: self.price_from_yield(bond, y) - target, -0.5, 2.0, xtol=1e-12)

    def analytics(self, bond: FixedRateBond) -> BondAnalytics:
        dirty = self.dirty_price(bond)
        y = self.yield_to_maturity(bond, dirty)
        times, amounts = bond.cashflows()
        f = bond.frequency
        disc = (1 + y / f) ** (-f * times)
        pv = amounts * disc
        mac = float(np.sum(times * pv) / dirty)
        mod = mac / (1 + y / f)
        conv = float(np.sum(pv * times * (times + 1 / f)) / (dirty * (1 + y / f) ** 2))
        bp = 1e-4
        dv01 = (self.dirty_price(bond, self.curve.shifted(-bp)) - self.dirty_price(bond, self.curve.shifted(bp))) / 2
        acc = bond.accrued_interest()
        return BondAnalytics(dirty, dirty - acc, acc, y, mac, mod, conv, dv01)


class FuturesPricer:
    """Forward-based futures pricing (deterministic rates => futures = forwards)."""

    def __init__(self, curve: RateCurve):
        self.curve = curve

    def price(self, fut: EquityFuture | BondFuture) -> float:
        if isinstance(fut, EquityFuture):
            return fut.spot * np.exp(-fut.dividend_yield * fut.maturity) / self.curve.discount(fut.maturity)
        if isinstance(fut, BondFuture):
            bond, td = fut.bond, fut.delivery
            times, amounts = bond.cashflows()
            dirty_now = float(np.sum(amounts * self.curve.discount(times)))
            before = times <= td
            pv_coupons = float(np.sum(amounts[before] * self.curve.discount(times[before])))
            fwd_dirty = (dirty_now - pv_coupons) / self.curve.discount(td)
            fwd_clean = fwd_dirty - bond.accrued_interest(td)
            return fwd_clean / fut.conversion_factor
        raise TypeError(f"unsupported future: {type(fut).__name__}")
