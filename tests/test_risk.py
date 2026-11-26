import math
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


# ----------------------------------------------------------------------------- digital / Asian / cliquet positions

def history_snapshot(closes: dict[date, float], **kw) -> MarketSnapshot:
    """AAPL history: last close on or before the requested date."""
    def lookup(ticker, d):
        known = [c for day, c in sorted(closes.items()) if day <= d]
        return known[-1] if ticker == "AAPL" and known else None
    m = snapshot(**kw)
    m.past_close = lookup
    return m


def test_digital_position_matches_closed_form():
    from qplat.instruments import DigitalOption
    from qplat.pricers import AnalyticDigitalPricer

    p = Position(10, "digital", 20, "AAPL", {"strike": 105, "expiry": iso(365), "option_type": "call", "cash": 100})
    v = value_position(p, snapshot())
    g = AnalyticDigitalPricer().greeks(DigitalOption(spot=100, strike=105, expiry=1.0, vol=0.25, rate=0.04, cash=100))
    assert v.unit_price == pytest.approx(g.price)
    assert v.market_value_base == pytest.approx(20 * g.price * 0.9)
    assert v.delta == pytest.approx(20 * g.delta)


def test_new_asian_position_has_no_past_fixing():
    from qplat.instruments import AsianOption
    from qplat.pricers import GeometricAsianPricer

    q = {"strike": 100, "start_date": TODAY.isoformat(), "expiry": iso(365), "n_fixings": 4, "option_type": "call",
         "averaging": "geometric"}
    v = value_position(Position(11, "asian", 1, "AAPL", q), snapshot())
    times = tuple(round(365 * (i + 1) / 4) / 365 for i in range(4))
    expected = GeometricAsianPricer().price(AsianOption(spot=100, vol=0.25, rate=0.04, strike=100, fixing_times=times,
                                                        averaging="geometric"))
    assert v.unit_price == pytest.approx(expected, rel=1e-10)


def test_seasoned_asian_uses_past_closes():
    start = TODAY - timedelta(days=200)
    q = {"strike": 100, "start_date": start.isoformat(), "expiry": (start + timedelta(days=400)).isoformat(),
         "n_fixings": 4, "option_type": "call", "averaging": "arithmetic"}
    hi = value_position(Position(12, "asian", 1, "AAPL", q), history_snapshot({start: 150.0}), mc_paths=20_000)
    lo = value_position(Position(12, "asian", 1, "AAPL", q), history_snapshot({start: 60.0}), mc_paths=20_000)
    assert hi.unit_price > lo.unit_price + 10   # two fixings already observed at 150 vs 60
    # once every fixing is known, the value is the payoff and the risk is gone
    done = {**q, "start_date": (TODAY - timedelta(days=500)).isoformat(), "expiry": iso(-100)}
    v = value_position(Position(13, "asian", 1, "AAPL", done), history_snapshot({TODAY - timedelta(days=600): 130.0}))
    assert v.unit_price == pytest.approx(30.0) and v.delta == 0


def test_cliquet_position_accrues_completed_periods():
    # no global floor: the payoff is linear in the accrued sum, so the gap is exactly 5 points discounted
    q = {"start_date": (TODAY - timedelta(days=200)).isoformat(), "maturity_years": 2, "frequency": 4,
         "local_floor": -0.05, "local_cap": 0.05, "global_floor": None, "initial_level": 100.0}
    up = value_position(Position(14, "cliquet", 1, "AAPL", q),
                        history_snapshot({TODAY - timedelta(days=200): 110.0}, spot_aapl=110.0))
    flat = value_position(Position(14, "cliquet", 1, "AAPL", q), history_snapshot({TODAY - timedelta(days=200): 100.0}))
    # two resets passed: +10% (capped at 5%) then 0% -> +5 points accrued vs 0, same running period
    assert up.unit_price - flat.unit_price == pytest.approx(5 * math.exp(-0.04 * (730 - 200) / 365), abs=1e-6)
    # running period started at a frozen level: the cliquet now has a delta
    assert abs(up.delta) > 1e-4


def test_new_cliquet_is_struck_at_inception():
    q = {"start_date": TODAY.isoformat(), "maturity_years": 1, "frequency": 4, "local_floor": -0.05,
         "local_cap": 0.05, "global_floor": None, "initial_level": 100.0}
    v = value_position(Position(15, "cliquet", 1, "AAPL", q), snapshot(), mc_paths=50_000)
    assert v.error is None and v.unit_price > 0


