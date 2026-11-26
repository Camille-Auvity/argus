"""FX volatility smile from the three market quotes of an expiry: ATM, 25-delta risk reversal and butterfly.

Market conventions (G10 pairs such as EURUSD, premium in the domestic currency, non premium-adjusted):
  * ATM = delta-neutral straddle:            K_ATM = F e^{sigma_ATM^2 T / 2}
  * 25D risk reversal  RR  = sigma_25C - sigma_25P
  * 25D butterfly quoted as a MARKET strangle (broker fly): one single vol sigma_ATM + BF_mkt prices the
    strangle whose strikes are the 25-delta strikes AT THAT vol. This is not the "smile" butterfly
    (sigma_25C + sigma_25P) / 2 - sigma_ATM: the smile butterfly BF_s is solved so that the smile
    reprices the market strangle (Clark, "Foreign Exchange Option Pricing", 2011, ch. 3).
  * Delta: spot delta up to one year, forward delta beyond.

Interpolation: Vanna-Volga (Castagna & Mercurio, 2007). At any strike K, the Black-Scholes price at the ATM
vol is corrected by the three pillar options, weighted to match vega, vanna and volga at K:

    C(K) = C_BS(K, sigma_ATM) + sum_i x_i(K) [C_BS(K_i, sigma_i) - C_BS(K_i, sigma_ATM)]

The first-order approximation of the implied vol is a Lagrange interpolation in ln K.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Literal

import numpy as np
from scipy.optimize import brentq
from scipy.stats import norm

from qplat.fx.options import gk_greeks, gk_price

DeltaConvention = Literal["spot", "forward"]


@dataclass(frozen=True)
class FXMarket:
    spot: float
    T: float
    rd: float
    rf: float

    @property
    def forward(self) -> float:
        return self.spot * math.exp((self.rd - self.rf) * self.T)

    def default_convention(self) -> DeltaConvention:
        return "spot" if self.T <= 1.0 + 1e-9 else "forward"


def strike_from_delta(m: FXMarket, delta: float, vol: float, phi: int, convention: DeltaConvention = "spot") -> float:
    """Strike of the option with |delta| = delta (non premium-adjusted)."""
    target = abs(delta) * (math.exp(m.rf * m.T) if convention == "spot" else 1.0)
    if not 0 < target < 1:
        raise ValueError("delta out of range")
    d1 = phi * norm.ppf(target)
    sq = vol * math.sqrt(m.T)
    return m.forward * math.exp(-d1 * sq + 0.5 * sq * sq)


def delta_of_strike(m: FXMarket, K: float, vol: float, phi: int, convention: DeltaConvention = "spot") -> float:
    g = gk_greeks(m.spot, K, m.T, m.rd, m.rf, vol, phi)
    return g.delta_spot if convention == "spot" else g.delta_forward


def atm_dns_strike(m: FXMarket, vol: float) -> float:
    return m.forward * math.exp(0.5 * vol * vol * m.T)


class VannaVolga:
    """Vanna-Volga smile through three pillars (K1 < K2 = ATM < K3)."""

    def __init__(self, m: FXMarket, strikes, vols):
        self.m = m
        self.K = np.asarray(strikes, float)
        self.vols = np.asarray(vols, float)
        if not (self.K[0] < self.K[1] < self.K[2]):
            raise ValueError("pillar strikes must be increasing")
        self.atm = float(self.vols[1])
        # market cost of each pillar over its ATM-vol price (call prices: puts give the same by parity)
        self.cost = np.array([gk_price(m.spot, k, m.T, m.rd, m.rf, s, 1) - gk_price(m.spot, k, m.T, m.rd, m.rf, self.atm, 1)
                              for k, s in zip(self.K, self.vols)])
        self.risks = np.array([self._risks(k) for k in self.K]).T   # rows: vega, vanna, volga; columns: pillars

    def _risks(self, K: float) -> np.ndarray:
        g = gk_greeks(self.m.spot, K, self.m.T, self.m.rd, self.m.rf, self.atm, 1)
        return np.array([g.vega, g.vanna, g.volga])

    def weights(self, K: float) -> np.ndarray:
        return np.linalg.solve(self.risks, self._risks(K))

    def price(self, K: float, phi: int = 1) -> float:
        m = self.m
        return gk_price(m.spot, K, m.T, m.rd, m.rf, self.atm, phi) + float(self.weights(K) @ self.cost)

    def vol(self, K: float) -> float | None:
        """Implied vol of the Vanna-Volga price (None where the correction leaves no-arbitrage bounds)."""
        m = self.m
        price = self.price(K, 1)
        lo = gk_price(m.spot, K, m.T, m.rd, m.rf, 1e-4, 1)
        hi = gk_price(m.spot, K, m.T, m.rd, m.rf, 3.0, 1)
        if not lo < price < hi:
            return None
        return float(brentq(lambda s: gk_price(m.spot, K, m.T, m.rd, m.rf, s, 1) - price, 1e-4, 3.0, xtol=1e-12))

    def vol_first_order(self, K: float) -> float:
        """Castagna-Mercurio first-order approximation: Lagrange interpolation of the pillar vols in ln K."""
        k1, k2, k3 = np.log(self.K)
        x = math.log(K)
        s1, s2, s3 = self.vols
        return float((x - k2) * (x - k3) / ((k1 - k2) * (k1 - k3)) * s1
                     + (x - k1) * (x - k3) / ((k2 - k1) * (k2 - k3)) * s2
                     + (x - k1) * (x - k2) / ((k3 - k1) * (k3 - k2)) * s3)


@dataclass
class FXSmile:
    market: FXMarket
    convention: DeltaConvention
    atm: float
    rr25: float
    bf25_market: float
    bf25_smile: float
    pillars: dict           # name -> {strike, vol, delta}
    market_strangle: dict   # {vol, call_strike, put_strike, value}
    vv: VannaVolga

    def vol(self, K: float) -> float | None:
        return self.vv.vol(K)


def build_smile(m: FXMarket, atm: float, rr25: float, bf25: float, convention: DeltaConvention | None = None) -> FXSmile:
    conv = convention or m.default_convention()
    if atm <= 0 or atm + bf25 - abs(rr25) / 2 <= 0:
        raise ValueError("quotes imply a negative vol")
    k_atm = atm_dns_strike(m, atm)

    # market strangle: one vol, 25-delta strikes at that vol
    s_ms = atm + bf25
    kc_ms = strike_from_delta(m, 0.25, s_ms, 1, conv)
    kp_ms = strike_from_delta(m, 0.25, s_ms, -1, conv)
    target = gk_price(m.spot, kc_ms, m.T, m.rd, m.rf, s_ms, 1) + gk_price(m.spot, kp_ms, m.T, m.rd, m.rf, s_ms, -1)

    def smile(bf_s: float) -> VannaVolga:
        sc, sp = atm + bf_s + rr25 / 2, atm + bf_s - rr25 / 2
        kc = strike_from_delta(m, 0.25, sc, 1, conv)
        kp = strike_from_delta(m, 0.25, sp, -1, conv)
        return VannaVolga(m, [kp, k_atm, kc], [sp, atm, sc])

    def gap(bf_s: float) -> float:
        vv = smile(bf_s)
        return vv.price(kc_ms, 1) + vv.price(kp_ms, -1) - target

    if abs(gap(bf25)) < 1e-14:
        bf_s = bf25
    else:
        width = max(0.01, abs(bf25))
        lo_bound = abs(rr25) / 2 - atm + 1e-4   # keeps both pillar vols positive
        lo, hi = max(bf25 - width, lo_bound), bf25 + width
        while gap(lo) * gap(hi) > 0 and hi - lo < 1.0:
            lo, hi = max(lo - width, lo_bound), hi + width
        bf_s = float(brentq(gap, lo, hi, xtol=1e-12))
    vv = smile(bf_s)
    names = ("25D put", "ATM", "25D call")
    pillars = {n: {"strike": float(k), "vol": float(s),
                   "delta": float(delta_of_strike(m, k, s, -1 if n == "25D put" else 1, conv))}
               for n, k, s in zip(names, vv.K, vv.vols)}
    return FXSmile(m, conv, atm, rr25, bf25, bf_s, pillars,
                   {"vol": s_ms, "call_strike": kc_ms, "put_strike": kp_ms, "value": target}, vv)


def risk_neutral_density(smile: FXSmile, strikes) -> np.ndarray:
    """q(K) = e^{r_d T} d2C/dK2 from the Vanna-Volga call prices (negative values flag butterfly arbitrage)."""
    m = smile.market
    out = []
    for K in strikes:
        h = K * 1e-3
        c = [smile.vv.price(k, 1) for k in (K - h, K, K + h)]
        out.append(math.exp(m.rd * m.T) * (c[0] - 2 * c[1] + c[2]) / (h * h))
    return np.array(out)
