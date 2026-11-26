"""Caps and floors on the forward rates of a discount curve: Black-76 (lognormal) or Bachelier (normal).

A cap of maturity T and frequency f is a strip of caplets on the periods (t_{i-1}, t_i], t_i = i / f.
The first period, already fixed today, is excluded (market convention). Caplet i pays at t_i

    N tau_i max(L_i - K, 0),   L_i = simple forward rate fixed at t_{i-1},   F_i = (P(t_{i-1}) / P(t_i) - 1) / tau_i

    Black:      N tau_i P(t_i) [F N(d1) - K N(d2)],      d1,2 = [ln(F/K) +- sigma^2 t_{i-1} / 2] / (sigma sqrt t_{i-1})
    Bachelier:  N tau_i P(t_i) [(F - K) N(d) + sigma_n sqrt(t_{i-1}) n(d)],   d = (F - K) / (sigma_n sqrt t_{i-1})

Floors: same with puts. Parity: cap - floor = payer swap = sum_i N tau_i P(t_i) (F_i - K).
Times are ACT/365F year fractions and accrual fractions tau_i = t_i - t_{i-1} (simplified schedule).
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Literal

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm

from qplat.curves.rate_curve import RateCurve

Model = Literal["black", "bachelier"]


@dataclass(frozen=True)
class CapFloor:
    maturity: float
    strike: float
    kind: Literal["cap", "floor"] = "cap"
    frequency: int = 4
    notional: float = 1.0

    @property
    def phi(self) -> int:
        return 1 if self.kind == "cap" else -1

    def periods(self) -> tuple[np.ndarray, np.ndarray]:
        """(start, end) of every caplet, the first (already fixed) period excluded."""
        n = int(round(self.maturity * self.frequency))
        if n < 2:
            raise ValueError("a cap needs at least two periods (the first one is already fixed)")
        t = self.maturity * np.arange(n + 1) / n
        return t[1:-1], t[2:]


def forward_rates(curve: RateCurve, start: np.ndarray, end: np.ndarray) -> np.ndarray:
    return (np.asarray(curve.discount(start)) / np.asarray(curve.discount(end)) - 1.0) / (end - start)


def forward_swap_rate(curve: RateCurve, start: np.ndarray, end: np.ndarray) -> float:
    """Par rate of the swap on the same periods: the ATM strike of the cap."""
    annuity = float(np.sum((end - start) * np.asarray(curve.discount(end))))
    return float((curve.discount(start[0]) - curve.discount(end[-1])) / annuity)


def caplet_values(F, K, T, vol, phi: int, model: Model) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Undiscounted, unit-accrual option value, dV/dF and dV/dvol for each caplet (vectorised)."""
    F, T = np.asarray(F, float), np.asarray(T, float)
    vol = np.broadcast_to(np.asarray(vol, float), F.shape)
    sq = vol * np.sqrt(T)
    if model == "black":
        if np.any(F <= 0) or K <= 0:
            raise ValueError("Black needs positive forwards and strike: use the Bachelier (normal) model")
        d1 = (np.log(F / K) + 0.5 * sq * sq) / sq
        d2 = d1 - sq
        value = phi * (F * norm.cdf(phi * d1) - K * norm.cdf(phi * d2))
        return value, phi * norm.cdf(phi * d1), F * norm.pdf(d1) * np.sqrt(T)
    d = (F - K) / sq
    value = phi * (F - K) * norm.cdf(phi * d) + sq * norm.pdf(d)
    return value, phi * norm.cdf(phi * d), np.sqrt(T) * norm.pdf(d)


@dataclass(frozen=True)
class CapletRow:
    start: float
    end: float
    accrual: float
    forward: float
    discount: float
    price: float
    delta: float    # dV/dF x tau x P x N (value change per unit forward move, PV)
    vega: float     # dV/dvol (PV)


@dataclass(frozen=True)
class CapFloorResult:
    price: float
    atm_strike: float
    annuity: float
    caplets: list[CapletRow]


def price_capfloor(cap: CapFloor, curve: RateCurve, vol: float, model: Model = "black") -> CapFloorResult:
    start, end = cap.periods()
    tau = end - start
    F = forward_rates(curve, start, end)
    P = np.asarray(curve.discount(end), float)
    v, dvdf, dvdvol = caplet_values(F, cap.strike, start, vol, cap.phi, model)
    w = cap.notional * tau * P
    rows = [CapletRow(float(a), float(b), float(t), float(f), float(p), float(x), float(d), float(g))
            for a, b, t, f, p, x, d, g in zip(start, end, tau, F, P, w * v, w * dvdf, w * dvdvol)]
    return CapFloorResult(float(np.sum(w * v)), forward_swap_rate(curve, start, end), float(np.sum(tau * P)), rows)


@dataclass(frozen=True)
class CapFloorGreeks:
    price: float
    dv01: float      # value change for a +1 bp parallel shift of the curve (vol held)
    gamma_1bp: float # second difference for 1 bp shifts: V(+1) - 2V + V(-1)
    vega: float      # per 1 vol point (Black: 1% lognormal; Bachelier: 1 bp normal)
    theta: float     # one day later, same curve and vol (calendar roll)


def capfloor_greeks(cap: CapFloor, curve: RateCurve, vol: float, model: Model = "black") -> CapFloorGreeks:
    bp = 1e-4
    v0 = price_capfloor(cap, curve, vol, model).price
    up = price_capfloor(cap, curve.shifted(bp), vol, model).price
    dn = price_capfloor(cap, curve.shifted(-bp), vol, model).price
    unit = 0.01 if model == "black" else 1e-4
    vega = (price_capfloor(cap, curve, vol + unit / 2, model).price
            - price_capfloor(cap, curve, vol - unit / 2, model).price)
    # one day later: every date one day closer (approximation: same curve seen from tomorrow)
    dt = 1 / 365
    later = _shifted_price(cap, curve, vol, model, dt)
    return CapFloorGreeks(v0, up - v0, up - 2 * v0 + dn, vega, later - v0)


def _shifted_price(cap: CapFloor, curve: RateCurve, vol: float, model: Model, dt: float) -> float:
    start, end = cap.periods()
    start, end = start - dt, end - dt
    tau = end - start
    F = forward_rates(curve, start, end)
    P = np.asarray(curve.discount(end), float)
    v, _, _ = caplet_values(F, cap.strike, np.maximum(start, 1e-8), vol, cap.phi, model)
    return float(np.sum(cap.notional * tau * P * v))


def implied_flat_vol(cap: CapFloor, curve: RateCurve, price: float, model: Model = "black") -> float:
    """Single vol that reprices the whole cap (the market 'flat' vol quote)."""
    lo, hi = (1e-4, 5.0) if model == "black" else (1e-6, 0.1)
    return float(brentq(lambda s: price_capfloor(cap, curve, s, model).price - price, lo, hi, xtol=1e-12))


def swap_value(cap: CapFloor, curve: RateCurve) -> float:
    """Payer swap on the same periods at the cap strike: cap - floor."""
    start, end = cap.periods()
    F = forward_rates(curve, start, end)
    return float(np.sum(cap.notional * (end - start) * np.asarray(curve.discount(end)) * (F - cap.strike)))


def with_strike(cap: CapFloor, strike: float) -> CapFloor:
    return replace(cap, strike=strike)


__all__ = [
    "CapFloor", "CapFloorGreeks", "CapFloorResult", "CapletRow", "caplet_values", "capfloor_greeks",
    "forward_rates", "forward_swap_rate", "implied_flat_vol", "price_capfloor", "swap_value", "with_strike",
]
