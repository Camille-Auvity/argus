#!/usr/bin/env python3
"""Database housekeeping.

    python scripts/maintenance.py            # apply the retention policy
    python scripts/maintenance.py --vacuum   # ... and give the freed space back to the disk

Retention (also applied automatically after each options refresh):
  * option chains: every snapshot of the last 7 days, then the last snapshot of each day per ticker;
  * refresh log: 90 days.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from qplat import config  # noqa: E402
from qplat.data.db import Database  # noqa: E402


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--keep-days", type=int, default=7, help="days of intraday option snapshots kept")
    parser.add_argument("--vacuum", action="store_true", help="compact the file afterwards")
    args = parser.parse_args()

    db = Database()
    size = lambda: config.DB_PATH.stat().st_size / 1e6  # noqa: E731
    before = size()
    t0 = time.time()
    options = db.prune_option_snapshots(args.keep_days)
    logs = db.prune_refresh_log()
    print(f"deleted {options:,} option rows and {logs:,} log rows in {time.time() - t0:.1f}s")
    if args.vacuum:
        t0 = time.time()
        db.vacuum()
        print(f"vacuum in {time.time() - t0:.1f}s")
    print(f"database size: {before:,.0f} MB -> {size():,.0f} MB")


if __name__ == "__main__":
    main()
