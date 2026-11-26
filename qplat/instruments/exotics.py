"""Path-dependent and digital equity options: digital, Asian, cliquet.

Every product here exposes the same Monte Carlo interface:
  ``observation_times``       dates (years, > 0) where the payoff looks at the spot
  ``path_payoff(paths)``      payoff paid at ``maturity`` for spots simulated at those dates,
                              ``paths`` of shape (n_paths, len(observation_times))
so a single Monte Carlo engine prices all of them under any path model.
"""

from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from enum import Enum
from typing import Optional

import numpy as np

from qplat.instruments.base import EquityDerivative, OptionType


def _check_times(times) -> tuple[float, ...]:
    times = tuple(float(t) for t in times)
    if not times or any(t <= 0 for t in times) or any(b <= a for a, b in zip(times, times[1:])):
        raise ValueError("dates must be positive and strictly increasing")
    return times


def _regular_times(maturity: float, n: int) -> tuple[float, ...]:
    if n < 1:
        raise ValueError("need at least one date")
    return tuple(maturity * (i + 1) / n for i in range(n))


# ----------------------------------------------------------------------------- digital

class DigitalKind(str, Enum):
    CASH = "cash-or-nothing"    # pays `cash` if in the money
    ASSET = "asset-or-nothing"  # pays S_T if in the money


@dataclass(frozen=True, kw_only=True)
class DigitalOption(EquityDerivative):
    """European binary option: pays ``cash`` (or S_T) if S_T > K (call) / S_T < K (put)."""

    strike: float
    expiry: float
    option_type: OptionType = OptionType.CALL
    kind: DigitalKind = DigitalKind.CASH
    cash: float = 1.0

    def __post_init__(self):
        super().__post_init__()
        if self.expiry <= 0 or self.strike <= 0:
            raise ValueError("expiry and strike must be > 0")
        object.__setattr__(self, "option_type", OptionType(self.option_type))
        object.__setattr__(self, "kind", DigitalKind(self.kind))

    @property
    def maturity(self) -> float:
        return self.expiry

    @property
    def observation_times(self) -> tuple[float, ...]:
        return (self.expiry,)

    def payoff(self, s):
        s = np.asarray(s, dtype=float)
        itm = self.option_type.phi * (s - self.strike) > 0
        return np.where(itm, self.cash if self.kind is DigitalKind.CASH else s, 0.0)

    def path_payoff(self, paths: np.ndarray) -> np.ndarray:
        return self.payoff(paths[:, -1])

    def time_shifted(self, dt: float):
        return dataclasses.replace(self, expiry=self.expiry - dt)


# ----------------------------------------------------------------------------- Asian

class Averaging(str, Enum):
    ARITHMETIC = "arithmetic"
    GEOMETRIC = "geometric"


@dataclass(frozen=True, kw_only=True)
class AsianOption(EquityDerivative):
    """Average-price option on discrete fixings: payoff (phi (A - K))+ paid at the last fixing.

    A is the arithmetic or geometric mean of S over every fixing of the contract: the
    already observed ``past_fixings`` (seasoned option) and the future ``fixing_times``.
    """

    strike: float
    fixing_times: tuple[float, ...]
    option_type: OptionType = OptionType.CALL
    averaging: Averaging = Averaging.ARITHMETIC
    past_fixings: tuple[float, ...] = ()

    def __post_init__(self):
        super().__post_init__()
        if self.strike <= 0:
            raise ValueError("strike must be > 0")
        object.__setattr__(self, "fixing_times", _check_times(self.fixing_times))
        object.__setattr__(self, "option_type", OptionType(self.option_type))
        object.__setattr__(self, "averaging", Averaging(self.averaging))
        object.__setattr__(self, "past_fixings", tuple(float(x) for x in self.past_fixings))
        if any(x <= 0 for x in self.past_fixings):
            raise ValueError("past fixings must be > 0")

    @property
    def n_total(self) -> int:
        return len(self.past_fixings) + len(self.fixing_times)

    @classmethod
    def regular(cls, expiry: float, n_fixings: int, **kwargs) -> "AsianOption":
        """Evenly spaced fixings, the last one at expiry (e.g. 12 monthly fixings over 1y)."""
        return cls(fixing_times=_regular_times(expiry, n_fixings), **kwargs)

    @property
    def maturity(self) -> float:
        return self.fixing_times[-1]

    @property
    def observation_times(self) -> tuple[float, ...]:
        return self.fixing_times

    def average(self, paths: np.ndarray) -> np.ndarray:
        n = self.n_total
        if self.averaging is Averaging.GEOMETRIC:
            return np.exp((np.log(paths).sum(axis=1) + float(np.log(self.past_fixings).sum())) / n)
        return (paths.sum(axis=1) + sum(self.past_fixings)) / n

    def path_payoff(self, paths: np.ndarray) -> np.ndarray:
        return np.maximum(self.option_type.phi * (self.average(paths) - self.strike), 0.0)

    def time_shifted(self, dt: float):
        """Fixings passed during dt are fixed at today's spot (theta convention: the spot does not move)."""
        passed = [t for t in self.fixing_times if t <= dt]
        if len(passed) == len(self.fixing_times):
            raise ValueError("time shift goes past the last fixing")
        return dataclasses.replace(self, fixing_times=tuple(t - dt for t in self.fixing_times if t > dt),
                                   past_fixings=self.past_fixings + (self.spot,) * len(passed))


