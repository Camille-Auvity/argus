from __future__ import annotations

import dataclasses
from dataclasses import dataclass
from datetime import date
from enum import Enum

import numpy as np

from qplat.core.conventions import DEFAULT_DAY_COUNT, DayCount, year_fraction
from qplat.instruments.base import EquityDerivative, OptionType


class ExerciseStyle(str, Enum):
    EUROPEAN = "european"
    AMERICAN = "american"


@dataclass(frozen=True, kw_only=True)
class VanillaOption(EquityDerivative):
    strike: float
    expiry: float  # year fraction, ACT/365F
    option_type: OptionType = OptionType.CALL
    exercise: ExerciseStyle = ExerciseStyle.EUROPEAN

    def __post_init__(self):
        super().__post_init__()
        if self.strike <= 0:
            raise ValueError("strike must be > 0")
        if self.expiry <= 0:
            raise ValueError("expiry must be > 0")
        object.__setattr__(self, "option_type", OptionType(self.option_type))
        object.__setattr__(self, "exercise", ExerciseStyle(self.exercise))

    @property
    def maturity(self) -> float:
        return self.expiry

    def payoff(self, s):
        s = np.asarray(s, dtype=float)
        return np.maximum(self.option_type.phi * (s - self.strike), 0.0)

    def time_shifted(self, dt: float):
        return dataclasses.replace(self, expiry=self.expiry - dt)

    @classmethod
    def from_dates(cls, valuation_date: date, expiry_date: date,
                   day_count: DayCount = DEFAULT_DAY_COUNT, **kwargs):
        return cls(expiry=year_fraction(valuation_date, expiry_date, day_count), **kwargs)


@dataclass(frozen=True, kw_only=True)
class EuropeanOption(VanillaOption):
    exercise: ExerciseStyle = ExerciseStyle.EUROPEAN

    def __post_init__(self):
        super().__post_init__()
        if self.exercise is not ExerciseStyle.EUROPEAN:
            raise ValueError("EuropeanOption must have european exercise")


@dataclass(frozen=True, kw_only=True)
class AmericanOption(VanillaOption):
    exercise: ExerciseStyle = ExerciseStyle.AMERICAN

    def __post_init__(self):
        super().__post_init__()
        if self.exercise is not ExerciseStyle.AMERICAN:
            raise ValueError("AmericanOption must have american exercise")
