"""Stochastic calculus, checked numerically (Continuous-Time Finance, lecture 3).

  * Brownian motion: B_t ~ N(0, t), sqrt(t) scaling;
  * total variation sum |dB| grows like sqrt(2N/pi) (no finite length), quadratic variation sum dB^2 -> T with a
    variance 2T^2/N: (dB)^2 = dt;
  * Ito vs right-point sums for int B dB: L_N -> (B_T^2 - T)/2 (mean 0, a martingale), R_N -> (B_T^2 + T)/2;
  * martingales: B_t, B_t^2 - t, exp(lambda B_t - lambda^2 t / 2) have constant expectation, B_t^2 and
    exp(lambda B_t) do not;
  * Girsanov: weighting by Y = exp(theta B_T - theta^2 T / 2) shifts the law of B_T from N(0, T) to N(theta T, T);
    used backwards, it gives importance sampling.
"""

from __future__ import annotations

import math

import numpy as np
from scipy.stats import norm

from qplat.instruments import DigitalOption, EuropeanOption
from qplat.pricers import AnalyticDigitalPricer, BlackScholesPricer, MonteCarloExoticPricer, MonteCarloPricer
from qplat.pricers.paths import auto_theta


def brownian_paths(n_paths: int, n_steps: int, T: float = 1.0, seed: int = 0) -> np.ndarray:
    """(n_paths, n_steps + 1) Brownian paths on an even grid, B_0 = 0."""
    rng = np.random.default_rng(seed)
    inc = rng.standard_normal((n_paths, n_steps)) * math.sqrt(T / n_steps)
    return np.hstack([np.zeros((n_paths, 1)), np.cumsum(inc, axis=1)])


def variations(steps=(4, 16, 64, 256, 1024, 4096), n_paths: int = 2000, T: float = 1.0, seed: int = 1) -> list[dict]:
    """Total and quadratic variation of Brownian paths on finer and finer grids."""
    out = []
    for n in steps:
        B = brownian_paths(n_paths, n, T, seed)
        dB = np.diff(B, axis=1)
        tv = np.abs(dB).sum(axis=1)
        qv = (dB * dB).sum(axis=1)
        out.append({"n": n, "total_variation": float(tv.mean()), "total_variation_theory": math.sqrt(2 * n * T / math.pi),
                    "quadratic_variation": float(qv.mean()), "quadratic_variation_sd": float(qv.std(ddof=1)),
                    "quadratic_variation_sd_theory": math.sqrt(2 / n) * T})
    return out


def ito_sums(n_steps: int = 500, n_paths: int = 5000, T: float = 1.0, seed: int = 2) -> dict:
    """Left (Ito) and right Riemann sums of B dB, against (B_T^2 -+ T)/2."""
    B = brownian_paths(n_paths, n_steps, T, seed)
    dB = np.diff(B, axis=1)
    left = (B[:, :-1] * dB).sum(axis=1)
    right = (B[:, 1:] * dB).sum(axis=1)
    BT = B[:, -1]
    ito = 0.5 * (BT**2 - T)
    counts_l, edges = np.histogram(np.concatenate([left, right]), bins=60)
    hist_l = np.histogram(left, bins=edges)[0]
    hist_r = np.histogram(right, bins=edges)[0]
    return {
        "mean_left": float(left.mean()), "mean_right": float(right.mean()), "T": T,
        "max_gap_left": float(np.abs(left - ito).max()), "max_gap_right": float(np.abs(right - (ito + T)).max()),
        "rms_gap_left": float(np.sqrt(np.mean((left - ito) ** 2))),
        "histogram": {"edges": edges.tolist(), "left": hist_l.tolist(), "right": hist_r.tolist()},
        "example": {"t": np.linspace(0, T, n_steps + 1)[::5].tolist(), "B": B[0, ::5].tolist(),
                    "left_running": np.concatenate([[0.0], np.cumsum(B[0, :-1] * dB[0])])[::5].tolist(),
                    "ito_running": (0.5 * (B[0] ** 2 - np.linspace(0, T, n_steps + 1)))[::5].tolist()},
    }


def martingales(lam: float = 1.0, n_paths: int = 20_000, T: float = 2.0, n_steps: int = 200, seed: int = 3) -> dict:
    """E[X_t] for martingales and non-martingales built on the same Brownian paths."""
    B = brownian_paths(n_paths, n_steps, T, seed)
    t = np.linspace(0, T, n_steps + 1)
    sel = slice(None, None, 10)
    se = lambda x: (x.std(axis=0, ddof=1) / math.sqrt(n_paths))[sel].tolist()  # noqa: E731
    series = {
        "B_t": B, "B_t^2 - t": B**2 - t, "exp(λB_t - λ²t/2)": np.exp(lam * B - 0.5 * lam**2 * t),
        "B_t^2": B**2, "exp(λB_t)": np.exp(lam * B),
    }
    return {"t": t[sel].tolist(), "lambda": lam,
            "series": {k: {"mean": v.mean(axis=0)[sel].tolist(), "se": se(v), "martingale": k in ("B_t", "B_t^2 - t", "exp(λB_t - λ²t/2)")}
                       for k, v in series.items()}}


