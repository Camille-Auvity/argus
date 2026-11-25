#!/usr/bin/env python3
"""Prepare the files the static (GitHub Pages) build serves to the in-browser engine.

    python scripts/export_static.py                  # -> web/public/engine/
    python scripts/export_static.py --out some/dir

Writes:
  qplat.db       a trimmed copy of the database (latest option snapshot per ticker,
                 90 days of news, no personal positions) — the source database is untouched
  argus.zip      the Python sources (qplat/ + api/) unpacked by Pyodide in the browser
  manifest.json  build metadata (data date, sizes) shown by the loading screen
"""

from __future__ import annotations

import argparse
import json
import shutil
import sqlite3
import sys
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from qplat import config  # noqa: E402

NEWS_DAYS = 90
LOG_ROWS = 500


def trimmed_database(source: Path, target: Path) -> dict:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_suffix(".tmp")
    tmp.unlink(missing_ok=True)
    # sqlite backup API: a consistent copy even if the cron is writing at the same time
    with sqlite3.connect(source) as src, sqlite3.connect(tmp) as dst:
        src.backup(dst)
    con = sqlite3.connect(tmp)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=NEWS_DAYS)).isoformat()
    con.executescript(f"""
        DELETE FROM option_quotes
         WHERE asof < (SELECT MAX(asof) FROM option_quotes o2 WHERE o2.ticker = option_quotes.ticker);
        DELETE FROM sentiment WHERE news_id IN (SELECT id FROM news WHERE published < '{cutoff}');
        DELETE FROM news WHERE published < '{cutoff}';
        DELETE FROM refresh_log WHERE rowid NOT IN (SELECT rowid FROM refresh_log ORDER BY ts DESC LIMIT {LOG_ROWS});
        DELETE FROM positions;
    """)
    con.commit()
    stats = {t: con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0]
             for t in ("tickers", "spot_prices", "rate_quotes", "option_quotes", "news", "sentiment")}
    stats["data_asof"] = con.execute("SELECT MAX(date) FROM spot_prices").fetchone()[0]
    stats["last_refresh"] = con.execute("SELECT MAX(ts) FROM refresh_log").fetchone()[0]
    con.execute("VACUUM")
    con.close()
    tmp.replace(target)
    return stats


def python_sources(target: Path) -> int:
    n = 0
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for package in ("qplat", "api"):
            for f in sorted((ROOT / package).rglob("*.py")):
                z.write(f, f.relative_to(ROOT))
                n += 1
    return n


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, default=config.DB_PATH)
    parser.add_argument("--out", type=Path, default=ROOT / "web" / "public" / "engine")
    args = parser.parse_args()
    if not args.db.exists():
        sys.exit(f"database not found: {args.db} — run scripts/refresh.py --force first")

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    stats = trimmed_database(args.db, out / "qplat.db")
    n_files = python_sources(out / "argus.zip")
    manifest = {
        "built_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        **stats,
        "python_files": n_files,
        "db_bytes": (out / "qplat.db").stat().st_size,
        "zip_bytes": (out / "argus.zip").stat().st_size,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2))
    print(json.dumps(manifest, indent=2))


if __name__ == "__main__":
    main()
