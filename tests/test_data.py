import json
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from qplat.data.db import Database, utc_now
from qplat import config
from qplat.data.market import curve_from_par_yields, curve_from_quotes, realized_vol
from qplat.data.refresh import market_is_open, open_markets
from qplat.data.sentiment import SentimentScorer, aggregate_sentiment


@pytest.fixture
def db(tmp_path):
    return Database(tmp_path / "test.db")


def _news(i, ticker="AAPL"):
    return {"id": f"n{i}", "ticker": ticker, "published": utc_now(), "title": f"headline {i}",
            "publisher": "x", "url": f"https://example.com/{i}", "summary": "", "source": "test",
            "fetched_at": utc_now()}


def test_spots_and_rates_round_trip(db):
    db.upsert_spots([{"ticker": "AAPL", "date": "2026-10-08", "close": 100.0},
                     {"ticker": "AAPL", "date": "2026-10-09", "close": 101.0}])
    assert db.latest_spot("AAPL") == 101.0
    db.upsert_rates([{"asof": "2026-10-08", "tenor_years": 1.0, "rate": 0.04, "source": "FRED"},
                     {"asof": "2026-10-09", "tenor_years": 1.0, "rate": 0.05, "source": "FRED"},
                     {"asof": "2026-10-09", "tenor_years": 1.0, "rate": 0.02, "source": "ECB",
                      "currency": "EUR", "quote_type": "zero"}])
    assert db.latest_rates("USD").rate.tolist() == [0.05]
    assert db.latest_rates("EUR").quote_type.tolist() == ["zero"]
    assert db.latest_rates("JPY").empty


def test_usd_fallback_source_used_only_without_fred(db):
    db.upsert_rates([{"asof": "2026-10-10", "tenor_years": 10.0, "rate": 0.05, "source": "yfinance"}])
    assert db.latest_rates("USD").source.tolist() == ["yfinance"]
    db.upsert_rates([{"asof": "2026-10-08", "tenor_years": 10.0, "rate": 0.04, "source": "FRED"}])
    assert db.latest_rates("USD").source.tolist() == ["FRED"]


def test_migration_adds_columns_to_old_database(tmp_path):
    import sqlite3

    path = tmp_path / "old.db"
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE rate_quotes (asof TEXT, tenor_years REAL, rate REAL, source TEXT, "
                "PRIMARY KEY (asof, tenor_years, source))")
    con.execute("INSERT INTO rate_quotes VALUES ('2026-01-01', 1.0, 0.04, 'FRED')")
    con.commit()
    con.close()
    old = Database(path).latest_rates("USD")
    assert old.currency.tolist() == ["USD"] and old.quote_type.tolist() == ["par"]


def test_news_insert_is_idempotent(db):
    assert db.insert_news([_news(1), _news(2)]) == 2
    assert db.insert_news([_news(1), _news(3)]) == 1


class FakeClient:
    """Mimics client.beta.messages.create and records the request."""

    def __init__(self, scores):
        self.scores = scores
        self.calls = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self._create))

    def _create(self, **kwargs):
        self.calls.append(kwargs)
        items = [{"id": k, "score": v, "label": "positive", "rationale": "r"} for k, v in self.scores.items()]
        items.append({"id": "unknown", "score": 0.1, "label": "neutral", "rationale": "ignored"})
        return SimpleNamespace(stop_reason="end_turn",
                               content=[SimpleNamespace(type="text", text=json.dumps({"items": items}))])


def test_sentiment_scoring_pipeline(db):
    db.insert_news([_news(1), _news(2)])
    client = FakeClient({"n1": 0.6, "n2": 3.0})  # out-of-range score gets clipped
    scorer = SentimentScorer(model="test-model", client=client)
    assert scorer.score_pending(db) == 2
    assert scorer.score_pending(db) == 0  # nothing left to score
    req = client.calls[0]
    assert req["output_config"]["format"]["type"] == "json_schema"
    news = db.news_with_sentiment("AAPL").set_index("id")
    assert news.loc["n2", "score"] == 1.0
    agg = aggregate_sentiment(news.reset_index())
    assert agg.loc[0, "sentiment"] == pytest.approx(0.8)


