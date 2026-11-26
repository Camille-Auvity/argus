import numpy as np
import pandas as pd
import pytest

from qplat.research.vol_managed import Panels, analyse, manage, monthly_panel, ols_hac, volatility_buckets


def daily_frame(n_months=240, seed=0, regimes=True, mu=0.0004):
    """Daily factor with persistent volatility regimes and a CONSTANT mean (pure risk timing)."""
    rng = np.random.default_rng(seed)
    dates = pd.bdate_range("1990-01-01", periods=n_months * 21)
    vol = np.ones(len(dates)) * 0.01
    if regimes:
        state = 0
        for i in range(len(dates)):
            if i % 21 == 0 and rng.random() < 0.15:
                state = 1 - state
            vol[i] = 0.025 if state else 0.007
    r = mu + vol * rng.standard_normal(len(dates))
    return pd.DataFrame({"mkt_rf": r, "smb": rng.normal(0, 0.005, len(dates)), "hml": rng.normal(0, 0.005, len(dates))},
                        index=dates.strftime("%Y-%m-%d"))


def test_monthly_panel():
    d = pd.DataFrame({"mkt_rf": [0.01, -0.02, 0.03] * 5}, index=pd.bdate_range("2020-01-01", periods=15).strftime("%Y-%m-%d"))
    p = monthly_panel(d, "mkt_rf")
    x = d["mkt_rf"].to_numpy()
    assert p["ret"].iloc[0] == pytest.approx(np.prod(1 + x) - 1)
    assert p["rv"].iloc[0] == pytest.approx(((x - x.mean()) ** 2).sum())


def test_ols_hac_recovers_coefficients():
    rng = np.random.default_rng(1)
    x = rng.standard_normal(500)
    y = 0.3 + 2.0 * x + 0.1 * rng.standard_normal(500)
    reg = ols_hac(y, np.column_stack([np.ones(500), x]), lags=3)
    assert reg["coef"] == pytest.approx([0.3, 2.0], abs=0.02)
    assert reg["t"][1] > 100 and 0.99 < reg["r2"] <= 1


def test_same_volatility_by_construction_and_constant_rv():
    panel = monthly_panel(daily_frame(), "mkt_rf")
    df, c = manage(panel, "full")
    assert df["managed"].std(ddof=1) == pytest.approx(df["ret"].std(ddof=1), rel=1e-12)
    # with a constant realised variance the managed portfolio IS the factor: alpha 0, beta 1
    flat = panel.assign(rv=0.002)
    df2, _ = manage(flat, "full")
    assert np.allclose(df2["managed"], df2["ret"]) and np.allclose(df2["w"], 1.0)


def test_risk_timing_creates_alpha():
    r = analyse(daily_frame(n_months=360, seed=2), "mkt_rf")
    assert r.stats["alpha"] > 0 and r.stats["alpha_t"] > 2
    assert r.stats["sharpe_managed"] > r.stats["sharpe_original"]
    # without volatility regimes there is nothing to time
    flat = analyse(daily_frame(n_months=360, seed=2, regimes=False), "mkt_rf")
    assert abs(flat.stats["alpha_t"]) < 2.5
    # the volatility-sorted buckets: next-month variance rises, mean / variance falls
    b = volatility_buckets(daily_frame(n_months=360, seed=2), "mkt_rf", n=3)
    assert b[-1]["vol"] > b[0]["vol"] and b[-1]["mean_over_var"] < b[0]["mean_over_var"]


def test_realtime_version_has_no_look_ahead():
    d = daily_frame(n_months=300, seed=3)
    panel = monthly_panel(d, "mkt_rf")
    w1 = manage(panel, "realtime", min_history=60)[0]["w"]
    changed = panel.copy()
    changed.iloc[-12:, changed.columns.get_loc("ret")] *= 5          # rewrite the last year
    w2 = manage(changed, "realtime", min_history=60)[0]["w"]
    common = w1.index[:-13]
    assert np.allclose(w1.loc[common], w2.loc[common])


def test_cap_and_costs():
    P = Panels(daily_frame(seed=4))
    capped = analyse(P, "mkt_rf", leverage_cap=1.2)
    assert capped.weights.max() <= 1.2 + 1e-12
    free = analyse(P, "mkt_rf")
    costly = analyse(P, "mkt_rf", cost_bp=50)
    assert costly.stats["mean_managed"] < free.stats["mean_managed"]
    assert free.stats["alpha_ff3"] is not None          # controls: the two other factors of the frame
