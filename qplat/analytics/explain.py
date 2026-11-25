"""Step-by-step diagnostics of each pricing method, for teaching / inspection.

Everything here calls the production pricers (same code paths, same random
numbers) and only collects their intermediate quantities, so what is shown is
exactly how the platform's prices are produced.
"""

from __future__ import annotations

import dataclasses
import math

import numpy as np
from scipy.stats import norm

from qplat.instruments.options import AmericanOption, EuropeanOption, ExerciseStyle, VanillaOption
from qplat.pricers.binomial import BinomialTreePricer
from qplat.pricers.black_scholes import BlackScholesPricer
from qplat.pricers.monte_carlo import MonteCarloPricer
from qplat.pricers.paths import gbm_paths, standard_normals


def as_european(opt: VanillaOption) -> EuropeanOption:
    fields = {f.name: getattr(opt, f.name) for f in dataclasses.fields(opt) if f.name != "exercise"}
    return EuropeanOption(**fields)


def as_american(opt: VanillaOption) -> AmericanOption:
    fields = {f.name: getattr(opt, f.name) for f in dataclasses.fields(opt) if f.name != "exercise"}
    return AmericanOption(**fields)


def _step(label: str, formula: str, value: float, note: str = "") -> dict:
    return {"label": label, "formula": formula, "value": float(value), "note": note}


# ----------------------------------------------------------------------------- Black-Scholes

def explain_black_scholes(opt: VanillaOption) -> dict:
    eu = as_european(opt)
    s, k, t, sig, q = eu.spot, eu.strike, eu.expiry, eu.vol, eu.dividend_yield
    r = float(eu.curve.zero_rate(t))
    phi = eu.option_type.phi
    sqrt_t = math.sqrt(t)
    d1 = (math.log(s / k) + (r - q + 0.5 * sig**2) * t) / (sig * sqrt_t)
    d2 = d1 - sig * sqrt_t
    disc_s = s * math.exp(-q * t)
    disc_k = k * math.exp(-r * t)
    term_s = phi * disc_s * norm.cdf(phi * d1)
    term_k = phi * disc_k * norm.cdf(phi * d2)
    price = term_s - term_k
    fwd = s * math.exp((r - q) * t)
    call = phi == 1

    steps = [
        _step("Taux zéro à l'échéance", "r = −ln P(0,T) / T", r, "lu sur la courbe, composition continue"),
        _step("Forward", "F = S·e^{(r−q)T}", fwd),
        _step("d₁", "[ln(S/K) + (r − q + σ²/2)·T] / (σ√T)", d1),
        _step("d₂", "d₁ − σ√T", d2),
        _step("N(d₁)" if call else "N(−d₁)", "fonction de répartition normale", norm.cdf(phi * d1),
              "= delta / e^{−qT}"),
        _step("N(d₂)" if call else "N(−d₂)", "fonction de répartition normale", norm.cdf(phi * d2),
              "probabilité risque-neutre de finir dans la monnaie"),
        _step("Terme sous-jacent", ("S·e^{−qT}·N(d₁)" if call else "−S·e^{−qT}·N(−d₁)"), term_s),
        _step("Terme strike", ("K·e^{−rT}·N(d₂)" if call else "−K·e^{−rT}·N(−d₂)"), term_k),
        _step("Prix", "terme sous-jacent − terme strike", price),
    ]

    # risk-neutral density of S_T: ln S_T ~ N(ln S + (r − q − σ²/2)T, σ²T)
    m = math.log(s) + (r - q - 0.5 * sig**2) * t
    sd = sig * sqrt_t
    grid = np.exp(np.linspace(m - 4 * sd, m + 4 * sd, 240))
    pdf = norm.pdf((np.log(grid) - m) / sd) / (grid * sd)
    return {
        "inputs": {"spot": s, "strike": k, "T": t, "rate": r, "dividend_yield": q, "vol": sig, "option_type": eu.option_type.value},
        "steps": steps,
        "price": price,
        "prob_itm": float(norm.cdf(phi * d2)),
        "forward": fwd,
        "density": {"s": grid.tolist(), "pdf": pdf.tolist()},
    }


# ----------------------------------------------------------------------------- binomial tree

TREE_CONVERGENCE_STEPS = list(range(2, 61)) + list(range(70, 301, 10))


