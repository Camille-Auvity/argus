"""Structured / exotic equity products."""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import numpy as np

from qplat.instruments.base import EquityDerivative, OptionType


class BarrierType(str, Enum):
    DOWN_AND_OUT = "down-and-out"
    DOWN_AND_IN = "down-and-in"
    UP_AND_OUT = "up-and-out"
    UP_AND_IN = "up-and-in"

    @property
    def is_up(self) -> bool:
        return self in (BarrierType.UP_AND_OUT, BarrierType.UP_AND_IN)

    @property
    def is_knock_in(self) -> bool:
        return self in (BarrierType.DOWN_AND_IN, BarrierType.UP_AND_IN)


@dataclass(frozen=True, kw_only=True)
class BarrierOption(EquityDerivative):
    """Single-barrier European option.

    ``monitoring_per_year=None`` means continuous monitoring; otherwise the
    barrier is checked on a regular grid with that many dates per year.
    Rebate: paid at hit time for knock-outs, at expiry for unactivated knock-ins.
    """

    strike: float
    expiry: float
    barrier: float
    barrier_type: BarrierType
    option_type: OptionType = OptionType.CALL
    rebate: float = 0.0
    monitoring_per_year: Optional[int] = None

    def __post_init__(self):
        super().__post_init__()
        object.__setattr__(self, "barrier_type", BarrierType(self.barrier_type))
        object.__setattr__(self, "option_type", OptionType(self.option_type))
        if self.expiry <= 0 or self.strike <= 0 or self.barrier <= 0:
            raise ValueError("expiry, strike and barrier must be > 0")

    @property
    def maturity(self) -> float:
        return self.expiry

    def is_breached(self, s) -> np.ndarray | bool:
        return s >= self.barrier if self.barrier_type.is_up else s <= self.barrier

    def vanilla_payoff(self, s):
        return np.maximum(self.option_type.phi * (np.asarray(s, dtype=float) - self.strike), 0.0)

    def time_shifted(self, dt: float):
        return dataclasses.replace(self, expiry=self.expiry - dt)


@dataclass(frozen=True, kw_only=True)
class Autocallable(EquityDerivative):
    """Phoenix / Athena autocall on a single underlying.

    All barriers are expressed as a fraction of ``initial_level`` (the strike
    fixing, defaults to the current spot and is then frozen so that spot bumps
    move the underlying, not the barriers).

    On each observation date t_k (performance = S_k / initial_level):
      * coupon ``coupon_rate * notional`` if perf >= coupon_barrier
        (with memory: also pays previously missed coupons);
      * before the last date: early redemption at par if perf >= autocall_barrier;
      * at the last date: par if perf >= protection_barrier, else notional * perf.
    ``coupon_barrier == autocall_barrier`` gives a classic Athena.
    """

    observation_times: tuple[float, ...]
    notional: float = 100.0
    coupon_rate: float = 0.02
    autocall_barrier: float = 1.0
    coupon_barrier: float = 0.7
    protection_barrier: float = 0.6
    memory: bool = True
    initial_level: Optional[float] = None

    def __post_init__(self):
        super().__post_init__()
        times = tuple(float(t) for t in self.observation_times)
        if not times or any(t <= 0 for t in times) or any(b <= a for a, b in zip(times, times[1:])):
            raise ValueError("observation_times must be positive and strictly increasing")
        object.__setattr__(self, "observation_times", times)
        if self.initial_level is None:
            object.__setattr__(self, "initial_level", self.spot)

    @property
    def maturity(self) -> float:
        return self.observation_times[-1]

    def time_shifted(self, dt: float):
        if dt >= self.observation_times[0]:
            raise ValueError("time shift goes past the first observation date")
        return dataclasses.replace(self, observation_times=tuple(t - dt for t in self.observation_times))

    @classmethod
    def regular(cls, maturity_years: float, frequency: int = 4, **kwargs) -> "Autocallable":
        """Autocall with evenly spaced observations (e.g. quarterly over 5y)."""
        n = int(round(maturity_years * frequency))
        times = tuple((i + 1) / frequency for i in range(n))
        return cls(observation_times=times, **kwargs)
