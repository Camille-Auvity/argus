#!/bin/bash
# Cron entry point: runs the market-aware refresh and appends to logs/refresh.log.
cd "$(dirname "$0")/.." || exit 1
mkdir -p logs
/Users/camilleauvity/anaconda3/bin/python3 scripts/refresh.py "$@" >> logs/refresh.log 2>&1
