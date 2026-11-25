"""Cox-Ross-Rubinstein binomial tree for European and American vanillas.

The risk-neutral probability uses the curve's forward rate on each step, so a
term structure of rates is honoured without changing the tree geometry.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np

from qplat.instruments.options import ExerciseStyle, VanillaOption
from qplat.pricers.base import FiniteDifferencePricer


@dataclass(frozen=True)
class TreeParameters:
    dt: float
    u: float
    d: float
    p: np.ndarray           # risk-neutral up probability per step
    step_disc: np.ndarray   # P(t_i, t_{i+1}) per step


@dataclass(frozen=True)
class Lattice:
    """Full tree, level i has i+1 nodes ordered from highest to lowest spot."""

    params: TreeParameters
    spots: list[np.ndarray]
    values: list[np.ndarray]
    continuation: list[np.ndarray]  # discounted expected value (= value when not exercised)
    exercised: list[np.ndarray]     # True where early exercise is optimal (American only)


class BinomialTreePricer(FiniteDifferencePricer):
    name = "Binomial (CRR)"

    def __init__(self, steps: int = 500, **bumps):
        super().__init__(**bumps)
        if steps < 1:
            raise ValueError("steps must be >= 1")
        self.steps = steps

    @staticmethod
    def parameters(opt: VanillaOption, steps: int) -> TreeParameters:
        dt = opt.expiry / steps
        u = float(np.exp(opt.vol * np.sqrt(dt)))
        d = 1.0 / u
        dfs = opt.curve.discount(dt * np.arange(steps + 1))
        step_disc = dfs[1:] / dfs[:-1]                          # P(t_i, t_{i+1})
        growth = np.exp(-opt.dividend_yield * dt) / step_disc   # E[S_{i+1}/S_i]
        p = (growth - d) / (u - d)
        if np.any((p <= 0) | (p >= 1)):
            raise ValueError("arbitrage in tree: increase steps or check inputs")
        return TreeParameters(dt=dt, u=u, d=d, p=p, step_disc=step_disc)

    def price(self, opt: VanillaOption) -> float:
        return self._induction(opt, self.steps)[0]

    def lattice(self, opt: VanillaOption, steps: int | None = None) -> Lattice:
        """Same backward induction as `price`, keeping every node (for inspection)."""
        return self._induction(opt, steps or self.steps, keep=True)[1]

    def _induction(self, opt: VanillaOption, n: int, keep: bool = False) -> tuple[float, Lattice | None]:
        prm = self.parameters(opt, n)
        u, p, step_disc = prm.u, prm.p, prm.step_disc
        american = opt.exercise is ExerciseStyle.AMERICAN
        j = np.arange(n + 1)
        spots_n = opt.spot * u ** (n - 2 * j)
        values = opt.payoff(spots_n)
        if keep:
            spots, vals, conts, exs = [spots_n], [values], [values], [np.zeros(n + 1, dtype=bool)]
        for i in range(n - 1, -1, -1):
            cont = step_disc[i] * (p[i] * values[:-1] + (1 - p[i]) * values[1:])
            values = cont
            if american or keep:
                s_i = opt.spot * u ** (i - 2 * j[: i + 1])
            if american:
                exercise = opt.payoff(s_i)
                values = np.maximum(cont, exercise)
            if keep:
                spots.append(s_i)
                vals.append(values)
                conts.append(cont)
                exs.append((exercise > cont) & (exercise > 0) if american else np.zeros(i + 1, dtype=bool))
        lattice = Lattice(prm, spots[::-1], vals[::-1], conts[::-1], exs[::-1]) if keep else None
        return float(values[0]), lattice
