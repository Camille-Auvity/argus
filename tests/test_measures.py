import math

import numpy as np
import pytest
from scipy.stats import norm

from qplat.theory.measures import (
    compare_measures, empirical_terminal, historical_drift, lognormal_pdf, lognormal_stats, risk_neutral_density,
)

S0, T, R, Q, SIG = 100.0, 0.5, 0.04, 0.01, 0.25
F = S0 * math.exp((R - Q) * T)
FLAT = lambda K: np.full_like(np.asarray(K, float), SIG)  # noqa: E731


def test_lognormal_moments_and_ordering():
    st = lognormal_stats(S0, 0.10, Q, SIG, T)
    m = math.log(S0) + (0.10 - Q - 0.5 * SIG**2) * T
    assert st["mean"] == pytest.approx(S0 * math.exp((0.10 - Q) * T))
    assert st["median"] == pytest.approx(math.exp(m)) and st["mode"] == pytest.approx(math.exp(m - SIG**2 * T))
    assert st["mean"] > st["median"] > st["mode"]
    assert st["prob_below"]["1.00"] == pytest.approx(norm.cdf((math.log(S0) - m) / (SIG * math.sqrt(T))))


def test_girsanov_same_vol_different_drift():
    """With mu = r the real-world law is the risk-neutral one; with mu > r every quantile moves up by e^{(mu-r)T}."""
    P, Qs = lognormal_stats(S0, R, Q, SIG, T), lognormal_stats(S0, R, Q, SIG, T)
    assert P == Qs
    P2 = lognormal_stats(S0, 0.12, Q, SIG, T)
    for p in P2["quantiles"]:
        assert P2["quantiles"][p] / Qs["quantiles"][p] == pytest.approx(math.exp((0.12 - R) * T))
    assert Qs["mean"] == pytest.approx(F)        # discounted price is a Q-martingale


def test_breeden_litzenberger_flat_smile_is_the_lognormal():
    rn = risk_neutral_density(FLAT, F, T, math.exp(-R * T), 20, 400, n=2001)
    assert rn["mass"] == pytest.approx(1.0, abs=1e-6) and rn["mean"] == pytest.approx(F, rel=1e-6)
    exact = lognormal_pdf(rn["K"], S0, R, Q, SIG, T)
    assert np.max(np.abs(rn["density"] - exact)) < 1e-5
    cdf = norm.cdf((np.log(rn["K"] / F) + 0.5 * SIG**2 * T) / (SIG * math.sqrt(T)))
    assert np.max(np.abs(rn["cdf"] - cdf)) < 1e-5


def test_skew_fattens_the_left_tail_but_keeps_the_forward():
    skew = lambda K: np.clip(SIG - 0.15 * np.log(np.asarray(K) / F), 0.05, 2)  # noqa: E731
    out = compare_measures(S0, T, R, Q, 0.10, SIG, skew)
    flat = compare_measures(S0, T, R, Q, 0.10, SIG, FLAT)
    assert out["checks"]["mean"] == pytest.approx(F, rel=1e-3)
    assert out["stats"]["Q_smile"]["prob_below"]["0.80"] > flat["stats"]["Q_smile"]["prob_below"]["0.80"] + 0.01
    assert out["stats"]["Q_smile"]["median"] > flat["stats"]["Q_smile"]["median"]   # negative skew: median above
    assert flat["stats"]["Q_smile"]["median"] == pytest.approx(flat["stats"]["Q"]["median"], rel=1e-4)


def test_pricing_kernel_decreases_when_mu_above_r():
    out = compare_measures(S0, T, R, Q, 0.12, SIG, FLAT)
    k = np.array(out["kernel"]["lognormal"])
    assert np.all(np.diff(k) < 0) and out["market_price_of_risk"] == pytest.approx((0.12 - R) / SIG)
    assert np.allclose(out["kernel"]["smile"], k, rtol=1e-3)


def test_fan_starts_at_spot_and_widens():
    out = compare_measures(S0, T, R, Q, 0.10, SIG, FLAT, vol_at=lambda h: FLAT)
    rows = out["fan"]["rows"]
    assert rows[0]["P"] == [S0] * 5
    widths = [r["Q"][4] - r["Q"][0] for r in rows]
    assert all(b > a for a, b in zip(widths, widths[1:]))
    assert rows[-1]["Q_smile"][2] == pytest.approx(rows[-1]["Q"][2], rel=1e-4)


def test_historical_drift_and_its_standard_error():
    rng = np.random.default_rng(0)
    mu, sig, n = 0.10, 0.2, 252 * 40
    lr = (mu - 0.5 * sig**2) / 252 + sig / math.sqrt(252) * rng.standard_normal(n)
    h = historical_drift(100 * np.exp(np.concatenate([[0], np.cumsum(lr)])))
    assert h["sigma"] == pytest.approx(sig, rel=0.02)
    assert abs(h["mu"] - mu) < 3 * h["se"] and h["se"] == pytest.approx(sig / math.sqrt(40), rel=0.02)
    e = empirical_terminal(np.array([1.0, 1.1, 1.21, 1.331] * 10), 50.0, 1)
    assert len(e) == 39
