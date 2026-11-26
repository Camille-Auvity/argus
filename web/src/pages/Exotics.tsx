import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { api, type AsianRequest, type CliquetRequest, type DigitalRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { defaultMarket, GreekCharts, GreeksTable, MarketForm } from "../components/pricing";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { ccySymbol, num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export const EXOTIC_PAGES = [
  { path: "digitale", label: "Digitale" },
  { path: "asiatique", label: "Asiatique" },
  { path: "cliquet", label: "Cliquet" },
] as const;

export default function Exotics() {
  const { ticker } = useTicker();
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Options exotiques — {ticker}</h1>
          <div className="page-sub">Digitales, asiatiques et cliquets : formules fermées, Monte Carlo et grecques de chaque produit.</div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label="Produits exotiques">
        {EXOTIC_PAGES.map((m) => (
          <NavLink key={m.path} to={`/exotics/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

/** Remount the desk (fresh defaults) when the underlying changes or its data arrives. */
function useDeskKey() {
  const { ticker, snapshot } = useTicker();
  return `${ticker}:${snapshot ? "ready" : "loading"}`;
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

const PATHS = [20_000, 50_000, 100_000, 200_000].map((v) => ({ value: v, label: v.toLocaleString("fr-FR") }));

// ----------------------------------------------------------------------------- digital

export function DigitalPage() {
  return <DigitalDesk key={useDeskKey()} />;
}

function DigitalDesk() {
  const { snapshot } = useTicker();
  const market = defaultMarket(snapshot);
  const ccy = ccySymbol(snapshot?.currency);
  const [req, setReq] = useState<DigitalRequest>({
    ...market, strike: Math.round(market.spot), expiry: 0.5, option_type: "call", kind: "cash-or-nothing", cash: 100,
    mc_paths: 100_000,
  });
  const set = (patch: Partial<DigitalRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req);
  const { data, error, isFetching } = useQuery({ queryKey: ["digital", debounced], queryFn: () => api.digital(debounced), placeholderData: keepPreviousData });
  const ref = data?.results[0];
  const cash = req.kind === "cash-or-nothing";

  const priceOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 4) },
    grid: { top: 16 },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "value" },
    series: [{
      type: "line", name: "Prix", showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
      data: data?.profile.spots.map((s, i) => [s, data.profile.series.price[i]]) ?? [],
      markLine: { symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
        lineStyle: { color: p.muted, type: "dashed", width: 1 },
        data: [{ xAxis: req.spot, name: "spot" }, { xAxis: req.strike, name: "K" }] },
    }],
  }), [data, req.spot, req.strike]);

  const spreadOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
    grid: { top: 30 },
    legend: {},
    xAxis: { type: "category", name: "largeur du spread", nameLocation: "middle", nameGap: 28,
      data: data?.call_spread.map((c) => pct(c.width, 1)) ?? [] },
    yAxis: { type: "value", scale: true },
    series: [
      { type: "line", name: `${req.option_type === "call" ? "Call" : "Put"} spread × cash / largeur`, symbolSize: 8, lineStyle: { width: 2 },
        color: p.series[1], data: data?.call_spread.map((c) => c.price) ?? [] },
      { type: "line", name: "Digitale (formule fermée)", showSymbol: false, color: p.series[0], lineStyle: { width: 2, type: "dashed" },
        data: data?.call_spread.map(() => ref?.greeks.price) ?? [] },
    ],
  }), [data, ref, req.option_type]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
            <div className="form-sep" />
            <div className="form-group-title">Contrat</div>
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })}
              options={[{ value: "call", label: "Call (S > K)" }, { value: "put", label: "Put (S < K)" }]} />
            <Segmented value={req.kind} onChange={(kind) => set({ kind })}
              options={[{ value: "cash-or-nothing", label: "Cash-or-nothing" }, { value: "asset-or-nothing", label: "Asset-or-nothing" }]} />
            <div className="form-row">
              <NumberField label="Strike" value={req.strike} suffix={ccy} min={0.0001} digits={2} onChange={(strike) => set({ strike })} />
              <NumberField label="Maturité" value={req.expiry} suffix="ans" min={0.01} max={30} digits={2} onChange={(expiry) => set({ expiry })} />
            </div>
            {cash && <NumberField label="Montant payé" value={req.cash} suffix={ccy} min={0.0001} digits={2} onChange={(v) => set({ cash: v })} />}
            <SelectField label="Trajectoires Monte Carlo" value={req.mc_paths} onChange={(mc_paths) => set({ mc_paths })} options={PATHS} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <div className="grid cols-4">
          <Stat label="Prix" value={ref ? `${num(ref.greeks.price, 4)} ${ccy}` : "—"}
            foot={ref ? (cash ? `${pct(ref.greeks.price / req.cash, 1)} du montant payé (≈ proba × actualisation)`
              : `${pct(ref.greeks.price / req.spot, 1)} du spot`) : undefined} busy={isFetching} />
          <Stat label="Delta" value={num(ref?.greeks.delta, 4)} foot={ref ? `Gamma ${num(ref.greeks.gamma, 5)}` : undefined} busy={isFetching} />
          <Stat label="Vega (1 %)" value={num(ref?.greeks.vega, 4)}
            foot={ref ? (ref.greeks.vega < 0 ? "Plus de vol éloigne du strike : prix en baisse" : "Plus de vol rapproche du strike : prix en hausse") : undefined} busy={isFetching} />
          <Stat label="Theta (1 jour)" value={num(ref?.greeks.theta, 4)} foot={ref ? `Rho 1 % : ${num(ref.greeks.rho, 4)}` : undefined} busy={isFetching} />
        </div>
        <Card title="Formule fermée vs Monte Carlo" flush>
          {data ? <GreeksTable results={data.results} busy={isFetching} /> : <div className="card-body"><Skeleton height={90} /></div>}
        </Card>
        <InfoBox>
          Les grecques Monte Carlo d'une digitale sont bruitées : le payoff est discontinu en K, donc la différence finie du gamma
          ne voit que les rares trajectoires qui finissent près du strike. C'est pour ça qu'on préfère la formule fermée, ou la
          réplication par call spread.
        </InfoBox>
        {cash && (
          <Card title="Réplication par call spread">
            <Explainer>
              Une digitale cash-or-nothing est la limite d'un call spread serré : acheter le call de strike K − w/2, vendre celui de
              strike K + w/2, et multiplier par cash / w. Quand w → 0, on retrouve −∂C/∂K (l'erreur d'un spread centré décroît
              en w²). En pratique, un desk qui vend une digitale la couvre avec un spread décalé, de K − w à K : il la surévalue
              un peu, mais le gamma de sa couverture reste borné.
            </Explainer>
            {data ? <EChart option={spreadOption} height={320} ariaLabel="Convergence du call spread vers la digitale" /> : <Skeleton height={300} />}
          </Card>
        )}
        <Card title="Prix selon le spot">
          {data ? <EChart option={priceOption} height={380} ariaLabel="Prix de la digitale selon le spot" /> : <Skeleton height={300} />}
        </Card>
        {data && <GreekCharts profile={data.profile} keys={["delta", "gamma", "vega"]}
          markers={[{ x: req.spot, name: "spot" }, { x: req.strike, name: "K", strong: true }]} />}
        <InfoBox>
          À l'approche de l'échéance, le delta d'une digitale devient un pic autour du strike et le gamma change de signe en K :
          c'est le produit le plus difficile à couvrir en delta. Réduisez la maturité pour voir le pic se former.
        </InfoBox>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- Asian

export function AsianPage() {
  return <AsianDesk key={useDeskKey()} />;
}

function AsianDesk() {
  const { snapshot } = useTicker();
  const market = defaultMarket(snapshot);
  const ccy = ccySymbol(snapshot?.currency);
  const [req, setReq] = useState<AsianRequest>({
    ...market, strike: Math.round(market.spot), expiry: 1, n_fixings: 12, option_type: "call", averaging: "arithmetic",
    mc_paths: 50_000,
  });
  const set = (patch: Partial<AsianRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req);
  const { data, error, isFetching } = useQuery({ queryKey: ["asian", debounced], queryFn: () => api.asian(debounced), placeholderData: keepPreviousData });
  // reference: control-variate MC for the arithmetic average, closed form for the geometric one
  const ref = data ? (req.averaging === "arithmetic" ? data.results[data.results.length - 1] : data.results[0]) : undefined;

  const errorOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
    legend: {},
    grid: { top: 36, left: 56 },
    xAxis: { type: "log", name: "trajectoires", nameLocation: "middle", nameGap: 28, min: 1000 },
    yAxis: { type: "log", name: "erreur standard", nameLocation: "middle", nameGap: 44 },
    series: [
      { type: "line", name: "Monte Carlo simple", symbolSize: 7, lineStyle: { width: 2 }, color: p.series[1],
        data: data?.convergence.map((c) => [c.n_paths, c.plain_se]) ?? [] },
      ...(req.averaging === "arithmetic" ? [{
        type: "line", name: "Avec variable de contrôle", symbolSize: 7, lineStyle: { width: 2 }, color: p.series[0],
        data: data?.convergence.map((c) => [c.n_paths, c.cv_se]) ?? [] }] : []),
    ],
  }), [data, req.averaging]);

  const priceOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 4) },
    grid: { top: 16 },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "value" },
    series: [{
      type: "line", name: "Prix", showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
      data: data?.profile.spots.map((s, i) => [s, data.profile.series.price[i]]) ?? [],
      markLine: { symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
        lineStyle: { color: p.muted, type: "dashed", width: 1 },
        data: [{ xAxis: req.spot, name: "spot" }, { xAxis: req.strike, name: "K" }] },
    }],
  }), [data, req.spot, req.strike]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
            <div className="form-sep" />
            <div className="form-group-title">Contrat</div>
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })}
              options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
            <Segmented value={req.averaging} onChange={(averaging) => set({ averaging })}
              options={[{ value: "arithmetic", label: "Moyenne arithmétique" }, { value: "geometric", label: "Géométrique" }]} />
            <div className="form-row">
              <NumberField label="Strike" value={req.strike} suffix={ccy} min={0.0001} digits={2} onChange={(strike) => set({ strike })} />
              <NumberField label="Maturité" value={req.expiry} suffix="ans" min={0.05} max={10} digits={2} onChange={(expiry) => set({ expiry })} />
            </div>
            <SelectField label="Fixings (équirépartis)" value={req.n_fixings} onChange={(n_fixings) => set({ n_fixings })}
              options={[{ value: 1, label: "1 (= européenne)" }, { value: 4, label: "4" }, { value: 12, label: "12" },
                { value: 52, label: "52" }, { value: 252, label: "252" }]} />
            <SelectField label="Trajectoires Monte Carlo" value={req.mc_paths} onChange={(mc_paths) => set({ mc_paths })} options={PATHS} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <div className="grid cols-4">
          <Stat label="Prix" value={ref ? `${num(ref.greeks.price, 4)} ${ccy}` : "—"}
            foot={data && data.vanilla_price > 0 && ref ? `${pct(ref.greeks.price / data.vanilla_price, 1)} de la vanille européenne` : undefined} busy={isFetching} />
          <Stat label="Delta" value={num(ref?.greeks.delta, 4)} foot={ref ? `Gamma ${num(ref.greeks.gamma, 5)}` : undefined} busy={isFetching} />
          <Stat label="Vega (1 %)" value={num(ref?.greeks.vega, 4)} foot={ref ? `Rho 1 % : ${num(ref.greeks.rho, 4)}` : undefined} busy={isFetching} />
          <Stat label="Réduction de variance" value={data?.variance_reduction ? `× ${num(data.variance_reduction, 0)}` : "—"}
            foot={data?.cv_beta != null ? `β = ${num(data.cv_beta, 3)}` : "Sans objet en moyenne géométrique"} busy={isFetching} />
        </div>
        <Card title="Méthodes de pricing" flush>
          {data ? <GreeksTable results={data.results} busy={isFetching} /> : <div className="card-body"><Skeleton height={110} /></div>}
        </Card>
        <Card title="Variable de contrôle : erreur selon le nombre de trajectoires">
          <Explainer>
            La moyenne géométrique a un prix exact (log-normale) et est très corrélée à la moyenne arithmétique sur les mêmes
            trajectoires. On corrige donc l'estimateur : X − β (Y − E[Y]). L'erreur décroît toujours en 1/√N, mais à un niveau
            bien plus bas : à précision égale, il faut environ {data?.variance_reduction ? num(data.variance_reduction, 0) : "…"} fois
            moins de trajectoires.
          </Explainer>
          {data ? <EChart option={errorOption} height={340} ariaLabel="Erreur standard Monte Carlo selon le nombre de trajectoires" /> : <Skeleton height={300} />}
        </Card>
        <Card title={`Prix selon le spot (${req.averaging === "arithmetic" ? "approximation de Lévy" : "formule fermée"})`}>
          {data ? <EChart option={priceOption} height={360} ariaLabel="Prix de l'asiatique selon le spot" /> : <Skeleton height={300} />}
        </Card>
        {data && <GreekCharts profile={data.profile} keys={["delta", "gamma", "vega", "theta"]}
          markers={[{ x: req.spot, name: "spot" }, { x: req.strike, name: "K" }]} />}
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- cliquet

function OptionalPct({ label, value, fallback, onChange }: {
  label: string; value: number | null; fallback: number; onChange: (v: number | null) => void;
}) {
  return (
    <div>
      <Check label={label} checked={value !== null} onChange={(on) => onChange(on ? fallback : null)} />
      {value !== null && <NumberField label="Niveau" value={value} suffix="%" scale={100} min={-1} digits={2} onChange={onChange} />}
    </div>
  );
}

export function CliquetPage() {
  return <CliquetDesk key={useDeskKey()} />;
}

function CliquetDesk() {
  const { snapshot } = useTicker();
  const ccy = ccySymbol(snapshot?.currency);
  const [req, setReq] = useState<CliquetRequest>({
    ...defaultMarket(snapshot), maturity: 2, frequency: 4, local_floor: -0.05, local_cap: 0.05, global_floor: 0, global_cap: null,
    mc_paths: 50_000,
  });
  const set = (patch: Partial<CliquetRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 450);
  const { data, error, isFetching } = useQuery({ queryKey: ["cliquet", debounced], queryFn: () => api.cliquet(debounced), placeholderData: keepPreviousData });
  const ref = data?.results.find((r) => r.method.startsWith("Monte Carlo")) ?? data?.results[0];
  const unbounded = data?.results.find((r) => r.method.startsWith("Sans bornes"));

  const volOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
    grid: { top: 16 },
    xAxis: { type: "value", name: "volatilité", nameLocation: "middle", nameGap: 28, min: "dataMin", max: "dataMax",
      axisLabel: { formatter: (v: number) => pct(v, 0) } },
    yAxis: { type: "value", scale: true, name: "% du nominal" },
    series: [{
      type: "line", name: "Prix", symbolSize: 7, lineStyle: { width: 2 }, color: p.series[0],
      data: data?.vol_profile.spots.map((v, i) => [v, data.vol_profile.series.price[i]]) ?? [],
      markLine: { symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
        lineStyle: { color: p.muted, type: "dashed", width: 1 }, data: [{ xAxis: req.vol, name: "vol actuelle" }] },
    }],
  }), [data, req.vol]);

  const histOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const { edges, counts } = data.histogram;
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      grid: { top: 16 },
      xAxis: { type: "category", name: "payoff (% du nominal)", nameLocation: "middle", nameGap: 28,
        data: counts.map((_, i) => num((edges[i] + edges[i + 1]) / 2, 1)), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [{ type: "bar", name: "Fréquence", color: p.series[0], barCategoryGap: "8%", itemStyle: { borderRadius: [3, 3, 0, 0] },
        data: counts.map((c) => c / total) }],
    };
  }, [data]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
            <div className="form-sep" />
            <div className="form-group-title">Structure</div>
            <div className="form-row">
              <NumberField label="Maturité" value={req.maturity} suffix="ans" min={0.25} max={10} digits={2} onChange={(maturity) => set({ maturity })} />
              <SelectField label="Resets" value={req.frequency} onChange={(frequency) => set({ frequency })}
                options={[{ value: 12, label: "Mensuels" }, { value: 4, label: "Trimestriels" }, { value: 2, label: "Semestriels" }, { value: 1, label: "Annuels" }]} />
            </div>
            <div className="form-row">
              <OptionalPct label="Floor local" value={req.local_floor} fallback={-0.05} onChange={(local_floor) => set({ local_floor })} />
              <OptionalPct label="Cap local" value={req.local_cap} fallback={0.05} onChange={(local_cap) => set({ local_cap })} />
            </div>
            <div className="form-row">
              <OptionalPct label="Floor global" value={req.global_floor} fallback={0} onChange={(global_floor) => set({ global_floor })} />
              <OptionalPct label="Cap global" value={req.global_cap} fallback={0.3} onChange={(global_cap) => set({ global_cap })} />
            </div>
            <SelectField label="Trajectoires Monte Carlo" value={req.mc_paths} onChange={(mc_paths) => set({ mc_paths })} options={PATHS} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          Le cliquet additionne les performances de chaque période (R<sub>i</sub> = S<sub>i</sub>/S<sub>i−1</sub> − 1), chacune bornée
          par un floor et un cap locaux. La somme est ensuite bornée par un floor et un cap globaux. Payoff en % du nominal,
          versé à l'échéance.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Prix (% du nominal)" value={num(ref?.greeks.price, 3)} foot={ref?.std_error != null ? `± ${num(ref.std_error, 3)} (1 σ MC)` : undefined} busy={isFetching} />
          <Stat label="Vega (1 %)" value={num(ref?.greeks.vega, 4)}
            foot={ref ? (ref.greeks.vega < 0 ? "Vendeur de vol : les caps locaux dominent" : "Acheteur de vol") : undefined} busy={isFetching} />
          <Stat label="Rho (1 %)" value={num(ref?.greeks.rho, 4)} foot={ref ? `Theta 1j ${num(ref.greeks.theta, 4)}` : undefined} busy={isFetching} />
          <Stat label="Delta / gamma" value={ref ? `${num(ref.greeks.delta, 4)} / ${num(ref.greeks.gamma, 4)}` : "—"}
            foot="Payoff en rendements : indépendant du niveau du spot" busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label="Floor global activé" value={pct(data?.floor_probability, 1)} foot="Probabilité risque-neutre" busy={isFetching} />
          <Stat label="Périodes cappées" value={data?.cap_hit_rate != null ? pct(data.cap_hit_rate, 1) : "—"} busy={isFetching} />
          <Stat label="Périodes floorées" value={data?.floor_hit_rate != null ? pct(data.floor_hit_rate, 1) : "—"} busy={isFetching} />
          <Stat label="Valeur des bornes globales" value={ref && unbounded ? num(ref.greeks.price - unbounded.greeks.price, 3) : "—"}
            foot={unbounded ? `Somme des spreads seule : ${num(unbounded.greeks.price, 3)}` : undefined} busy={isFetching} />
        </div>
        <Card title="Méthodes de pricing" flush>
          {data ? <GreeksTable results={data.results} busy={isFetching} /> : <div className="card-body"><Skeleton height={90} /></div>}
        </Card>
        <InfoBox>
          Sans bornes globales, chaque période est un call spread à départ différé sur le rendement, et le prix a une formule fermée
          sous Black-Scholes. Le floor global, lui, est une option sur la somme et nécessite le Monte Carlo. Le prix ne dépend que
          des volatilités forward : sous un smile réel, c'est le skew forward qui compte (voir Modèles de volatilité →
          Digitale, asiatique, cliquet).
        </InfoBox>
        <div className="grid cols-2">
          <Card title="Prix selon la volatilité">
            {data ? <EChart option={volOption} height={340} ariaLabel="Prix du cliquet selon la volatilité" /> : <Skeleton height={300} />}
          </Card>
          <Card title="Distribution du payoff">
            {data ? <EChart option={histOption} height={340} ariaLabel="Distribution du payoff du cliquet" /> : <Skeleton height={300} />}
          </Card>
        </div>
      </div>
    </div>
  );
}
