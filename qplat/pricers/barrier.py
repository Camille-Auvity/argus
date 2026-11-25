"""Barrier option pricers.

* ``AnalyticBarrierPricer``: Reiner-Rubinstein (1991) closed form for continuous
  monitoring (formulas as in Haug, *Option Pricing Formulas*), with the
  Broadie-Glasserman-Kou shift for discrete monitoring.
* ``MonteCarloBarrierPricer``: path simulation; discrete monitoring is exact,
  continuous monitoring uses the Brownian-bridge crossing probability.
Greeks of both come from the shared finite-difference engine.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.stats import norm

from qplat.instruments.base import OptionType
from qplat.instruments.options import EuropeanOption
from qplat.instruments.structured import BarrierOption, BarrierType
from qplat.pricers.base import FiniteDifferencePricer
from qplat.pricers.black_scholes import BlackScholesPricer
from qplat.pricers.paths import gbm_paths, standard_normals

BGK_BETA = 0.5825971579390106  # -zeta(1/2)/sqrt(2*pi)


def _vanilla_of(opt: BarrierOption) -> EuropeanOption:
    return EuropeanOption(spot=opt.spot, vol=opt.vol, rate=opt.rate, dividend_yield=opt.dividend_yield,
                          strike=opt.strike, expiry=opt.expiry, option_type=opt.option_type)


class AnalyticBarrierPricer(FiniteDifferencePricer):
    name = "Barrier closed form"

    def price(self, opt: BarrierOption) -> float:
        s, k, t, sig = opt.spot, opt.strike, opt.expiry, opt.vol
        r = float(opt.curve.zero_rate(t))
        q = opt.dividend_yield
        bt = opt.barrier_type
        h = opt.barrier
        if opt.monitoring_per_year:
            # BGK: shift the barrier away from spot to mimic discrete monitoring
            shift = math.exp(BGK_BETA * sig * math.sqrt(1.0 / opt.monitoring_per_year))
            h = h * shift if bt.is_up else h / shift

        breached = s >= h if bt.is_up else s <= h
        if breached:
            if bt.is_knock_in:
                return BlackScholesPricer().price(_vanilla_of(opt))
            return opt.rebate  # knocked out now: rebate paid immediately

        b = r - q
        phi = opt.option_type.phi
        eta = -1 if bt.is_up else 1
        sst = sig * math.sqrt(t)
        mu = (b - 0.5 * sig * sig) / (sig * sig)
        lam = math.sqrt(mu * mu + 2 * r / (sig * sig))
        x1 = math.log(s / k) / sst + (1 + mu) * sst
        x2 = math.log(s / h) / sst + (1 + mu) * sst
        y1 = math.log(h * h / (s * k)) / sst + (1 + mu) * sst
        y2 = math.log(h / s) / sst + (1 + mu) * sst
        z = math.log(h / s) / sst + lam * sst
        carry = math.exp((b - r) * t)
        disc = math.exp(-r * t)
        hs = h / s
        N = norm.cdf

        A = phi * s * carry * N(phi * x1) - phi * k * disc * N(phi * x1 - phi * sst)
        B = phi * s * carry * N(phi * x2) - phi * k * disc * N(phi * x2 - phi * sst)
        C = (phi * s * carry * hs ** (2 * (mu + 1)) * N(eta * y1)
             - phi * k * disc * hs ** (2 * mu) * N(eta * y1 - eta * sst))
        D = (phi * s * carry * hs ** (2 * (mu + 1)) * N(eta * y2)
             - phi * k * disc * hs ** (2 * mu) * N(eta * y2 - eta * sst))
        E = opt.rebate * disc * (N(eta * x2 - eta * sst) - hs ** (2 * mu) * N(eta * y2 - eta * sst))
        F = opt.rebate * (hs ** (mu + lam) * N(eta * z) + hs ** (mu - lam) * N(eta * z - 2 * eta * lam * sst))

        call = opt.option_type is OptionType.CALL
        k_above = k > h
        table = {
            (BarrierType.DOWN_AND_IN, True): (C + E, A - B + D + E),
            (BarrierType.UP_AND_IN, True): (A + E, B - C + D + E),
            (BarrierType.DOWN_AND_IN, False): (B - C + D + E, A + E),
            (BarrierType.UP_AND_IN, False): (A - B + D + E, C + E),
            (BarrierType.DOWN_AND_OUT, True): (A - C + F, B - D + F),
            (BarrierType.UP_AND_OUT, True): (F, A - B + C - D + F),
            (BarrierType.DOWN_AND_OUT, False): (A - B + C - D + F, F),
            (BarrierType.UP_AND_OUT, False): (B - D + F, A - C + F),
        }
        above, below = table[(bt, call)]
        return float(above if k_above else below)


class MonteCarloBarrierPricer(FiniteDifferencePricer):
    name = "Barrier Monte Carlo"

    def __init__(self, n_paths: int = 50_000, steps_per_year: int = 252, seed: int = 7,
                 antithetic: bool = True, model=None, **bumps):
        """`model`: optional path generator (HestonPathModel, LocalVolPathModel); default flat-vol GBM."""
        super().__init__(**bumps)
        self.n_paths = n_paths
        self.steps_per_year = steps_per_year
        self.seed = seed
        self.antithetic = antithetic
        self.model = model
        if model is not None:
            self.name = f"Barrier MC ({model.name})"

    def price(self, opt: BarrierOption) -> float:
        return self.price_with_error(opt)[0]

    def price_with_error(self, opt: BarrierOption) -> tuple[float, float]:
        continuous = opt.monitoring_per_year is None
        freq = self.steps_per_year if continuous else opt.monitoring_per_year
        n = max(int(math.ceil(opt.expiry * freq)), 1)
        times = opt.expiry * np.arange(1, n + 1) / n
        if self.model is None:
            z = standard_normals(self.n_paths, n, self.seed, self.antithetic)
            paths = gbm_paths(opt.spot, opt.vol, opt.dividend_yield, opt.curve, times, z)
        else:
            paths = self.model.simulate(opt.spot, opt.dividend_yield, opt.curve, times, self.n_paths, self.seed,
                                        self.antithetic)
        df_t = opt.curve.discount(opt.expiry)
        vanilla = opt.vanilla_payoff(paths[:, -1])
        bt = opt.barrier_type

        # the Brownian-bridge correction needs a constant vol: other models are monitored on the daily grid
        if continuous and self.model is None:
            if opt.rebate:
                raise NotImplementedError("rebate with continuous monitoring: use AnalyticBarrierPricer")
            full = np.hstack([np.full((paths.shape[0], 1), opt.spot), paths])
            dt = opt.expiry / n
            lh = np.log(full / opt.barrier)
            same_side = (lh[:, :-1] * lh[:, 1:]) > 0
            p_cross = np.where(same_side, np.exp(-2 * lh[:, :-1] * lh[:, 1:] / (opt.vol**2 * dt)), 1.0)
            survival = np.prod(1 - p_cross, axis=1)
            pv_out = df_t * vanilla * survival
            pv = df_t * vanilla - pv_out if bt.is_knock_in else pv_out
        else:
            hit = opt.is_breached(paths)
            ever = hit.any(axis=1)
            if bt.is_knock_in:
                pv = df_t * np.where(ever, vanilla, opt.rebate)
            else:
                first = hit.argmax(axis=1)
                rebate_pv = opt.rebate * opt.curve.discount(times[first])
                pv = np.where(ever, rebate_pv, df_t * vanilla)

        half = len(pv) // 2
        if self.antithetic:
            pairs = 0.5 * (pv[:half] + pv[half:2 * half])
            err = pairs.std(ddof=1) / np.sqrt(len(pairs))
        else:
            err = pv.std(ddof=1) / np.sqrt(len(pv))
        return float(pv.mean()), float(err)
