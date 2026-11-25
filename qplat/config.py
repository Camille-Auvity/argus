"""Runtime settings, overridable by environment variables (or a local .env file)."""

from __future__ import annotations

import os
from dataclasses import dataclass
from datetime import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path = ROOT / ".env") -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, value = line.split("=", 1)
            value = value.strip().strip('"').strip("'")
            if value:
                os.environ.setdefault(key.strip(), value)


_load_dotenv()

DEFAULT_TICKERS = (
    "SPY,QQQ,AAPL,MSFT,NVDA,"                                  # US
    "^STOXX50E,^FCHI,MC.PA,TTE.PA,AIR.PA,SAN.PA,ASML.AS,SAP.DE"  # Europe
)

DB_PATH = Path(os.environ.get("QPLAT_DB", ROOT / "data" / "qplat.db"))
TICKERS = [t.strip().upper() for t in os.environ.get("QPLAT_TICKERS", DEFAULT_TICKERS).split(",") if t.strip()]
ALPHAVANTAGE_API_KEY = os.environ.get("ALPHAVANTAGE_API_KEY")
SENTIMENT_MODEL = os.environ.get("QPLAT_SENTIMENT_MODEL", "claude-opus-5-5")


@dataclass(frozen=True)
class Market:
    name: str
    currency: str
    tz: str
    open: time
    close: time
    news_region: str
    news_lang: str


MARKETS = {
    "US": Market("US", "USD", "America/New_York", time(9, 30), time(16, 0), "US", "en-US"),
    "EU": Market("EU", "EUR", "Europe/Paris", time(9, 0), time(17, 30), "FR", "fr-FR"),
}
MARKET_TZ = MARKETS["US"].tz  # kept for backward compatibility

EU_SUFFIXES = (".PA", ".DE", ".F", ".AS", ".BR", ".MI", ".MC", ".LS", ".HE", ".VI", ".IR")
EU_INDICES = {"^STOXX50E", "^STOXX", "^FCHI", "^GDAXI", "^AEX", "^FTSEMIB", "^IBEX", "^BFX"}


def market_of(ticker: str) -> Market:
    t = ticker.upper()
    if t in EU_INDICES or t.endswith(EU_SUFFIXES):
        return MARKETS["EU"]
    return MARKETS["US"]
