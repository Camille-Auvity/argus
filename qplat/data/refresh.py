"""Refresh jobs, shared by the scheduler script and the dashboard button."""

from __future__ import annotations

import logging
from datetime import datetime
from zoneinfo import ZoneInfo

from qplat import config
from qplat.data import market, news
from qplat.data.db import Database

log = logging.getLogger(__name__)

JOBS = ("info", "prices", "options", "rates", "news", "sentiment")


def market_is_open(now: datetime | None = None, market: config.Market = config.MARKETS["US"]) -> bool:
    """Weekday trading-hours check (no exchange holiday calendar)."""
    now = (now or datetime.now(ZoneInfo(market.tz))).astimezone(ZoneInfo(market.tz))
    return now.weekday() < 5 and market.open <= now.time() <= market.close


def open_markets(now: datetime | None = None) -> set[str]:
    return {name for name, m in config.MARKETS.items() if market_is_open(now, m)}


def run_jobs(db: Database, tickers: list[str], jobs: tuple[str, ...] = JOBS) -> dict[str, str]:
    """Run each job, logging failures without stopping the others."""
    report: dict[str, str] = {}

    def run(name: str, fn):
        try:
            msg = str(fn())
            db.log(name, "ok", msg)
            report[name] = f"ok: {msg}"
        except Exception as exc:
            log.exception("job %s failed", name)
            db.log(name, "error", repr(exc))
            report[name] = f"error: {exc!r}"

    for t in tickers:
        if "info" in jobs:
            run(f"info:{t}", lambda t=t: market.fetch_ticker_info(db, t) or "updated")
        if "prices" in jobs:
            run(f"prices:{t}", lambda t=t: (market.fetch_spot_history(db, t), market.fetch_intraday_spot(db, t)))
        if "options" in jobs:
            run(f"options:{t}", lambda t=t: market.fetch_option_chain(db, t))
        if "news" in jobs:
            run(f"news:{t}", lambda t=t: news.fetch_news(db, t))
    if "options" in jobs:
        # retention: intraday snapshots for a week, then one per day (deleted pages are reused, no VACUUM needed)
        run("retention", lambda: {"option_rows_deleted": db.prune_option_snapshots(),
                                  "log_rows_deleted": db.prune_refresh_log()})
    if "rates" in jobs:
        run("rates", lambda: market.fetch_all_curves(db))
    if "sentiment" in jobs:
        from qplat.data.sentiment import SentimentScorer

        run("sentiment", lambda: SentimentScorer().score_pending(db))
    return report
