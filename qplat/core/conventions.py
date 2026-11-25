"""Calendar and day-count conventions.

Platform-wide convention (fixed once, here, to avoid silent price drifts):

* Every time quantity handled by pricers and curves is a **year fraction**
  measured with ACT/365 Fixed from the valuation date.
* Every rate handled internally is **continuously compounded** and expressed
  on that same ACT/365F time axis.
* Market quotes that use other conventions (money-market ACT/360 deposits,
  30/360 bond coupons, ...) are converted at the boundary, when building the
  instrument or the curve, never inside a pricer.
"""

from __future__ import annotations

import math
from datetime import date
from enum import Enum


class DayCount(str, Enum):
    ACT_365F = "ACT/365F"
    ACT_360 = "ACT/360"
    THIRTY_360 = "30/360"
    ACT_ACT_ISDA = "ACT/ACT"


DEFAULT_DAY_COUNT = DayCount.ACT_365F
TRADING_DAYS_PER_YEAR = 252


def year_fraction(start: date, end: date, convention: DayCount = DEFAULT_DAY_COUNT) -> float:
    """Year fraction between two dates under the given day-count convention."""
    if end < start:
        return -year_fraction(end, start, convention)
    days = (end - start).days
    if convention == DayCount.ACT_365F:
        return days / 365.0
    if convention == DayCount.ACT_360:
        return days / 360.0
    if convention == DayCount.THIRTY_360:
        # US 30/360 (bond basis)
        d1, d2 = min(start.day, 30), end.day
        if d1 == 30 and d2 == 31:
            d2 = 30
        return (360 * (end.year - start.year) + 30 * (end.month - start.month) + (d2 - d1)) / 360.0
    if convention == DayCount.ACT_ACT_ISDA:
        if start.year == end.year:
            return days / _days_in_year(start.year)
        frac = (date(start.year + 1, 1, 1) - start).days / _days_in_year(start.year)
        frac += end.year - start.year - 1
        frac += (end - date(end.year, 1, 1)).days / _days_in_year(end.year)
        return frac
    raise ValueError(f"Unsupported day count: {convention}")


def _days_in_year(year: int) -> int:
    return 366 if (year % 4 == 0 and year % 100 != 0) or year % 400 == 0 else 365


def business_days_between(start: date, end: date) -> int:
    """Weekdays in [start, end) — no holiday calendar (documented simplification)."""
    import numpy as np

    return int(np.busday_count(start, end))


# --- Rate conversions -------------------------------------------------------

def simple_to_continuous(rate: float, tau: float) -> float:
    """Simple (money-market) rate over accrual tau -> continuous rate on same tau."""
    return math.log1p(rate * tau) / tau


def compounded_to_continuous(rate: float, frequency: int) -> float:
    """Rate compounded `frequency` times a year -> continuous rate."""
    return frequency * math.log1p(rate / frequency)


def continuous_to_compounded(rate: float, frequency: int) -> float:
    return frequency * (math.exp(rate / frequency) - 1.0)
