"""Book of positions: valuation, aggregated Greeks, stress scenarios, VaR and P&L explain.

The engine is data-agnostic: it receives a `MarketSnapshot` (spots, vol term
structures, dividends, curves, FX) and a list of `Position`s. Scenarios are new
snapshots (shocked spots / vols / curves) and every scenario is a full
revaluation with the same pricers as the rest of the platform.
"""

from __future__ import annotations

import dataclasses
import math
from dataclasses import dataclass, field
from datetime import date
from typing import Callable

import numpy as np

from qplat.core.conventions import year_fraction
from qplat.curves.rate_curve import RateCurve
from qplat.instruments import (
    AmericanOption, Autocallable, BarrierOption, EquityFuture, EuropeanOption, FixedRateBond,
)
from qplat.pricers import (
    AnalyticBarrierPricer, BinomialTreePricer, BlackScholesPricer, DiscountingBondPricer, FuturesPricer,
    MonteCarloAutocallPricer,
)

KINDS = ("equity", "option", "barrier", "autocall", "bond", "future")


@dataclass(frozen=True)
class Position:
    id: int | None
    kind: str
    quantity: float
    ticker: str | None = None          # underlying (None for bonds)
    params: dict = field(default_factory=dict)
    entry_price: float | None = None   # per unit, in the instrument currency
    book: str = "Principal"
    label: str = ""


@dataclass
class MarketSnapshot:
    valuation_date: date
    spots: dict[str, float]
    vols: dict[str, Callable[[float], float]]     # ticker -> ATM vol as a function of maturity
    dividends: dict[str, float]
    currencies: dict[str, str]                    # ticker -> currency
    curves: dict[str, RateCurve]                  # currency -> curve
    fx_to_base: dict[str, float]                  # currency -> units of base currency per unit
    base_currency: str = "EUR"

    def shocked(self, spot_shift: float = 0.0, vol_shift: float = 0.0, rate_shift: float = 0.0,
                spot_moves: dict[str, float] | None = None) -> "MarketSnapshot":
        """Relative spot shock (all underlyings, or per ticker), absolute vol and parallel rate shifts."""
        spots = {t: s * (1 + (spot_moves or {}).get(t, spot_shift)) for t, s in self.spots.items()}
        vols = {t: (lambda T, f=f: max(f(T) + vol_shift, 0.01)) for t, f in self.vols.items()}
        curves = {c: (cv.shifted(rate_shift) if rate_shift else cv) for c, cv in self.curves.items()}
        return dataclasses.replace(self, spots=spots, vols=vols, curves=curves)


@dataclass
class Valuation:
    position: Position
    currency: str
    unit_price: float
    market_value: float          # instrument currency
    market_value_base: float     # base currency
    pnl_base: float | None
    delta: float                 # shares-equivalent
    delta_cash_base: float       # delta * spot, base currency
    gamma_cash_base: float       # P&L of the gamma term for a 1% move: 0.5 * gamma * (S * 1%)^2
    vega_base: float             # per 1 vol point
    theta_base: float            # per calendar day
    rho_base: float              # per 1% parallel rate shift (bonds: -100 * DV01)
    dv01_base: float
    description: str
    error: str | None = None


def _T(snapshot: MarketSnapshot, iso: str) -> float:
    return year_fraction(snapshot.valuation_date, date.fromisoformat(iso))


def describe(p: Position) -> str:
    q = p.params
    if p.kind == "equity":
        return f"Action {p.ticker}"
    if p.kind == "option":
        style = "américain" if q.get("exercise") == "american" else "européen"
        return f"{q['option_type'].capitalize()} {style} {p.ticker} K={q['strike']:g} éch. {q['expiry']}"
    if p.kind == "barrier":
        return f"{q['option_type'].capitalize()} {q['barrier_type']} {p.ticker} K={q['strike']:g} H={q['barrier']:g} éch. {q['expiry']}"
    if p.kind == "autocall":
        return (f"Autocall {p.ticker} {q['maturity_years']:g} ans, coupon {100 * q['coupon_rate']:.2f} % / période, "
                f"protection {100 * q['protection_barrier']:.0f} %")
    if p.kind == "bond":
        return f"Obligation {q['currency']} {100 * q['coupon_rate']:.3f} % éch. {q['maturity']}"
    if p.kind == "future":
        return f"Future {p.ticker} éch. {q['expiry']} (×{q.get('multiplier', 1):g})"
    return p.kind


