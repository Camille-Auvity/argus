"""Pricers for digital, Asian and cliquet options.

* ``AnalyticDigitalPricer``      Black-Scholes closed form (cash- and asset-or-nothing).
* ``GeometricAsianPricer``       exact closed form of the discrete geometric average.
* ``LevyAsianPricer``            Lévy (1992) lognormal moment matching for the arithmetic average.
* ``MonteCarloExoticPricer``     one Monte Carlo engine for every product of
  ``qplat.instruments.exotics`` (any path model), with the geometric Asian as
  control variate for arithmetic Asians under Black-Scholes.

Greeks come from the shared finite-difference engine (common random numbers for MC).
"""

from __future__ import annotations

import dataclasses
import math

import numpy as np
from scipy.stats import norm

from qplat.instruments.exotics import AsianOption, Averaging, CliquetOption, DigitalKind, DigitalOption
from qplat.pricers.base import FiniteDifferencePricer
from qplat.pricers.paths import gbm_paths, standard_normals


# ----------------------------------------------------------------------------- digital

def digital_bs(spot: float, strike: float, t: float, r: float, q: float, vol: float, phi: int,
               kind: DigitalKind = DigitalKind.CASH, cash: float = 1.0) -> float:
    sst = vol * math.sqrt(t)
    d1 = (math.log(spot / strike) + (r - q + 0.5 * vol * vol) * t) / sst
    d2 = d1 - sst
    if kind is DigitalKind.CASH:
        return cash * math.exp(-r * t) * norm.cdf(phi * d2)
    return spot * math.exp(-q * t) * norm.cdf(phi * d1)


class AnalyticDigitalPricer(FiniteDifferencePricer):
    name = "Closed form (BS)"

    def price(self, opt: DigitalOption) -> float:
        r = float(opt.curve.zero_rate(opt.expiry))
        return digital_bs(opt.spot, opt.strike, opt.expiry, r, opt.dividend_yield, opt.vol,
                          opt.option_type.phi, opt.kind, opt.cash)


# ----------------------------------------------------------------------------- Asian closed forms

def _forwards(opt: AsianOption) -> tuple[np.ndarray, np.ndarray]:
    """Fixing times and log-growth int_0^t (f - q) so that F(t) = S e^{growth}."""
    t = np.asarray(opt.fixing_times)
    growth = -np.log(opt.curve.discount(t)) - opt.dividend_yield * t
    return t, growth


def _black(phi: int, fwd: float, strike: float, total_var: float, df: float) -> float:
    if strike <= 0:  # seasoned average already above any strike: a forward (call) or worthless (put)
        return df * (fwd - strike) if phi > 0 else 0.0
    s = math.sqrt(total_var)
    d1 = (math.log(fwd / strike) + 0.5 * total_var) / s
    return df * phi * (fwd * norm.cdf(phi * d1) - strike * norm.cdf(phi * (d1 - s)))


def geometric_asian_price(opt: AsianOption) -> float:
    """ln G = (sum of ln past fixings + sum_i ln S(t_i)) / n is Gaussian:
    m = [sum ln P_j + sum_i (ln S + g_i - s^2 t_i / 2)] / n,  v = s^2/n^2 sum_ij min(t_i, t_j)."""
    t, growth = _forwards(opt)
    n = opt.n_total
    past = float(np.log(opt.past_fixings).sum()) if opt.past_fixings else 0.0
    m = (past + float(np.sum(math.log(opt.spot) + growth - 0.5 * opt.vol**2 * t))) / n
    v = opt.vol**2 * float(np.minimum.outer(t, t).sum()) / n**2
    return _black(opt.option_type.phi, math.exp(m + 0.5 * v), opt.strike, v, float(opt.curve.discount(t[-1])))


class GeometricAsianPricer(FiniteDifferencePricer):
    name = "Closed form (geometric)"

    def price(self, opt: AsianOption) -> float:
        if opt.averaging is not Averaging.GEOMETRIC:
            raise ValueError("closed form only for the geometric average")
        return geometric_asian_price(opt)


class LevyAsianPricer(FiniteDifferencePricer):
    """Arithmetic average approximated by a lognormal with the same first two moments."""

    name = "Lévy approximation"

    def price(self, opt: AsianOption) -> float:
        t, growth = _forwards(opt)
        f = opt.spot * np.exp(growth)
        n, past = opt.n_total, float(sum(opt.past_fixings))
        m1 = (past + float(f.sum())) / n
        cross = float((np.outer(f, f) * np.exp(opt.vol**2 * np.minimum.outer(t, t))).sum())
        m2 = (past**2 + 2 * past * float(f.sum()) + cross) / n**2
        return _black(opt.option_type.phi, m1, opt.strike, math.log(m2 / m1**2), float(opt.curve.discount(t[-1])))


# ----------------------------------------------------------------------------- cliquet closed form

def _undiscounted_call(fwd: float, strike: float, total_var: float) -> float:
    if strike <= 0:
        return fwd - strike
    if total_var <= 0:
        return max(fwd - strike, 0.0)
    return _black(1, fwd, strike, total_var, 1.0)


