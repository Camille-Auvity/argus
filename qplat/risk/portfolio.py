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
from datetime import date, timedelta
from typing import Callable, Optional

import numpy as np

from qplat.core.conventions import year_fraction
from qplat.credit import CDS, cds_risk
from qplat.fx import FXMarket, build_smile, gk_greeks
from qplat.pricers.capfloor import strip_value
from qplat.curves.rate_curve import RateCurve
from qplat.instruments import (
    AmericanOption, AsianOption, Autocallable, BarrierOption, CliquetOption, DigitalOption, EquityFuture, EuropeanOption,
    FixedRateBond,
)
from qplat.pricers import (
    AnalyticBarrierPricer, AnalyticDigitalPricer, BinomialTreePricer, BlackScholesPricer, DiscountingBondPricer,
    FuturesPricer, GeometricAsianPricer, MonteCarloAutocallPricer, MonteCarloExoticPricer,
)

KINDS = ("equity", "option", "barrier", "digital", "asian", "cliquet", "autocall", "bond", "future", "cds", "capfloor", "fxoption")
FX_TICKER = "EURUSD=X"   # underlying of FX options: price of 1 EUR in USD
CDS_TENORS = (1.0, 2.0, 3.0, 5.0, 7.0, 10.0)


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
    # (ticker, date) -> close on or before that date: past fixings of Asians and cliquets
    past_close: Optional[Callable[[str, date], Optional[float]]] = None
    credit_spread_shift: float = 0.0              # parallel shift of every CDS spread curve (stress)
    vol_shift: float = 0.0                        # absolute vol shock, also applied to quoted FX smiles

    def fixing(self, ticker: str, d: date) -> float:
        """Observed level at a past fixing date (falls back to the current spot when no history is available)."""
        level = self.past_close(ticker, d) if self.past_close else None
        return float(level) if level else self.spots[ticker]

    def shocked(self, spot_shift: float = 0.0, vol_shift: float = 0.0, rate_shift: float = 0.0,
                spot_moves: dict[str, float] | None = None, spread_shift: float = 0.0) -> "MarketSnapshot":
        """Relative spot shock (all underlyings, or per ticker), absolute vol, rate and credit spread shifts."""
        spots = {t: s * (1 + (spot_moves or {}).get(t, spot_shift)) for t, s in self.spots.items()}
        vols = {t: (lambda T, f=f: max(f(T) + vol_shift, 0.01)) for t, f in self.vols.items()}
        curves = {c: (cv.shifted(rate_shift) if rate_shift else cv) for c, cv in self.curves.items()}
        return dataclasses.replace(self, spots=spots, vols=vols, curves=curves,
                                   credit_spread_shift=self.credit_spread_shift + spread_shift,
                                   vol_shift=self.vol_shift + vol_shift)


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
    cs01_base: float = 0.0       # +1 bp on the credit spreads (CDS)
    jtd_base: float = 0.0        # P&L if the reference entity defaults now (CDS)


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
    if p.kind == "capfloor":
        vol = (f"{1e4 * q['vol']:.0f} bp normale" if q.get("model", "bachelier") == "bachelier"
               else f"{100 * q['vol']:.1f} % log-normale")
        return (f"{q['cf_kind'].capitalize()} {q['currency']} {100 * q['strike']:.3f} % éch. {q['maturity']} "
                f"({ {1: 'annuel', 2: 'semestriel', 4: 'trimestriel', 12: 'mensuel'}[int(q['frequency'])] }, vol {vol})")
    if p.kind == "fxoption":
        side = "Call EUR / put USD" if q["option_type"] == "call" else "Put EUR / call USD"
        return f"{side} K={q['strike']:.4f} éch. {q['expiry']}"
    if p.kind == "cds":
        side = "achat" if p.quantity >= 0 else "vente"
        return f"CDS {q.get('reference', '')} {side} de protection, coupon {q['coupon_bp']:g} bp, éch. {q['maturity']}"
    if p.kind == "digital":
        what = "cash" if q.get("digital_kind", "cash-or-nothing") == "cash-or-nothing" else "asset"
        return f"Digitale {what} {q['option_type']} {p.ticker} K={q['strike']:g} éch. {q['expiry']}"
    if p.kind == "asian":
        avg = "géométrique" if q.get("averaging") == "geometric" else "arithmétique"
        return f"Asiatique {avg} {q['option_type']} {p.ticker} K={q['strike']:g}, {q['n_fixings']} fixings, éch. {q['expiry']}"
    if p.kind == "cliquet":
        bounds = []
        if q.get("local_floor") is not None:
            bounds.append(f"floor local {100 * q['local_floor']:g} %")
        if q.get("local_cap") is not None:
            bounds.append(f"cap local {100 * q['local_cap']:g} %")
        if q.get("global_floor") is not None:
            bounds.append(f"floor global {100 * q['global_floor']:g} %")
        return f"Cliquet {p.ticker} {q['maturity_years']:g} ans ({', '.join(bounds) or 'sans bornes'})"
    return p.kind


