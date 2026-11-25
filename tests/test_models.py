import numpy as np
import pytest

from qplat.curves import FlatCurve
from qplat.instruments import Autocallable, BarrierOption, EuropeanOption
from qplat.models.heston import (
    HestonParams, HestonPathModel, HestonPricer, calibrate_heston, heston_call_prices, heston_implied_vols,
    heston_prices,
)
from qplat.models.svi import LocalVolPathModel, SviSlice, VolSurface, durrleman_g, fit_svi_slice
from qplat.pricers import MonteCarloAutocallPricer, MonteCarloBarrierPricer
from qplat.pricers.black_scholes import bs_price

P = HestonParams(v0=0.04, kappa=1.5, theta=0.04, sigma=0.5, rho=-0.7)


def test_heston_tends_to_black_scholes_without_vol_of_vol():
    p = HestonParams(0.04, 2.0, 0.04, 1e-3, 0.0)
    k = np.array([80.0, 100.0, 120.0])
    assert heston_call_prices(100, k, 1.0, 0.03, 0.01, p) == pytest.approx(bs_price(100, k, 1.0, 0.03, 0.01, 0.2, 1), abs=1e-5)


def test_heston_put_call_parity_and_bounds():
    k = np.array([70.0, 100.0, 140.0])
    c = heston_prices(100, k, 0.7, 0.03, 0.02, P, ["call"] * 3)
    p = heston_prices(100, k, 0.7, 0.03, 0.02, P, ["put"] * 3)
    assert c - p == pytest.approx(100 * np.exp(-0.02 * 0.7) - k * np.exp(-0.03 * 0.7))
    assert np.all(c >= np.maximum(100 * np.exp(-0.014) - k * np.exp(-0.021), 0) - 1e-12)


def test_heston_lewis_matches_monte_carlo():
    paths = HestonPathModel(P, steps_per_year=200).simulate(100, 0.0, FlatCurve(0.03), np.array([1.0]), 200_000, 1)
    st = paths[:, 0]
    for k in (90.0, 100.0, 110.0):
        mc = np.exp(-0.03) * np.maximum(st - k, 0)
        se = mc.std() / np.sqrt(len(mc))
        assert abs(mc.mean() - heston_call_prices(100, [k], 1.0, 0.03, 0.0, P)[0]) < 4 * se + 0.02  # + Euler bias


def test_negative_correlation_gives_downside_skew():
    iv = heston_implied_vols(100, [80, 100, 120], 0.5, 0.03, 0.0, P)
    assert iv[0] > iv[1] > iv[2]


def test_calibration_recovers_parameters():
    true = HestonParams(0.03, 2.5, 0.05, 0.7, -0.75)
    strikes, ts, types, ivs = [], [], [], []
    for t in (0.1, 0.25, 0.5, 1.0, 1.5):
        ks = 100 * np.exp(np.linspace(-0.3, 0.2, 12) * np.sqrt(t) * 1.5)
        strikes += list(ks)
        ts += [t] * len(ks)
        types += ["put" if k < 100 else "call" for k in ks]
        ivs += list(heston_implied_vols(100, ks, t, 0.03, 0.01, true))
    res = calibrate_heston(100, strikes, ts, types, ivs, [0.03] * len(strikes), 0.01)
    assert res.params.as_array() == pytest.approx(true.as_array(), rel=1e-3)
    assert res.rmse_vol < 1e-6


def test_heston_pricer_greeks():
    opt = EuropeanOption(spot=100, strike=100, expiry=1.0, vol=0.2, rate=0.03)
    g = HestonPricer(P).greeks(opt)
    assert 0.4 < g.delta < 0.8 and g.gamma > 0 and g.vega > 0


# ----------------------------------------------------------------------------- SVI / local vol

def test_svi_fit_recovers_slice():
    true = SviSlice(0.5, 0.01, 0.1, -0.6, 0.02, 0.15)
    k = np.linspace(-0.4, 0.3, 25)
    fit = fit_svi_slice(k, true.implied_vol(k), 0.5)
    assert fit.implied_vol(k) == pytest.approx(true.implied_vol(k), abs=1e-5)


def test_durrleman_flat_smile():
    k = np.linspace(-0.5, 0.5, 11)
    w = np.full_like(k, 0.04)
    assert durrleman_g(w, 0 * k, 0 * k, k) == pytest.approx(np.ones_like(k))


def _flat_surface(vol=0.2):
    # b -> 0 gives w(k) = a: a flat smile of total variance vol^2 T
    slices = [SviSlice(t, vol**2 * t, 1e-8, 0.0, 0.0, 0.1) for t in (0.25, 0.5, 1.0, 2.0)]
    return VolSurface(slices, 100.0, 0.01, FlatCurve(0.03))


