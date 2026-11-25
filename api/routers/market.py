"""Market overview, tickers, price history, volatility smile, news & sentiment, refresh."""

from __future__ import annotations

from functools import lru_cache

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException, Query

from api import services
from api.schemas import RateSpec
from qplat import config
from qplat.analytics import atm_term_structure, compute_smile
from qplat.data.refresh import open_markets, run_jobs
from qplat.data.sentiment import aggregate_sentiment

router = APIRouter(prefix="/api", tags=["market"])


def _sentiment_by_ticker() -> dict[str, float]:
    agg = aggregate_sentiment(services.get_db().news_with_sentiment(None, limit=2000))
    return dict(zip(agg.ticker, agg.sentiment.astype(float)))


def _universe(tickers: pd.DataFrame) -> list[str]:
    known = set(tickers.ticker) | set(config.TICKERS)
    return sorted(known, key=lambda t: (config.market_of(t).name != "US", t))


@router.get("/status")
def status():
    db = services.get_db()
    log = db.refresh_log(1)
    import os

    return {
        "open_markets": sorted(open_markets()),
        "markets": {k: {"tz": m.tz, "open": m.open.strftime("%H:%M"), "close": m.close.strftime("%H:%M"),
                        "currency": m.currency} for k, m in config.MARKETS.items()},
        "last_refresh": None if log.empty else log.ts.iloc[0],
        "sentiment_model": config.SENTIMENT_MODEL,
        "anthropic_configured": bool(os.environ.get("ANTHROPIC_API_KEY")),
        "static": config.STATIC_MODE,
    }


def _forbid_in_static(action: str) -> None:
    if config.STATIC_MODE:
        raise HTTPException(403, f"{action} n'est pas disponible dans la version en ligne : "
                                 "les données sont mises à jour automatiquement par le serveur de publication.")


@router.get("/tickers")
def list_tickers():
    db = services.get_db()
    tickers = db.tickers()
    sentiment = _sentiment_by_ticker()
    return [services.ticker_snapshot(t, tickers, db.spot_history(t), sentiment) for t in _universe(tickers)]


@router.get("/tickers/{ticker}")
def get_ticker(ticker: str):
    db = services.get_db()
    return services.ticker_snapshot(ticker, db.tickers(), db.spot_history(ticker), _sentiment_by_ticker())


@router.get("/tickers/{ticker}/history")
def ticker_history(ticker: str, days: int = Query(500, ge=5, le=5000)):
    h = services.get_db().spot_history(ticker).tail(days + 21)
    if h.empty:
        return {"dates": [], "close": [], "realized_vol_1m": []}
    rv = (np.log(h.close).diff().rolling(21).std() * np.sqrt(252)).tail(days)
    h = h.tail(days)
    return {
        "dates": h.date.dt.strftime("%Y-%m-%d").tolist(),
        "close": h.close.round(4).tolist(),
        "realized_vol_1m": [None if np.isnan(v) else round(float(v), 5) for v in rv],
    }


@router.post("/refresh/{ticker}")
def refresh_ticker(ticker: str):
    """Fetch prices, options, news (and both curves) now for one ticker."""
    _forbid_in_static("Le rafraîchissement manuel")
    report = run_jobs(services.get_db(), [ticker.upper()], ("info", "prices", "options", "rates", "news"))
    _smile_cached.cache_clear()
    return report


# ----------------------------------------------------------------------------- volatility

@lru_cache(maxsize=64)
def _smile_cached(ticker: str, asof: str, rate_json: str):
    db = services.get_db()
    chain = db.latest_option_chain(ticker)
    spec = RateSpec.model_validate_json(rate_json)
    tickers = db.tickers()
    row = tickers[tickers.ticker == ticker]
    q = float(row.dividend_yield.iloc[0]) if not row.empty and row.dividend_yield.notna().iloc[0] else 0.0
    smile = compute_smile(chain, q, services.resolve_rate(spec))
    return smile, atm_term_structure(smile), q, float(chain.spot.dropna().iloc[0])


@router.get("/vol/{ticker}/smile")
def vol_smile(ticker: str, rate_mode: str = "curve", flat_rate: float = 0.03):
    db = services.get_db()
    chain_head = db.query("SELECT MAX(asof) AS asof FROM option_quotes WHERE ticker=?", (ticker,))
    asof = chain_head["asof"].iloc[0]
    if asof is None:
        reason = ("Yahoo Finance ne diffuse pas de chaînes d'options pour ce marché"
                  if config.market_of(ticker).name == "EU" else "aucune chaîne d'options en base")
        raise HTTPException(404, reason)
    spec = RateSpec(mode=rate_mode, currency=services.ticker_currency(ticker), flat_rate=flat_rate)
    smile, atm, q, spot = _smile_cached(ticker, asof, spec.model_dump_json())
    expiries = []
    for exp, g in smile.groupby("expiry"):
        expiries.append({
            "expiry": exp, "days": int(round(g["T"].iloc[0] * 365)), "T": float(g["T"].iloc[0]),
            "points": g[["strike", "moneyness", "iv", "vendor_iv", "mid", "option_type"]]
            .replace({np.nan: None}).to_dict("records"),
        })
    return {
        "asof": asof, "spot": spot, "dividend_yield": q, "expiries": expiries,
        "atm_term_structure": atm.to_dict("records"),
    }


# ----------------------------------------------------------------------------- news & sentiment

@router.get("/news")
def news(ticker: str | None = None, limit: int = Query(100, ge=1, le=1000)):
    df = services.get_db().news_with_sentiment(ticker, limit)
    return df.replace({np.nan: None}).to_dict("records")


@router.get("/sentiment/summary")
def sentiment_summary():
    db = services.get_db()
    all_news = db.news_with_sentiment(None, limit=5000)
    agg = aggregate_sentiment(all_news)
    tickers = db.tickers()[["ticker", "name", "sector"]]
    agg = agg.merge(tickers, on="ticker", how="left")
    agg["market"] = agg.ticker.map(lambda t: config.market_of(t).name)
    by_sector = []
    for sector, g in agg.dropna(subset=["sector"]).groupby("sector"):
        by_sector.append({"sector": sector, "sentiment": float(np.average(g.sentiment, weights=g.n_articles)),
                          "n_articles": int(g.n_articles.sum())})
    agg["last_article"] = agg.last_article.astype(str)
    return {
        "by_ticker": agg.replace({np.nan: None}).to_dict("records"),
        "by_sector": sorted(by_sector, key=lambda x: x["sentiment"]),
        "pending": int(all_news.score.isna().sum()) if not all_news.empty else 0,
    }


@router.post("/sentiment/score")
def score_sentiment(limit: int = Query(100, ge=1, le=500)):
    """Send unscored headlines to Claude (billed API calls)."""
    _forbid_in_static("Le scoring à la demande")
    from qplat.data.sentiment import SentimentScorer

    try:
        n = SentimentScorer().score_pending(services.get_db(), limit=limit)
    except Exception as exc:
        raise HTTPException(502, f"scoring failed: {exc}") from exc
    return {"scored": n}
