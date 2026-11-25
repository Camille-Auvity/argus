"""Closed-form Black-Scholes-Merton pricer for European vanillas.

With a term-structure curve, the rate used is the zero rate to expiry, which
is exact for a European payoff under deterministic rates.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm

from qplat.instruments.options import ExerciseStyle, VanillaOption
from qplat.instruments.base import OptionType
from qplat.pricers.base import Pricer


def _check(opt: VanillaOption):
    if opt.exercise is not ExerciseStyle.EUROPEAN:
        raise ValueError("BlackScholesPricer only prices European exercise")


def bs_price(spot, strike, t, r, q, vol, phi):
    """Vectorised Black-Scholes-Merton price (phi=+1 call, -1 put)."""
    sqrt_t = np.sqrt(t)
    d1 = (np.log(spot / strike) + (r - q + 0.5 * vol**2) * t) / (vol * sqrt_t)
    d2 = d1 - vol * sqrt_t
    return phi * (spot * np.exp(-q * t) * norm.cdf(phi * d1) - strike * np.exp(-r * t) * norm.cdf(phi * d2))


class BlackScholesPricer(Pricer):
    name = "Black-Scholes"

    @staticmethod
    def _inputs(opt: VanillaOption):
        _check(opt)
        t = opt.expiry
        r = float(opt.curve.zero_rate(t))
        q = opt.dividend_yield
        sig = opt.vol
        sqrt_t = math.sqrt(t)
        d1 = (math.log(opt.spot / opt.strike) + (r - q + 0.5 * sig * sig) * t) / (sig * sqrt_t)
        d2 = d1 - sig * sqrt_t
        return t, r, q, sig, sqrt_t, d1, d2, opt.option_type.phi

    def price(self, opt):
        t, r, q, sig, _, d1, d2, phi = self._inputs(opt)
        return phi * (opt.spot * math.exp(-q * t) * norm.cdf(phi * d1)
                      - opt.strike * math.exp(-r * t) * norm.cdf(phi * d2))

    def delta(self, opt):
        t, _, q, _, _, d1, _, phi = self._inputs(opt)
        return phi * math.exp(-q * t) * norm.cdf(phi * d1)

    def gamma(self, opt):
        t, _, q, sig, sqrt_t, d1, _, _ = self._inputs(opt)
        return math.exp(-q * t) * norm.pdf(d1) / (opt.spot * sig * sqrt_t)

    def vega(self, opt):
        t, _, q, _, sqrt_t, d1, _, _ = self._inputs(opt)
        return opt.spot * math.exp(-q * t) * norm.pdf(d1) * sqrt_t

    def theta(self, opt):
        t, r, q, sig, sqrt_t, d1, d2, phi = self._inputs(opt)
        s, k = opt.spot, opt.strike
        return (-s * math.exp(-q * t) * norm.pdf(d1) * sig / (2 * sqrt_t)
                - phi * r * k * math.exp(-r * t) * norm.cdf(phi * d2)
                + phi * q * s * math.exp(-q * t) * norm.cdf(phi * d1))

    def rho(self, opt):
        t, r, _, _, _, _, d2, phi = self._inputs(opt)
        return phi * opt.strike * t * math.exp(-r * t) * norm.cdf(phi * d2)


def implied_volatility(price: float, spot: float, strike: float, t: float, r: float,
                       q: float = 0.0, option_type: OptionType | str = OptionType.CALL,
                       lo: float = 1e-4, hi: float = 5.0) -> float:
    """Black-Scholes implied vol by Brent's method; NaN if outside no-arbitrage bounds."""
    phi = OptionType(option_type).phi
    fwd_disc = spot * math.exp(-q * t)
    k_disc = strike * math.exp(-r * t)
    intrinsic = max(phi * (fwd_disc - k_disc), 0.0)
    upper = fwd_disc if phi == 1 else k_disc
    if not (intrinsic - 1e-12 < price < upper) or t <= 0:
        return float("nan")
    f = lambda v: bs_price(spot, strike, t, r, q, v, phi) - price  # noqa: E731
    try:
        if f(lo) > 0:
            return float("nan")
        return brentq(f, lo, hi, xtol=1e-10, maxiter=200)
    except ValueError:
        return float("nan")


def implied_volatility_vec(prices, spot, strikes, t, r, q, option_types, lo: float = 1e-4, hi: float = 5.0,
                           iterations: int = 70) -> np.ndarray:
    """Vectorised implied vol by bisection (all options solved at once); NaN outside no-arbitrage bounds.

    Same answer as `implied_volatility` (to ~1e-10 after 70 halvings of [1e-4, 5]) but without a
    Python-level loop: this is what keeps the smile fast in the browser (Pyodide).
    """
    prices = np.asarray(prices, float)
    strikes = np.asarray(strikes, float)
    t = np.broadcast_to(np.asarray(t, float), prices.shape)
    r = np.broadcast_to(np.asarray(r, float), prices.shape)
    q = np.broadcast_to(np.asarray(q, float), prices.shape)
    phi = np.where(np.asarray([str(o) for o in np.atleast_1d(option_types)]) == "put", -1.0, 1.0)
    phi = np.broadcast_to(phi, prices.shape)
    fwd_disc = spot * np.exp(-q * t)
    k_disc = strikes * np.exp(-r * t)
    intrinsic = np.maximum(phi * (fwd_disc - k_disc), 0.0)
    upper = np.where(phi > 0, fwd_disc, k_disc)
    valid = (prices > intrinsic - 1e-12) & (prices < upper) & (t > 0)
    a = np.full(prices.shape, lo)
    b = np.full(prices.shape, hi)
    with np.errstate(all="ignore"):
        valid &= bs_price(spot, strikes, t, r, q, a, phi) <= prices   # root bracketed from below
        for _ in range(iterations):
            mid = 0.5 * (a + b)
            above = bs_price(spot, strikes, t, r, q, mid, phi) > prices
            b = np.where(above, mid, b)
            a = np.where(above, a, mid)
    out = 0.5 * (a + b)
    # the bracket can't reach hi: treat as no solution, like the scalar solver
    return np.where(valid & (out < hi - 1e-6), out, np.nan)