def explain_tree(opt: VanillaOption, display_steps: int = 6, boundary_steps: int = 300) -> dict:
    display_steps = int(min(max(display_steps, 1), 12))
    pricer = BinomialTreePricer(steps=display_steps)
    lat = pricer.lattice(opt)
    prm = lat.params
    nodes = []
    for i, (sp, v, c, ex) in enumerate(zip(lat.spots, lat.values, lat.continuation, lat.exercised)):
        for j in range(i + 1):
            nodes.append({"i": i, "j": j, "t": i * prm.dt, "spot": float(sp[j]), "value": float(v[j]),
                          "continuation": float(c[j]), "exercise_value": float(opt.payoff(sp[j])),
                          "exercised": bool(ex[j])})

    convergence = [BinomialTreePricer(steps=n).price(opt) for n in TREE_CONVERGENCE_STEPS]
    if opt.exercise is ExerciseStyle.EUROPEAN:
        reference, reference_label = BlackScholesPricer().price(opt), "Black-Scholes (exact)"
    else:
        reference, reference_label = BinomialTreePricer(steps=2000).price(opt), "Arbre 2000 pas"

    boundary = _tree_boundary(opt, boundary_steps) if opt.exercise is ExerciseStyle.AMERICAN else None
    p0, disc0 = float(prm.p[0]), float(prm.step_disc[0])
    steps = [
        _step("Pas de temps", "Δt = T / N", prm.dt, f"N = {display_steps} pas affichés"),
        _step("Facteur de hausse", "u = e^{σ√Δt}", prm.u),
        _step("Facteur de baisse", "d = 1/u", prm.d),
        _step("Actualisation sur un pas", "P(t₀, t₁) = e^{−f·Δt}", disc0, "f : taux forward de la courbe sur le pas"),
        _step("Probabilité risque-neutre", "p = (e^{−qΔt}/P(t₀,t₁) − d) / (u − d)", p0,
              "fait croître le sous-jacent au taux sans risque en espérance"),
        _step("Valeur d'un nœud", "V = P·[p·V_haut + (1−p)·V_bas]" + (" puis max(·, payoff)" if opt.exercise is ExerciseStyle.AMERICAN else ""),
              float(lat.values[0][0]), "induction à rebours depuis les payoffs à l'échéance"),
    ]
    return {
        "params": {"dt": prm.dt, "u": prm.u, "d": prm.d, "p": p0, "step_discount": disc0, "steps": display_steps},
        "steps": steps,
        "nodes": nodes,
        "price_display": float(lat.values[0][0]),
        "convergence": {"n": TREE_CONVERGENCE_STEPS, "price": convergence},
        "reference": reference,
        "reference_label": reference_label,
        "boundary": boundary,
    }


def _tree_boundary(opt: VanillaOption, steps: int) -> dict:
    """Early-exercise frontier: per date, the spot beyond which exercising beats holding."""
    lat = BinomialTreePricer(steps=steps).lattice(as_american(opt))
    put = opt.option_type.phi < 0
    t, s = [], []
    for i, (sp, ex) in enumerate(zip(lat.spots, lat.exercised)):
        # even levels only: CRR nodes alternate between two price grids, which makes the raw frontier zigzag
        if ex.any() and i < steps and i % 2 == 0:
            t.append(i * lat.params.dt)
            s.append(float(sp[ex].max() if put else sp[ex].min()))
    return {"t": t, "s": s}


# ----------------------------------------------------------------------------- Monte Carlo

def explain_monte_carlo(opt: VanillaOption, n_paths: int = 100_000, display_paths: int = 40,
                        display_steps: int = 80, seed: int = 42) -> dict:
    eu = as_european(opt)
    pricer = MonteCarloPricer(n_paths=n_paths, seed=seed, antithetic=True)
    s_t = pricer.terminal_spots(eu)
    df = float(eu.curve.discount(eu.expiry))
    payoff = eu.payoff(s_t)
    pv = df * payoff
    price, se = float(pv.mean()), pricer._std_error(pv)
    plain_price, plain_se = MonteCarloPricer(n_paths=n_paths, seed=seed, antithetic=False).price_with_error(eu)

    # illustrative paths on a fine grid (same dynamics as the pricer, fewer paths)
    times = eu.expiry * np.arange(1, display_steps + 1) / display_steps
    z = standard_normals(display_paths, display_steps, seed + 1, antithetic=False)
    paths = gbm_paths(eu.spot, eu.vol, eu.dividend_yield, eu.curve, times, z)
    paths = np.hstack([np.full((display_paths, 1), eu.spot), paths])

    # running estimate, antithetic pairs kept together
    half = len(pv) // 2
    paired = 0.5 * (pv[:half] + pv[half:2 * half])
    checkpoints = np.unique(np.geomspace(50, len(paired), 80).astype(int))
    cum = np.cumsum(paired)
    cum2 = np.cumsum(paired**2)
    means = cum[checkpoints - 1] / checkpoints
    var = (cum2[checkpoints - 1] - checkpoints * means**2) / (checkpoints - 1)
    half_width = 1.96 * np.sqrt(np.maximum(var, 0) / checkpoints)

    counts, edges = np.histogram(s_t, bins=70)
    itm = payoff > 0
    pay_counts, pay_edges = np.histogram(payoff[itm], bins=50) if itm.any() else (np.array([]), np.array([0.0, 1.0]))
    reference = BlackScholesPricer().price(eu)

    steps = [
        _step("Trajectoires simulées", "N (paires antithétiques Z, −Z)", n_paths),
        _step("Spot final simulé", "S_T = S·e^{−qT}/P(0,T) · e^{−σ²T/2 + σ√T·Z}", float(s_t.mean()),
              f"moyenne des S_T ; forward théorique {eu.spot * math.exp(-eu.dividend_yield * eu.expiry) / df:.4f}"),
        _step("Proportion dans la monnaie", "#{payoff > 0} / N", float(itm.mean())),
        _step("Payoff moyen", "moyenne de max(φ(S_T − K), 0)", float(payoff.mean())),
        _step("Facteur d'actualisation", "P(0,T)", df),
        _step("Prix", "P(0,T) × payoff moyen", price),
        _step("Erreur standard", "écart-type des paires / √(N/2)", se),
        _step("Intervalle de confiance à 95 %", "prix ± 1,96 × erreur standard", 1.96 * se,
              f"[{price - 1.96 * se:.4f} ; {price + 1.96 * se:.4f}]"),
    ]
    return {
        "steps": steps,
        "price": price,
        "std_error": se,
        "reference": reference,
        "antithetic": {"with": {"price": price, "std_error": se}, "without": {"price": plain_price, "std_error": plain_se},
                       "variance_reduction": float((plain_se / se) ** 2) if se > 0 else None},
        "paths": {"t": np.concatenate([[0.0], times]).tolist(), "s": paths.round(4).tolist()},
        "terminal_histogram": {"edges": edges.tolist(), "counts": counts.tolist()},
        "payoff_histogram": {"edges": pay_edges.tolist(), "counts": pay_counts.tolist(), "otm_fraction": float(1 - itm.mean())},
        "convergence": {"n": (checkpoints * 2).tolist(), "mean": means.tolist(),
                        "lo": (means - half_width).tolist(), "hi": (means + half_width).tolist()},
    }


