"""Market data fetchers: spots, ticker metadata, option chains (yfinance),
US Treasury par yields (US Treasury daily CSV, then FRED, then yfinance), euro-area AAA
zero-coupon curve (ECB data API) and long short-rate histories (Ornstein-Uhlenbeck / Vasicek lab)."""

from __future__ import annotations

import io
import math
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


# US Treasury daily par yield curve, one CSV per calendar year since 1990 (the same yields FRED republishes)
TREASURY_URL = ("https://home.treasury.gov/resource-center/data-chart-center/interest-rates/daily-treasury-rates.csv/"
                "{year}/all?type=daily_treasury_yield_curve&field_tdr_date_value={year}&page&_format=csv")
TREASURY_COLUMNS = {"1 Mo": 1 / 12, "3 Mo": 0.25, "6 Mo": 0.5, "1 Yr": 1.0, "2 Yr": 2.0, "3 Yr": 3.0,
                    "5 Yr": 5.0, "7 Yr": 7.0, "10 Yr": 10.0, "20 Yr": 20.0, "30 Yr": 30.0}
TREASURY_FIRST_YEAR = 1990


def treasury_year(year: int) -> pd.DataFrame:
    """Par yields (fractions) of one calendar year, indexed by ISO date, columns = tenors in years."""
    raw = _http_get(TREASURY_URL.format(year=year), timeout=60)
    df = pd.read_csv(io.BytesIO(raw))
    df["Date"] = pd.to_datetime(df["Date"], format="%m/%d/%Y").dt.strftime("%Y-%m-%d")
    keep = {c: t for c, t in TREASURY_COLUMNS.items() if c in df.columns}
    out = df.set_index("Date")[list(keep)].rename(columns=keep).apply(pd.to_numeric, errors="coerce") / 100.0
    return out.sort_index()


def fetch_treasury_official(db: Database, lookback_days: int = 30) -> int:
    """Today's curve from the Treasury itself: one request, full curve (FRED often times out)."""
    year = datetime.now(timezone.utc).year
    df = treasury_year(year)
    if len(df) < lookback_days:  # early January: add the end of last year
        df = pd.concat([treasury_year(year - 1), df])
    df = df.dropna().tail(lookback_days)  # complete curves only
    rows = [{"asof": d, "tenor_years": float(t), "rate": float(v), "source": "Treasury",
             "currency": "USD", "quote_type": "par"}
            for d, vals in df.iterrows() for t, v in vals.items()]
    if not rows:
        raise ValueError("no complete Treasury curve")
    return db.upsert_rates(rows)


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
    """US Treasury first, then FRED, then yfinance: each failure degrades to the next source."""
    for name, fn in (("Treasury", fetch_treasury_official), ("FRED", fetch_treasury_fred)):
        try:
            return fn(db)
        except Exception as exc:  # network / format issue -> degrade gracefully
            log.warning("%s fetch failed (%s), trying the next source", name, exc)
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
VOL_INDEX_TICKERS = {"VIX": "^VIX"}   # CBOE 30-day implied vol of the S&P 500 (variance swap page)


def fetch_fx(db: Database) -> int:
    n = 0
    for ticker in FX_TICKERS.values():
        n += fetch_spot_history(db, ticker, period="2y")
    return n


def fetch_vol_indices(db: Database) -> int:
    return sum(fetch_spot_history(db, t, period="2y") for t in VOL_INDEX_TICKERS.values())


def fetch_all_curves(db: Database) -> dict[str, int]:
    """Fetch every currency curve and the FX rates; one failure doesn't block the others but is still raised."""
    out: dict[str, int] = {}
    errors: list[str] = []
    for name, fn in (("USD", fetch_treasury_curve), ("EUR", fetch_ecb_curve), ("FX", fetch_fx),
                     ("VOL", fetch_vol_indices)):
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


# --- Fama-French factors (Kenneth French data library) -------------------------------

