"""Market data fetchers: spots, ticker metadata, option chains (yfinance),
US Treasury par yields (FRED public CSV, yfinance fallback) and euro-area AAA
zero-coupon curve (ECB data API)."""

from __future__ import annotations

import io
import logging
import urllib.request
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from qplat import config
from qplat.data.db import Database

log = logging.getLogger(__name__)

# FRED constant-maturity Treasury par yields (no API key needed for the CSV endpoint)
FRED_SERIES = {
    "DGS1MO": 1 / 12, "DGS3MO": 0.25, "DGS6MO": 0.5, "DGS1": 1.0, "DGS2": 2.0, "DGS3": 3.0,
    "DGS5": 5.0, "DGS7": 7.0, "DGS10": 10.0, "DGS20": 20.0, "DGS30": 30.0,
}
YF_RATE_TICKERS = {"^IRX": 0.25, "^FVX": 5.0, "^TNX": 10.0, "^TYX": 30.0}
# ECB euro-area AAA government curve (Svensson fit), continuously compounded spot rates
ECB_TENORS = {"SR_3M": 0.25, "SR_6M": 0.5, "SR_1Y": 1.0, "SR_2Y": 2.0, "SR_3Y": 3.0, "SR_5Y": 5.0,
              "SR_7Y": 7.0, "SR_10Y": 10.0, "SR_15Y": 15.0, "SR_20Y": 20.0, "SR_30Y": 30.0}
USER_AGENT = "Mozilla/5.0 (qplat research platform)"


def _http_get(url: str, timeout: float = 20.0) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


# --- equities -------------------------------------------------------------------

def fetch_ticker_info(db: Database, ticker: str) -> None:
    import yfinance as yf

    info = yf.Ticker(ticker).info or {}
    dy = info.get("trailingAnnualDividendYield")  # already a fraction (dividendYield is in %)
    db.upsert_ticker(
        ticker=ticker,
        name=" ".join((info.get("longName") or info.get("shortName") or ticker).split()),
        sector=info.get("sector") or info.get("category")
        or {"ETF": "ETF", "INDEX": "Indice"}.get(info.get("quoteType")),
        dividend_yield=float(dy) if dy is not None and np.isfinite(dy) else 0.0,
        currency=info.get("currency") or config.market_of(ticker).currency,
    )


FUNDAMENTALS_MAX_AGE_DAYS = 7


def _first(frame, *rows):
    for r in rows:
        if r in frame.index:
            v = frame.loc[r].dropna()
            if len(v):
                return float(v.iloc[0])
    return None


def fetch_fundamentals(db: Database, ticker: str, force: bool = False) -> str:
    """Shares outstanding and debt (latest annual balance sheet) for the Merton model; weekly at most.

    Indices and ETFs have no balance sheet: nothing is stored for them.
    """
    import yfinance as yf

    row = db.tickers().query("ticker == @ticker")
    if not force and not row.empty and row.fundamentals_at.notna().iloc[0]:
        age = datetime.now(timezone.utc) - datetime.fromisoformat(row.fundamentals_at.iloc[0])
        if age.days < FUNDAMENTALS_MAX_AGE_DAYS:
            return "fresh"
    tk = yf.Ticker(ticker)
    info = tk.info or {}
    if info.get("quoteType") not in (None, "EQUITY"):
        return "not an equity"
    bs = tk.balance_sheet
    if bs is None or bs.empty:
        return "no balance sheet"
    db.upsert_ticker(
        ticker=ticker,
        shares_outstanding=info.get("sharesOutstanding"),
        short_term_debt=_first(bs, "Current Debt And Capital Lease Obligation", "Current Debt"),
        long_term_debt=_first(bs, "Long Term Debt And Capital Lease Obligation", "Long Term Debt"),
        total_debt=_first(bs, "Total Debt"),
        cash=_first(bs, "Cash And Cash Equivalents", "Cash Cash Equivalents And Short Term Investments"),
        financial_currency=info.get("financialCurrency") or info.get("currency"),
        fundamentals_at=datetime.now(timezone.utc).isoformat(),
    )
    return "updated"