def _autocall_times(snapshot: MarketSnapshot, q: dict) -> tuple[float, ...]:
    start = date.fromisoformat(q["start_date"])
    elapsed = year_fraction(start, snapshot.valuation_date)
    n = int(round(q["maturity_years"] * q["frequency"]))
    times = [(i + 1) / q["frequency"] - elapsed for i in range(n)]
    return tuple(t for t in times if t > 1 / 365)


def value_position(p: Position, m: MarketSnapshot, mc_paths: int = 20_000) -> Valuation:
    """Price one position and its Greeks (desk units), converted to the base currency."""
    q = p.params
    mult = float(q.get("multiplier", 1.0))
    if p.kind == "bond":
        ccy = q["currency"]
    else:
        ccy = m.currencies.get(p.ticker, "USD")
    fx = m.fx_to_base.get(ccy, 1.0)
    scale = p.quantity * mult * fx
    zero = dict(delta=0.0, delta_cash_base=0.0, gamma_cash_base=0.0, vega_base=0.0, theta_base=0.0, rho_base=0.0, dv01_base=0.0)

    def result(unit_price: float, **greeks) -> Valuation:
        mv = unit_price * p.quantity * mult
        pnl = None if p.entry_price is None else (unit_price - p.entry_price) * p.quantity * mult * fx
        return Valuation(p, ccy, unit_price, mv, mv * fx, pnl, description=describe(p), **{**zero, **greeks})

    try:
        if p.kind == "bond":
            T = _T(m, q["maturity"])
            if T <= 0:
                return result(0.0)
            bond = FixedRateBond(maturity=T, coupon_rate=q["coupon_rate"], frequency=int(q.get("frequency", 2)),
                                 face=q.get("face", 100.0))
            pricer = DiscountingBondPricer(m.curves[ccy])
            dirty = pricer.dirty_price(bond)
            bp = 1e-4
            dv01 = (pricer.dirty_price(bond, m.curves[ccy].shifted(-bp)) - pricer.dirty_price(bond, m.curves[ccy].shifted(bp))) / 2
            theta = (DiscountingBondPricer(m.curves[ccy]).dirty_price(dataclasses.replace(bond, maturity=T - 1 / 365)) - dirty)
            return result(dirty, dv01_base=dv01 * scale, rho_base=-100 * dv01 * scale, theta_base=theta * scale)

        spot = m.spots[p.ticker]
        div = m.dividends.get(p.ticker, 0.0)
        curve = m.curves[ccy]

        if p.kind == "equity":
            return result(spot, delta=p.quantity * mult, delta_cash_base=spot * scale)

        if p.kind == "future":
            T = _T(m, q["expiry"])
            fut = EquityFuture(spot=spot, maturity=max(T, 1e-6), dividend_yield=div)
            f = FuturesPricer(curve).price(fut)
            # a future has no upfront value: its P&L is (F - entry) on the notional
            dfd = float(math.exp(-div * T))
            entry = p.entry_price if p.entry_price is not None else f
            val = Valuation(p, ccy, f, (f - entry) * p.quantity * mult, (f - entry) * scale,
                            (f - entry) * scale, description=describe(p), **zero)
            val.delta = dfd / float(curve.discount(T)) * p.quantity * mult
            val.delta_cash_base = val.delta * spot * fx
            return val

        if p.kind == "autocall":
            times = _autocall_times(m, q)
            if not times:
                return result(0.0, )
            vol = m.vols[p.ticker](times[-1])
            inst = Autocallable(spot=spot, vol=vol, rate=curve, dividend_yield=div, observation_times=times,
                                notional=q.get("notional", 100.0), coupon_rate=q["coupon_rate"],
                                autocall_barrier=q["autocall_barrier"], coupon_barrier=q["coupon_barrier"],
                                protection_barrier=q["protection_barrier"], memory=q.get("memory", True),
                                initial_level=q["initial_level"])
            pricer = MonteCarloAutocallPricer(n_paths=mc_paths)
        else:
            T = _T(m, q["expiry"])
            if T <= 0:
                return result(0.0)
            vol = m.vols[p.ticker](T)
            common = dict(spot=spot, vol=vol, rate=curve, dividend_yield=div, strike=q["strike"], expiry=T,
                          option_type=q["option_type"])
            if p.kind == "option":
                if q.get("exercise") == "american":
                    inst, pricer = AmericanOption(**common), BinomialTreePricer(steps=200)
                else:
                    inst, pricer = EuropeanOption(**common), BlackScholesPricer()
            elif p.kind == "barrier":
                inst = BarrierOption(**common, barrier=q["barrier"], barrier_type=q["barrier_type"],
                                     rebate=q.get("rebate", 0.0), monitoring_per_year=q.get("monitoring_per_year"))
                pricer = AnalyticBarrierPricer()
            else:
                raise ValueError(f"unknown position kind {p.kind}")

        g = pricer.greeks(inst).scaled()
        return result(
            g["price"],
            delta=g["delta"] * p.quantity * mult,
            delta_cash_base=g["delta"] * spot * scale,
            gamma_cash_base=0.5 * g["gamma"] * (0.01 * spot) ** 2 * scale,
            vega_base=g["vega (1%)"] * scale,
            theta_base=g["theta (1d)"] * scale,
            rho_base=g["rho (1%)"] * scale,
        )
    except Exception as exc:  # one bad position must not break the whole book
        return Valuation(p, ccy, float("nan"), float("nan"), 0.0, None, description=describe(p), error=str(exc), **zero)


