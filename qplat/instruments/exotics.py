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

    A is the arithmetic or geometric mean of S at ``fixing_times``. Every fixing is
    in the future (no averaging period already started).
    """

    strike: float
    fixing_times: tuple[float, ...]
    option_type: OptionType = OptionType.CALL
    averaging: Averaging = Averaging.ARITHMETIC

    def __post_init__(self):
        super().__post_init__()
        if self.strike <= 0:
            raise ValueError("strike must be > 0")
        object.__setattr__(self, "fixing_times", _check_times(self.fixing_times))
        object.__setattr__(self, "option_type", OptionType(self.option_type))
        object.__setattr__(self, "averaging", Averaging(self.averaging))

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
        if self.averaging is Averaging.GEOMETRIC:
            return np.exp(np.log(paths).mean(axis=1))
        return paths.mean(axis=1)

    def path_payoff(self, paths: np.ndarray) -> np.ndarray:
        return np.maximum(self.option_type.phi * (self.average(paths) - self.strike), 0.0)

    def time_shifted(self, dt: float):
        if dt >= self.fixing_times[0]:
            raise ValueError("time shift goes past the first fixing")
        return dataclasses.replace(self, fixing_times=tuple(t - dt for t in self.fixing_times))


# ----------------------------------------------------------------------------- cliquet

@dataclass(frozen=True, kw_only=True)
class CliquetOption(EquityDerivative):
    """Locally capped / floored, globally floored cliquet (ratchet), paid at the last reset.

    With resets t_1 < ... < t_n (t_0 = 0) and R_i = S(t_i) / S(t_{i-1}) - 1:

        payoff = notional * min( max( sum_i min(max(R_i, local_floor), local_cap), global_floor ), global_cap )

    ``None`` removes a cap or floor. Each period is a forward-starting call spread on the
    return: the price only depends on forward volatilities, not on the spot level.
    """

    reset_times: tuple[float, ...]
    local_floor: Optional[float] = None
    local_cap: Optional[float] = None
    global_floor: Optional[float] = None
    global_cap: Optional[float] = None
    notional: float = 100.0

    def __post_init__(self):
        super().__post_init__()
        object.__setattr__(self, "reset_times", _check_times(self.reset_times))
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

    def period_returns(self, paths: np.ndarray) -> np.ndarray:
        full = np.hstack([np.full((paths.shape[0], 1), self.spot), paths])
        return full[:, 1:] / full[:, :-1] - 1.0

    def path_payoff(self, paths: np.ndarray) -> np.ndarray:
        r = self.period_returns(paths)
        lo = -np.inf if self.local_floor is None else self.local_floor
        hi = np.inf if self.local_cap is None else self.local_cap
        total = np.clip(r, lo, hi).sum(axis=1)
        glo = -np.inf if self.global_floor is None else self.global_floor
        ghi = np.inf if self.global_cap is None else self.global_cap
        return self.notional * np.clip(total, glo, ghi)

    def time_shifted(self, dt: float):
        if dt >= self.reset_times[0]:
            raise ValueError("time shift goes past the first reset")
        return dataclasses.replace(self, reset_times=tuple(t - dt for t in self.reset_times))