def fetch_spot_history(db: Database, ticker: str, period: str = "2y") -> int:
    import yfinance as yf

    hist = yf.Ticker(ticker).history(period=period, auto_adjust=False)
    if hist.empty:
        return 0
    rows = [{"ticker": ticker, "date": idx.strftime("%Y-%m-%d"), "close": float(c)}
            for idx, c in hist["Close"].items() if np.isfinite(c)]
    return db.upsert_spots(rows)


def fetch_intraday_spot(db: Database, ticker: str) -> float | None:
    """Last traded price stored under today's date (overwritten until the close)."""
    import yfinance as yf

    hist = yf.Ticker(ticker).history(period="1d", interval="1m")
    if hist.empty:
        return None
    last = float(hist["Close"].iloc[-1])
    db.upsert_spots([{"ticker": ticker, "date": hist.index[-1].strftime("%Y-%m-%d"), "close": last}])
    return last


# target horizons (days) for the stored expiries: a term structure, not a pile of weeklies
EXPIRY_TARGETS_DAYS = (7, 14, 30, 60, 90, 180, 270, 365, 545)


def select_expiries(expiries: list[str], today: datetime | None = None,
                    targets: tuple[int, ...] = EXPIRY_TARGETS_DAYS) -> list[str]:
    """For each target horizon, the listed expiry closest to it (deduplicated, sorted)."""
    today = today or datetime.now(timezone.utc)
    days = {e: (datetime.fromisoformat(e).replace(tzinfo=timezone.utc) - today).days for e in expiries}
    future = [e for e in expiries if days[e] >= 1]
    chosen = {min(future, key=lambda e: abs(days[e] - target)) for target in targets} if future else set()
    return sorted(chosen)


def fetch_option_chain(db: Database, ticker: str) -> int:
    import yfinance as yf

    tk = yf.Ticker(ticker)
    spot = db.latest_spot(ticker)
    asof = datetime.now(timezone.utc).replace(second=0, microsecond=0).isoformat()
    rows = []
    for expiry in select_expiries(list(tk.options)):
        chain = tk.option_chain(expiry)
        for opt_type, df in (("call", chain.calls), ("put", chain.puts)):
            for r in df.itertuples(index=False):
                rows.append({
                    "asof": asof, "ticker": ticker, "expiry": expiry, "strike": float(r.strike),
                    "option_type": opt_type,
                    "bid": _num(r.bid), "ask": _num(r.ask), "last": _num(r.lastPrice),
                    "volume": _num(r.volume), "open_interest": _num(r.openInterest),
                    "vendor_iv": _num(r.impliedVolatility), "spot": spot,
                })
    return db.upsert_options(rows)


def _num(x) -> float | None:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return None
    return x if np.isfinite(x) else None


def realized_vol(closes: pd.Series, window: int = 252) -> float:
    rets = np.log(closes.astype(float)).diff().dropna().tail(window)
    return float(rets.std(ddof=1) * np.sqrt(252)) if len(rets) > 5 else float("nan")


# --- rates ----------------------------------------------------------------------

def fetch_treasury_fred(db: Database, lookback_days: int = 30) -> int:
    frames = []
    for series, tenor in FRED_SERIES.items():
        raw = _http_get(f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series}")
        df = pd.read_csv(io.BytesIO(raw))
        df.columns = ["date", "value"]
        df["value"] = pd.to_numeric(df["value"], errors="coerce")
        df = df.dropna().tail(lookback_days)
        df["tenor"] = tenor
        frames.append(df)
    data = pd.concat(frames)
    rows = [{"asof": r.date, "tenor_years": r.tenor, "rate": r.value / 100.0, "source": "FRED",
             "currency": "USD", "quote_type": "par"}
            for r in data.itertuples(index=False)]
    # only keep dates where the full curve is available
    complete = data.groupby("date")["tenor"].count()
    full_dates = set(complete[complete == len(FRED_SERIES)].index)
    return db.upsert_rates([r for r in rows if r["asof"] in full_dates])


