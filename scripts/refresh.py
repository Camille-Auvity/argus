#!/usr/bin/env python3
"""Scheduled data refresh — run by cron every 15 minutes.

    python scripts/refresh.py                 # only tickers whose market (US/EU) is open
    python scripts/refresh.py --force         # run anyway (first load, weekends)
    python scripts/refresh.py --jobs rates,news --tickers AAPL,MSFT
"""

from __future__ import annotations

import argparse
import logging
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qplat import config  # noqa: E402
from qplat.data.db import Database  # noqa: E402
from qplat.data.refresh import JOBS, open_markets, run_jobs  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--tickers", default=",".join(config.TICKERS))
    parser.add_argument("--jobs", default=",".join(JOBS), help=f"comma-separated subset of {JOBS}")
    parser.add_argument("--force", action="store_true", help="run even when markets are closed")
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    tickers = [t.strip().upper() for t in args.tickers.split(",") if t.strip()]
    if not args.force:
        markets = open_markets()
        if not markets:
            logging.info("US and EU markets closed — nothing to do (use --force to override)")
            return 0
        tickers = [t for t in tickers if config.market_of(t).name in markets]
        logging.info("open markets: %s", ", ".join(sorted(markets)))

    jobs = tuple(j.strip() for j in args.jobs.split(",") if j.strip())
    unknown = set(jobs) - set(JOBS)
    if unknown:
        parser.error(f"unknown jobs: {sorted(unknown)}")
    report = run_jobs(Database(), tickers, jobs)
    for job, status in report.items():
        logging.info("%-20s %s", job, status)
    return 1 if any(s.startswith("error") for s in report.values()) else 0


if __name__ == "__main__":
    sys.exit(main())
