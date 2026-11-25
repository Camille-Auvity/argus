"""Bonds and futures — contract terms only, priced by ``qplat.pricers.rates``."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from qplat.instruments.base import Instrument


@dataclass(frozen=True, kw_only=True)
class FixedRateBond(Instrument):
    """Bullet fixed-coupon bond. Schedule is built backward from maturity.

    ``maturity`` is an ACT/365F year fraction; coupon accrual uses the regular
    period length 1/frequency (an ACT/ACT-style simplification).
    """

    maturity: float
    coupon_rate: float
    face: float = 100.0
    frequency: int = 2

    def __post_init__(self):
        if self.maturity <= 0:
            raise ValueError("maturity must be > 0")
        if self.frequency <= 0:
            raise ValueError("frequency must be >= 1")

    @property
    def period(self) -> float:
        return 1.0 / self.frequency

    def coupon_times(self, after: float = 0.0) -> np.ndarray:
        """Coupon dates strictly after `after`."""
        n = int(np.floor((self.maturity - after) * self.frequency + 1e-9))
        times = self.maturity - self.period * np.arange(n + 1)[::-1]
        return times[times > after + 1e-12]

    def cashflows(self, after: float = 0.0) -> tuple[np.ndarray, np.ndarray]:
        times = self.coupon_times(after)
        amounts = np.full(times.shape, self.face * self.coupon_rate / self.frequency)
        amounts[-1] += self.face
        return times, amounts

    def accrued_interest(self, t: float = 0.0) -> float:
        times = self.coupon_times(t)
        if len(times) == 0:
            return 0.0
        time_to_next = times[0] - t
        elapsed = max(self.period - time_to_next, 0.0)
        return self.face * self.coupon_rate / self.frequency * elapsed / self.period


@dataclass(frozen=True, kw_only=True)
class ZeroCouponBond(FixedRateBond):
    coupon_rate: float = 0.0
    frequency: int = 1


@dataclass(frozen=True, kw_only=True)
class EquityFuture(Instrument):
    spot: float
    maturity: float
    dividend_yield: float = 0.0


@dataclass(frozen=True, kw_only=True)
class BondFuture(Instrument):
    """Bond future on a single deliverable (no CTD switch, no delivery options).

    Times of the underlying bond are measured from today, like ``delivery``.
    """

    bond: FixedRateBond
    delivery: float
    conversion_factor: float = 1.0

    def __post_init__(self):
        if not 0 < self.delivery < self.bond.maturity:
            raise ValueError("delivery must be between today and bond maturity")