# ----------------------------------------------------------------------------- CDS positions

CDS_PARAMS = {"reference": "Test", "currency": "EUR", "maturity": iso(5 * 365), "coupon_bp": 100, "recovery": 0.4,
              "spreads_bp": [40, 55, 70, 95, 110, 120]}


def test_cds_position_matches_credit_engine():
    from qplat.credit import CDS, cds_risk

    m = snapshot()
    v = value_position(Position(20, "cds", 1e7, None, CDS_PARAMS), m)
    r, _ = cds_risk(CDS(maturity=5.0, coupon=0.01, recovery=0.4), [1, 2, 3, 5, 7, 10],
                    np.array(CDS_PARAMS["spreads_bp"]) * 1e-4, m.curves["EUR"])
    assert v.unit_price == pytest.approx(r.value)
    assert v.market_value_base == pytest.approx(1e7 * r.value)          # EUR position: no FX
    assert v.cs01_base == pytest.approx(1e7 * r.cs01) and v.cs01_base > 0
    assert v.jtd_base == pytest.approx(1e7 * (0.6 - r.value))
    assert v.delta == 0 and v.vega_base == 0


def test_cds_seller_mirrors_buyer_and_spread_stress():
    m = snapshot()
    buy = value_position(Position(21, "cds", 1e7, None, CDS_PARAMS), m)
    sell = value_position(Position(22, "cds", -1e7, None, CDS_PARAMS), m)
    assert sell.market_value_base == pytest.approx(-buy.market_value_base)
    assert sell.cs01_base == pytest.approx(-buy.cs01_base) and sell.jtd_base < 0
    grid = stress_grid([Position(21, "cds", 1e7, None, CDS_PARAMS)], m)
    up = next(s for s in grid["spread_shocks"] if s["shift"] == 0.01)
    # +100 bp: the protection buyer gains roughly 100 x CS01 (a bit less: convexity of the risky annuity)
    assert 80 * buy.cs01_base < up["pnl"] < 100 * buy.cs01_base
    assert all(row == [0.0] * len(row) for row in grid["pnl"])          # no equity / vol exposure


# ----------------------------------------------------------------------------- caps / floors and FX options

def test_new_cap_position_matches_pricer():
    from qplat.pricers.capfloor import CapFloor, price_capfloor

    # quarterly schedule built on dates: ~ the 5y quarterly cap of the pricer
    q = {"currency": "EUR", "cf_kind": "cap", "start_date": TODAY.isoformat(), "maturity": iso(5 * 365), "frequency": 4,
         "strike": 0.025, "model": "bachelier", "vol": 0.008}
    v = value_position(Position(30, "capfloor", 1e7, None, q), snapshot())
    ref = price_capfloor(CapFloor(maturity=5, strike=0.025, notional=1e7), FlatCurve(0.025), 0.008, "bachelier").price
    assert v.market_value_base == pytest.approx(ref, rel=2e-3)
    assert v.dv01_base < 0 and v.rho_base > 0 and v.vega_base > 0      # a cap gains when rates rise
    floor = value_position(Position(31, "capfloor", 1e7, None, {**q, "cf_kind": "floor"}), snapshot())
    assert floor.dv01_base > 0


def test_seasoned_cap_values_the_running_period_at_intrinsic():
    q = {"currency": "EUR", "cf_kind": "cap", "start_date": iso(-200), "maturity": iso(365), "frequency": 4,
         "strike": 0.0, "model": "bachelier", "vol": 1e-6}
    from qplat.risk.portfolio import capfloor_schedule

    v = value_position(Position(32, "capfloor", 1.0, None, q), snapshot())
    starts, ends = capfloor_schedule(q, TODAY)
    running = (starts <= 0) & (ends > 0)
    assert running.sum() == 1
    # zero strike, no vol: future caplets telescope to P(e0) - P(T); the running one pays its full accrual
    # at today's rate to its payment date (fixings are not stored)
    P = lambda t: math.exp(-0.025 * t)  # noqa: E731
    s0, e0 = float(starts[running][0]), float(ends[running][0])
    expected = (e0 - s0) * P(e0) * (1 / P(e0) - 1) / e0 + P(e0) - P(float(ends[-1]))
    assert v.unit_price == pytest.approx(expected, rel=1e-9)