def value_book(positions: list[Position], m: MarketSnapshot, mc_paths: int = 20_000) -> list[Valuation]:
    return [value_position(p, m, mc_paths) for p in positions]


def book_value(positions: list[Position], m: MarketSnapshot, mc_paths: int = 20_000) -> float:
    return float(sum(v.market_value_base for v in value_book(positions, m, mc_paths) if v.error is None))


# ----------------------------------------------------------------------------- risk

def aggregate(valuations: list[Valuation], key: Callable[[Valuation], str]) -> list[dict]:
    groups: dict[str, dict] = {}
    for v in valuations:
        if v.error:
            continue
        g = groups.setdefault(key(v), {"key": key(v), "market_value": 0.0, "pnl": 0.0, "delta_cash": 0.0,
                                       "gamma_cash": 0.0, "vega": 0.0, "theta": 0.0, "rho": 0.0, "dv01": 0.0, "n": 0})
        g["market_value"] += v.market_value_base
        g["pnl"] += v.pnl_base or 0.0
        g["delta_cash"] += v.delta_cash_base
        g["gamma_cash"] += v.gamma_cash_base
        g["vega"] += v.vega_base
        g["theta"] += v.theta_base
        g["rho"] += v.rho_base
        g["dv01"] += v.dv01_base
        g["n"] += 1
    return sorted(groups.values(), key=lambda g: -abs(g["market_value"]))


SPOT_SHOCKS = (-0.20, -0.10, -0.05, -0.02, 0.0, 0.02, 0.05, 0.10, 0.20)
VOL_SHOCKS = (-0.05, 0.0, 0.05, 0.10)
RATE_SHOCKS = (-0.01, -0.005, 0.005, 0.01)


def stress_grid(positions: list[Position], m: MarketSnapshot, mc_paths: int = 10_000) -> dict:
    """Full revaluation P&L for joint equity / vol shocks, and for parallel rate shocks."""
    base = book_value(positions, m, mc_paths)
    grid = [[book_value(positions, m.shocked(spot_shift=s, vol_shift=v), mc_paths) - base for s in SPOT_SHOCKS]
            for v in VOL_SHOCKS]
    rates = [{"shift": r, "pnl": book_value(positions, m.shocked(rate_shift=r), mc_paths) - base} for r in RATE_SHOCKS]
    return {"base_value": base, "spot_shocks": list(SPOT_SHOCKS), "vol_shocks": list(VOL_SHOCKS), "pnl": grid,
            "rate_shocks": rates}


