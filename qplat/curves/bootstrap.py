"""Curve bootstrapping from money-market deposits and par swap / par bond rates.

Pillars are solved sequentially by maturity: for each quote we find the
discount factor at its maturity such that the quote reprices exactly, given
the pillars already fixed and the chosen interpolation for intermediate
cash-flow dates.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Sequence

import numpy as np
from scipy.optimize import brentq

from qplat.curves.rate_curve import InterpolatedCurve, Interpolation


@dataclass(frozen=True)
class DepositQuote:
    """Money-market deposit: simple rate, ACT/360 accrual on an ACT/365F maturity."""

    maturity: float
    rate: float
    accrual_basis: float = 365.0 / 360.0  # tau_accrual = maturity * basis

    def implied_df(self) -> float:
        return 1.0 / (1.0 + self.rate * self.maturity * self.accrual_basis)

    def residual(self, curve: InterpolatedCurve) -> float:
        return curve.discount(self.maturity) - self.implied_df()


@dataclass(frozen=True)
class ParRateQuote:
    """Par swap rate (fixed leg) or par bond yield: c * sum(tau_i P_i) + P_n = 1."""

    maturity: float
    rate: float
    frequency: int = 1

    def payment_times(self) -> np.ndarray:
        step = 1.0 / self.frequency
        n = max(int(round(self.maturity * self.frequency)), 1)
        times = self.maturity - step * np.arange(n)[::-1]
        return times[times > 1e-10]

    def residual(self, curve: InterpolatedCurve) -> float:
        times = self.payment_times()
        accruals = np.diff(np.concatenate([[0.0], times]))
        dfs = curve.discount(times)
        return self.rate * np.sum(accruals * dfs) + dfs[-1] - 1.0


Quote = DepositQuote | ParRateQuote


def bootstrap_curve(quotes: Sequence[Quote], interpolation: Interpolation = Interpolation.LOGLINEAR_DF) -> InterpolatedCurve:
    if not quotes:
        raise ValueError("need at least one quote")
    quotes = sorted(quotes, key=lambda q: q.maturity)
    mats = [q.maturity for q in quotes]
    if len(set(mats)) != len(mats):
        raise ValueError("duplicate maturities in quotes")

    times: list[float] = []
    dfs: list[float] = []
    for q in quotes:
        def f(df_guess: float) -> float:
            curve = InterpolatedCurve(times + [q.maturity], dfs + [df_guess], interpolation)
            return q.residual(curve)

        df = brentq(f, 1e-6, 2.0, xtol=1e-14, maxiter=200)
        times.append(q.maturity)
        dfs.append(df)
    return InterpolatedCurve(times, dfs, interpolation)
