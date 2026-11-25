"""Pricer interface and the shared finite-difference Greeks engine.

Greek conventions (raw sensitivities, everywhere in the library):
  delta = dV/dS, gamma = d2V/dS2, vega = dV/dsigma (per 1.00 of vol),
  theta = dV/dt (per year, calendar time passing), rho = dV/dr (per 1.00
  parallel shift of the continuously compounded zero curve).
``Greeks.scaled()`` gives the desk-style units (vega/rho per 1%, theta per day).
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import asdict, dataclass

from qplat.instruments.base import EquityDerivative


@dataclass(frozen=True)
class Greeks:
    price: float
    delta: float
    gamma: float
    vega: float
    theta: float
    rho: float

    def as_dict(self) -> dict[str, float]:
        return asdict(self)

    def scaled(self) -> dict[str, float]:
        return {
            "price": self.price,
            "delta": self.delta,
            "gamma": self.gamma,
            "vega (1%)": self.vega / 100.0,
            "theta (1d)": self.theta / 365.0,
            "rho (1%)": self.rho / 100.0,
        }


class Pricer(ABC):
    """Common interface: every pricer exposes price + the five Greeks."""

    name: str = "pricer"

    @abstractmethod
    def price(self, instrument: EquityDerivative) -> float: ...

    @abstractmethod
    def delta(self, instrument: EquityDerivative) -> float: ...

    @abstractmethod
    def gamma(self, instrument: EquityDerivative) -> float: ...

    @abstractmethod
    def vega(self, instrument: EquityDerivative) -> float: ...

    @abstractmethod
    def theta(self, instrument: EquityDerivative) -> float: ...

    @abstractmethod
    def rho(self, instrument: EquityDerivative) -> float: ...

    def greeks(self, instrument: EquityDerivative) -> Greeks:
        return Greeks(
            price=self.price(instrument),
            delta=self.delta(instrument),
            gamma=self.gamma(instrument),
            vega=self.vega(instrument),
            theta=self.theta(instrument),
            rho=self.rho(instrument),
        )


class FiniteDifferencePricer(Pricer):
    """Greeks by bump-and-reprice, written once for every numerical pricer.

    Subclasses only implement ``price``. Monte Carlo subclasses must reuse the
    same random numbers across bumps (common random numbers) for stable Greeks.
    """

    def __init__(self, spot_bump: float = 0.01, vol_bump: float = 0.01,
                 rate_bump: float = 1e-4, time_bump: float = 1.0 / 365.0):
        self.spot_bump = spot_bump    # relative
        self.vol_bump = vol_bump      # absolute
        self.rate_bump = rate_bump    # absolute parallel shift
        self.time_bump = time_bump    # years

    def _spot_prices(self, inst: EquityDerivative) -> tuple[float, float, float, float]:
        h = inst.spot * self.spot_bump
        up = self.price(inst.with_spot(inst.spot + h))
        mid = self.price(inst)
        down = self.price(inst.with_spot(inst.spot - h))
        return up, mid, down, h

    def delta(self, inst):
        up, _, down, h = self._spot_prices(inst)
        return (up - down) / (2 * h)

    def gamma(self, inst):
        up, mid, down, h = self._spot_prices(inst)
        return (up - 2 * mid + down) / (h * h)

    def vega(self, inst):
        h = min(self.vol_bump, inst.vol / 2)
        return (self.price(inst.with_vol(inst.vol + h)) - self.price(inst.with_vol(inst.vol - h))) / (2 * h)

    def theta(self, inst):
        dt = min(self.time_bump, inst.maturity / 2)
        return (self.price(inst.time_shifted(dt)) - self.price(inst)) / dt

    def rho(self, inst):
        h = self.rate_bump
        return (self.price(inst.with_rate_shift(h)) - self.price(inst.with_rate_shift(-h))) / (2 * h)

    def greek_breakdown(self, inst) -> list[dict]:
        """Every repricing behind each finite-difference Greek (same bumps as delta()/vega()/...)."""
        up, mid, down, h = self._spot_prices(inst)
        hv = min(self.vol_bump, inst.vol / 2)
        v_up, v_dn = self.price(inst.with_vol(inst.vol + hv)), self.price(inst.with_vol(inst.vol - hv))
        dt = min(self.time_bump, inst.maturity / 2)
        t_later = self.price(inst.time_shifted(dt))
        hr = self.rate_bump
        r_up, r_dn = self.price(inst.with_rate_shift(hr)), self.price(inst.with_rate_shift(-hr))
        return [
            {"greek": "delta", "formula": "[V(S+h) − V(S−h)] / 2h", "bump": h, "bump_label": "h (spot)",
             "prices": {"V(S+h)": up, "V(S−h)": down}, "value": (up - down) / (2 * h)},
            {"greek": "gamma", "formula": "[V(S+h) − 2V(S) + V(S−h)] / h²", "bump": h, "bump_label": "h (spot)",
             "prices": {"V(S+h)": up, "V(S)": mid, "V(S−h)": down}, "value": (up - 2 * mid + down) / (h * h)},
            {"greek": "vega", "formula": "[V(σ+h) − V(σ−h)] / 2h", "bump": hv, "bump_label": "h (vol)",
             "prices": {"V(σ+h)": v_up, "V(σ−h)": v_dn}, "value": (v_up - v_dn) / (2 * hv)},
            {"greek": "theta", "formula": "[V(t+dt) − V(t)] / dt", "bump": dt, "bump_label": "dt (années)",
             "prices": {"V(t+dt)": t_later, "V(t)": mid}, "value": (t_later - mid) / dt},
            {"greek": "rho", "formula": "[V(r+h) − V(r−h)] / 2h", "bump": hr, "bump_label": "h (taux, shift parallèle)",
             "prices": {"V(r+h)": r_up, "V(r−h)": r_dn}, "value": (r_up - r_dn) / (2 * hr)},
        ]

    def greeks(self, inst):
        # reuse the spot ladder for delta and gamma
        up, mid, down, h = self._spot_prices(inst)
        return Greeks(
            price=mid,
            delta=(up - down) / (2 * h),
            gamma=(up - 2 * mid + down) / (h * h),
            vega=self.vega(inst),
            theta=self.theta(inst),
            rho=self.rho(inst),
        )