def test_local_vol_of_flat_surface_is_flat():
    s = _flat_surface(0.2)
    assert s.local_vol(np.array([-0.2, 0.0, 0.2]), 0.7) == pytest.approx([0.2, 0.2, 0.2], abs=1e-4)
    assert all(b["ok"] for b in s.arbitrage_report()["butterfly"])


def test_calendar_arbitrage_detected():
    s = VolSurface([SviSlice(0.5, 0.04, 0.05, 0, 0, 0.1), SviSlice(1.0, 0.02, 0.05, 0, 0, 0.1)], 100, 0, FlatCurve(0.0))
    assert not s.arbitrage_report()["calendar"][0]["ok"]
    assert np.all(np.isnan(s.local_vol(np.array([0.0]), 0.75)))


def test_local_vol_mc_reprices_vanilla():
    s = _flat_surface(0.25)
    st = LocalVolPathModel(s, 100).simulate(100, 0.01, FlatCurve(0.03), np.array([1.0]), 100_000, 5)[:, 0]
    mc = np.exp(-0.03) * np.maximum(st - 100, 0).mean()
    assert mc == pytest.approx(bs_price(100, 100, 1.0, 0.03, 0.01, 0.25, 1), rel=0.01)


def test_exotic_pricers_accept_models():
    curve = FlatCurve(0.03)
    b = BarrierOption(spot=100, strike=100, expiry=1.0, barrier=80, barrier_type="down-and-out", vol=0.2, rate=curve,
                      monitoring_per_year=252)
    gbm = MonteCarloBarrierPricer(n_paths=20_000).price(b)
    lv = MonteCarloBarrierPricer(n_paths=20_000, model=LocalVolPathModel(_flat_surface(0.2))).price(b)
    assert lv == pytest.approx(gbm, rel=0.03)  # flat local vol == Black-Scholes
    a = Autocallable.regular(2, 4, spot=100, vol=0.2, rate=curve)
    assert 80 < MonteCarloAutocallPricer(n_paths=10_000, model=HestonPathModel(P, 52)).price(a) < 110


def test_models_api_on_synthetic_chain(tmp_path):
    """Heston-generated option chain -> the three /api/models endpoints answer with valid JSON."""
    import json

    from fastapi.testclient import TestClient

    from api import services
    from api.main import app
    from api.routers import models as models_router
    from qplat.data.db import Database, utc_now

    db = Database(tmp_path / "m.db")
    db.upsert_ticker(ticker="SYN", name="Synthetic", sector="Test", dividend_yield=0.01, currency="USD")
    db.upsert_spots([{"ticker": "SYN", "date": "2026-10-09", "close": 100.0}])
    db.upsert_rates([{"asof": "2026-10-08", "tenor_years": t, "rate": 0.04, "source": "FRED"} for t in (0.25, 1, 2, 5, 10)])
    true = HestonParams(0.03, 2.0, 0.05, 0.6, -0.7)
    asof = utc_now()
    rows = []
    from datetime import date, timedelta
    for days in (30, 60, 120, 240, 400):
        expiry = (date.today() + timedelta(days=days)).isoformat()
        t = days / 365
        for k in np.linspace(75, 125, 21):
            ot = "put" if k < 100 else "call"
            price = float(heston_prices(100, [k], t, 0.04, 0.01, true, [ot])[0])
            rows.append({"asof": asof, "ticker": "SYN", "expiry": expiry, "strike": float(k), "option_type": ot,
                         "bid": price * 0.995, "ask": price * 1.005, "last": price, "volume": 1.0,
                         "open_interest": 1.0, "vendor_iv": None, "spot": 100.0})
    db.upsert_options(rows)
    original = services.get_db
    services.get_db = lambda: db
    for f in (models_router._market, models_router._heston, models_router._surface, models_router._exotics):
        f.cache_clear()
    try:
        client = TestClient(app)
        h = client.get("/api/models/SYN/heston")
        assert h.status_code == 200, h.text
        assert h.json()["params"]["rho"] == pytest.approx(-0.7, abs=0.1)
        s = client.get("/api/models/SYN/surface")
        assert s.status_code == 200, s.text
        json.loads(s.text)  # strict JSON (no NaN)
        e = client.post("/api/models/SYN/exotics", json={"n_paths": 5000})
        assert e.status_code == 200, e.text
        assert len(e.json()["autocall"]["rows"]) == 3
    finally:
        services.get_db = original
        for f in (models_router._market, models_router._heston, models_router._surface, models_router._exotics):
            f.cache_clear()
