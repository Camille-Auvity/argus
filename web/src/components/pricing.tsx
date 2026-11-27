import { useCallback } from "react";
import type { Currency, MarketParams, MethodResult, Profile } from "../api/client";
import { num } from "../lib/format";
import { useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { EChart } from "./EChart";
import { Card, NumberField, Segmented } from "./ui";
import { tr } from "../lib/i18n";

/** Market inputs shared by every pricing screen (defaults come from the selected underlying). */
export function defaultMarket(snapshot: ReturnType<typeof useTicker>["snapshot"]): MarketParams {
  return {
    spot: snapshot?.last ?? 100,
    vol: snapshot?.realized_vol_1y ?? 0.2,
    dividend_yield: snapshot?.dividend_yield ?? 0,
    rate: { mode: "curve", currency: (snapshot?.currency as Currency) ?? "USD", flat_rate: 0.03 },
  };
}

export function MarketForm({ value, onChange, currency }: {
  value: MarketParams; onChange: (m: MarketParams) => void; currency: string;
}) {
  const set = (patch: Partial<MarketParams>) => onChange({ ...value, ...patch });
  return (
    <>
      <div className="form-group-title">{tr("Marché", "Market")}</div>
      <div className="form-row">
        <NumberField label="Spot" value={value.spot} suffix={currency} min={0.0001} onChange={(spot) => set({ spot })} digits={2} />
        <NumberField label={tr("Volatilité", "Volatility")} value={value.vol} suffix="%" scale={100} min={0.001} max={5} digits={2}
          hint={tr("Par défaut : volatilité réalisée sur 1 an", "Default: 1-year realised volatility")} onChange={(vol) => set({ vol })} />
      </div>
      <div className="form-row">
        <NumberField label="Dividend yield" value={value.dividend_yield} suffix="%" scale={100} digits={3}
          onChange={(dividend_yield) => set({ dividend_yield })} />
        {value.rate.mode === "flat" ? (
          <NumberField label={tr("Taux continu", "Continuous rate")} value={value.rate.flat_rate} suffix="%" scale={100} digits={3}
            onChange={(flat_rate) => set({ rate: { ...value.rate, flat_rate } })} />
        ) : <div />}
      </div>
      <Segmented
        label={tr("Taux sans risque (courbe ou constant)", "Risk-free rate (curve or constant)")}
        value={value.rate.mode === "flat" ? "flat" : value.rate.currency}
        options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }, { value: "flat", label: tr("Constant", "Constant") }]}
        onChange={(v) => set({
          rate: v === "flat" ? { ...value.rate, mode: "flat" } : { ...value.rate, mode: "curve", currency: v as Currency },
        })}
      />
    </>
  );
}

const greekCols = () => [
  { key: "price", label: tr("Prix", "Price"), digits: 4 },
  { key: "delta", label: "Delta", digits: 4 },
  { key: "gamma", label: "Gamma", digits: 5 },
  { key: "vega", label: "Vega 1%", digits: 4 },
  { key: "theta", label: tr("Theta 1j", "Theta 1d"), digits: 4 },
  { key: "rho", label: "Rho 1%", digits: 4 },
] as const;

export function GreeksTable({ results, busy }: { results: MethodResult[]; busy?: boolean }) {
  return (
    <div className={`table-wrap${busy ? " busy" : ""}`}>
      <table className="data">
        <thead>
          <tr>
            <th>{tr("Méthode", "Method")}</th>
            {greekCols().map((c) => <th key={c.key}>{c.label}</th>)}
            <th>{tr("Erreur MC", "MC error")}</th>
            <th>{tr("Temps", "Time")}</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r) => (
            <tr key={r.method}>
              <td className="strong">{r.method}</td>
              {greekCols().map((c) => (
                <td key={c.key} className={c.key === "price" ? "strong" : ""}>{num(r.greeks[c.key], c.digits)}</td>
              ))}
              <td className="muted">{r.std_error != null ? `± ${num(r.std_error, 4)}` : "—"}</td>
              <td className="muted">{num(r.elapsed_ms, 0)} ms</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const GREEK_PAIRS: Record<string, [string, string]> = {
  price: ["Prix", "Price"], delta: ["Delta", "Delta"], gamma: ["Gamma", "Gamma"], vega: ["Vega (1 %)", "Vega (1%)"],
  theta: ["Theta (1 jour)", "Theta (1 day)"], rho: ["Rho (1 %)", "Rho (1%)"],
};
const greekLabel = (k: string) => (GREEK_PAIRS[k] ? tr(GREEK_PAIRS[k][0], GREEK_PAIRS[k][1]) : k);

export interface Marker {
  x: number;
  name: string;
  strong?: boolean;
}

/** One small chart per Greek, as a function of spot, with vertical markers (spot, strike, barrier...). */
export function GreekCharts({ profile, keys, markers, height = 280 }: {
  profile: Profile; keys: string[]; markers: Marker[]; height?: number;
}) {
  const option = useCallback((key: string) => (p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
    grid: { top: 16 },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "value" },
    series: [{
      type: "line", name: greekLabel(key), showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
      data: profile.spots.map((s, i) => [s, profile.series[key][i]]),
      markLine: {
        symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
        data: markers.map((m) => ({ xAxis: m.x, name: m.name, lineStyle: m.strong
          ? { color: p.critical, type: "solid", width: 1.5 } : { color: p.muted, type: "dashed", width: 1 } })),
      },
    }],
  }), [profile, markers]);
  return (
    <div className="grid cols-2">
      {keys.map((k) => (
        <Card key={k} title={tr(`${greekLabel(k)} selon le spot`, `${greekLabel(k)} by spot`)}>
          <EChart option={option(k)} height={height} ariaLabel={tr(`${greekLabel(k)} selon le spot`, `${greekLabel(k)} by spot`)} />
        </Card>
      ))}
    </div>
  );
}
