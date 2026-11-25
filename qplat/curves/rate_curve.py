"""Discount curves.

All curves answer the same questions on the ACT/365F time axis, with
continuously compounded rates (see ``qplat.core.conventions``):

* ``discount(t)``      discount factor P(0, t)
* ``zero_rate(t)``     -ln P(0, t) / t
* ``forward_rate(a,b)``continuous forward rate between a and b
* ``shifted(bp)``      parallel-shifted copy (used for rho / DV01)
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from enum import Enum
from typing import Union

import numpy as np

ArrayLike = Union[float, np.ndarray]

_EPS_T = 1e-8


class RateCurve(ABC):
    @abstractmethod
    def discount(self, t: ArrayLike) -> ArrayLike:
        """Discount factor P(0, t). Vectorised over t."""

    def zero_rate(self, t: ArrayLike) -> ArrayLike:
        t_arr = np.maximum(np.asarray(t, dtype=float), _EPS_T)
        z = -np.log(self.discount(t_arr)) / t_arr
        return float(z) if np.ndim(z) == 0 else z

    def forward_rate(self, t1: ArrayLike, t2: ArrayLike) -> ArrayLike:
        t1 = np.asarray(t1, dtype=float)
        t2 = np.asarray(t2, dtype=float)
        dt = np.maximum(t2 - t1, _EPS_T)
        f = np.log(self.discount(t1) / self.discount(t2)) / dt
        return float(f) if np.ndim(f) == 0 else f

    def shifted(self, shift: float) -> "RateCurve":
        """Parallel shift of the zero curve by `shift` (absolute, e.g. 0.0001 = 1bp)."""
        return ShiftedCurve(self, shift)


class FlatCurve(RateCurve):
    """Constant continuously compounded rate."""

    def __init__(self, rate: float):
        self.rate = float(rate)

    def discount(self, t):
        return np.exp(-self.rate * np.asarray(t, dtype=float)) if np.ndim(t) else float(np.exp(-self.rate * t))

    def shifted(self, shift: float) -> "FlatCurve":
        return FlatCurve(self.rate + shift)

    def __repr__(self) -> str:
        return f"FlatCurve({self.rate:.6f})"


class ShiftedCurve(RateCurve):
    def __init__(self, base: RateCurve, shift: float):
        self.base, self.shift = base, float(shift)

    def discount(self, t):
        t_arr = np.asarray(t, dtype=float)
        out = self.base.discount(t_arr) * np.exp(-self.shift * t_arr)
        return float(out) if np.ndim(out) == 0 else out


class Interpolation(str, Enum):
    LINEAR_ZERO = "linear_zero"      # linear on zero rates, flat extrapolation
    LOGLINEAR_DF = "loglinear_df"    # linear on ln P => piecewise-constant forwards


class InterpolatedCurve(RateCurve):
    """Curve defined by pillar (time, discount factor) pairs."""

    def __init__(self, times, discount_factors, interpolation: Interpolation = Interpolation.LOGLINEAR_DF):
        times = np.asarray(times, dtype=float)
        dfs = np.asarray(discount_factors, dtype=float)
        if times.ndim != 1 or times.shape != dfs.shape or len(times) == 0:
            raise ValueError("times and discount_factors must be 1-D arrays of equal, non-zero length")
        if np.any(np.diff(times) <= 0) or times[0] <= 0:
            raise ValueError("pillar times must be strictly increasing and > 0")
        if np.any(dfs <= 0):
            raise ValueError("discount factors must be positive")
        self.times = times
        self.dfs = dfs
        self.interpolation = Interpolation(interpolation)
        self._zeros = -np.log(dfs) / times
        # log-linear nodes include the anchor P(0,0) = 1
        self._nodes_t = np.concatenate([[0.0], times])
        self._nodes_lndf = np.concatenate([[0.0], np.log(dfs)])

    def discount(self, t):
        t_arr = np.asarray(t, dtype=float)
        scalar = t_arr.ndim == 0
        t_arr = np.atleast_1d(t_arr)
        if self.interpolation == Interpolation.LINEAR_ZERO:
            z = np.interp(t_arr, self.times, self._zeros)  # flat outside pillars
            out = np.exp(-z * t_arr)
        else:
            ln_df = np.interp(t_arr, self._nodes_t, self._nodes_lndf)
            beyond = t_arr > self.times[-1]
            if np.any(beyond):
                if len(self.times) > 1:
                    last_fwd = (self._nodes_lndf[-2] - self._nodes_lndf[-1]) / (self._nodes_t[-1] - self._nodes_t[-2])
                else:
                    last_fwd = self._zeros[-1]
                ln_df[beyond] = self._nodes_lndf[-1] - last_fwd * (t_arr[beyond] - self.times[-1])
            out = np.exp(ln_df)
        return float(out[0]) if scalar else out

    def pillars(self):
        """(time, discount factor, zero rate) per pillar — handy for display/storage."""
        return list(zip(self.times.tolist(), self.dfs.tolist(), self._zeros.tolist()))

    def __repr__(self) -> str:
        return f"InterpolatedCurve({len(self.times)} pillars, {self.interpolation.value})"


CurveLike = Union[float, RateCurve]


def as_curve(rate: CurveLike) -> RateCurve:
    """Accept either a constant rate or a curve — lets instruments take both."""
    return rate if isinstance(rate, RateCurve) else FlatCurve(float(rate))
