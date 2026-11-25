from datetime import date, timedelta

import numpy as np
import pytest

from qplat.curves import FlatCurve
from qplat.instruments import EuropeanOption
from qplat.pricers import BlackScholesPricer
from qplat.risk.portfolio import (
    MarketSnapshot, Position, aggregate, book_value, historical_var, pnl_explain, stress_grid, value_book,
    value_position,
)

TODAY = date(2026, 10, 12)


def snapshot(spot_aapl=100.0, spot_mc=200.0, day=TODAY) -> MarketSnapshot:
    return MarketSnapshot(
        valuation_date=day,
        spots={"AAPL": spot_aapl, "MC.PA": spot_mc},
        vols={"AAPL": lambda T: 0.25, "MC.PA": lambda T: 0.2},
        dividends={"AAPL": 0.0, "MC.PA": 0.02},
        currencies={"AAPL": "USD", "MC.PA": "EUR"},
        curves={"USD": FlatCurve(0.04), "EUR": FlatCurve(0.025)},
        fx_to_base={"EUR": 1.0, "USD": 0.9},
    )


def iso(days: int) -> str:
    return (TODAY + timedelta(days=days)).isoformat()


def test_equity_in_base_currency():
    v = value_position(Position(1, "equity", 10, "AAPL"), snapshot())
    assert v.market_value == pytest.approx(1000) and v.market_value_base == pytest.approx(900)
    assert v.delta == 10 and v.delta_cash_base == pytest.approx(900)


def test_option_position_matches_black_scholes():
    p = Position(2, "option", 5, "MC.PA", {"strike": 210, "expiry": iso(365), "option_type": "call",
                                           "exercise": "european", "multiplier": 10})
    v = value_position(p, snapshot())
    opt = EuropeanOption(spot=200, strike=210, expiry=1.0, vol=0.2, rate=0.025, dividend_yield=0.02)
    g = BlackScholesPricer().greeks(opt)
    assert v.unit_price == pytest.approx(g.price)
    assert v.market_value_base == pytest.approx(50 * g.price)
    assert v.delta == pytest.approx(50 * g.delta)
    assert v.vega_base == pytest.approx(50 * g.vega / 100)
    assert v.gamma_cash_base == pytest.approx(0.5 * g.gamma * 2.0**2 * 50)


def test_bond_rho_negative_and_future_zero_value():
    m = snapshot()
    b = value_position(Position(3, "bond", 10, None, {"currency": "EUR", "maturity": iso(3650), "coupon_rate": 0.03,
                                                      "frequency": 1}), m)
    assert b.dv01_base > 0 and b.rho_base < 0
    f = value_position(Position(4, "future", -2, "AAPL", {"expiry": iso(90), "multiplier": 50}, entry_price=None), m)
    assert f.market_value_base == pytest.approx(0.0) and f.delta < 0


def test_stress_grid_linear_book():
    m = snapshot()
    book = [Position(1, "equity", 10, "AAPL"), Position(2, "equity", 5, "MC.PA")]
    st = stress_grid(book, m)
    i0 = st["spot_shocks"].index(0.0)
    i_down = st["spot_shocks"].index(-0.10)
    assert st["pnl"][1][i0] == pytest.approx(0.0)
    assert st["pnl"][1][i_down] == pytest.approx(-0.10 * book_value(book, m))
    assert all(r["pnl"] == pytest.approx(0.0) for r in st["rate_shocks"])  # equities have no rate risk


def test_short_option_book_loses_on_vol_up():
    book = [Position(1, "option", -10, "AAPL", {"strike": 100, "expiry": iso(180), "option_type": "put", "exercise": "european"})]
    st = stress_grid(book, snapshot())
    i0 = st["spot_shocks"].index(0.0)
    assert st["pnl"][st["vol_shocks"].index(0.10)][i0] < 0


def test_historical_var_linear_book():
    m = snapshot()
    book = [Position(1, "equity", 10, "AAPL")]
    vals = value_book(book, m)
    rng = np.random.default_rng(0)
    rets = rng.normal(0, 0.02, 500)
    var = historical_var(vals, {"AAPL": rets}, m.spots)
    expected = -np.quantile(np.expm1(rets) * 900, 0.01)
    assert var["var_99"] == pytest.approx(expected, rel=1e-9)
    assert var["es_99"] >= var["var_99"]
    assert var["parametric_var_99"] == pytest.approx(2.3263 * np.std(np.expm1(rets), ddof=1) * 900, rel=1e-6)


def test_pnl_explain_delta_gamma():
    book = [Position(1, "equity", 10, "AAPL"),
            Position(2, "option", 10, "AAPL", {"strike": 100, "expiry": iso(120), "option_type": "call", "exercise": "european"})]
    prev = snapshot(100.0, day=TODAY)
    now = snapshot(101.0, day=TODAY)  # same day: isolate the spot move
    ex = pnl_explain(book, prev, now)
    eq = ex["rows"][0]
    assert eq["residual"] == pytest.approx(0.0, abs=1e-9)
    opt = ex["rows"][1]
    # delta + gamma explains a 1% move up to third-order terms
    assert abs(opt["residual"]) < 0.02 * abs(opt["actual"])


def test_aggregate_by_underlying():
    vals = value_book([Position(1, "equity", 10, "AAPL"), Position(2, "equity", 1, "AAPL"), Position(3, "equity", 1, "MC.PA")], snapshot())
    groups = {g["key"]: g for g in aggregate(vals, lambda v: v.position.ticker)}
    assert groups["AAPL"]["n"] == 2 and groups["AAPL"]["delta_cash"] == pytest.approx(11 * 90)
