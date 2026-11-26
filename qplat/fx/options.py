"""FX vanilla options: Garman-Kohlhagen (1983).

The underlying is the price of one unit of FOREIGN currency in DOMESTIC currency (EURUSD = 1.09:
foreign EUR, domestic USD). The foreign interest rate plays the role of a dividend yield:

    V = phi [S e^{-r_f T} N(phi d1) - K e^{-r_d T} N(phi d2)],   d1,2 = [ln(F/K) +- sigma^2 T / 2] / (sigma sqrt T),
    F = S e^{(r_d - r_f) T}

Values are in domestic currency per unit of foreign notional. Delta conventions:
  spot delta       e^{-r_f T} phi N(phi d1)   (hedge in spot, non premium-adjusted)
  forward delta    phi N(phi d1)              (hedge with an outright forward)
  premium-adjusted spot delta = spot delta - V / S (premium paid in the foreign currency).
"""

from __future__ import annotations

import math
from dataclasses import dataclass

from scipy.stats import norm


@dataclass(frozen=True)
class GKGreeks:
    price: float        # domestic per unit of foreign
    delta_spot: float
    delta_forward: float
    delta_premium_adjusted: float
    gamma: float        # d(delta_spot)/dS
    vega: float         # dV/dsigma (per 1.00 of vol)
    vanna: float        # d2V/dS dsigma
    volga: float        # d2V/dsigma2
    theta: float        # dV/dt per year (calendar time passing)
    rho_domestic: float # dV/dr_d (per 1.00)
    rho_foreign: float  # dV/dr_f (per 1.00)
    d1: float
    d2: float


def gk_price(spot: float, strike: float, T: float, rd: float, rf: float, vol: float, phi: int) -> float:
    sq = vol * math.sqrt(T)
    fwd = spot * math.exp((rd - rf) * T)
    d1 = (math.log(fwd / strike) + 0.5 * sq * sq) / sq
    return phi * math.exp(-rd * T) * (fwd * norm.cdf(phi * d1) - strike * norm.cdf(phi * (d1 - sq)))


def gk_greeks(spot: float, strike: float, T: float, rd: float, rf: float, vol: float, phi: int) -> GKGreeks:
    sqT = math.sqrt(T)
    sq = vol * sqT
    dfd, dff = math.exp(-rd * T), math.exp(-rf * T)
    d1 = (math.log(spot / strike) + (rd - rf + 0.5 * vol * vol) * T) / sq
    d2 = d1 - sq
    Nd1, Nd2, nd1 = norm.cdf(phi * d1), norm.cdf(phi * d2), norm.pdf(d1)
    price = phi * (spot * dff * Nd1 - strike * dfd * Nd2)
    vega = spot * dff * nd1 * sqT
    theta = (-spot * dff * nd1 * vol / (2 * sqT) + phi * rf * spot * dff * Nd1 - phi * rd * strike * dfd * Nd2)
    return GKGreeks(
        price=price,
        delta_spot=phi * dff * Nd1,
        delta_forward=phi * Nd1,
        delta_premium_adjusted=phi * dff * Nd1 - price / spot,
        gamma=dff * nd1 / (spot * sq),
        vega=vega,
        vanna=-dff * nd1 * d2 / vol,
        volga=vega * d1 * d2 / vol,
        theta=theta,
        rho_domestic=phi * strike * T * dfd * Nd2,
        rho_foreign=-phi * spot * T * dff * Nd1,
        d1=d1, d2=d2,
    )
