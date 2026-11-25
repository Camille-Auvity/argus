"""SQLite storage. Fetchers write here; the dashboard only reads.

Schema was designed from what the pricers consume: spot + dividend yield +
realised vol (equity derivatives), option chains (implied-vol smile),
Treasury par yields (curve bootstrap), news + LLM sentiment.
"""

from __future__ import annotations

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Iterator

import pandas as pd

from qplat import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS tickers (
    ticker TEXT PRIMARY KEY,
    name TEXT,
    sector TEXT,
    dividend_yield REAL,          -- annual, as a fraction
    currency TEXT,
    updated_at TEXT
);
CREATE TABLE IF NOT EXISTS spot_prices (
    ticker TEXT NOT NULL,
    date TEXT NOT NULL,           -- YYYY-MM-DD (daily close) or ISO timestamp (intraday)
    close REAL NOT NULL,
    PRIMARY KEY (ticker, date)
);
CREATE TABLE IF NOT EXISTS rate_quotes (
    asof TEXT NOT NULL,           -- observation date YYYY-MM-DD
    tenor_years REAL NOT NULL,
    rate REAL NOT NULL,           -- as a fraction
    source TEXT NOT NULL,
    currency TEXT NOT NULL DEFAULT 'USD',
    quote_type TEXT NOT NULL DEFAULT 'par',  -- 'par' (bond-equivalent par yield) or 'zero' (continuous)
    PRIMARY KEY (asof, tenor_years, source)
);
CREATE TABLE IF NOT EXISTS option_quotes (
    asof TEXT NOT NULL,           -- snapshot timestamp (UTC, minute)
    ticker TEXT NOT NULL,
    expiry TEXT NOT NULL,         -- YYYY-MM-DD
    strike REAL NOT NULL,
    option_type TEXT NOT NULL,    -- call / put
    bid REAL, ask REAL, last REAL,
    volume REAL, open_interest REAL,
    vendor_iv REAL,
    spot REAL,
    PRIMARY KEY (asof, ticker, expiry, strike, option_type)
);
CREATE TABLE IF NOT EXISTS news (
    id TEXT PRIMARY KEY,
    ticker TEXT NOT NULL,
    published TEXT,               -- ISO UTC
    title TEXT NOT NULL,
    publisher TEXT,
    url TEXT,
    summary TEXT,
    source TEXT,
    fetched_at TEXT
);
CREATE TABLE IF NOT EXISTS sentiment (
    news_id TEXT NOT NULL REFERENCES news(id),
    model TEXT NOT NULL,
    score REAL NOT NULL,          -- -1 (very negative) .. +1 (very positive)
    label TEXT NOT NULL,
    rationale TEXT,
    scored_at TEXT,
    PRIMARY KEY (news_id, model)
);
CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    book TEXT NOT NULL DEFAULT 'Principal',
    kind TEXT NOT NULL,           -- equity / option / barrier / autocall / bond / future
    ticker TEXT,
    quantity REAL NOT NULL,
    params TEXT NOT NULL,         -- JSON contract terms
    entry_price REAL,             -- per unit, instrument currency
    label TEXT,
    created_at TEXT
);
CREATE TABLE IF NOT EXISTS refresh_log (
    ts TEXT NOT NULL,
    job TEXT NOT NULL,
    status TEXT NOT NULL,
    message TEXT
);
CREATE INDEX IF NOT EXISTS idx_news_ticker ON news(ticker, published);
CREATE INDEX IF NOT EXISTS idx_opt_ticker ON option_quotes(ticker, asof);
"""


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


class Database:
    def __init__(self, path: Path | str = config.DB_PATH):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as con:
            con.executescript(SCHEMA)
            self._migrate(con)

    @staticmethod
    def _migrate(con: sqlite3.Connection) -> None:
        """Add columns introduced after the first release to existing databases."""
        added = {
            "tickers": [("currency", "TEXT")],
            "rate_quotes": [("currency", "TEXT NOT NULL DEFAULT 'USD'"), ("quote_type", "TEXT NOT NULL DEFAULT 'par'")],
        }
        for table, columns in added.items():
            existing = {row[1] for row in con.execute(f"PRAGMA table_info({table})")}
            for name, decl in columns:
                if name not in existing:
                    con.execute(f"ALTER TABLE {table} ADD COLUMN {name} {decl}")

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        con = sqlite3.connect(self.path)
        try:
            yield con
            con.commit()
        finally:
            con.close()

    # --- writes ---------------------------------------------------------------

    def _upsert(self, table: str, rows: Iterable[dict]) -> int:
        rows = list(rows)
        if not rows:
            return 0
        # rows may carry different column sets (omitted columns take their SQL default)
        by_cols: dict[tuple[str, ...], list[dict]] = {}
        for r in rows:
            by_cols.setdefault(tuple(r), []).append(r)
        with self.connect() as con:
            for cols, group in by_cols.items():
                sql = f"INSERT OR REPLACE INTO {table} ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})"
                con.executemany(sql, [tuple(r[c] for c in cols) for r in group])
        return len(rows)

    def upsert_ticker(self, **row) -> None:
        self._upsert("tickers", [{**row, "updated_at": utc_now()}])

    def upsert_spots(self, rows: Iterable[dict]) -> int:
        return self._upsert("spot_prices", rows)

    def upsert_rates(self, rows: Iterable[dict]) -> int:
        return self._upsert("rate_quotes", rows)

    def upsert_options(self, rows: Iterable[dict]) -> int:
        return self._upsert("option_quotes", rows)

    def insert_news(self, rows: Iterable[dict]) -> int:
        """Insert new articles only (keeps first fetch time); returns rows inserted."""
        rows = list(rows)
        if not rows:
            return 0
        cols = list(rows[0])
        sql = f"INSERT OR IGNORE INTO news ({','.join(cols)}) VALUES ({','.join('?' * len(cols))})"
        with self.connect() as con:
            before = con.total_changes
            con.executemany(sql, [tuple(r[c] for c in cols) for r in rows])
            return con.total_changes - before

    def upsert_sentiment(self, rows: Iterable[dict]) -> int:
        return self._upsert("sentiment", rows)

    def log(self, job: str, status: str, message: str = "") -> None:
        self._upsert("refresh_log", [{"ts": utc_now(), "job": job, "status": status, "message": message[:2000]}])

    # --- reads ----------------------------------------------------------------

    def query(self, sql: str, params: tuple = ()) -> pd.DataFrame:
        with self.connect() as con:
            return pd.read_sql_query(sql, con, params=params)

    def tickers(self) -> pd.DataFrame:
        return self.query("SELECT * FROM tickers ORDER BY ticker")

    def spot_history(self, ticker: str) -> pd.DataFrame:
        df = self.query("SELECT date, close FROM spot_prices WHERE ticker=? ORDER BY date", (ticker,))
        df["date"] = pd.to_datetime(df["date"], utc=True, format="mixed")
        return df

    def latest_spot(self, ticker: str) -> float | None:
        df = self.query("SELECT close FROM spot_prices WHERE ticker=? ORDER BY date DESC LIMIT 1", (ticker,))
        return None if df.empty else float(df.iloc[0, 0])

    # preferred source first; a fallback source is used only if the preferred one has no data
    RATE_SOURCES = {"USD": ("FRED", "yfinance"), "EUR": ("ECB",)}

    def latest_rates(self, currency: str = "USD") -> pd.DataFrame:
        for source in self.RATE_SOURCES.get(currency, ()):
            df = self.query(
                """SELECT * FROM rate_quotes WHERE source=? AND currency=?
                   AND asof=(SELECT MAX(asof) FROM rate_quotes WHERE source=? AND currency=?)
                   ORDER BY tenor_years""",
                (source, currency, source, currency),
            )
            if not df.empty:
                return df
        return self.query("SELECT * FROM rate_quotes WHERE 0")

    def rate_history(self, currency: str = "USD") -> pd.DataFrame:
        source = self.RATE_SOURCES.get(currency, ("",))[0]
        return self.query("SELECT * FROM rate_quotes WHERE currency=? AND source=? ORDER BY asof, tenor_years",
                          (currency, source))

    def latest_option_chain(self, ticker: str) -> pd.DataFrame:
        return self.query(
            "SELECT * FROM option_quotes WHERE ticker=? AND asof=(SELECT MAX(asof) FROM option_quotes WHERE ticker=?)",
            (ticker, ticker),
        )

    def news_with_sentiment(self, ticker: str | None = None, limit: int = 200) -> pd.DataFrame:
        where, params = ("WHERE n.ticker=?", (ticker,)) if ticker else ("", ())
        return self.query(
            f"""SELECT n.*, s.score, s.label, s.rationale, s.model
                FROM news n LEFT JOIN sentiment s ON s.news_id = n.id
                {where} ORDER BY n.published DESC LIMIT {int(limit)}""",
            params,
        )

    def unscored_news(self, model: str, limit: int = 100, max_age_days: float | None = 7) -> pd.DataFrame:
        """Newest unscored headlines; older ones are skipped so a backlog never turns into a large bill."""
        from datetime import timedelta

        since = "" if max_age_days is None else (
            datetime.now(timezone.utc) - timedelta(days=max_age_days)).isoformat()
        return self.query(
            """SELECT n.* FROM news n
               WHERE NOT EXISTS (SELECT 1 FROM sentiment s WHERE s.news_id = n.id AND s.model = ?)
                 AND COALESCE(n.published, n.fetched_at) >= ?
               ORDER BY n.published DESC LIMIT ?""",
            (model, since, limit),
        )

    # --- positions -----------------------------------------------------------------

    def add_position(self, kind: str, quantity: float, params: dict, ticker: str | None = None,
                     entry_price: float | None = None, book: str = "Principal", label: str = "") -> int:
        import json

        with self.connect() as con:
            cur = con.execute(
                "INSERT INTO positions (book, kind, ticker, quantity, params, entry_price, label, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (book, kind, ticker, quantity, json.dumps(params), entry_price, label, utc_now()))
            return int(cur.lastrowid)

    def positions(self) -> list[dict]:
        import json

        df = self.query("SELECT * FROM positions ORDER BY id")
        rows = df.to_dict("records")
        for r in rows:
            r["params"] = json.loads(r["params"])
            r["entry_price"] = None if pd.isna(r["entry_price"]) else float(r["entry_price"])
            r["ticker"] = None if r["ticker"] is None or (isinstance(r["ticker"], float) and pd.isna(r["ticker"])) else r["ticker"]
        return rows

    def delete_position(self, position_id: int) -> int:
        with self.connect() as con:
            return con.execute("DELETE FROM positions WHERE id=?", (position_id,)).rowcount

    def clear_positions(self) -> int:
        with self.connect() as con:
            return con.execute("DELETE FROM positions").rowcount

    # --- retention -----------------------------------------------------------------

    def prune_option_snapshots(self, keep_days: int = 7) -> int:
        """Keep every option snapshot of the last `keep_days`; before that, only the last one of each day
        per ticker (a full daily history stays available). Returns the number of rows deleted."""
        from datetime import timedelta

        cutoff = (datetime.now(timezone.utc) - timedelta(days=keep_days)).isoformat()
        with self.connect() as con:
            con.execute("DROP TABLE IF EXISTS temp.keep_snapshots")
            con.execute("""CREATE TEMP TABLE keep_snapshots AS
                           SELECT ticker, MAX(asof) AS asof FROM option_quotes
                           WHERE asof < ? GROUP BY ticker, substr(asof, 1, 10)""", (cutoff,))
            deleted = con.execute("""DELETE FROM option_quotes WHERE asof < ? AND NOT EXISTS (
                                         SELECT 1 FROM keep_snapshots k
                                         WHERE k.ticker = option_quotes.ticker AND k.asof = option_quotes.asof)""",
                                  (cutoff,)).rowcount
            con.execute("DROP TABLE temp.keep_snapshots")
        return deleted

    def prune_refresh_log(self, keep_days: int = 90) -> int:
        from datetime import timedelta

        cutoff = (datetime.now(timezone.utc) - timedelta(days=keep_days)).isoformat()
        with self.connect() as con:
            return con.execute("DELETE FROM refresh_log WHERE ts < ?", (cutoff,)).rowcount

    def vacuum(self) -> None:
        """Give the freed space back to the disk (rewrites the file; run occasionally, not every refresh)."""
        con = sqlite3.connect(self.path)
        try:
            con.execute("VACUUM")
        finally:
            con.close()

    def refresh_log(self, limit: int = 50) -> pd.DataFrame:
        return self.query("SELECT * FROM refresh_log ORDER BY ts DESC LIMIT ?", (limit,))
