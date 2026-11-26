import math

import numpy as np
import pandas as pd
import pytest
from scipy.interpolate import interp1d
from scipy.stats import norm

from qplat.models.heston import HestonParams, heston_implied_vols
from qplat.pricers.variance import (
    heston_expected_variance, heston_realized_variance_mc, listed_variance, path_realized_variance,
    realized_variance, replicate_variance, value_variance_swap, vix_from_chain, vol_swap_convexity,
)


def test_realized_variance_convention():
    closes = 100 * np.exp(np.cumsum([0.0, 0.01, -0.02, 0.015]))
    expected = 252 * np.mean(np.array([0.01, -0.02, 0.015]) ** 2)      # zero mean, not the sample variance
    assert realized_variance(closes) == pytest.approx(expected)


def test_flat_smile_replicates_sigma_squared():
    rep = replicate_variance(lambda k: np.full_like(k, 0.25), 0.75, 100.0)
    assert rep.variance == pytest.approx(0.0625, rel=1e-5)


def test_replication_of_a_heston_smile_gives_heston_expected_variance():
    # the strongest check: replicating the Heston smile with OTM options recovers E[int v dt] / T in closed form
    p = HestonParams(0.04, 2.0, 0.05, 0.5, -0.7)
    T, S = 0.5, 100.0
    k = np.linspace(-1.5, 1.0, 801)
    v = heston_implied_vols(S, S * np.exp(k), T, 0.0, 0.0, p)
    ok = np.isfinite(v)
    smile = interp1d(k[ok], v[ok], bounds_error=False, fill_value=(v[ok][0], v[ok][-1]))
    rep = replicate_variance(smile, T, S)
    assert rep.variance == pytest.approx(heston_expected_variance(0.04, 2.0, 0.05, T), rel=1e-4)
    # a negative spot-vol correlation puts most of the weight on the puts
    assert rep.put_share > 0.6


def test_heston_vol_swap_convexity():
    rv = heston_realized_variance_mc(0.04, 2.0, 0.05, 0.5, 0.5, n_paths=40_000)
    assert rv.mean() == pytest.approx(heston_expected_variance(0.04, 2.0, 0.05, 0.5), rel=0.01)
    vol_swap = np.sqrt(rv).mean()
    assert vol_swap < math.sqrt(rv.mean())                                  # Jensen: E[sqrt V] < sqrt(E V)
    assert vol_swap_convexity(rv.mean(), rv.var()) == pytest.approx(vol_swap, abs=0.003)


def test_path_realized_variance_under_gbm():
    rng = np.random.default_rng(0)
    T, n, sigma = 1.0, 252, 0.3
    z = rng.standard_normal((20_000, n))
    paths = 100 * np.exp(np.cumsum(-0.5 * sigma**2 * T / n + sigma * math.sqrt(T / n) * z, axis=1))
    rv = path_realized_variance(paths, 100.0, T)
    assert rv.mean() == pytest.approx(sigma**2, rel=0.01)


def bs_chain(S=100.0, T=30 / 365, r=0.04, vol=0.2, strikes=None):
    strikes = np.arange(50, 160.5, 1.0) if strikes is None else strikes
    F = S * math.exp(r * T)
    rows = []
    for K in strikes:
        sq = vol * math.sqrt(T)
        d1 = (math.log(F / K) + 0.5 * sq * sq) / sq
        c = math.exp(-r * T) * (F * norm.cdf(d1) - K * norm.cdf(d1 - sq))
        p = c - math.exp(-r * T) * (F - K)
        for ot, px in (("call", c), ("put", p)):
            rows.append({"strike": K, "option_type": ot, "bid": px, "ask": px, "spot": S})
    return pd.DataFrame(rows)


def test_cboe_formula_on_a_flat_smile():
    T = 30 / 365
    lr = listed_variance(bs_chain(T=T), T, 0.04, 100.0)
    assert math.sqrt(lr.variance) == pytest.approx(0.2, abs=0.002)
    assert lr.forward == pytest.approx(100 * math.exp(0.04 * T), abs=1e-6)
    # truncating the strike strip loses the wings: the variance is underestimated
    narrow = listed_variance(bs_chain(T=T, strikes=np.arange(95, 105.5, 1.0)), T, 0.04, 100.0)
    assert narrow.variance < lr.variance


def test_vix_interpolation_between_two_expiries():
    asof = pd.Timestamp("2026-01-05")
    parts = []
    for days in (23, 37):
        ch = bs_chain(T=days / 365, vol=0.18)
        ch["expiry"] = (asof + pd.Timedelta(days=days)).strftime("%Y-%m-%d")
        parts.append(ch)
    res = vix_from_chain(pd.concat(parts), asof, lambda T: 0.04)
    assert res["vix"] == pytest.approx(18.0, abs=0.2) and (res["near_days"], res["next_days"]) == (23, 37)


def test_variance_swap_value():
    v = value_variance_swap(100_000, 0.2, 0.2, 1.0)
    assert v.value == pytest.approx(0.0) and v.variance_notional == pytest.approx(100_000 / 40)
    # vega notional: +1 vol point of implied ~ + vega notional at the money
    up = value_variance_swap(100_000, 0.2, 0.21, 1.0)
    assert up.value == pytest.approx(100_000 * (21**2 - 400) / 40)
    assert v.vega == pytest.approx(100_000)
    # seasoned: half the life realised at 30%, the rest implied at 20%
    s = value_variance_swap(100_000, 0.2, 0.2, 1.0, elapsed=0.5, realized_vol_so_far=0.3)
    assert s.expected_variance_pts == pytest.approx(0.5 * 900 + 0.5 * 400)
    assert s.vega == pytest.approx(50_000)
    # payoff: convex in realised vol for the variance swap, linear for the vol swap
    prof = v.payoff_profile
    assert prof["variance_swap"][-1] > prof["volatility_swap"][-1]
