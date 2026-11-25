"""Instrument base classes — pure data containers, they never price themselves."""

from __future__ import annotations

import dataclasses
from abc import ABC, abstractmethod
from dataclasses import dataclass
from enum import Enum

from qplat.curves.rate_curve import CurveLike, RateCurve, as_curve


class OptionType(str, Enum):
    CALL = "call"
    PUT = "put"

    @property
    def phi(self) -> int:
        """+1 for calls, -1 for puts (sign used in closed-form formulas)."""
        return 1 if self is OptionType.CALL else -1


@dataclass(frozen=True, kw_only=True)
class Instrument(ABC):
    """Root of every priceable product."""


@dataclass(frozen=True, kw_only=True)
class EquityDerivative(Instrument):
    """Derivative on a single equity/index under a lognormal (Black-Scholes) market.

    Carries the market parameters the pricers need. ``rate`` accepts either a
    constant continuously compounded rate or any ``RateCurve``.
    Times are ACT/365F year fractions from the valuation date.
    """

    spot: float
    vol: float
    rate: CurveLike = 0.0
    dividend_yield: float = 0.0

    def __post_init__(self):
        if self.spot <= 0:
            raise ValueError("spot must be > 0")
        if self.vol <= 0:
            raise ValueError("vol must be > 0")

    @property
    def curve(self) -> RateCurve:
        return as_curve(self.rate)

    @property
    @abstractmethod
    def maturity(self) -> float:
        """Final time of the product (years)."""

    # --- bump helpers used by finite-difference Greeks ------------------------

    def with_spot(self, spot: float):
        return dataclasses.replace(self, spot=spot)

    def with_vol(self, vol: float):
        return dataclasses.replace(self, vol=vol)

    def with_rate_shift(self, shift: float):
        return dataclasses.replace(self, rate=self.curve.shifted(shift))

    @abstractmethod
    def time_shifted(self, dt: float):
        """Same contract seen `dt` years later (all remaining dates shortened by dt)."""
