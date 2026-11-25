"""Implied-volatility smile from a stored option chain snapshot."""

from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from qplat.curves.rate_curve import RateCurve
from qplat.pricers.black_scholes import implied_volatility

EXPIRY_CLOSE_TZ = ZoneInfo("America/New_York")  # listed US options expire at the 16:00 NY close


def compute_smile(chain: pd.DataFrame, dividend_yield: float, curve: RateCurve,
                  moneyness_range: tuple[float, float] = (0.7, 1.3), min_days: float = 2.0) -> pd.DataFrame:
    """OTM options, mid bid/ask (last trade if no two-sided quote), IV by Brent on Black-Scholes.

    Returns one row per option with columns: expiry, T, option_type, strike, moneyness, mid, iv, vendor_iv.
    """
    if chain.empty or not chain["spot"].notna().any():
        return pd.DataFrame(columns=["expiry", "T", "option_type", "strike", "moneyness", "mid", "iv", "vendor_iv"])
    df = chain.copy()
    spot = float(df["spot"].dropna().iloc[0])
    asof = pd.to_datetime(df["asof"].iloc[0], utc=True)
    expiry_close = pd.to_datetime(df["expiry"]).map(
        lambda d: datetime(d.year, d.month, d.day, 16, tzinfo=EXPIRY_CLOSE_TZ))
    df["T"] = [(e - asof).total_seconds() / (365 * 86400) for e in expiry_close]
    two_sided = (df["bid"] > 0) & (df["ask"] > 0)
    df["mid"] = np.where(two_sided, (df["bid"] + df["ask"]) / 2, df["last"])
    df["moneyness"] = df["strike"] / spot
    otm = (((df["option_type"] == "call") & (df["strike"] >= spot))
           | ((df["option_type"] == "put") & (df["strike"] < spot)))
    lo, hi = moneyness_range
    df = df[otm & (df["T"] > min_days / 365) & (df["mid"] > 0) & df["moneyness"].between(lo, hi)].copy()
    df["iv"] = [
        implied_volatility(r.mid, spot, r.strike, r.T, float(curve.zero_rate(r.T)), dividend_yield, r.option_type)
        for r in df.itertuples()
    ]
    cols = ["expiry", "T", "option_type", "strike", "moneyness", "mid", "iv", "vendor_iv"]
    return df.dropna(subset=["iv"]).sort_values(["expiry", "strike"])[cols].reset_index(drop=True)


def atm_term_structure(smile: pd.DataFrame) -> pd.DataFrame:
    """Per expiry, the IV of the strike closest to the money."""
    if smile.empty:
        return pd.DataFrame(columns=["expiry", "T", "iv"])
    closest = smile.assign(dist=(smile["moneyness"] - 1).abs()).sort_values("dist").groupby("expiry").first()
    return closest.reset_index()[["expiry", "T", "iv"]].sort_values("T").reset_index(drop=True)
