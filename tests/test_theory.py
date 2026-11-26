import math

import numpy as np
import pytest

from qplat.pricers import BlackScholesPricer
from qplat.instruments import EuropeanOption
from qplat.theory.hedging import (
    backtest_short_options, bs_value_delta_gamma, derman_kamal_sd, simulate_hedge,
)
from qplat.theory.replication import build_tree, market_maker


# ----------------------------------------------------------------------------- the course example (lecture 2)

def test_one_period_put_of_the_course():
    t = build_tree(100, 1.2, 0.8, 1.05, 110, "put", 1)
    root = t.node(0, 0)
    assert t.price == pytest.approx(10.714, abs=1e-3)
    assert root.delta == pytest.approx(-0.75) and root.bond == pytest.approx(85.714, abs=1e-3)
    assert t.pi == pytest.approx(0.625)


def test_two_period_put_of_the_course():
    t = build_tree(100, 1.2, 0.8, 1.05, 110, "put", 2)
    up, dn, root = t.node(1, 1), t.node(1, 0), t.node(0, 0)
    assert (up.value, up.delta, up.bond) == pytest.approx((5.0, -0.2917, 40.0), abs=1e-4)
    assert (dn.value, dn.delta, dn.bond) == pytest.approx((24.762, -1.0, 104.762), abs=1e-3)
    assert (t.price, root.delta, root.bond) == pytest.approx((11.820, -0.4940, 61.224), abs=1e-3)
    # multiply along paths, add across paths: Q(S2 = 96) = 2 x 0.625 x 0.375
    assert t.node(2, 1).probability == pytest.approx(0.46875)
    assert t.direct_value() == pytest.approx(t.price, abs=1e-12)


def test_self_financing_at_every_node():
    t = build_tree(100, 1.15, 0.9, 1.01, 100, "call", 6)
    for level in t.nodes[1:]:
        for n in level:
            assert n.parent_portfolio_value == pytest.approx(n.value, abs=1e-10)
    assert sum(n.probability for n in t.nodes[-1]) == pytest.approx(1.0)


def test_no_arbitrage_condition():
    with pytest.raises(ValueError):
        build_tree(100, 1.02, 0.8, 1.05, 100)       # R > u: lend and short the stock


def test_market_maker_hedges_every_path():
    t = build_tree(100, 1.2, 0.8, 1.05, 110, "put", 2)
    for path in ("uu", "ud", "du", "dd"):
        mm = market_maker(t, path, 12.0)
        assert mm["net"] == pytest.approx(0.0, abs=1e-10)
        assert mm["spread_kept"] == pytest.approx(12.0 - 11.820, abs=1e-3)
    up = market_maker(t, "uu", 12.0)["steps"][1]
    assert up["cash_before"] == pytest.approx(64.286, abs=1e-3) and up["trade_cash"] == pytest.approx(-24.286, abs=1e-3)
    down = market_maker(t, "dd", 12.0)["steps"][1]
    assert down["trade_cash"] == pytest.approx(40.476, abs=1e-3)


def test_american_put_and_convergence_to_black_scholes():
    eu = build_tree(100, 1.2, 0.8, 1.05, 110, "put", 3).price
    am = build_tree(100, 1.2, 0.8, 1.05, 110, "put", 3, american=True).price
    assert am >= eu
    # CRR parametrisation: the tree converges to Black-Scholes
    n, T, sig, r = 400, 1.0, 0.2, 0.03
    dt = T / n
    t = build_tree(100, math.exp(sig * math.sqrt(dt)), math.exp(-sig * math.sqrt(dt)), math.exp(r * dt), 100, "call", n)
    bs = BlackScholesPricer().price(EuropeanOption(spot=100, strike=100, expiry=T, vol=sig, rate=r))
    assert t.price == pytest.approx(bs, abs=0.01)


# ----------------------------------------------------------------------------- delta hedging

ARGS = (100.0, 100.0, 0.25, 0.03, 0.0)


def test_hedging_error_decreases_like_one_over_sqrt_n():
    sds = []
    for n in (13, 52, 208):
        o = simulate_hedge(*ARGS, 0.2, 0.2, 0.1, n, 20_000)
        assert abs(o["pnl"].mean()) < 4 * o["pnl"].std() / math.sqrt(20_000) + 0.01
        assert o["pnl"].std() == pytest.approx(derman_kamal_sd(*ARGS, 0.2, n), rel=0.1)
        sds.append(o["pnl"].std())
    assert sds[0] / sds[2] == pytest.approx(4.0, rel=0.15)          # 16 x more rebalancing -> 4 x less error


def test_the_drift_does_not_matter():
    means = [simulate_hedge(*ARGS, 0.2, 0.2, mu, 52, 20_000, seed=3)["pnl"].mean() for mu in (-0.3, 0.0, 0.3)]
    assert max(means) - min(means) < 0.05                           # vs a premium of ~4


def test_realised_vs_implied_volatility():
    phi = 1
    locked = bs_value_delta_gamma(100.0, 100.0, 0.25, 0.03, 0.0, 0.2, phi)[0] - bs_value_delta_gamma(100.0, 100.0, 0.25, 0.03, 0.0, 0.15, phi)[0]
    at_implied = simulate_hedge(*ARGS, 0.2, 0.15, 0.05, 252, 20_000)
    at_realised = simulate_hedge(*ARGS, 0.2, 0.15, 0.05, 252, 20_000, hedge_vol=0.15)
    assert at_implied["pnl"].mean() == pytest.approx(at_implied["gamma_theta"].mean(), abs=0.02)
    assert at_realised["pnl"].mean() == pytest.approx(locked, abs=0.02)
    assert at_realised["pnl"].std() < at_implied["pnl"].std()       # hedging at the right vol locks the P&L


def test_backtest_on_synthetic_paths():
    rng = np.random.default_rng(0)
    n = 21 * 40
    closes = 100 * np.exp(np.cumsum(-0.5 * 0.2**2 / 252 + 0.2 / math.sqrt(252) * rng.standard_normal(n)))
    dates = [str(i) for i in range(n)]
    fair = backtest_short_options(closes, dates, np.full(n, 0.2), 0.0, 0.0)
    rich = backtest_short_options(closes, dates, np.full(n, 0.3), 0.0, 0.0)
    assert abs(np.mean([x["pnl_pct"] for x in fair])) < 0.002
    assert np.mean([x["pnl_pct"] for x in rich]) > 0.005
    assert np.corrcoef([x["pnl_pct"] for x in rich], [x["gamma_theta_pct"] for x in rich])[0, 1] > 0.9