class CliquetSpreadPricer(FiniteDifferencePricer):
    """Cliquet without global cap / floor = sum of forward-starting call spreads on each period return.

    Under Black-Scholes, 1 + R_i is lognormal with mean F_i = P(t_{i-1}) / P(t_i) e^{-q dt} and
    variance sigma^2 dt, independent of the spot level:
        E[min(max(R_i, f), c)] = f + C(F_i, 1 + f) - C(F_i, 1 + c)   (undiscounted Black calls)
    """

    name = "Closed form (forward-start spreads)"

    def price(self, opt: CliquetOption) -> float:
        if opt.global_floor is not None or opt.global_cap is not None:
            raise ValueError("closed form only without global floor / cap")
        if opt.initial_level is not None or opt.accrued:
            raise ValueError("closed form only for a cliquet not yet started")
        grid = np.concatenate([[0.0], opt.reset_times])
        dfs = opt.curve.discount(grid)
        total = 0.0
        for i in range(1, len(grid)):
            dt = grid[i] - grid[i - 1]
            fwd = float(dfs[i - 1] / dfs[i]) * math.exp(-opt.dividend_yield * dt)
            var = opt.vol**2 * dt
            lo = -1.0 if opt.local_floor is None else max(opt.local_floor, -1.0)
            expected = lo + _undiscounted_call(fwd, 1.0 + lo, var)
            if opt.local_cap is not None:
                expected -= _undiscounted_call(fwd, 1.0 + opt.local_cap, var)
            total += expected
        return opt.notional * float(dfs[-1]) * total


# ----------------------------------------------------------------------------- Monte Carlo

class MonteCarloExoticPricer(FiniteDifferencePricer):
    """Monte Carlo on the observation dates of the product (exact GBM, or a path model).

    ``control_variate``: for an arithmetic Asian under Black-Scholes, the geometric
    Asian on the same paths (known exact price) is used as control variate:
    X_cv = X - b (Y - E[Y]) with b = Cov(X, Y) / Var(Y).
    """

    def __init__(self, n_paths: int = 50_000, seed: int = 17, antithetic: bool = True, model=None,
                 control_variate: bool = True, **bumps):
        super().__init__(**bumps)
        self.n_paths = n_paths
        self.seed = seed
        self.antithetic = antithetic
        self.model = model
        self.control_variate = control_variate
        self.name = "Monte Carlo" if model is None else f"Monte Carlo ({model.name})"

    def uses_control_variate(self, inst) -> bool:
        return (self.control_variate and self.model is None and isinstance(inst, AsianOption)
                and inst.averaging is Averaging.ARITHMETIC)

    def simulate(self, inst) -> np.ndarray:
        times = np.asarray(inst.observation_times)
        if self.model is None:
            z = standard_normals(self.n_paths, len(times), self.seed, self.antithetic)
            return gbm_paths(inst.spot, inst.vol, inst.dividend_yield, inst.curve, times, z)
        return self.model.simulate(inst.spot, inst.dividend_yield, inst.curve, times, self.n_paths, self.seed,
                                   self.antithetic)

    def _pairs(self, x: np.ndarray) -> np.ndarray:
        """Antithetic pairs averaged: i.i.d. samples for the error estimate."""
        if not self.antithetic:
            return x
        half = len(x) // 2
        return 0.5 * (x[:half] + x[half:2 * half])

    def analyze(self, inst) -> dict:
        paths = self.simulate(inst)
        df = float(inst.curve.discount(inst.maturity))
        payoff = inst.path_payoff(paths)
        x = self._pairs(df * payoff)
        out = {"plain_price": float(x.mean()), "plain_std_error": float(x.std(ddof=1) / math.sqrt(len(x))),
               "payoffs": payoff, "paths": paths}
        if self.uses_control_variate(inst):
            geo = dataclasses.replace(inst, averaging=Averaging.GEOMETRIC)
            y = self._pairs(df * geo.path_payoff(paths))
            var_y = y.var(ddof=1)
            b = float(np.cov(x, y, ddof=1)[0, 1] / var_y) if var_y > 0 else 0.0
            adj = x - b * (y - geometric_asian_price(geo))
            out.update(price=float(adj.mean()), std_error=float(adj.std(ddof=1) / math.sqrt(len(adj))),
                       cv_beta=b, variance_reduction=float(x.var(ddof=1) / max(adj.var(ddof=1), 1e-300)))
        else:
            out.update(price=out["plain_price"], std_error=out["plain_std_error"], cv_beta=None, variance_reduction=None)
        return out

    def price_with_error(self, inst) -> tuple[float, float]:
        a = self.analyze(inst)
        return a["price"], a["std_error"]

    def price(self, inst) -> float:
        return self.price_with_error(inst)[0]


__all__ = [
    "AnalyticDigitalPricer", "CliquetSpreadPricer", "GeometricAsianPricer", "LevyAsianPricer", "MonteCarloExoticPricer",
    "digital_bs", "geometric_asian_price",
]