def sample_paths(n_paths: int = 30, n_steps: int = 500, T: float = 1.0, seed: int = 4) -> dict:
    B = brownian_paths(n_paths, n_steps, T, seed)
    t = np.linspace(0, T, n_steps + 1)
    return {"t": t[::2].tolist(), "paths": np.round(B[:, ::2], 4).tolist(), "band": (1.96 * np.sqrt(t[::2])).tolist()}


# ----------------------------------------------------------------------------- Girsanov

def girsanov(theta: float = 1.0, T: float = 1.0, n_paths: int = 200_000, seed: int = 5) -> dict:
    """Density of B_T under P and Q (dQ/dP = exp(theta B_T - theta^2 T / 2)) and Monte Carlo checks."""
    b = np.linspace(-4 * math.sqrt(T) + min(theta * T, 0), 4 * math.sqrt(T) + max(theta * T, 0), 241)
    fP = norm.pdf(b, 0, math.sqrt(T))
    Y = np.exp(theta * b - 0.5 * theta**2 * T)
    rng = np.random.default_rng(seed)
    BT = rng.standard_normal(n_paths) * math.sqrt(T)
    w = np.exp(theta * BT - 0.5 * theta**2 * T)
    a = theta * T                                       # Q(B_T > theta T) = 1/2: the Q-mean
    return {"b": b.tolist(), "density_P": fP.tolist(), "density_Q": (fP * Y).tolist(), "weight": Y.tolist(),
            "mean_weight": float(w.mean()), "mean_weight_se": float(w.std(ddof=1) / math.sqrt(n_paths)),
            "q_mean_by_weighting": float((w * BT).mean()), "q_mean_theory": theta * T,
            "prob_above_q_mean": float((w * (BT > a)).mean()), "theta": theta, "T": T}


def importance_sampling(S0: float, K: float, T: float, r: float, q: float, vol: float, product: str = "call",
                        n_paths: int = 20_000) -> dict:
    """Plain vs importance-sampled Monte Carlo for a far out-of-the-money payoff, and the variance across theta."""
    if product == "digital":
        inst = DigitalOption(spot=S0, strike=K, expiry=T, vol=vol, rate=r, dividend_yield=q,
                             option_type="call" if K >= S0 else "put")
        exact = AnalyticDigitalPricer().price(inst)
        make = lambda th: MonteCarloExoticPricer(n_paths=n_paths, importance=th, control_variate=False)  # noqa: E731
    else:
        inst = EuropeanOption(spot=S0, strike=K, expiry=T, vol=vol, rate=r, dividend_yield=q, option_type=product)
        exact = BlackScholesPricer().price(inst)
        make = lambda th: MonteCarloPricer(n_paths=n_paths, importance=th)  # noqa: E731
    theta_star = auto_theta(S0, K, vol, q, inst.curve, T)
    plain = make(None).price_with_error(inst)
    shifted = make("auto").price_with_error(inst)
    grid = []
    for th in np.linspace(theta_star - 2.5 / math.sqrt(T), theta_star + 2.5 / math.sqrt(T), 21):
        p, se = make(float(th)).price_with_error(inst)
        grid.append({"theta": float(th), "price": p, "se": se})
    conv = []
    for n in (1_000, 2_000, 5_000, 10_000, 20_000, 50_000):
        pl = (MonteCarloExoticPricer(n_paths=n, control_variate=False) if product == "digital" else MonteCarloPricer(n_paths=n)).price_with_error(inst)
        im = (MonteCarloExoticPricer(n_paths=n, importance="auto", control_variate=False) if product == "digital"
              else MonteCarloPricer(n_paths=n, importance="auto")).price_with_error(inst)
        conv.append({"n": n, "plain": pl[0], "plain_se": pl[1], "importance": im[0], "importance_se": im[1]})
    return {"exact": exact, "theta_star": theta_star,
            "plain": {"price": plain[0], "se": plain[1]}, "importance": {"price": shifted[0], "se": shifted[1]},
            "variance_reduction": (plain[1] / shifted[1]) ** 2 if shifted[1] > 0 else None,
            "itm_probability": float(norm.cdf((math.log(S0 / K) + (r - q - 0.5 * vol**2) * T) / (vol * math.sqrt(T))))
            if product != "put" else float(norm.cdf(-(math.log(S0 / K) + (r - q - 0.5 * vol**2) * T) / (vol * math.sqrt(T)))),
            "theta_grid": grid, "convergence": conv}
