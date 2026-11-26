import math

import numpy as np
import pytest

from qplat.curves import FlatCurve
from qplat.instruments import AsianOption, EuropeanOption
from qplat.pricers import BlackScholesPricer, MonteCarloExoticPricer, MonteCarloPricer
from qplat.pricers.paths import auto_theta, importance_shift, standard_normals
from qplat.theory.stochastic import girsanov, importance_sampling, ito_sums, martingales, variations


def test_total_variation_explodes_quadratic_variation_converges():
    rows = variations(steps=(16, 256, 4096), n_paths=2000)
    for r in rows:
        assert r["total_variation"] == pytest.approx(r["total_variation_theory"], rel=0.03)
        assert r["quadratic_variation"] == pytest.approx(1.0, abs=4 * r["quadratic_variation_sd"] / math.sqrt(2000) + 0.01)
        assert r["quadratic_variation_sd"] == pytest.approx(r["quadratic_variation_sd_theory"], rel=0.1)
    assert rows[-1]["total_variation"] > 15 * rows[0]["total_variation"]     # x 16 = sqrt(4096 / 16)


def test_ito_versus_right_point_sums():
    s = ito_sums(n_steps=1000, n_paths=5000)
    assert s["mean_left"] == pytest.approx(0.0, abs=0.06)
    assert s["mean_right"] == pytest.approx(1.0, abs=0.06)
    coarse = ito_sums(n_steps=50, n_paths=5000)
    assert s["rms_gap_left"] < coarse["rms_gap_left"]                          # L_N -> (B_T^2 - T) / 2


def test_martingales():
    m = martingales(lam=0.8, n_paths=40_000)
    for name, v in m["series"].items():
        drift = v["mean"][-1] - v["mean"][0]
        if v["martingale"]:
            assert abs(drift) < 4 * v["se"][-1] + 1e-3, name
        else:
            assert drift > 10 * v["se"][-1], name


def test_girsanov_shifts_the_mean():
    g = girsanov(theta=0.7, T=2.0)
    assert g["mean_weight"] == pytest.approx(1.0, abs=4 * g["mean_weight_se"])
    assert g["q_mean_by_weighting"] == pytest.approx(1.4, abs=0.03)
    assert g["prob_above_q_mean"] == pytest.approx(0.5, abs=0.01)


def test_likelihood_ratio_has_mean_one():
    z = standard_normals(200_000, 12, 1, True)
    _, w = importance_shift(z, np.linspace(1 / 12, 1, 12), 0.8)
    assert w.mean() == pytest.approx(1.0, abs=0.01)


def test_importance_sampling_is_unbiased_and_efficient():
    for K, kind in ((150, "call"), (65, "put")):
        opt = EuropeanOption(spot=100, strike=K, expiry=0.5, vol=0.2, rate=0.03, option_type=kind)
        exact = BlackScholesPricer().price(opt)
        p, se = MonteCarloPricer(n_paths=20_000, importance="auto").price_with_error(opt)
        assert abs(p - exact) < 4 * se
        plain_se = MonteCarloPricer(n_paths=20_000).price_with_error(opt)[1]
        assert (plain_se / se) ** 2 > 100
    # at the money there is little to gain
    res = importance_sampling(100, 100, 0.5, 0.03, 0.0, 0.2, "call", 20_000)
    assert res["variance_reduction"] < 3
    assert abs(res["theta_star"] - auto_theta(100, 100, 0.2, 0.0, FlatCurve(0.03), 0.5)) < 1e-12


def test_importance_sampling_on_path_dependent_products():
    a = AsianOption.regular(1.0, 12, spot=100, strike=145, vol=0.25, rate=0.03)
    plain = MonteCarloExoticPricer(n_paths=60_000, control_variate=False).price_with_error(a)
    shifted = MonteCarloExoticPricer(n_paths=60_000, control_variate=False, importance="auto").price_with_error(a)
    assert abs(plain[0] - shifted[0]) < 4 * math.hypot(plain[1], shifted[1])
    assert shifted[1] < plain[1] / 3


def test_greeks_with_importance_sampling():
    opt = EuropeanOption(spot=100, strike=140, expiry=0.5, vol=0.2, rate=0.03)
    bs = BlackScholesPricer().greeks(opt)
    mc = MonteCarloPricer(n_paths=50_000, importance="auto").greeks(opt)
    assert mc.delta == pytest.approx(bs.delta, rel=0.03) and mc.vega == pytest.approx(bs.vega, rel=0.05)
