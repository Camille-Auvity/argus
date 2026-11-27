#!/usr/bin/env python3
"""Carry the locally scored news history to the published site.

The online build starts from the database it published last time, so headlines
scored on this machine (e.g. a backfill) never reach it on their own. This script
writes them to a versioned file that the publishing workflow merges in.

    python scripts/sentiment_seed.py export     # local database -> seed/news_sentiment.json.gz
    python scripts/sentiment_seed.py import     # seed file -> database (used by the workflow)

Import never overwrites: rows already in the database (news or scores) are kept,
so the file only fills gaps. Only scored headlines are exported.
"""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from qplat import config  # noqa: E402
from qplat.data.db import Database  # noqa: E402

SEED = ROOT / "seed" / "news_sentiment.json.gz"
NEWS_COLS = ("id", "ticker", "published", "title", "publisher", "url", "summary", "source", "fetched_at")
SENT_COLS = ("news_id", "model", "score", "label", "rationale", "scored_at")
SUMMARY_CHARS = 400   # what the scorer reads; the rest is not shown either


def export(db_path: Path, seed: Path) -> dict:
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    news = [dict(r) for r in con.execute(
        f"SELECT {','.join('n.' + c for c in NEWS_COLS)} FROM news n "
        "WHERE EXISTS (SELECT 1 FROM sentiment s WHERE s.news_id = n.id) ORDER BY n.published, n.id")]
    for r in news:
        if r["summary"]:
            r["summary"] = r["summary"][:SUMMARY_CHARS]
    sentiment = [dict(r) for r in con.execute(
        f"SELECT {','.join(SENT_COLS)} FROM sentiment ORDER BY news_id, model")]
    con.close()
    seed.parent.mkdir(parents=True, exist_ok=True)
    payload = {"news": [[r[c] for c in NEWS_COLS] for r in news],
               "sentiment": [[r[c] for c in SENT_COLS] for r in sentiment]}
    # mtime=0: the same rows give the same bytes, so an unchanged export leaves git clean
    with open(seed, "wb") as f, gzip.GzipFile(filename="", fileobj=f, mode="wb", mtime=0) as z:
        z.write(json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode())
    return {"news": len(news), "sentiment": len(sentiment), "bytes": seed.stat().st_size}


def load(db_path: Path, seed: Path) -> dict:
    if not seed.exists():
        return {"news": 0, "sentiment": 0, "note": "no seed file"}
    payload = json.loads(gzip.decompress(seed.read_bytes()))
    Database(db_path)   # creates the schema on a fresh database
    con = sqlite3.connect(db_path)
    before = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] for t in ("news", "sentiment")}
    with con:
        con.executemany(f"INSERT OR IGNORE INTO news ({','.join(NEWS_COLS)}) VALUES ({','.join('?' * len(NEWS_COLS))})",
                        payload["news"])
        con.executemany(f"INSERT OR IGNORE INTO sentiment ({','.join(SENT_COLS)}) "
                        f"VALUES ({','.join('?' * len(SENT_COLS))})", payload["sentiment"])
    added = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] - before[t] for t in before}
    con.close()
    return added


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("action", choices=("export", "import"))
    parser.add_argument("--db", type=Path, default=config.DB_PATH)
    parser.add_argument("--seed", type=Path, default=SEED)
    args = parser.parse_args()
    if args.action == "export":
        if not args.db.exists():
            sys.exit(f"database not found: {args.db}")
        print(json.dumps(export(args.db, args.seed)))
    else:
        print(json.dumps({"added": load(args.db, args.seed)}))


if __name__ == "__main__":
    main()