def _autocall_times(snapshot: MarketSnapshot, q: dict) -> tuple[float, ...]:
    start = date.fromisoformat(q["start_date"])
    elapsed = year_fraction(start, snapshot.valuation_date)
    n = int(round(q["maturity_years"] * q["frequency"]))
    times = [(i + 1) / q["frequency"] - elapsed for i in range(n)]
    return tuple(t for t in times if t > 1 / 365)


def asian_schedule(q: dict) -> list[date]:
    """Fixing dates evenly spread between the start date (excluded) and the expiry (included)."""
    start, end = date.fromisoformat(q["start_date"]), date.fromisoformat(q["expiry"])
    n = int(q["n_fixings"])
    return [start + timedelta(days=round((end - start).days * (i + 1) / n)) for i in range(n)]


def cliquet_schedule(q: dict) -> list[date]:
    start = date.fromisoformat(q["start_date"])
    n = int(round(q["maturity_years"] * q["frequency"]))
    return [start + timedelta(days=round(365 * (i + 1) / q["frequency"])) for i in range(n)]


def _seasoned_asian(p: Position, m: MarketSnapshot, common: dict) -> AsianOption | float:
    """Asian with its past fixings read from history; a float (the payoff) once every fixing is known."""
    q = p.params
    dates = asian_schedule(q)
    past = tuple(m.fixing(p.ticker, d) for d in dates if d <= m.valuation_date)
    future = tuple(_T(m, d.isoformat()) for d in dates if d > m.valuation_date)
    if not future:
        geometric = q.get("averaging") == "geometric"
        avg = float(np.exp(np.mean(np.log(past)))) if geometric else float(np.mean(past))
        phi = 1 if q["option_type"] == "call" else -1
        return max(phi * (avg - q["strike"]), 0.0)
    return AsianOption(**common, strike=q["strike"], option_type=q["option_type"],
                       averaging=q.get("averaging", "arithmetic"), fixing_times=future, past_fixings=past)


def _seasoned_cliquet(p: Position, m: MarketSnapshot, common: dict) -> CliquetOption | float:
    """Cliquet with completed periods accrued from history and the running period's reference frozen."""
    q = p.params
    dates = cliquet_schedule(q)
    levels = [float(q["initial_level"])] + [m.fixing(p.ticker, d) for d in dates if d <= m.valuation_date]
    future = tuple(_T(m, d.isoformat()) for d in dates if d > m.valuation_date)
    # with no reset left, a dummy future date only carries the accrued sum: path_payoff on zero dates
    inst = CliquetOption(**common, reset_times=future or (1.0,), local_floor=q.get("local_floor"),
                         local_cap=q.get("local_cap"), global_floor=q.get("global_floor"),
                         global_cap=q.get("global_cap"), notional=q.get("notional", 100.0), initial_level=levels[-1])
    accrued = float(sum(inst.clip_local(b / a - 1.0) for a, b in zip(levels, levels[1:])))
    inst = dataclasses.replace(inst, accrued=accrued)
    if not future:
        return float(inst.path_payoff(np.empty((1, 0)))[0])
    return inst