def fetch_treasury_yfinance(db: Database) -> int:
    import yfinance as yf

    rows = []
    for tkr, tenor in YF_RATE_TICKERS.items():
        hist = yf.Ticker(tkr).history(period="5d")
        if hist.empty:
            continue
        idx, val = hist.index[-1], float(hist["Close"].iloc[-1])
        rows.append({"asof": idx.strftime("%Y-%m-%d"), "tenor_years": tenor, "rate": val / 100.0, "source": "yfinance",
                     "currency": "USD", "quote_type": "par"})
    return db.upsert_rates(rows)


def fetch_treasury_curve(db: Database) -> int:
    try:
        return fetch_treasury_fred(db)
    except Exception as exc:  # network / format issue -> degrade gracefully
        log.warning("FRED fetch failed (%s), falling back to yfinance", exc)
        return fetch_treasury_yfinance(db)


def fetch_ecb_curve(db: Database, lookback_days: int = 30) -> int:
    key = "B.U2.EUR.4F.G_N_A.SV_C_YM." + "+".join(ECB_TENORS)
    url = f"https://data-api.ecb.europa.eu/service/data/YC/{key}?lastNObservations={lookback_days}&format=csvdata"
    df = pd.read_csv(io.BytesIO(_http_get(url)), usecols=["DATA_TYPE_FM", "TIME_PERIOD", "OBS_VALUE"])
    df = df.dropna()
    complete = df.groupby("TIME_PERIOD")["DATA_TYPE_FM"].nunique()
    full_dates = set(complete[complete == len(ECB_TENORS)].index)
    rows = [{"asof": r.TIME_PERIOD, "tenor_years": ECB_TENORS[r.DATA_TYPE_FM], "rate": r.OBS_VALUE / 100.0,
             "source": "ECB", "currency": "EUR", "quote_type": "zero"}
            for r in df.itertuples(index=False) if r.TIME_PERIOD in full_dates]
    return db.upsert_rates(rows)


FX_TICKERS = {"EURUSD": "EURUSD=X"}  # stored in spot_prices like any other quote


def fetch_fx(db: Database) -> int:
    n = 0
    for ticker in FX_TICKERS.values():
        n += fetch_spot_history(db, ticker, period="2y")
    return n


def fetch_all_curves(db: Database) -> dict[str, int]:
    """Fetch every currency curve and the FX rates; one failure doesn't block the others but is still raised."""
    out: dict[str, int] = {}
    errors: list[str] = []
    for name, fn in (("USD", fetch_treasury_curve), ("EUR", fetch_ecb_curve), ("FX", fetch_fx)):
        try:
            out[name] = fn(db)
        except Exception as exc:
            errors.append(f"{name}: {exc!r}")
    if errors:
        raise RuntimeError(f"stored {out}, failed {errors}")
    return out


def curve_from_quotes(tenors, rates, quote_type: str = "par", interpolation=None):
    """Discount curve from stored quotes: zero rates are used directly, par yields are bootstrapped."""
    from qplat.curves import InterpolatedCurve, Interpolation

    interpolation = interpolation or Interpolation.LOGLINEAR_DF
    if quote_type == "zero":
        t = np.asarray(tenors, dtype=float)
        return InterpolatedCurve(t, np.exp(-np.asarray(rates, dtype=float) * t), interpolation)
    return curve_from_par_yields(tenors, rates, interpolation)


def curve_from_par_yields(tenors, rates, interpolation=None):
    """Bootstrap a discount curve from Treasury par yields.

    Bills (<= 6M) are treated as simple-yield deposits (ACT/365F accrual);
    coupon tenors as semi-annual par bonds.
    """
    from qplat.curves import DepositQuote, Interpolation, ParRateQuote, bootstrap_curve

    quotes = []
    for t, r in zip(tenors, rates):
        if t <= 0.5:
            quotes.append(DepositQuote(float(t), float(r), accrual_basis=1.0))
        else:
            quotes.append(ParRateQuote(float(t), float(r), frequency=2))
    return bootstrap_curve(quotes, interpolation or Interpolation.LOGLINEAR_DF)
