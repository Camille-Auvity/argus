"""Monte Carlo pricer for vanillas: exact terminal sampling for European
exercise, Longstaff-Schwartz regression for American exercise."""

from __future__ import annotations

import numpy as np

from qplat.instruments.options import ExerciseStyle, VanillaOption
from qplat.pricers.base import FiniteDifferencePricer
from qplat.pricers.paths import gbm_paths, standard_normals


class MonteCarloPricer(FiniteDifferencePricer):
    name = "Monte Carlo"

    def __init__(self, n_paths: int = 100_000, seed: int = 42, antithetic: bool = True,
                 lsm_steps: int = 50, lsm_degree: int = 3, **bumps):
        super().__init__(**bumps)
        self.n_paths = n_paths
        self.seed = seed
        self.antithetic = antithetic
        self.lsm_steps = lsm_steps
        self.lsm_degree = lsm_degree

    def price(self, opt: VanillaOption) -> float:
        return self.price_with_error(opt)[0]

    def price_with_error(self, opt: VanillaOption) -> tuple[float, float]:
        """(price, standard error). Same seed on every call => common random numbers."""
        if opt.exercise is ExerciseStyle.AMERICAN:
            pv = self._lsm_pathwise(opt)
        else:
            pv = self._european_pathwise(opt)
        return float(pv.mean()), self._std_error(pv)

    def _std_error(self, pv: np.ndarray) -> float:
        if self.antithetic:
            half = len(pv) // 2
            pairs = 0.5 * (pv[:half] + pv[half:2 * half])
            return float(pairs.std(ddof=1) / np.sqrt(len(pairs)))
        return float(pv.std(ddof=1) / np.sqrt(len(pv)))

    def terminal_spots(self, opt: VanillaOption) -> np.ndarray:
        """Simulated S_T used by the European estimator (exact one-step GBM sampling)."""
        z = standard_normals(self.n_paths, 1, self.seed, self.antithetic)
        return gbm_paths(opt.spot, opt.vol, opt.dividend_yield, opt.curve, np.array([opt.expiry]), z)[:, 0]

    def _european_pathwise(self, opt: VanillaOption) -> np.ndarray:
        return opt.curve.discount(opt.expiry) * opt.payoff(self.terminal_spots(opt))

    def lsm_diagnostics(self, opt: VanillaOption, snapshot_step: int | None = None) -> dict:
        """Run Longstaff-Schwartz and return the exercise boundary and one regression snapshot."""
        record: dict = {"snapshot_step": snapshot_step if snapshot_step is not None else self.lsm_steps // 2,
                        "boundary": {}}
        pv = self._lsm_pathwise(opt, record)
        record["price"] = float(pv.mean())
        record["std_error"] = self._std_error(pv)
        return record

    def _lsm_pathwise(self, opt: VanillaOption, record: dict | None = None) -> np.ndarray:
        n = self.lsm_steps
        times = opt.expiry * np.arange(1, n + 1) / n
        z = standard_normals(self.n_paths, n, self.seed, self.antithetic)
        paths = gbm_paths(opt.spot, opt.vol, opt.dividend_yield, opt.curve, times, z)
        dfs = opt.curve.discount(np.concatenate([[0.0], times]))

        cash = opt.payoff(paths[:, -1])  # value at t_n of the optimal policy
        for i in range(n - 2, -1, -1):   # exercise decisions at t_{n-1} .. t_1
            cash *= dfs[i + 2] / dfs[i + 1]  # bring back to t_{i+1}
            s = paths[:, i]
            exercise = opt.payoff(s)
            itm = exercise > 0
            if itm.sum() > self.lsm_degree + 1:
                x = s[itm] / opt.strike
                coefs = np.polynomial.polynomial.polyfit(x, cash[itm], self.lsm_degree)
                continuation = np.polynomial.polynomial.polyval(x, coefs)
                ex_now = exercise[itm] > continuation
                idx = np.flatnonzero(itm)[ex_now]
                if record is not None:
                    self._record_step(record, i, times[i], s[itm], cash[itm], coefs, exercise[itm], ex_now, opt)
                cash[idx] = exercise[idx]
        pv = cash * dfs[1]
        immediate = float(opt.payoff(opt.spot))
        # exercising at t=0 is a deterministic decision on the whole book
        return np.full_like(pv, immediate) if immediate > pv.mean() else pv

    @staticmethod
    def _record_step(record, i, t, s_itm, cash_itm, coefs, exercise_itm, ex_now, opt) -> None:
        # boundary: the spot level separating exercise from continuation at this date
        if ex_now.any():
            exercised = s_itm[ex_now]
            record["boundary"][float(t)] = float(exercised.max() if opt.option_type.phi < 0 else exercised.min())
        if i == record["snapshot_step"]:
            record["snapshot"] = {"t": float(t), "s": s_itm, "discounted_cashflow": cash_itm, "coefs": coefs,
                                  "exercise_value": exercise_itm, "exercised": ex_now}