# ----------------------------------------------------------------------------- Longstaff-Schwartz

def explain_lsm(opt: VanillaOption, n_paths: int = 50_000, lsm_steps: int = 50, snapshot_step: int | None = None,
                max_points: int = 1500) -> dict:
    am = as_american(opt)
    pricer = MonteCarloPricer(n_paths=n_paths, lsm_steps=lsm_steps)
    snapshot_step = lsm_steps // 2 if snapshot_step is None else int(min(max(snapshot_step, 0), lsm_steps - 2))
    diag = pricer.lsm_diagnostics(am, snapshot_step)
    tree_am = BinomialTreePricer(steps=1000).price(am)
    european = BlackScholesPricer().price(as_european(am))

    snap = diag.get("snapshot")
    regression = None
    if snap is not None:
        rng = np.random.default_rng(0)
        idx = rng.choice(len(snap["s"]), size=min(max_points, len(snap["s"])), replace=False)
        x_grid = np.linspace(snap["s"].min(), snap["s"].max(), 120)
        fitted = np.polynomial.polynomial.polyval(x_grid / am.strike, snap["coefs"])
        regression = {
            "t": snap["t"],
            "points": {"s": snap["s"][idx].round(4).tolist(), "cashflow": snap["discounted_cashflow"][idx].round(4).tolist(),
                       "exercised": snap["exercised"][idx].tolist()},
            "fit": {"s": x_grid.tolist(), "continuation": fitted.tolist(), "exercise": am.payoff(x_grid).tolist()},
            "coefficients": snap["coefs"].tolist(),
            "n_itm": int(len(snap["s"])),
            "n_exercised": int(snap["exercised"].sum()),
        }
    boundary = sorted(diag["boundary"].items())
    steps = [
        _step("Dates d'exercice", "M dates équidistantes", lsm_steps),
        _step("Trajectoires", "N", n_paths),
        _step("Régression à chaque date", "E[cash-flow futur | S] ≈ β₀ + β₁x + β₂x² + β₃x³,  x = S/K", len(boundary),
              "dates où l'exercice est optimal pour au moins une trajectoire"),
        _step("Règle d'exercice", "exercer si payoff(S) > continuation estimée", diag["price"]),
        _step("Prix LSM", "moyenne des cash-flows actualisés de la stratégie optimale", diag["price"]),
        _step("Erreur standard", "σ / √N (paires antithétiques)", diag["std_error"]),
        _step("Prix européen (Black-Scholes)", "sans droit d'exercice anticipé", european),
        _step("Prime d'exercice anticipé", "LSM − européen", diag["price"] - european),
    ]
    return {
        "steps": steps,
        "price": diag["price"],
        "std_error": diag["std_error"],
        "tree_price": tree_am,
        "european_price": european,
        "boundary": {"t": [b[0] for b in boundary], "s": [b[1] for b in boundary]},
        "tree_boundary": _tree_boundary(am, 300),
        "regression": regression,
        "lsm_steps": lsm_steps,
        "snapshot_step": snapshot_step,
    }


# ----------------------------------------------------------------------------- finite-difference Greeks

def explain_greeks(opt: VanillaOption, method: str = "tree", tree_steps: int = 500, n_paths: int = 100_000) -> dict:
    pricer = BinomialTreePricer(steps=tree_steps) if method == "tree" else MonteCarloPricer(n_paths=n_paths)
    rows = pricer.greek_breakdown(opt)
    closed = None
    if opt.exercise is ExerciseStyle.EUROPEAN:
        g = BlackScholesPricer().greeks(opt)
        closed = {"delta": g.delta, "gamma": g.gamma, "vega": g.vega, "theta": g.theta, "rho": g.rho}
    return {"method": pricer.name, "rows": rows, "closed_form": closed}
