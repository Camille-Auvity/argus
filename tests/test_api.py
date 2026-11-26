"""API tests against a temporary database seeded with synthetic data (no network)."""

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from api import services
from api.main import app
from qplat.data.db import Database, utc_now


@pytest.fixture(scope="module")
def client(tmp_path_factory):
    db = Database(tmp_path_factory.mktemp("api") / "api.db")
    dates = pd.bdate_range("2025-01-01", periods=300)
    closes = 100 * np.exp(np.cumsum(np.random.default_rng(0).normal(0, 0.01, len(dates))))
    db.upsert_spots([{"ticker": "AAPL", "date": d.strftime("%Y-%m-%d"), "close": float(c)}
                     for d, c in zip(dates, closes)])
    db.upsert_ticker(ticker="AAPL", name="Apple", sector="Technology", dividend_yield=0.005, currency="USD")
    db.upsert_rates([{"asof": "2026-10-08", "tenor_years": t, "rate": r, "source": "FRED"}
                     for t, r in [(0.25, 0.042), (1, 0.044), (2, 0.047), (10, 0.052), (30, 0.056)]])
    db.upsert_rates([{"asof": "2026-10-08", "tenor_years": t, "rate": r, "source": "ECB", "currency": "EUR",
                      "quote_type": "zero"} for t, r in [(0.25, 0.025), (1, 0.026), (10, 0.032), (30, 0.038)]])
    asof = utc_now()
    db.upsert_options([{"asof": asof, "ticker": "AAPL", "expiry": "2027-01-15", "strike": k, "option_type": ot,
                        "bid": b, "ask": b + 0.2, "last": b, "volume": 1.0, "open_interest": 1.0,
                        "vendor_iv": 0.25, "spot": float(closes[-1])}
                       for k, ot, b in [(90, "put", 2.0), (95, "put", 3.0), (105, "call", 4.0), (110, "call", 2.5)]])
    db.insert_news([{"id": "n1", "ticker": "AAPL", "published": utc_now(), "title": "t", "publisher": "p",
                     "url": "u", "summary": "", "source": "s", "fetched_at": utc_now()}])
    db.upsert_sentiment([{"news_id": "n1", "model": "m", "score": 0.5, "label": "positive", "rationale": "r",
                          "scored_at": utc_now()}])
    services.get_db.cache_clear()
    original = services.get_db
    services.get_db = lambda: db
    try:
        yield TestClient(app)
    finally:
        services.get_db = original


VANILLA = {"spot": 42, "strike": 40, "expiry": 0.5, "vol": 0.2, "rate": {"mode": "flat", "flat_rate": 0.1},
           "mc_paths": 20000, "tree_steps": 200}


def test_vanilla_three_methods(client):
    r = client.post("/api/price/vanilla", json=VANILLA)
    assert r.status_code == 200
    res = {m["method"]: m for m in r.json()["results"]}
    assert res["Black-Scholes"]["greeks"]["price"] == pytest.approx(4.7594, abs=1e-4)
    assert res["Monte Carlo"]["std_error"] > 0


def test_american_skips_black_scholes(client):
    r = client.post("/api/price/vanilla", json={**VANILLA, "exercise": "american", "option_type": "put"})
    assert [m["method"] for m in r.json()["results"]] == ["Binomial (CRR)", "Monte Carlo"]


def test_vanilla_profile(client):
    r = client.post("/api/price/vanilla/profile", json=VANILLA).json()
    assert len(r["spots"]) == len(r["series"]["delta"]) == 49


def test_validation_error(client):
    assert client.post("/api/price/vanilla", json={**VANILLA, "expiry": -1}).status_code == 422


def test_curves_and_bonds(client):
    usd = client.get("/api/curves/USD").json()
    assert usd["quote_type"] == "par" and set(usd["curves"]) == {"linear_zero", "loglinear_df"}
    eur = client.get("/api/curves/EUR").json()
    assert eur["curves"]["loglinear_df"]["zero"][0] == pytest.approx(0.025, abs=1e-3)
    assert client.get("/api/curves/JPY").status_code == 404
    bond = client.post("/api/bonds/analytics", json={"currency": "USD", "maturity": 10, "coupon_rate": 0.052,
                                                      "frequency": 2}).json()
    assert bond["dirty_price"] == pytest.approx(100, abs=1e-6)


def test_curve_pricing_uses_stored_curve(client):
    r = client.post("/api/price/vanilla", json={**VANILLA, "rate": {"mode": "curve", "currency": "EUR"}})
    assert r.status_code == 200