def historical_var(valuations: list[Valuation], returns: dict[str, np.ndarray], spots: dict[str, float],
                   levels=(0.95, 0.99)) -> dict:
    """1-day VaR / Expected Shortfall from historical joint returns, delta-gamma revaluation per underlying.

    `returns[t]` are aligned daily log-returns. P&L_s = sum_t delta_cash_t r + 0.5 * Gamma_t S_t^2 r^2,
    with Gamma_t S_t^2 recovered from the 1% gamma cash (gamma_cash = 0.5 Gamma S^2 1e-4).
    """
    by_ticker = aggregate([v for v in valuations if v.position.ticker], lambda v: v.position.ticker)
    tickers = [g["key"] for g in by_ticker if g["key"] in returns]
    if not tickers:
        return {"n_scenarios": 0}
    r = np.column_stack([np.expm1(returns[t]) for t in tickers])           # simple returns
    delta = np.array([next(g for g in by_ticker if g["key"] == t)["delta_cash"] for t in tickers])
    gamma_s2 = np.array([next(g for g in by_ticker if g["key"] == t)["gamma_cash"] for t in tickers]) * 2 / 1e-4
    pnl = r @ delta + 0.5 * (r * r) @ gamma_s2
    out = {"n_scenarios": int(len(pnl)), "tickers": tickers}
    for lvl in levels:
        var = -float(np.quantile(pnl, 1 - lvl))
        tail = pnl[pnl <= -var]
        out[f"var_{int(lvl * 100)}"] = var
        out[f"es_{int(lvl * 100)}"] = -float(tail.mean()) if len(tail) else var
    # delta-normal (parametric) VaR on the same history
    cov = np.cov(r, rowvar=False) if len(tickers) > 1 else np.array([[np.var(r[:, 0], ddof=1)]])
    sigma = float(np.sqrt(delta @ cov @ delta))
    out["parametric_var_95"] = 1.6449 * sigma
    out["parametric_var_99"] = 2.3263 * sigma
    counts, edges = np.histogram(pnl, bins=50)
    out["histogram"] = {"edges": edges.tolist(), "counts": counts.tolist()}
    worst = np.argsort(pnl)[:5]
    out["worst_scenarios"] = [{"index": int(i), "pnl": float(pnl[i])} for i in worst]
    return out


def pnl_explain(positions: list[Position], m_prev: MarketSnapshot, m_now: MarketSnapshot, mc_paths: int = 20_000) -> dict:
    """Day-on-day P&L split into delta, gamma, theta and an unexplained residual (spot moves only)."""
    prev = value_book(positions, m_prev, mc_paths)
    now = value_book(positions, m_now, mc_paths)
    rows = []
    totals = {"actual": 0.0, "delta": 0.0, "gamma": 0.0, "theta": 0.0, "residual": 0.0}
    for vp, vn in zip(prev, now):
        if vp.error or vn.error:
            continue
        t = vp.position.ticker
        ret = (m_now.spots[t] / m_prev.spots[t] - 1) if t in m_now.spots and t in m_prev.spots else 0.0
        actual = vn.market_value_base - vp.market_value_base
        delta = vp.delta_cash_base * ret
        gamma = vp.gamma_cash_base * (ret / 0.01) ** 2
        theta = vp.theta_base * max((m_now.valuation_date - m_prev.valuation_date).days, 0)
        residual = actual - delta - gamma - theta
        rows.append({"id": vp.position.id, "description": vp.description, "return": ret, "actual": actual,
                     "delta": delta, "gamma": gamma, "theta": theta, "residual": residual})
        for k, v in (("actual", actual), ("delta", delta), ("gamma", gamma), ("theta", theta), ("residual", residual)):
            totals[k] += v
    return {"rows": rows, "totals": totals}
