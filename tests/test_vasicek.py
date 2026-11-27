"""Ornstein-Uhlenbeck estimation and the Vasicek term structure."""

import math

import numpy as np
import pytest

from qplat.theory.vasicek import (calibrate_vasicek, estimate_ou, estimator_distribution, long_yield, ou_mean, ou_var,
                                  prob_negative, simulate_ou, stationary_sd, vasicek_discount, vasicek_forward,
                                  vasicek_yield)

K, TH, SIG, R0 = 0.4, 0.03, 0.01, 0.05


def test_exact_simulation_matches_the_moments():
    paths = simulate_ou(R0, K, TH, SIG, dt=0.5, n_steps=4, n_paths=200_000, seed=1)
    t = 2.0
    assert paths[:, -1].mean() == pytest.approx(float(ou_mean(R0, K, TH, t)), abs=1e-4)
    assert paths[:, -1].var() == pytest.approx(float(ou_var(K, SIG, t)), rel=0.01)
    # stationary law reached for long horizons
    assert float(ou_var(K, SIG, 1e3)) == pytest.approx(stationary_sd(K, SIG) ** 2)


def test_ar1_regression_recovers_the_parameters():
    path = simulate_ou(TH, K, TH, SIG, dt=1 / 12, n_steps=60_000, seed=2)[0]
    e = estimate_ou(path, 1 / 12)
    assert e.mean_reverting
    assert e.kappa == pytest.approx(K, rel=0.05)
    assert e.theta == pytest.approx(TH, abs=5e-4)
    assert e.sigma == pytest.approx(SIG, rel=0.02)
    assert e.half_life == pytest.approx(math.log(2) / e.kappa)
    assert e.half_life_low < e.half_life < e.half_life_high
    assert abs(e.kappa - K) < 3 * e.se_kappa


def test_exact_discretisation_maps_b_and_residuals():
    b = math.exp(-K / 12)
    resid_var = SIG ** 2 * (1 - b * b) / (2 * K)
    assert float(ou_var(K, SIG, 1 / 12)) == pytest.approx(resid_var)


def test_random_walk_has_no_mean_reversion():
    rw = np.cumsum(np.r_[0.02, np.full(300, 1e-4)])  # a steadily rising series: slope >= 1
    e = estimate_ou(rw, 1 / 12)
    assert not e.mean_reverting and math.isnan(e.kappa)
    with pytest.raises(ValueError):
        estimate_ou([0.01] * 5, 1 / 12)


def test_small_sample_bias_follows_kendall():
    dist = estimator_distribution(TH, 0.2, TH, SIG, dt=1 / 12, n=240, n_sims=4000, seed=3)
    # the slope is biased downwards by about (1 + 3b) / n, so kappa is overestimated
    assert dist["b_bias"] < 0
    assert dist["b_bias"] == pytest.approx(dist["b_bias_kendall"], rel=0.25)
    assert dist["kappa_mean"] > 0.2


def test_zero_coupon_limits_and_closed_forms():
    assert float(vasicek_yield(R0, K, TH, SIG, 1e-8)) == pytest.approx(R0, abs=1e-6)
    assert float(vasicek_yield(R0, K, TH, SIG, 2000.0)) == pytest.approx(long_yield(K, TH, SIG), abs=1e-4)
    # sigma -> 0: the yield is the average of the expected path
    tau = 5.0
    avg = TH + (R0 - TH) * (1 - math.exp(-K * tau)) / (K * tau)
    assert float(vasicek_yield(R0, K, TH, 1e-12, tau)) == pytest.approx(avg, abs=1e-10)
    # forward = -d ln P / dt
    t, h = 3.0, 1e-5
    fd = -(math.log(float(vasicek_discount(R0, K, TH, SIG, t + h))) - math.log(float(vasicek_discount(R0, K, TH, SIG, t - h)))) / (2 * h)
    assert float(vasicek_forward(R0, K, TH, SIG, t)) == pytest.approx(fd, abs=1e-8)


def test_bond_price_matches_monte_carlo():
    tau, n = 5.0, 500
    dt = tau / n
    paths = simulate_ou(R0, K, TH, SIG, dt=dt, n_steps=n, n_paths=20_000, seed=4)
    integral = (paths[:, :-1] + paths[:, 1:]).sum(axis=1) * dt / 2
    mc = np.exp(-integral)
    assert mc.mean() == pytest.approx(float(vasicek_discount(R0, K, TH, SIG, tau)), abs=4 * mc.std() / math.sqrt(len(mc)) + 1e-5)


def test_calibration_round_trip():
    tenors = np.array([0.25, 1, 2, 5, 10, 20, 30])
    z = vasicek_yield(0.04, 0.15, 0.055, 0.008, tenors)
    fit = calibrate_vasicek(tenors, z, 0.04, 0.008)
    assert fit["kappa"] == pytest.approx(0.15, rel=1e-4)
    assert fit["theta"] == pytest.approx(0.055, abs=1e-6)
    assert fit["rmse"] < 1e-9


def test_probability_of_negative_rates():
    assert prob_negative(K, 0.0, SIG) == pytest.approx(0.5)
    assert prob_negative(K, TH, SIG) < prob_negative(K, TH, 2 * SIG)
    assert prob_negative(K, TH, SIG, r0=R0, t=1e-9) == pytest.approx(0.0, abs=1e-12)