def test_barrier_and_autocall(client):
    b = client.post("/api/price/barrier", json={"spot": 100, "strike": 100, "expiry": 0.5, "vol": 0.25,
                                                "barrier": 95, "barrier_type": "down-and-out",
                                                "rate": {"mode": "flat", "flat_rate": 0.08},
                                                "dividend_yield": 0.04, "mc_paths": 10000}).json()
    assert b["results"][0]["greeks"]["price"] == pytest.approx(4.5126, abs=1e-3)
    a = client.post("/api/price/autocall", json={"spot": 100, "vol": 0.2, "maturity": 2, "mc_paths": 5000,
                                                 "with_greeks": False}).json()
    assert sum(a["redemption_probabilities"]) == pytest.approx(1.0)


FLAT = {"spot": 100, "vol": 0.25, "dividend_yield": 0.01, "rate": {"mode": "flat", "flat_rate": 0.03}}


def test_digital_asian_cliquet(client):
    d = client.post("/api/price/digital", json={**FLAT, "strike": 100, "expiry": 1, "mc_paths": 20000}).json()
    assert [r["method"] for r in d["results"]] == ["Closed form (BS)", "Monte Carlo"]
    assert d["call_spread"][-1]["price"] == pytest.approx(d["results"][0]["greeks"]["price"], rel=1e-3)
    assert set(d["profile"]["series"]) == {"price", "delta", "gamma", "vega"}
    a = client.post("/api/price/asian", json={**FLAT, "strike": 100, "expiry": 1, "mc_paths": 20000}).json()
    assert [r["method"] for r in a["results"]] == ["Lévy approximation", "Monte Carlo", "MC + control variate"]
    assert a["variance_reduction"] > 50 and a["convergence"][-1]["n_paths"] == 20000
    c = client.post("/api/price/cliquet", json={**FLAT, "mc_paths": 20000}).json()
    mc = c["results"][0]["greeks"]
    assert mc["delta"] == pytest.approx(0.0, abs=1e-9) and mc["vega"] < 0
    assert sum(c["histogram"]["counts"]) == 20000 and len(c["vol_profile"]["spots"]) == 12


def test_market_endpoints(client):
    tickers = client.get("/api/tickers").json()
    aapl = next(t for t in tickers if t["ticker"] == "AAPL")
    assert aapl["sentiment"] == pytest.approx(0.5) and len(aapl["sparkline"]) == 60
    assert len(client.get("/api/tickers/AAPL/history?days=100").json()["close"]) == 100
    smile = client.get("/api/vol/AAPL/smile").json()
    assert smile["expiries"] and all(0 < p["iv"] < 2 for p in smile["expiries"][0]["points"])
    assert client.get("/api/vol/MC.PA/smile").status_code == 404
    summary = client.get("/api/sentiment/summary").json()
    assert summary["by_sector"][0]["sector"] == "Technology"
    assert client.get("/api/status").json()["markets"]["EU"]["currency"] == "EUR"


def test_explain_endpoints(client):
    am = {**VANILLA, "spot": 36, "exercise": "american", "option_type": "put", "rate": {"mode": "flat", "flat_rate": 0.06}}
    bs = client.post("/api/explain/black-scholes", json=VANILLA).json()
    assert bs["price"] == pytest.approx(4.7594, abs=1e-4) and len(bs["density"]["s"]) == 240
    tree = client.post("/api/explain/tree", json={**am, "display_steps": 4}).json()
    assert len(tree["nodes"]) == 15 and tree["boundary"]["t"]
    root = next(n for n in tree["nodes"] if n["i"] == 0)
    assert root["value"] == pytest.approx(tree["price_display"])
    mc = client.post("/api/explain/monte-carlo", json=VANILLA).json()
    assert abs(mc["price"] - mc["reference"]) < 4 * mc["std_error"]
    assert mc["antithetic"]["variance_reduction"] > 1
    lsm = client.post("/api/explain/lsm", json={**am, "lsm_steps": 20}).json()
    assert lsm["price"] > lsm["european_price"] and lsm["regression"]["points"]["s"]
    g = client.post("/api/explain/greeks", json={**VANILLA, "method": "tree"}).json()
    delta = next(r for r in g["rows"] if r["greek"] == "delta")
    assert delta["value"] == pytest.approx(g["closed_form"]["delta"], abs=0.01)
