"""Predictive regressions: Stambaugh bias, Amihud-Hurvich correction, continuous-time mapping, bootstrap."""

import math

import numpy as np
import pytest

from qplat.theory.predictive import (continuous_to_discrete, estimator_study, kendall_bias, predictive_regression,
                                     bootstrap_null, simulate_system)


def test_stambaugh_bias_formula_matches_monte_carlo():
    s = estimator_study(0.95, -0.9, 200, n_sims=20_000, seed=1)
    assert s["beta_bias"] > 0                                    # corr < 0: beta_hat biased upwards
    assert s["beta_bias"] == pytest.approx(s["beta_bias_stambaugh"], rel=0.2)
    assert s["rho_bias"] == pytest.approx(kendall_bias(0.95, 200), rel=0.2)
    # the relation is exact in each sample: beta_hat - beta = gamma (rho_hat - rho) + noise uncorrelated with it
    slope = np.polyfit(s["samples"]["rho_err"], s["samples"]["beta_hat"], 1)[0]
    assert slope == pytest.approx(-0.9, abs=0.03)


def test_no_bias_without_correlated_innovations():
    s = estimator_study(0.98, 0.0, 120, n_sims=20_000, seed=2)
    assert abs(s["beta_bias"]) < 3 * s["beta_hat_sd"] / math.sqrt(s["n_sims"])
    assert s["size_ols_two_sided"] == pytest.approx(0.05, abs=0.01)


def test_ols_t_test_over_rejects_and_amihud_hurvich_fixes_it():
    s = estimator_study(0.98, -0.95, 240, n_sims=20_000, seed=3)
    assert s["size_ols_one_sided"] > 0.15                       # nominal 5%
    assert s["size_ah_one_sided"] == pytest.approx(0.05, abs=0.02)
    assert abs(s["beta_ah_mean"]) < 0.25 * s["beta_bias"]


def test_single_sample_estimates_and_corrections():
    r, x, xn = simulate_system(0.97, -0.9, 400, beta=0.0, n_sims=1, seed=4)
    e = predictive_regression(r[0], x[0], xn[0])
    assert e["n"] == 400
    assert e["corr_uv"] == pytest.approx(-0.9, abs=0.05)
    assert e["beta_stambaugh"] == pytest.approx(e["beta"] - e["gamma"] * kendall_bias(e["rho"], 400))
    assert e["rho_ah"] > e["rho"]
    assert e["se_ah"] > 0 and math.isfinite(e["t_ah"])
    with pytest.raises(ValueError):
        predictive_regression([0.1] * 5, [0.2] * 5, [0.3] * 5)


def test_bootstrap_p_values():
    r, x, xn = simulate_system(0.95, -0.9, 300, beta=0.0, n_sims=1, seed=5)
    null = bootstrap_null(r[0], x[0], xn[0], n_boot=1000, seed=6)
    assert 0.02 < null["p_two_sided"] <= 1.0
    assert null["beta_null_mean"] > 0                             # the null distribution is shifted, not centred on 0
    r, x, xn = simulate_system(0.95, -0.9, 300, beta=0.3, n_sims=1, seed=7)
    assert bootstrap_null(r[0], x[0], xn[0], n_boot=1000, seed=8)["p_one_sided"] < 0.01


def test_continuous_time_mapping_matches_fine_simulation():
    a, b, sx, th, yb, sy, rho_xy, dt = 0.06, 2.0, 0.16, 0.5, 0.01, 0.02, -0.8, 1.0
    m = continuous_to_discrete(a, b, sx, th, yb, sy, rho_xy, dt)
    assert m["rho"] == pytest.approx(math.exp(-th * dt))
    assert m["beta"] == pytest.approx(b * (1 - math.exp(-th * dt)) / th)
    # Euler on a fine grid over one period, Y started at Ybar
    rng = np.random.default_rng(9)
    paths, steps = 40_000, 400
    h = dt / steps
    y = np.full(paths, yb)
    lnx = np.zeros(paths)
    for _ in range(steps):
        z1, z2 = rng.standard_normal((2, paths))
        dby = math.sqrt(h) * z1
        dbx = math.sqrt(h) * (rho_xy * z1 + math.sqrt(1 - rho_xy ** 2) * z2)
        lnx += (a + b * y - 0.5 * sx ** 2) * h + sx * dbx
        y += th * (yb - y) * h + sy * dby
    u = lnx - (m["alpha"] + m["beta"] * yb)
    v = y - (m["mu"] + m["rho"] * yb)
    assert u.mean() == pytest.approx(0.0, abs=4 * m["sigma_u"] / math.sqrt(paths))
    assert u.std() == pytest.approx(m["sigma_u"], rel=0.02)
    assert v.std() == pytest.approx(m["sigma_v"], rel=0.02)
    assert np.corrcoef(u, v)[0, 1] == pytest.approx(m["corr_uv"], abs=0.02)
