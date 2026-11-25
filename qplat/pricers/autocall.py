"""Monte Carlo pricer for Phoenix / Athena autocallables."""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from qplat.instruments.structured import Autocallable
from qplat.pricers.base import FiniteDifferencePricer
from qplat.pricers.paths import gbm_paths, standard_normals


@dataclass(frozen=True)
class AutocallAnalysis:
    price: float
    std_error: float
    redemption_probabilities: np.ndarray  # P(redeemed at each observation date)
    coupon_probabilities: np.ndarray      # P(a coupon is paid at each date)
    loss_probability: float               # P(capital loss at maturity)
    expected_life: float                  # years


class MonteCarloAutocallPricer(FiniteDifferencePricer):
    name = "Autocall Monte Carlo"

    def __init__(self, n_paths: int = 100_000, seed: int = 11, antithetic: bool = True, model=None, **bumps):
        """`model`: optional path generator (HestonPathModel, LocalVolPathModel); default flat-vol GBM."""
        super().__init__(**bumps)
        self.n_paths = n_paths
        self.seed = seed
        self.antithetic = antithetic
        self.model = model
        if model is not None:
            self.name = f"Autocall MC ({model.name})"

    def price(self, inst: Autocallable) -> float:
        return self.analyze(inst).price

    def analyze(self, inst: Autocallable) -> AutocallAnalysis:
        times = np.asarray(inst.observation_times)
        n_obs = len(times)
        if self.model is None:
            # GBM is exact between observation dates: no barrier is path-continuous here.
            z = standard_normals(self.n_paths, n_obs, self.seed, self.antithetic)
            spots = gbm_paths(inst.spot, inst.vol, inst.dividend_yield, inst.curve, times, z)
        else:
            spots = self.model.simulate(inst.spot, inst.dividend_yield, inst.curve, times, self.n_paths, self.seed,
                                        self.antithetic)
        perf = spots / inst.initial_level
        dfs = inst.curve.discount(times)

        n = perf.shape[0]
        alive = np.ones(n, dtype=bool)
        missed = np.zeros(n)
        pv = np.zeros(n)
        life = np.zeros(n)
        redeem_prob = np.zeros(n_obs)
        coupon_prob = np.zeros(n_obs)
        coupon_amt = inst.coupon_rate * inst.notional

        for k in range(n_obs):
            p = perf[:, k]
            pays = alive & (p >= inst.coupon_barrier)
            n_coupons = 1 + missed if inst.memory else 1
            pv += np.where(pays, coupon_amt * n_coupons * dfs[k], 0.0)
            coupon_prob[k] = pays.mean()
            missed = np.where(pays, 0.0, np.where(alive, missed + 1, missed))

            if k < n_obs - 1:
                called = alive & (p >= inst.autocall_barrier)
                pv += np.where(called, inst.notional * dfs[k], 0.0)
            else:
                called = alive.copy()
                capital = np.where(p >= inst.protection_barrier, inst.notional, inst.notional * p)
                pv += np.where(called, capital * dfs[k], 0.0)
                loss = alive & (p < inst.protection_barrier)
            redeem_prob[k] = called.mean()
            life[called] = times[k]
            alive &= ~called

        if self.antithetic:
            half = n // 2
            pairs = 0.5 * (pv[:half] + pv[half:2 * half])
            err = pairs.std(ddof=1) / np.sqrt(len(pairs))
        else:
            err = pv.std(ddof=1) / np.sqrt(n)

        return AutocallAnalysis(
            price=float(pv.mean()),
            std_error=float(err),
            redemption_probabilities=redeem_prob,
            coupon_probabilities=coupon_prob,
            loss_probability=float(loss.mean()),
            expected_life=float(life.mean()),
        )