def fx_snapshot(spot=1.10):
    m = snapshot()
    m.spots["EURUSD=X"] = spot
    m.currencies["EURUSD=X"] = "USD"
    m.vols["EURUSD=X"] = lambda T: 0.07
    return m


def test_fx_option_position():
    from qplat.fx import FXMarket, build_smile, gk_greeks

    q = {"expiry": iso(182), "strike": 1.13, "option_type": "call", "atm": 0.07, "rr25": 0.004, "bf25": 0.003}
    m = fx_snapshot()
    v = value_position(Position(40, "fxoption", 5e6, "EURUSD=X", q), m)
    T = 182 / 365
    smile = build_smile(FXMarket(1.10, T, 0.04, 0.025), 0.07, 0.004, 0.003)
    g = gk_greeks(1.10, 1.13, T, 0.04, 0.025, smile.vol(1.13), 1)
    assert v.unit_price == pytest.approx(g.price)
    assert v.market_value_base == pytest.approx(5e6 * g.price * 0.9)         # USD premium converted to EUR
    assert v.delta == pytest.approx(5e6 * g.delta_spot)
    # a vol shock moves the quoted smile
    up = value_position(Position(40, "fxoption", 5e6, "EURUSD=X", q), m.shocked(vol_shift=0.01))
    assert up.market_value_base - v.market_value_base == pytest.approx(v.vega_base, rel=0.05)


# ----------------------------------------------------------------------------- variance swaps

def varswap_snapshot(closes_by_date: dict | None = None, fair_vol=0.2):
    m = snapshot()
    m.fair_variance = {"AAPL": lambda T: fair_vol**2}
    if closes_by_date is not None:
        days = sorted(closes_by_date)

        def price_range(ticker, a, b):
            return np.array([closes_by_date[d] for d in days if a <= d <= b])
        m.price_range = price_range
    return m


def test_new_variance_swap_at_fair_strike():
    q = {"start_date": TODAY.isoformat(), "maturity": iso(365), "strike_vol": 0.2}
    v = value_position(Position(50, "varswap", 100_000, "AAPL", q), varswap_snapshot())
    assert v.unit_price == pytest.approx(0.0, abs=1e-12)
    # at inception and at the money, the vega equals the vega notional (discounted), the delta is zero
    assert v.vega_base == pytest.approx(100_000 * 0.9 * math.exp(-0.04), rel=1e-9)
    assert v.delta == 0
    # gamma: a 1% move adds 1e4 x 0.01^2 / T variance points, times N_var = N_vega / (2 K)
    assert v.gamma_cash_base == pytest.approx(0.9 * math.exp(-0.04) * 100_000 / 40 * 1.0, rel=1e-9)
    # a day without move loses the implied variance of that day (theta)
    assert v.theta_base < 0
    short = value_position(Position(51, "varswap", -100_000, "AAPL", q), varswap_snapshot())
    assert short.theta_base == pytest.approx(-v.theta_base)


def test_seasoned_variance_swap_uses_realised_variance():
    start = TODAY - timedelta(days=91)
    q = {"start_date": start.isoformat(), "maturity": (start + timedelta(days=365)).isoformat(), "strike_vol": 0.2}
    # daily moves of +-2% for three months: ~31.7% realised vol, well above the 20% strike
    rng = np.random.default_rng(1)
    closes, level = {}, 100.0
    for i in range(92):
        closes[start + timedelta(days=i)] = level
        level *= math.exp(0.02 * rng.choice([-1, 1]))
    m = varswap_snapshot(closes)
    v = value_position(Position(52, "varswap", 1.0, "AAPL", q), m)
    rv = 252 * 0.02**2                                       # every log return is +-2%
    w = 91 / 365
    exp_var = w * 1e4 * rv + (1 - w) * 400
    df = math.exp(-0.04 * (365 - 91) / 365)
    assert v.unit_price == pytest.approx(df * (exp_var - 400) / 40, rel=1e-3)
    # a vol shock only moves the implied remainder
    up = value_position(Position(52, "varswap", 1.0, "AAPL", q), m.shocked(vol_shift=0.01))
    assert up.unit_price - v.unit_price == pytest.approx(df * (1 - w) * (21**2 - 400) / 40, rel=1e-6)