def capfloor_schedule(q: dict, valuation: date) -> tuple[np.ndarray, np.ndarray]:
    """Caplet periods (start, end) in years from the valuation date; the first period of the trade is excluded."""
    start = date.fromisoformat(q["start_date"])
    end = date.fromisoformat(q["maturity"])
    f = int(q["frequency"])
    n = max(int(round((end - start).days / 365 * f)), 2)
    dates = [start + timedelta(days=round((end - start).days * i / n)) for i in range(n + 1)]
    t = np.array([(d - valuation).days / 365 for d in dates])
    return t[1:-1], t[2:]


def _value_capfloor(p: Position, m: MarketSnapshot, ccy: str, scale: float, result) -> Valuation:
    q = p.params
    starts, ends = capfloor_schedule(q, m.valuation_date)
    if not np.any(ends > 0):
        return result(0.0)
    curve = m.curves[ccy]
    phi = 1 if q["cf_kind"] == "cap" else -1
    model = q.get("model", "bachelier")

    def value(cv=curve, vol=q["vol"], s=starts, e=ends):
        return strip_value(s, e, q["strike"], phi, cv, vol, model)

    v0 = value()
    bp = 1e-4
    dv01 = (value(cv=curve.shifted(-bp)) - value(cv=curve.shifted(bp))) / 2      # bond convention: gain for -1 bp
    unit = 0.01 if model == "black" else 1e-4
    vega = value(vol=q["vol"] + unit / 2) - value(vol=q["vol"] - unit / 2)
    theta = value(s=starts - 1 / 365, e=ends - 1 / 365) - v0
    return result(v0, dv01_base=dv01 * scale, rho_base=-100 * dv01 * scale, vega_base=vega * scale,
                  theta_base=theta * scale)


def _value_fx_option(p: Position, m: MarketSnapshot, scale: float, fx: float, result) -> Valuation:
    """EUR/USD option, quantity = EUR notional, priced on its quoted smile (ATM / RR / BF) at its strike."""
    q = p.params
    T = _T(m, q["expiry"])
    if T <= 0:
        return result(0.0)
    spot = m.spots[p.ticker]
    rd, rf = float(m.curves["USD"].zero_rate(T)), float(m.curves["EUR"].zero_rate(T))
    smile = build_smile(FXMarket(spot, T, rd, rf), q["atm"] + m.vol_shift, q.get("rr25", 0.0), q.get("bf25", 0.0))
    vol = smile.vol(q["strike"]) or q["atm"] + m.vol_shift
    phi = 1 if q["option_type"] == "call" else -1
    g = gk_greeks(spot, q["strike"], T, rd, rf, vol, phi)
    return result(
        g.price,
        delta=g.delta_spot * p.quantity,
        delta_cash_base=g.delta_spot * spot * scale,
        gamma_cash_base=0.5 * g.gamma * (0.01 * spot) ** 2 * scale,
        vega_base=g.vega / 100 * scale,
        theta_base=g.theta / 365 * scale,
        rho_base=(g.rho_domestic + g.rho_foreign) / 100 * scale,
    )