# ----------------------------------------------------------------------------- cliquet

@dataclass(frozen=True, kw_only=True)
class CliquetOption(EquityDerivative):
    """Locally capped / floored, globally floored cliquet (ratchet), paid at the last reset.

    With resets t_1 < ... < t_n (t_0 = 0) and R_i = S(t_i) / S(t_{i-1}) - 1:

        payoff = notional * min( max( sum_i min(max(R_i, local_floor), local_cap), global_floor ), global_cap )

    ``None`` removes a cap or floor. Each period is a forward-starting call spread on the
    return: the price only depends on forward volatilities, not on the spot level.

    Seasoned cliquet: ``accrued`` is the sum of the (locally clipped) returns of the periods
    already completed and ``initial_level`` the frozen reference level of the running period.
    ``initial_level=None`` means the reference is the current spot (contract not struck yet).
    """

    reset_times: tuple[float, ...]
    local_floor: Optional[float] = None
    local_cap: Optional[float] = None
    global_floor: Optional[float] = None
    global_cap: Optional[float] = None
    notional: float = 100.0
    initial_level: Optional[float] = None
    accrued: float = 0.0

    def __post_init__(self):
        super().__post_init__()
        object.__setattr__(self, "reset_times", _check_times(self.reset_times))
        if self.initial_level is not None and self.initial_level <= 0:
            raise ValueError("initial level must be > 0")
        if self.local_floor is not None and self.local_cap is not None and self.local_floor > self.local_cap:
            raise ValueError("local floor above local cap")
        if self.global_floor is not None and self.global_cap is not None and self.global_floor > self.global_cap:
            raise ValueError("global floor above global cap")

    @classmethod
    def regular(cls, maturity: float, frequency: int = 4, **kwargs) -> "CliquetOption":
        """Evenly spaced resets, e.g. quarterly over 2 years."""
        return cls(reset_times=_regular_times(maturity, int(round(maturity * frequency))), **kwargs)

    @property
    def maturity(self) -> float:
        return self.reset_times[-1]

    @property
    def observation_times(self) -> tuple[float, ...]:
        return self.reset_times

    def clip_local(self, r):
        lo = -np.inf if self.local_floor is None else self.local_floor
        hi = np.inf if self.local_cap is None else self.local_cap
        return np.clip(r, lo, hi)

    def period_returns(self, paths: np.ndarray) -> np.ndarray:
        ref = self.spot if self.initial_level is None else self.initial_level
        full = np.hstack([np.full((paths.shape[0], 1), ref), paths])
        return full[:, 1:] / full[:, :-1] - 1.0

    def path_payoff(self, paths: np.ndarray) -> np.ndarray:
        total = self.accrued + self.clip_local(self.period_returns(paths)).sum(axis=1)
        glo = -np.inf if self.global_floor is None else self.global_floor
        ghi = np.inf if self.global_cap is None else self.global_cap
        return self.notional * np.clip(total, glo, ghi)

    def time_shifted(self, dt: float):
        """A reset passed during dt completes its period at today's spot (theta convention)."""
        if dt >= self.reset_times[-1]:
            raise ValueError("time shift goes past the last reset")
        out = dataclasses.replace(self, reset_times=tuple(t - dt for t in self.reset_times if t > dt))
        for _ in (t for t in self.reset_times if t <= dt):
            ref = self.spot if out.initial_level is None else out.initial_level
            out = dataclasses.replace(out, accrued=out.accrued + float(self.clip_local(self.spot / ref - 1.0)),
                                      initial_level=self.spot)
        return out
