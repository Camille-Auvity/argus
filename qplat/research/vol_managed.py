"""Volatility-managed portfolios (Moreira & Muir, 2017, "Volatility-Managed Portfolios", Journal of Finance).

For a factor with monthly excess return f_{t+1}, the managed portfolio scales the exposure by the inverse of the
previous month's realised variance:

    f^sigma_{t+1} = (c / RV_t) f_{t+1},        RV_t = sum_{d in month t} (f_d - mean_t(f))^2

c is a constant such that f^sigma and f have the same unconditional volatility (in-sample, as in the paper),
or, in the real-time version, a constant estimated only on past data. The test is the time-series regression

    f^sigma_{t+1} = alpha + beta f_{t+1} + eps_{t+1}

A positive alpha means that the managed strategy expands the mean-variance frontier: volatility forecasts risk
much better than it forecasts returns, so cutting exposure after volatile months improves the Sharpe ratio.
"""

from __future__ import annotations

import math
from dataclasses import dataclass

import numpy as np
import pandas as pd

FACTOR_LABELS = {"mkt_rf": "Marché (Mkt-RF)", "smb": "Taille (SMB)", "hml": "Valeur (HML)", "mom": "Momentum (Mom)",
                 "rmw": "Rentabilité (RMW)", "cma": "Investissement (CMA)"}


# ----------------------------------------------------------------------------- monthly panel

def monthly_panel(daily: pd.DataFrame, factor: str) -> pd.DataFrame:
    """Monthly excess return (compounded daily excess returns) and within-month realised variance (demeaned)."""
    s = daily[factor].dropna()
    month = pd.PeriodIndex(pd.to_datetime(s.index), freq="M")
    g = s.groupby(month)
    n = g.size()
    out = pd.DataFrame({
        "ret": np.expm1(np.log1p(s).groupby(month).sum()),
        "rv": g.var(ddof=0) * n,                     # sum of squared deviations from the monthly mean
        "days": n,
    })
    return out[out["days"] >= 10]                    # incomplete first / last months


class Panels(dict):
    """Monthly panels of every factor, computed once per daily frame."""

    def __init__(self, daily: pd.DataFrame):
        super().__init__({c: monthly_panel(daily, c) for c in FACTOR_LABELS if c in daily.columns})


# ----------------------------------------------------------------------------- statistics

def ols_hac(y: np.ndarray, X: np.ndarray, lags: int = 6) -> dict:
    """OLS with Newey-West (Bartlett kernel) standard errors. X must include the constant column."""
    n, k = X.shape
    XtX_inv = np.linalg.inv(X.T @ X)
    beta = XtX_inv @ X.T @ y
    e = y - X @ beta
    Xe = X * e[:, None]
    S = Xe.T @ Xe
    for lag in range(1, lags + 1):
        w = 1 - lag / (lags + 1)
        G = Xe[lag:].T @ Xe[:-lag]
        S += w * (G + G.T)
    cov = XtX_inv @ S @ XtX_inv
    se = np.sqrt(np.diag(cov))
    ss_tot = np.sum((y - y.mean()) ** 2)
    return {"coef": beta, "se": se, "t": beta / se, "resid": e, "r2": float(1 - e @ e / ss_tot) if ss_tot > 0 else float("nan")}


def sharpe(monthly: np.ndarray) -> float:
    sd = monthly.std(ddof=1)
    return float(monthly.mean() / sd * math.sqrt(12)) if sd > 0 else float("nan")


def max_drawdown(monthly: np.ndarray) -> float:
    w = np.cumprod(1 + monthly)
    return float((w / np.maximum.accumulate(w) - 1).min())


# ----------------------------------------------------------------------------- strategy

@dataclass
class ManagedResult:
    factor: str
    dates: list[str]
    original: np.ndarray       # monthly excess returns f_{t+1}
    managed: np.ndarray        # managed excess returns (net of costs if any)
    weights: np.ndarray        # exposure c / RV_t applied to month t+1
    rv: np.ndarray             # lagged realised variance (annualised vol shown in the UI)
    c: float
    stats: dict


def manage(panel: pd.DataFrame, mode: str = "full", leverage_cap: float | None = None, cost_bp: float = 0.0,
           min_history: int = 120) -> tuple[pd.DataFrame, float]:
    """Exposure w_t = c / RV_{t-1} on the month t return. `mode` = "full" (c on the whole sample, as in the paper)
    or "realtime" (c_t from the expanding past only: no look-ahead). Costs charged on |w_t - w_{t-1}|."""
    df = pd.DataFrame({"ret": panel["ret"], "rv_lag": panel["rv"].shift(1)}).dropna()
    inv = 1.0 / df["rv_lag"]
    if mode == "full":
        c = float(df["ret"].std(ddof=1) / (df["ret"] * inv).std(ddof=1))
        w = c * inv
    else:
        raw = df["ret"] * inv
        # c_t chosen on the months strictly before t: std(f) / std(f / RV) over the past
        c_t = (df["ret"].expanding(min_history).std().shift(1) / raw.expanding(min_history).std().shift(1))
        w = c_t * inv
        c = float(c_t.dropna().iloc[-1]) if c_t.notna().any() else float("nan")
    if leverage_cap is not None:
        w = w.clip(upper=leverage_cap)
    df["w"] = w
    df = df.dropna()
    turnover = df["w"].diff().abs().fillna(df["w"].abs())
    df["managed"] = df["w"] * df["ret"] - cost_bp * 1e-4 * turnover
    return df, c