def value_position(p: Position, m: MarketSnapshot, mc_paths: int = 20_000) -> Valuation:
    """Price one position and its Greeks (desk units), converted to the base currency."""
    q = p.params
    mult = float(q.get("multiplier", 1.0))
    if p.kind in ("bond", "cds", "capfloor"):
        ccy = q["currency"]
    else:
        ccy = m.currencies.get(p.ticker, "USD")
    fx = m.fx_to_base.get(ccy, 1.0)
    scale = p.quantity * mult * fx
    zero = dict(delta=0.0, delta_cash_base=0.0, gamma_cash_base=0.0, vega_base=0.0, theta_base=0.0, rho_base=0.0, dv01_base=0.0,
                cs01_base=0.0, jtd_base=0.0)

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

        if p.kind == "cds":
            # quantity = notional (> 0: protection buyer); unit price = value per 1 of notional
            T = _T(m, q["maturity"])
            if T <= 0:
                return result(0.0)
            spreads = np.maximum(np.asarray(q["spreads_bp"], dtype=float) * 1e-4 + m.credit_spread_shift, 1e-7)
            cds = CDS(maturity=T, coupon=q["coupon_bp"] * 1e-4, recovery=q.get("recovery", 0.4))
            r, _ = cds_risk(cds, q.get("tenors", CDS_TENORS), spreads, m.curves[ccy], buyer=True)
            return result(r.value, cs01_base=r.cs01 * scale, jtd_base=r.jump_to_default * scale,
                          rho_base=100 * r.ir01 * scale, dv01_base=-r.ir01 * scale, theta_base=r.carry_1d * scale)

        if p.kind == "capfloor":
            return _value_capfloor(p, m, ccy, scale, result)

        if p.kind == "fxoption":
            return _value_fx_option(p, m, scale, fx, result)

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

        if p.kind in ("asian", "cliquet"):
            horizon = date.fromisoformat(q["expiry"]) if p.kind == "asian" else cliquet_schedule(q)[-1]
            vol = m.vols[p.ticker](max(_T(m, horizon.isoformat()), 1 / 365))
            common = dict(spot=spot, vol=vol, rate=curve, dividend_yield=div)
            inst = (_seasoned_asian if p.kind == "asian" else _seasoned_cliquet)(p, m, common)
            if isinstance(inst, float):  # every fixing observed: payoff known, paid at expiry (no more risk)
                return result(inst)
            geometric = p.kind == "asian" and inst.averaging.value == "geometric"
            pricer = GeometricAsianPricer() if geometric else MonteCarloExoticPricer(n_paths=mc_paths)
        elif p.kind == "autocall":
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
            elif p.kind == "digital":
                inst = DigitalOption(**common, kind=q.get("digital_kind", "cash-or-nothing"), cash=q.get("cash", 1.0))
                pricer = AnalyticDigitalPricer()
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
                                       "gamma_cash": 0.0, "vega": 0.0, "theta": 0.0, "rho": 0.0, "dv01": 0.0,
                                       "cs01": 0.0, "jtd": 0.0, "n": 0})
        g["market_value"] += v.market_value_base
        g["pnl"] += v.pnl_base or 0.0
        g["delta_cash"] += v.delta_cash_base
        g["gamma_cash"] += v.gamma_cash_base
        g["vega"] += v.vega_base
        g["theta"] += v.theta_base
        g["rho"] += v.rho_base
        g["dv01"] += v.dv01_base
        g["cs01"] += v.cs01_base
        g["jtd"] += v.jtd_base
        g["n"] += 1
    return sorted(groups.values(), key=lambda g: -abs(g["market_value"]))


SPOT_SHOCKS = (-0.20, -0.10, -0.05, -0.02, 0.0, 0.02, 0.05, 0.10, 0.20)
VOL_SHOCKS = (-0.05, 0.0, 0.05, 0.10)
RATE_SHOCKS = (-0.01, -0.005, 0.005, 0.01)
SPREAD_SHOCKS = (-0.0025, 0.0025, 0.005, 0.01, 0.02)


def stress_grid(positions: list[Position], m: MarketSnapshot, mc_paths: int = 10_000) -> dict:
    """Full revaluation P&L for joint equity / vol shocks, and for parallel rate shocks."""
    base = book_value(positions, m, mc_paths)
    grid = [[book_value(positions, m.shocked(spot_shift=s, vol_shift=v), mc_paths) - base for s in SPOT_SHOCKS]
            for v in VOL_SHOCKS]
    rates = [{"shift": r, "pnl": book_value(positions, m.shocked(rate_shift=r), mc_paths) - base} for r in RATE_SHOCKS]
    out = {"base_value": base, "spot_shocks": list(SPOT_SHOCKS), "vol_shocks": list(VOL_SHOCKS), "pnl": grid,
           "rate_shocks": rates, "spread_shocks": []}
    credit = [p for p in positions if p.kind == "cds"]
    if credit:
        # only the CDS move with credit spreads: revalue them alone
        base_c = book_value(credit, m, mc_paths)
        out["spread_shocks"] = [{"shift": s, "pnl": book_value(credit, m.shocked(spread_shift=s), mc_paths) - base_c}
                                for s in SPREAD_SHOCKS]
    return out


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