FRENCH_URL = "https://mba.tuck.dartmouth.edu/pages/faculty/ken.french/ftp/"
FRENCH_FILES = {
    "F-F_Research_Data_Factors_daily_CSV.zip": {"Mkt-RF": "mkt_rf", "SMB": "smb", "HML": "hml", "RF": "rf"},
    "F-F_Research_Data_5_Factors_2x3_daily_CSV.zip": {"RMW": "rmw", "CMA": "cma"},
    "F-F_Momentum_Factor_daily_CSV.zip": {"Mom": "mom"},
}
FACTORS_MAX_AGE_DAYS = 7


def _read_french_csv(raw: bytes, columns: dict[str, str]) -> pd.DataFrame:
    """The French CSVs have a text preamble, a header line starting with ',' and values in percent."""
    import zipfile

    text = zipfile.ZipFile(io.BytesIO(raw)).read(zipfile.ZipFile(io.BytesIO(raw)).namelist()[0]).decode("latin-1")
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith(",") and any(c in line for c in columns))
    body = []
    for line in lines[start + 1:]:
        if not line.strip() or not line.strip()[0].isdigit():
            break
        body.append(line)
    header = [h.strip() for h in lines[start].split(",")]
    frame = pd.read_csv(io.StringIO("\n".join(body)), header=None, names=["date"] + header[1:], skipinitialspace=True)
    frame["date"] = pd.to_datetime(frame["date"].astype(str), format="%Y%m%d").dt.strftime("%Y-%m-%d")
    frame = frame.set_index("date")
    keep = {k: v for k, v in columns.items() if k in frame.columns}
    return frame[list(keep)].rename(columns=keep) / 100.0


