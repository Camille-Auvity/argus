import numpy as np
import pandas as pd
import pytest

from qplat.allocation import (
    Constraints, estimate, frontier, ledoit_wolf, max_sharpe, min_variance, optimize, returns_in_base,
    unconstrained_frontier,
)
from qplat.allocation.backtest import Strategy, run_backtest

RNG = np.random.default_rng(42)
P = 6
MU = np.array([0.05, 0.08, 0.10, 0.06, 0.12, 0.04])
VOL = np.array([0.15, 0.20, 0.25, 0.18, 0.30, 0.12])
CORR = 0.3 + 0.7 * np.eye(P)
COV = np.outer(VOL, VOL) * CORR
INV = np.linalg.inv(COV)
ONE = np.ones(P)
WIDE = Constraints(long_only=False, short_max=100.0, w_max=100.0)


def test_global_minimum_variance_closed_form():
    r = min_variance(COV, WIDE)
    assert np.allclose(r.weights, INV @ ONE / (ONE @ INV @ ONE), atol=1e-6)
    assert r.risk_contributions.sum() == pytest.approx(1.0)


def test_unconstrained_mean_variance_closed_form():
    gamma = 4.0
    gmv = INV @ ONE / (ONE @ INV @ ONE)
    w = gmv + (INV @ MU - (ONE @ INV @ MU) / (ONE @ INV @ ONE) * (INV @ ONE)) / gamma
    assert np.allclose(optimize(MU, COV, gamma, WIDE).weights, w, atol=1e-6)


def test_long_only_and_caps():
    r = optimize(MU, COV, 2.0, Constraints(long_only=True, w_max=0.3))
    assert r.weights.min() >= -1e-9 and r.weights.max() <= 0.3 + 1e-9
    assert r.weights.sum() == pytest.approx(1.0)


def test_frontier_matches_closed_form_without_binding_constraints():
    pts = frontier(MU, COV, WIDE, 8)
    targets = np.array([p.expected_return for p in pts])
    assert np.allclose([p.volatility for p in pts], unconstrained_frontier(MU, COV, targets), atol=1e-5)
    # the long-only frontier lies on or to the right of the unconstrained one
    lo = frontier(MU, COV, Constraints(long_only=True), 8)
    for p_ in lo:
        assert p_.volatility >= unconstrained_frontier(MU, COV, np.array([p_.expected_return]))[0] - 1e-6


def test_tangency_has_the_best_sharpe():
    cons = Constraints(long_only=True)
    t = max_sharpe(MU, COV, cons, rf=0.02)
    assert all(t.sharpe >= p.sharpe - 1e-6 for p in frontier(MU, COV, cons, 25, rf=0.02))
    # unconstrained tangency: w ~ Sigma^-1 (mu - rf)
    wt = INV @ (MU - 0.02)
    wt /= wt.sum()
    assert max_sharpe(MU, COV, WIDE, rf=0.02).sharpe == pytest.approx((MU @ wt - 0.02) / np.sqrt(wt @ COV @ wt), rel=1e-4)


def test_lasso_needs_short_selling():
    cons = Constraints(long_only=False, short_max=1.0)
    sample = RNG.multivariate_normal(np.zeros(P), COV / 252, size=150)
    cov_s = np.cov(sample, rowvar=False) * 252
    n_active = [min_variance(cov_s, Constraints(long_only=False, short_max=1.0, l1=lam)).n_active
                for lam in (0.0, 0.002, 0.01, 0.05)]
    gross = [min_variance(cov_s, Constraints(long_only=False, short_max=1.0, l1=lam)).gross_exposure
             for lam in (0.0, 0.05)]
    assert gross[1] < gross[0] and n_active[-1] <= n_active[0]
    # long-only: ||w||_1 = 1 whatever the weights, so the L1 penalty changes nothing
    a = optimize(MU, COV, 3.0, Constraints(long_only=True)).weights
    b = optimize(MU, COV, 3.0, Constraints(long_only=True, l1=0.5)).weights
    assert np.allclose(a, b, atol=1e-6)
    assert min_variance(COV, cons).success


def test_transaction_costs_reduce_trading():
    w0 = tuple(np.full(P, 1 / P))
    free = optimize(MU, COV, 3.0, Constraints(long_only=True, w0=w0))
    costly = optimize(MU, COV, 3.0, Constraints(long_only=True, w0=w0, cost=0.01, holding=1 / 12))
    frozen = optimize(MU, COV, 3.0, Constraints(long_only=True, w0=w0, cost=1.0, holding=1 / 12))
    assert costly.turnover < free.turnover
    assert frozen.turnover == pytest.approx(0.0, abs=1e-6)


def test_ledoit_wolf():
    X = RNG.standard_normal((40, 20)) * 0.01          # few observations, identity covariance
    S, delta = ledoit_wolf(X)
    assert 0 < delta <= 1 and np.all(np.linalg.eigvalsh(S) > 0)
    X2 = RNG.standard_normal((5000, 5)) * 0.01         # many observations: little shrinkage needed
    assert ledoit_wolf(X2)[1] < delta


def test_returns_in_base_convert_usd_assets():
    idx = pd.to_datetime(["2026-01-02", "2026-01-05", "2026-01-06"]).date
    usd = pd.Series([100.0, 110.0, 110.0], index=idx)
    eur = pd.Series([50.0, 50.0, 55.0], index=idx)
    fx = pd.Series([1.10, 1.00, 1.10], index=idx)          # EURUSD
    R = returns_in_base({"US": usd, "EU": eur}, {"US": "USD", "EU": "EUR"}, fx)
    assert R["US"].iloc[0] == pytest.approx((110 / 1.00) / (100 / 1.10) - 1)
    assert R["EU"].iloc[1] == pytest.approx(0.1)


def test_estimate_shrinks_means():
    R = pd.DataFrame(RNG.multivariate_normal(MU / 252, COV / 252, size=300), columns=list("abcdef"))
    js = estimate(R, "shrunk", "sample")
    assert 0 <= js.mean_shrinkage <= 1
    assert np.ptp(js.mu) <= np.ptp(estimate(R, "sample", "sample").mu) + 1e-12


def test_backtest_has_no_look_ahead_and_charges_costs():
    dates = pd.bdate_range("2025-01-01", periods=200)
    R = pd.DataFrame(RNG.multivariate_normal(np.zeros(3), np.eye(3) * 1e-4, size=200), index=dates, columns=list("abc"))
    seen = []

    def rule(past, w):
        seen.append(past.index[-1])
        return np.array([0.5, 0.3, 0.2])

    res = run_backtest(R, [Strategy("test", rule)], window=50, rebalance_days=20, cost=0.01)[0]
    rebal_dates = [pd.Timestamp(d) for d, _ in res.weights_history]
    assert all(last < d for last, d in zip(seen, rebal_dates))          # only strictly past data
    assert res.total_cost > 0.01 * abs(0.5 - 1 / 3)                      # initial trade from 1/N is charged
    assert len(res.wealth) == 150
