"""Credit default swaps: piecewise-constant hazard curve, ISDA-style legs, bootstrap, risk.

Conventions (close to the ISDA Standard Model, simplified schedule):
  * premium paid quarterly (ACT/360 accrual), dates rolled backward from maturity, first period short;
  * accrued premium is paid on default;
  * protection pays (1 - R) x notional at default;
  * legs integrated on a grid fine enough (weekly + every breakpoint) for the hazard rate and the
    forward rate to be constant on each sub-interval, where the ISDA closed forms are exact:
        int_a^b lambda P(s) Q(s) ds = lambda / (lambda + f) [P(a)Q(a) - P(b)Q(b)].
Times are ACT/365F years from the valuation date. Spreads are fractions (0.01 = 100 bp).
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass

import numpy as np
from scipy.optimize import brentq

from qplat.curves.rate_curve import RateCurve

ACCRUAL = 365.0 / 360.0      # ACT/360 accrual per ACT/365F year
GRID_STEP = 1.0 / 52.0


# ----------------------------------------------------------------------------- hazard curve

@dataclass(frozen=True)
class HazardCurve:
    """Piecewise-constant default intensity: lambda_i on (t_{i-1}, t_i], flat after the last pillar."""

    pillars: tuple[float, ...]
    hazards: tuple[float, ...]

    def __post_init__(self):
        if len(self.pillars) != len(self.hazards) or not self.pillars:
            raise ValueError("one hazard rate per pillar")
        if any(b <= a for a, b in zip(self.pillars, self.pillars[1:])) or self.pillars[0] <= 0:
            raise ValueError("pillars must be positive and increasing")

    @classmethod
    def flat(cls, hazard: float) -> "HazardCurve":
        return cls((1.0,), (hazard,))

    def cumulative(self, t) -> np.ndarray:
        """Integrated hazard Lambda(t) = int_0^t lambda(s) ds."""
        t = np.asarray(t, dtype=float)
        edges = np.concatenate([[0.0], self.pillars[:-1], [np.inf]])
        lam = np.asarray(self.hazards)
        overlap = np.clip(t[..., None] - edges[:-1], 0.0, np.diff(edges))
        return (overlap * lam).sum(axis=-1)

    def survival(self, t) -> np.ndarray:
        return np.exp(-self.cumulative(t))

    def hazard(self, t) -> np.ndarray:
        idx = np.searchsorted(self.pillars, np.asarray(t, dtype=float), side="left")
        return np.asarray(self.hazards)[np.minimum(idx, len(self.hazards) - 1)]

    def with_hazard(self, i: int, value: float) -> "HazardCurve":
        h = list(self.hazards)
        h[i] = value
        return dataclasses.replace(self, hazards=tuple(h))


# ----------------------------------------------------------------------------- CDS legs

@dataclass(frozen=True)
class CDS:
    """Single-name CDS seen from the protection buyer (pays ``coupon``, receives protection)."""

    maturity: float
    coupon: float = 0.01          # running spread paid on the premium leg
    recovery: float = 0.4
    notional: float = 1.0
    frequency: int = 4

    def payment_times(self) -> np.ndarray:
        step = 1.0 / self.frequency
        n = int(math.ceil(self.maturity / step - 1e-9))
        times = self.maturity - step * np.arange(n)[::-1]
        return times[times > 1e-9]


@dataclass(frozen=True)
class CDSLegs:
    protection: float      # PV of (1 - R) per unit notional
    rpv01: float           # PV of 1 per year of running premium (premium leg / spread), incl. accrual on default
    par_spread: float

    def upfront(self, coupon: float) -> float:
        """Points upfront paid by the protection buyer for a standard running coupon (fraction of notional)."""
        return self.protection - coupon * self.rpv01


def cds_legs(cds: CDS, hazard: HazardCurve, curve: RateCurve) -> CDSLegs:
    pay = cds.payment_times()
    starts = np.concatenate([[0.0], pay[:-1]])
    breaks = np.concatenate([np.arange(0.0, cds.maturity, GRID_STEP), pay, hazard.pillars, [0.0, cds.maturity]])
    grid = np.unique(np.round(breaks[(breaks >= 0) & (breaks <= cds.maturity)], 12))
    P = np.asarray(curve.discount(grid), dtype=float)
    Q = hazard.survival(grid)
    dt = np.diff(grid)
    lam = np.log(Q[:-1] / Q[1:]) / dt
    f = np.log(P[:-1] / P[1:]) / dt
    pq = P * Q
    lf = lam + f
    with np.errstate(invalid="ignore", divide="ignore"):
        weight = np.where(np.abs(lf) > 1e-12, lam / lf * (pq[:-1] - pq[1:]), lam * pq[:-1] * dt)
    protection = (1.0 - cds.recovery) * float(weight.sum())

    # premium: scheduled coupons + accrued premium on default (accrual measured from the period start)
    rpv01 = float(np.sum(ACCRUAL * (pay - starts) * np.asarray(curve.discount(pay)) * hazard.survival(pay)))
    mid = 0.5 * (grid[:-1] + grid[1:])
    period = np.searchsorted(pay, mid, side="left")
    accrued = ACCRUAL * (mid - starts[np.minimum(period, len(starts) - 1)])
    p_mid = np.sqrt(P[:-1] * P[1:])
    rpv01 += float(np.sum(accrued * p_mid * (Q[:-1] - Q[1:])))
    return CDSLegs(protection, rpv01, protection / rpv01)


def cds_value(cds: CDS, hazard: HazardCurve, curve: RateCurve) -> float:
    """Mark-to-market for the protection buyer: notional x (protection - coupon x RPV01)."""
    legs = cds_legs(cds, hazard, curve)
    return cds.notional * legs.upfront(cds.coupon)


# ----------------------------------------------------------------------------- bootstrap

def bootstrap_hazard(tenors, par_spreads, curve: RateCurve, recovery: float = 0.4) -> HazardCurve:
    """Hazard rates such that a CDS of each tenor reprices exactly its quoted par spread.

    Sequential: the hazard of segment (T_{j-1}, T_j] is solved with brentq, earlier segments fixed.
    """
    tenors = tuple(float(t) for t in tenors)
    spreads = [float(s) for s in par_spreads]
    if len(tenors) != len(spreads) or any(s <= 0 for s in spreads):
        raise ValueError("one positive spread per tenor")
    curve_h = HazardCurve(tenors, tuple(s / (1 - recovery) for s in spreads))  # credit-triangle first guess
    for j, (T, s) in enumerate(zip(tenors, spreads)):
        cds = CDS(maturity=T, recovery=recovery)

        def gap(lam, j=j, cds=cds, s=s):
            return cds_legs(cds, curve_h.with_hazard(j, lam), curve).par_spread - s

        try:
            lam = brentq(gap, 1e-10, 20.0, xtol=1e-14)
        except ValueError as exc:
            raise ValueError(f"no hazard rate reprices {1e4 * s:.0f} bp at {T:g}y: spread curve too inverted") from exc
        curve_h = curve_h.with_hazard(j, lam)
    return curve_h


# ----------------------------------------------------------------------------- risk

@dataclass(frozen=True)
class CDSRisk:
    value: float          # MTM, protection buyer if quantity > 0
    par_spread: float
    upfront: float        # points upfront for the contract coupon (fraction of notional)
    rpv01: float
    cs01: float           # value change for +1 bp on every quoted spread (re-bootstrap)
    ir01: float           # value change for +1 bp on the discount curve (spreads held, re-bootstrap)
    rec01: float          # value change for +1% recovery (spreads held, re-bootstrap)
    jump_to_default: float  # P&L if the name defaults now
    carry_1d: float       # running coupon over one day


def cds_risk(cds: CDS, tenors, par_spreads, curve: RateCurve, buyer: bool = True) -> tuple[CDSRisk, HazardCurve]:
    sign = 1.0 if buyer else -1.0
    spreads = np.asarray(par_spreads, dtype=float)

    def value(spr=spreads, cv=curve, rec=cds.recovery):
        h = bootstrap_hazard(tenors, spr, cv, rec)
        return sign * cds_value(dataclasses.replace(cds, recovery=rec), h, cv), h

    v, hazard = value()
    legs = cds_legs(cds, hazard, curve)
    bp = 1e-4
    risk = CDSRisk(
        value=v,
        par_spread=legs.par_spread,
        upfront=legs.upfront(cds.coupon),
        rpv01=legs.rpv01,
        cs01=value(spr=spreads + bp)[0] - v,
        ir01=value(cv=curve.shifted(bp))[0] - v,
        rec01=value(rec=cds.recovery + 0.01)[0] - v,
        jump_to_default=sign * cds.notional * (1 - cds.recovery) - v,
        carry_1d=-sign * cds.notional * cds.coupon / 360.0,
    )
    return risk, hazard