def analyse(daily: pd.DataFrame | Panels, factor: str, mode: str = "full", leverage_cap: float | None = None,
            cost_bp: float = 0.0, start: str | None = None, end: str | None = None, robustness: bool = True) -> ManagedResult:
    panels = daily if isinstance(daily, Panels) else Panels(daily)
    panel = panels[factor]
    if start:
        panel = panel[panel.index >= pd.Period(start, "M")]
    if end:
        panel = panel[panel.index <= pd.Period(end, "M")]
    if len(panel) < 36:
        raise ValueError("not enough months for this sample")
    df, c = manage(panel, mode, leverage_cap, cost_bp)
    f, fs = df["ret"].to_numpy(), df["managed"].to_numpy()
    X = np.column_stack([np.ones(len(f)), f])
    reg = ols_hac(fs, X)
    alpha_m, beta = reg["coef"]
    resid_sd = reg["resid"].std(ddof=2)

    # robustness: alpha controlling for the three Fama-French factors (when the factor panel is available)
    alpha_ff3 = None
    if robustness:
        # the factor itself is already a regressor
        others = {k: panels[k]["ret"] for k in ("mkt_rf", "smb", "hml") if k != factor and k in panels}
        ff = pd.DataFrame(others).reindex(df.index).dropna()
        if len(ff) > 36:
            m = df.loc[ff.index]
            reg3 = ols_hac(m["managed"].to_numpy(), np.column_stack([np.ones(len(ff)), m["ret"].to_numpy(), ff.to_numpy()]))
            alpha_ff3 = {"alpha": float(reg3["coef"][0] * 12), "t": float(reg3["t"][0])}

    w = df["w"].to_numpy()
    stats = {
        "months": int(len(df)), "start": str(df.index[0]), "end": str(df.index[-1]), "c": c,
        "alpha": float(alpha_m * 12), "alpha_t": float(reg["t"][0]), "beta": float(beta), "r2": reg["r2"],
        "appraisal": float(alpha_m / resid_sd * math.sqrt(12)) if resid_sd > 0 else float("nan"),
        "sharpe_original": sharpe(f), "sharpe_managed": sharpe(fs),
        "mean_original": float(f.mean() * 12), "mean_managed": float(fs.mean() * 12),
        "vol_original": float(f.std(ddof=1) * math.sqrt(12)), "vol_managed": float(fs.std(ddof=1) * math.sqrt(12)),
        "mdd_original": max_drawdown(f), "mdd_managed": max_drawdown(fs),
        "weight_median": float(np.median(w)), "weight_p90": float(np.quantile(w, 0.9)), "weight_max": float(w.max()),
        "weight_min": float(w.min()), "turnover": float(np.abs(np.diff(w)).mean()), "alpha_ff3": alpha_ff3,
    }
    return ManagedResult(factor, [str(p) for p in df.index], f, fs, w, df["rv_lag"].to_numpy(), c, stats)


def volatility_buckets(daily: pd.DataFrame | Panels, factor: str, n: int = 5) -> list[dict]:
    """Sort months on the previous month's realised variance: next-month mean, volatility and mean / variance.

    The paper's key fact: from low to high lagged volatility, the next-month variance rises much more than the
    mean, so the risk-return trade-off (mean / variance) falls."""
    panel = daily[factor] if isinstance(daily, Panels) else monthly_panel(daily, factor)
    df = pd.DataFrame({"ret": panel["ret"], "rv_lag": panel["rv"].shift(1), "rv": panel["rv"]}).dropna()
    df["bucket"] = pd.qcut(df["rv_lag"], n, labels=False)
    out = []
    for b, g in df.groupby("bucket"):
        mean_a = float(g["ret"].mean() * 12)
        var_a = float(g["ret"].var(ddof=1) * 12)
        out.append({"bucket": int(b) + 1, "mean": mean_a, "vol": math.sqrt(var_a), "mean_over_var": mean_a / var_a,
                    "lagged_vol": float(np.sqrt(g["rv_lag"].mean() * 12)), "months": int(len(g))})
    return out


def subperiods(daily: pd.DataFrame | Panels, factor: str, mode: str = "full", leverage_cap: float | None = None,
               cost_bp: float = 0.0) -> list[dict]:
    """Alpha of the managed strategy decade by decade (c re-estimated within each window in full mode)."""
    panels = daily if isinstance(daily, Panels) else Panels(daily)
    panel = panels[factor]
    first, last = panel.index[0].year, panel.index[-1].year
    out = []
    for y0 in range(first - first % 10, last + 1, 10):
        try:
            r = analyse(panels, factor, mode, leverage_cap, cost_bp, f"{max(y0, first)}-01", f"{y0 + 9}-12", robustness=False)
        except ValueError:
            continue
        out.append({"period": f"{max(y0, first)}–{min(y0 + 9, last)}", "alpha": r.stats["alpha"], "alpha_t": r.stats["alpha_t"],
                    "sharpe_original": r.stats["sharpe_original"], "sharpe_managed": r.stats["sharpe_managed"]})
    return out