def test_sentiment_refusal_raises(db):
    client = FakeClient({})
    client.beta.messages.create = lambda **kw: SimpleNamespace(stop_reason="refusal", stop_details=None, content=[])
    with pytest.raises(RuntimeError):
        SentimentScorer(model="m", client=client).score_headlines("AAPL", [{"id": "a", "title": "t"}])


def test_market_hours():
    ny = ZoneInfo("America/New_York")
    assert market_is_open(datetime(2026, 10, 13, 10, 0, tzinfo=ny))
    assert not market_is_open(datetime(2026, 10, 13, 17, 0, tzinfo=ny))
    assert not market_is_open(datetime(2026, 10, 11, 12, 0, tzinfo=ny))  # Sunday
    paris = ZoneInfo("Europe/Paris")
    assert open_markets(datetime(2026, 10, 13, 10, 0, tzinfo=paris)) == {"EU"}
    assert open_markets(datetime(2026, 10, 13, 16, 0, tzinfo=paris)) == {"EU", "US"}
    assert open_markets(datetime(2026, 10, 13, 20, 0, tzinfo=paris)) == {"US"}
    assert open_markets(datetime(2026, 10, 13, 23, 0, tzinfo=paris)) == set()


@pytest.mark.parametrize("ticker, market", [("AAPL", "US"), ("SPY", "US"), ("MC.PA", "EU"), ("SAP.DE", "EU"),
                                            ("ASML.AS", "EU"), ("^STOXX50E", "EU"), ("^FCHI", "EU")])
def test_market_classification(ticker, market):
    assert config.market_of(ticker).name == market


def test_zero_quotes_used_directly():
    import numpy as np

    curve = curve_from_quotes([0.25, 1, 10], [0.025, 0.026, 0.032], "zero")
    assert curve.zero_rate(np.array([0.25, 1.0, 10.0])) == pytest.approx([0.025, 0.026, 0.032])


def test_treasury_curve_reprices_par_yields():
    tenors = [1 / 12, 0.25, 0.5, 1, 2, 5, 10, 30]
    rates = [0.041, 0.042, 0.0425, 0.044, 0.047, 0.0495, 0.052, 0.056]
    curve = curve_from_par_yields(tenors, rates)
    from qplat.instruments import FixedRateBond
    from qplat.pricers import DiscountingBondPricer

    bond = FixedRateBond(maturity=10, coupon_rate=0.052, frequency=2)
    assert DiscountingBondPricer(curve).dirty_price(bond) == pytest.approx(100.0, abs=1e-8)


def test_realized_vol_constant_returns_zero():
    assert realized_vol(pd.Series([100 * 1.01**i for i in range(50)])) == pytest.approx(0.0, abs=1e-12)


def test_select_expiries_spreads_the_term_structure():
    from datetime import timezone

    from qplat.data.market import select_expiries

    today = datetime(2026, 10, 12, tzinfo=timezone.utc)
    weeklies = [f"2026-{m:02d}-{d:02d}" for m in (10, 11, 12) for d in (14, 16, 21, 23, 28, 30) if not (m == 11 and d == 30)]
    listed = weeklies + ["2027-01-15", "2027-03-19", "2027-06-18", "2027-09-17", "2027-12-17", "2028-01-21"]
    chosen = select_expiries(listed, today)
    assert chosen[0] == "2026-10-21" and chosen[-1] == "2028-01-21"  # ~1 week ... ~1.5 years
    assert len(chosen) == len(set(chosen)) <= 9


def test_old_unscored_news_are_not_sent_for_scoring(db):
    old = {**_news(1), "published": "2020-01-01T00:00:00+00:00"}
    db.insert_news([old, _news(2)])
    assert db.unscored_news("m")["id"].tolist() == ["n2"]
    assert set(db.unscored_news("m", max_age_days=None)["id"]) == {"n1", "n2"}
