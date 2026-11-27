import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, type VanillaRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { defaultMarket, GreeksTable, MarketForm } from "../components/pricing";
import { Card, ErrorBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { ccySymbol, num } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { tr } from "../lib/i18n";

export default function Options() {
  const { ticker, snapshot } = useTicker();
  // remount (and reset defaults) when the underlying changes or its data arrives
  return <OptionsDesk key={`${ticker}:${snapshot ? "ready" : "loading"}`} />;
}

function OptionsDesk() {
  const { ticker, snapshot } = useTicker();
  const market = defaultMarket(snapshot);
  const ccy = ccySymbol(snapshot?.currency);
  const [req, setReq] = useState<VanillaRequest>({
    ...market,
    strike: Math.round(market.spot),
    expiry: 0.25,
    option_type: "call",
    exercise: "european",
    tree_steps: 500,
    mc_paths: 100_000,
  });
  const set = (patch: Partial<VanillaRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req);

  const pricing = useQuery({ queryKey: ["vanilla", debounced], queryFn: () => api.vanilla(debounced), placeholderData: keepPreviousData });
  const profile = useQuery({ queryKey: ["vanilla-profile", debounced], queryFn: () => api.vanillaProfile(debounced), placeholderData: keepPreviousData });
  const ref = pricing.data?.results[0];
  const busy = pricing.isFetching;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Options vanille", "Vanilla options")} — {ticker}</h1>
          <div className="page-sub">{tr("Black-Scholes fermé, arbre CRR et Monte Carlo (Longstaff-Schwartz pour l'exercice américain). Recalcul automatique.", "Closed-form Black-Scholes, CRR tree and Monte Carlo (Longstaff-Schwartz for American exercise). Recomputed automatically.")}</div>
        </div>
      </div>
      <div className="split">
        <div className="sticky">
          <Card title={tr("Paramètres", "Parameters")}>
            <div className="form">
              <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
              <div className="form-sep" />
              <div className="form-group-title">Contrat</div>
              <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })}
                options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
              <Segmented value={req.exercise} onChange={(exercise) => set({ exercise })}
                options={[{ value: "european", label: tr("Européenne", "European") }, { value: "american", label: tr("Américaine", "American") }]} />
              <div className="form-row">
                <NumberField label="Strike" value={req.strike} suffix={ccy} min={0.0001} digits={2} onChange={(strike) => set({ strike })} />
                <NumberField label={tr("Maturité", "Maturity")} value={req.expiry} suffix={tr("jours", "days")} scale={365} min={1 / 365} max={30} digits={0}
                  onChange={(expiry) => set({ expiry })} hint={tr("Jours calendaires, convention ACT/365F", "Calendar days, ACT/365F convention")} />
              </div>
              <div className="form-sep" />
              <div className="form-group-title">{tr("Numérique", "Numerics")}</div>
              <div className="form-row">
                <SelectField label={tr("Pas de l'arbre", "Tree steps")} value={req.tree_steps} onChange={(tree_steps) => set({ tree_steps })}
                  options={[100, 250, 500, 1000, 2000].map((v) => ({ value: v, label: String(v) }))} />
                <SelectField label={tr("Trajectoires MC", "MC paths")} value={req.mc_paths} onChange={(mc_paths) => set({ mc_paths })}
                  options={[20_000, 50_000, 100_000, 200_000, 500_000].map((v) => ({ value: v, label: num(v, 0) }))} />
              </div>
            </div>
          </Card>
        </div>

        <div className="grid">
          <ErrorBox error={pricing.error} />
          <div className="grid cols-4">
            <Stat label={tr(`Prix · ${ref?.method ?? ""}`, `Price · ${ref?.method ?? ""}`)} value={ref ? `${num(ref.greeks.price, 4)} ${ccy}` : "—"}
              foot={ref ? tr(`${num((ref.greeks.price / req.spot) * 100, 2)} % du spot`, `${num((ref.greeks.price / req.spot) * 100, 2)}% of spot`) : undefined} busy={busy} />
            <Stat label="Delta" value={num(ref?.greeks.delta, 4)} foot={ref ? `Gamma ${num(ref.greeks.gamma, 5)}` : undefined} busy={busy} />
            <Stat label={tr("Vega (1 % de vol)", "Vega (1% vol)")} value={num(ref?.greeks.vega, 4)} foot={ref ? tr(`Rho 1 % : ${num(ref.greeks.rho, 4)}`, `Rho 1%: ${num(ref.greeks.rho, 4)}`) : undefined} busy={busy} />
            <Stat label={tr("Theta (1 jour)", "Theta (1 day)")} value={num(ref?.greeks.theta, 4)} foot={tr(`Maturité ${num(req.expiry, 3)} an`, `Maturity ${num(req.expiry, 3)} y`)} busy={busy} />
          </div>

          <Card title={tr("Comparaison des méthodes", "Method comparison")} flush>
            {pricing.data ? <GreeksTable results={pricing.data.results} busy={busy} /> : <div className="card-body"><Skeleton height={110} /></div>}
          </Card>

          <ProfileCharts profile={profile.data} spot={req.spot} strike={req.strike} busy={profile.isFetching} />
        </div>
      </div>
    </>
  );
}

const greekCharts = () => [
  { key: "delta", title: "Delta" },
  { key: "gamma", title: "Gamma" },
  { key: "vega", title: tr("Vega (1 %)", "Vega (1%)") },
  { key: "theta", title: tr("Theta (1 jour)", "Theta (1 day)") },
];

function ProfileCharts({ profile, spot, strike, busy }: {
  profile?: { spots: number[]; series: Record<string, number[]> }; spot: number; strike: number; busy: boolean;
}) {
  const markers = useCallback((p: ChartPalette) => ({
    symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dashed", width: 1 },
    label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
    data: [{ xAxis: spot, name: "spot" }, { xAxis: strike, name: "K" }],
  }), [spot, strike]);

  const priceOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 30 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "value" },
    series: [
      { type: "line", name: tr("Valeur aujourd'hui", "Value today"), showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
        data: profile?.spots.map((s, i) => [s, profile.series.price[i]]) ?? [], markLine: markers(p) },
      { type: "line", name: tr("Payoff à l'échéance", "Payoff at expiry"), showSymbol: false, lineStyle: { width: 2, type: "dashed" }, color: p.series[1],
        data: profile?.spots.map((s, i) => [s, profile.series.payoff[i]]) ?? [] },
    ],
  }), [profile, markers]);

  const greekOption = useCallback((key: string) => (p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "value" },
    series: [{ type: "line", name: key, showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
      data: profile?.spots.map((s, i) => [s, profile.series[key][i]]) ?? [], markLine: markers(p) }],
  }), [profile, markers]);

  if (!profile) return <Skeleton height={300} />;
  return (
    <div className={`grid${busy ? " busy" : ""}`}>
      <Card title={tr("Valeur et payoff en fonction du spot", "Value and payoff as a function of spot")}>
        <EChart option={priceOption} height={420} ariaLabel={tr("Valeur de l'option et payoff selon le spot", "Option value and payoff by spot")} />
      </Card>
      <div className="grid cols-2">
        {greekCharts().map((g) => (
          <Card key={g.key} title={g.title}>
            <EChart option={greekOption(g.key)} height={290} ariaLabel={tr(`${g.title} selon le spot`, `${g.title} by spot`)} />
          </Card>
        ))}
      </div>
    </div>
  );
}
