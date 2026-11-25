"""News fetchers: Yahoo Finance RSS (default, no key) and Alpha Vantage
NEWS_SENTIMENT (if ALPHAVANTAGE_API_KEY is set)."""

from __future__ import annotations

import hashlib
import json
import urllib.parse
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

from qplat import config
from qplat.data.db import Database, utc_now
from qplat.data.market import _http_get


def _news_id(ticker: str, url: str, title: str) -> str:
    return hashlib.sha1(f"{ticker}|{url or title}".encode()).hexdigest()[:20]


def fetch_yahoo_rss(ticker: str) -> list[dict]:
    market = config.market_of(ticker)
    url = "https://feeds.finance.yahoo.com/rss/2.0/headline?" + urllib.parse.urlencode(
        {"s": ticker, "region": market.news_region, "lang": market.news_lang})
    root = ET.fromstring(_http_get(url))
    rows = []
    for item in root.iter("item"):
        title = (item.findtext("title") or "").strip()
        if not title:
            continue
        link = item.findtext("link") or ""
        pub = item.findtext("pubDate")
        try:
            published = parsedate_to_datetime(pub).astimezone(timezone.utc).isoformat() if pub else None
        except (TypeError, ValueError):
            published = None
        rows.append({
            "id": _news_id(ticker, link, title), "ticker": ticker, "published": published,
            "title": title, "publisher": "Yahoo Finance", "url": link,
            "summary": (item.findtext("description") or "").strip()[:1000],
            "source": "yahoo_rss", "fetched_at": utc_now(),
        })
    return rows


def fetch_alphavantage(ticker: str, api_key: str, limit: int = 50) -> list[dict]:
    params = {"function": "NEWS_SENTIMENT", "tickers": ticker, "limit": limit, "apikey": api_key}
    data = json.loads(_http_get("https://www.alphavantage.co/query?" + urllib.parse.urlencode(params)))
    rows = []
    for it in data.get("feed", []):
        try:
            published = datetime.strptime(it["time_published"], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc).isoformat()
        except (KeyError, ValueError):
            published = None
        rows.append({
            "id": _news_id(ticker, it.get("url", ""), it.get("title", "")), "ticker": ticker,
            "published": published, "title": it.get("title", ""), "publisher": it.get("source"),
            "url": it.get("url"), "summary": (it.get("summary") or "")[:1000],
            "source": "alphavantage", "fetched_at": utc_now(),
        })
    return rows


def fetch_news(db: Database, ticker: str) -> int:
    rows = fetch_yahoo_rss(ticker)
    if config.ALPHAVANTAGE_API_KEY:
        rows += fetch_alphavantage(ticker, config.ALPHAVANTAGE_API_KEY)
    return db.insert_news(rows)