def fetch_ff_factors(db: Database, force: bool = False) -> str:
    """Daily Fama-French factors (market, size, value, profitability, investment, momentum, T-bill) since 1926."""
    last = db.query("SELECT MAX(ts) AS d FROM refresh_log WHERE job='factors' AND status='ok'") if not force else None
    if last is not None and last["d"].iloc[0]:
        ts = datetime.fromisoformat(last["d"].iloc[0])
        age = datetime.now(timezone.utc) - (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc))
        if age.days < FACTORS_MAX_AGE_DAYS and not db.factors().empty:
            return "fresh"
    n = 0
    for name, cols in FRENCH_FILES.items():
        req = urllib.request.Request(FRENCH_URL + name, headers={"User-Agent": "Mozilla/5.0 (research data download)"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            n = max(n, db.upsert_factors(_read_french_csv(resp.read(), cols)))
    return f"{n} days"


# --- short-rate histories (Ornstein-Uhlenbeck / Vasicek lab) -------------------------

SHORT_RATES_MAX_AGE_DAYS = 7
ECB_SHORT_URL = "https://data-api.ecb.europa.eu/service/data/YC/B.U2.EUR.4F.G_N_A.SV_C_YM.SR_3M?format=csvdata"


def fetch_short_rates(db: Database, force: bool = False) -> str:
    """3-month rates over decades: US Treasury bills since 1990 (bond-equivalent yield, as published) and the
    euro-area AAA 3-month zero rate since 2004 (ECB). Refreshed once a week, only the years still missing."""
    last = db.query("SELECT MAX(ts) AS d FROM refresh_log WHERE job='short_rates' AND status='ok'") if not force else None
    if last is not None and last["d"].iloc[0]:
        ts = datetime.fromisoformat(last["d"].iloc[0])
        age = datetime.now(timezone.utc) - (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc))
        if age.days < SHORT_RATES_MAX_AGE_DAYS and not db.short_rates("USD_3M").empty:
            return "fresh"
    report = []
    stored = db.short_rates("USD_3M")
    first = TREASURY_FIRST_YEAR if stored.empty else int(stored.index[-1][:4])
    rows = []
    for year in range(first, datetime.now(timezone.utc).year + 1):
        col = treasury_year(year).get(0.25)
        if col is not None:
            rows += [{"series": "USD_3M", "date": d, "rate": float(v)} for d, v in col.dropna().items()]
    report.append(f"USD {db.upsert_short_rates(rows)}")
    try:
        df = pd.read_csv(io.BytesIO(_http_get(ECB_SHORT_URL, timeout=90)), usecols=["TIME_PERIOD", "OBS_VALUE"]).dropna()
        report.append(f"EUR {db.upsert_short_rates([{'series': 'EUR_3M', 'date': r.TIME_PERIOD, 'rate': r.OBS_VALUE / 100.0} for r in df.itertuples(index=False)])}")
    except Exception as exc:  # the USD history is still usable
        log.warning("ECB short-rate history failed (%s)", exc)
        report.append("EUR failed")
    return ", ".join(report)


# --- Shiller long-run S&P composite (predictive-regression lab) ---------------------

SHILLER_PAGE = "https://shillerdata.com/"
SHILLER_FALLBACK = "http://www.econ.yale.edu/~shiller/data/ie_data.xls"  # frozen in mid-2023
SHILLER_MAX_AGE_DAYS = 7


def _shiller_url() -> str:
    """The workbook on shillerdata.com sits behind a versioned link: read it from the page."""
    import re

    html = _http_get(SHILLER_PAGE, timeout=30).decode("utf-8", "ignore")
    m = re.search(r'href="([^"]*ie_data\.xls[^"]*)"', html)
    if not m:
        raise ValueError("lien ie_data.xls introuvable sur shillerdata.com")
    url = m.group(1)
    return "https:" + url if url.startswith("//") else url


def parse_shiller(raw: bytes) -> pd.DataFrame:
    """Monthly rows of Shiller's ie_data.xls (sheet Data). The date is written as a decimal year.month
    (1871.01 ... 1871.1 for October), so the month is rebuilt from the decimal part."""
    df = pd.read_excel(io.BytesIO(raw), sheet_name="Data", header=7, usecols=["Date", "P", "D", "E", "CPI", "Rate GS10"])
    df = df[pd.to_numeric(df["Date"], errors="coerce").notna() & pd.to_numeric(df["P"], errors="coerce").notna()]
    keys = [shiller_month(float(d)) for d in df["Date"]]
    num = lambda c: pd.to_numeric(df[c], errors="coerce").to_numpy()
    out = pd.DataFrame({"month": keys, "price": num("P"), "dividend": num("D"), "earnings": num("E"),
                        "cpi": num("CPI"), "gs10": num("Rate GS10") / 100.0})
    return out.dropna(subset=["month"]).drop_duplicates("month", keep="last").reset_index(drop=True)


def shiller_month(d: float) -> str | None:
    """Shiller's decimal date year.month -> 'YYYY-MM' (1871.1 is October 1871, 1871.01 January)."""
    year = int(math.floor(d + 1e-9))
    month = int(round((d - year) * 100))
    return f"{year:04d}-{month:02d}" if 1 <= month <= 12 else None


def fetch_shiller(db: Database, force: bool = False) -> str:
    """S&P composite price, dividends and earnings since 1871 (Robert Shiller, monthly). Refreshed once a week."""
    last = db.query("SELECT MAX(ts) AS d FROM refresh_log WHERE job='shiller' AND status='ok'") if not force else None
    if last is not None and last["d"].iloc[0]:
        ts = datetime.fromisoformat(last["d"].iloc[0])
        age = datetime.now(timezone.utc) - (ts if ts.tzinfo else ts.replace(tzinfo=timezone.utc))
        if age.days < SHILLER_MAX_AGE_DAYS and not db.shiller().empty:
            return "fresh"
    try:
        raw = _http_get(_shiller_url(), timeout=90)
    except Exception as exc:
        log.warning("shillerdata.com failed (%s), using the Yale copy", exc)
        raw = _http_get(SHILLER_FALLBACK, timeout=90)
    df = parse_shiller(raw)
    rows = [{k: (None if isinstance(v, float) and not np.isfinite(v) else v) for k, v in r.items()}
            for r in df.to_dict("records")]
    n = db.upsert_shiller(rows)
    return f"{n} months, last dividend {df.dropna(subset=['dividend'])['month'].iloc[-1]}"
