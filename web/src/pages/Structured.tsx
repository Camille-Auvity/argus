import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, type AutocallRequest, type BarrierRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { defaultMarket, GreekCharts, GreeksTable, MarketForm } from "../components/pricing";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { ccySymbol, num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export default function Structured() {
  const { ticker, snapshot } = useTicker();
  const [tab, setTab] = useState<"barrier" | "autocall">("autocall");
  const key = `${ticker}:${snapshot ? "ready" : "loading"}`;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Produits structurés — {ticker}</h1>
          <div className="page-sub">Moteur d'options + courbe de taux : barrières (formule fermée et Monte Carlo) et autocalls Phoenix / Athena.</div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "autocall"} className={tab === "autocall" ? "on" : ""} onClick={() => setTab("autocall")}>Autocall</button>
        <button role="tab" aria-selected={tab === "barrier"} className={tab === "barrier" ? "on" : ""} onClick={() => setTab("barrier")}>Option à barrière</button>
      </div>
      {tab === "barrier" ? <BarrierDesk key={key} /> : <AutocallDesk key={key} />}
    </>
  );
}

// ----------------------------------------------------------------------------- barrier

function BarrierDesk() {
  const { snapshot } = useTicker();
  const market = defaultMarket(snapshot);
  const ccy = ccySymbol(snapshot?.currency);
  const [req, setReq] = useState<BarrierRequest>({
    ...market, strike: Math.round(market.spot), expiry: 1, barrier: Math.round(market.spot * 0.8),
    barrier_type: "down-and-out", option_type: "call", rebate: 0, monitoring_per_year: null, mc_paths: 50_000,
  });
  const set = (patch: Partial<BarrierRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req);
  const { data, error, isFetching } = useQuery({ queryKey: ["barrier", debounced], queryFn: () => api.barrier(debounced), placeholderData: keepPreviousData });
  const ref = data?.results[0];

  const option = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "value" },
    series: [{
      type: "line", name: "Prix (formule fermée)", showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
      data: data?.profile.spots.map((s, i) => [s, data.profile.series.price[i]]) ?? [],
      markLine: { symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
        data: [
          { xAxis: req.barrier, name: "barrière", lineStyle: { color: p.critical, type: "solid", width: 1.5 } },
          { xAxis: req.spot, name: "spot", lineStyle: { color: p.muted, type: "dashed", width: 1 } },
          { xAxis: req.strike, name: "K", lineStyle: { color: p.muted, type: "dotted", width: 1 } },
        ] },
    }],
  }), [data, req.barrier, req.spot, req.strike]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
            <div className="form-sep" />
            <div className="form-group-title">Contrat</div>
            <SelectField label="Type de barrière" value={req.barrier_type} onChange={(barrier_type) => set({ barrier_type })}
              options={[{ value: "down-and-out", label: "Down-and-out" }, { value: "down-and-in", label: "Down-and-in" },
                { value: "up-and-out", label: "Up-and-out" }, { value: "up-and-in", label: "Up-and-in" }]} />
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })}
              options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
            <div className="form-row">
              <NumberField label="Strike" value={req.strike} suffix={ccy} min={0.0001} digits={2} onChange={(strike) => set({ strike })} />
              <NumberField label="Barrière" value={req.barrier} suffix={ccy} min={0.0001} digits={2} onChange={(barrier) => set({ barrier })} />
            </div>
            <div className="form-row">
              <NumberField label="Maturité" value={req.expiry} suffix="ans" min={0.01} max={30} digits={2} onChange={(expiry) => set({ expiry })} />
              <NumberField label="Rebate" value={req.rebate} suffix={ccy} min={0} digits={2} onChange={(rebate) => set({ rebate })} />
            </div>
            <SelectField label="Observation de la barrière" value={req.monitoring_per_year ?? 0}
              onChange={(v) => set({ monitoring_per_year: v === 0 ? null : v })}
              options={[{ value: 0, label: "Continue" }, { value: 252, label: "Quotidienne" }, { value: 52, label: "Hebdomadaire" }, { value: 12, label: "Mensuelle" }]} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <div className="grid cols-4">
          <Stat label="Prix barrière" value={ref ? `${num(ref.greeks.price, 4)} ${ccy}` : "—"} busy={isFetching} />
          <Stat label="Vanille équivalente" value={data ? `${num(data.vanilla_price, 4)} ${ccy}` : "—"}
            foot={data && data.vanilla_price > 0 ? `Barrière = ${pct(ref!.greeks.price / data.vanilla_price, 1)} de la vanille` : undefined} busy={isFetching} />
          <Stat label="Delta" value={num(ref?.greeks.delta, 4)} foot={ref ? `Gamma ${num(ref.greeks.gamma, 5)}` : undefined} busy={isFetching} />
          <Stat label="Vega (1 %)" value={num(ref?.greeks.vega, 4)} foot={ref ? `Theta 1j ${num(ref.greeks.theta, 4)}` : undefined} busy={isFetching} />
        </div>
        <Card title="Formule fermée vs Monte Carlo" flush>
          {data ? <GreeksTable results={data.results} busy={isFetching} /> : <div className="card-body"><Skeleton height={90} /></div>}
        </Card>
        {req.rebate > 0 && req.monitoring_per_year === null && (
          <InfoBox>Rebate en observation continue : seule la formule fermée est disponible.</InfoBox>
        )}
        <Card title="Prix en fonction du spot">
          {data ? <EChart option={option} height={440} ariaLabel="Prix de la barrière selon le spot" /> : <Skeleton height={300} />}
        </Card>
        {data && <GreekCharts profile={data.profile} keys={["delta", "gamma", "vega"]}
          markers={[{ x: req.spot, name: "spot" }, { x: req.strike, name: "K" }, { x: req.barrier, name: "barrière", strong: true }]} />}
        <InfoBox>
          À la barrière, la valeur d'une <i>out</i> tombe au rebate : le delta y varie brutalement et le gamma explose (pic
          positif pour un down-and-out call, très négatif pour un up-and-out call, dont la valeur s'effondre juste avant la touche).
          Le vega peut changer de signe, car plus de volatilité augmente aussi la probabilité d'être désactivé.
        </InfoBox>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- autocall

function AutocallDesk() {
  const { snapshot } = useTicker();
  const ccy = ccySymbol(snapshot?.currency);
  const [req, setReq] = useState<AutocallRequest>({
    ...defaultMarket(snapshot), maturity: 5, frequency: 4, coupon_rate: 0.02, autocall_barrier: 1, coupon_barrier: 0.7,
    protection_barrier: 0.6, memory: true, mc_paths: 50_000, with_greeks: true,
  });
  const set = (patch: Partial<AutocallRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 450);
  const { data, error, isFetching } = useQuery({ queryKey: ["autocall", debounced], queryFn: () => api.autocall(debounced), placeholderData: keepPreviousData });
  const fair = useMutation({ mutationFn: () => api.fairCoupon({ ...req, with_greeks: false }) });

  const option = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 30 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 1) },
    xAxis: { type: "category", axisLabel: { hideOverlap: true }, data: data?.observation_times.map((t) => num(t, 2)) ?? [] },
    yAxis: { type: "value", max: 1, axisLabel: { formatter: (v: number) => pct(v, 0) } },
    series: [
      { type: "bar", name: "Remboursement à la date", color: p.series[0], barGap: "10%", itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: data?.redemption_probabilities ?? [] },
      { type: "bar", name: "Paiement d'un coupon", color: p.series[2], itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: data?.coupon_probabilities ?? [] },
    ],
  }), [data]);

  const g = data?.greeks;
  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
            <div className="form-sep" />
            <div className="form-group-title">Structure</div>
            <div className="form-row">
              <NumberField label="Maturité" value={req.maturity} suffix="ans" min={0.5} max={15} digits={1} onChange={(maturity) => set({ maturity })} />
              <SelectField label="Observations" value={req.frequency} onChange={(frequency) => set({ frequency })}
                options={[{ value: 12, label: "Mensuelles" }, { value: 4, label: "Trimestrielles" }, { value: 2, label: "Semestrielles" }, { value: 1, label: "Annuelles" }]} />
            </div>
            <div className="form-row">
              <NumberField label="Coupon / période" value={req.coupon_rate} suffix="%" scale={100} min={0} max={1} digits={3} onChange={(coupon_rate) => set({ coupon_rate })} />
              <NumberField label="Barrière autocall" value={req.autocall_barrier} suffix="%" scale={100} min={0.01} digits={1} onChange={(autocall_barrier) => set({ autocall_barrier })} />
            </div>
            <div className="form-row">
              <NumberField label="Barrière coupon" value={req.coupon_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(coupon_barrier) => set({ coupon_barrier })} />
              <NumberField label="Protection capital" value={req.protection_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(protection_barrier) => set({ protection_barrier })} />
            </div>
            <Check label="Effet mémoire sur les coupons" checked={req.memory} onChange={(memory) => set({ memory })} />
            <Check label="Calculer les grecques (≈ 9 repricings)" checked={req.with_greeks} onChange={(with_greeks) => set({ with_greeks })} />
            <SelectField label="Trajectoires Monte Carlo" value={req.mc_paths} onChange={(mc_paths) => set({ mc_paths })}
              options={[20_000, 50_000, 100_000, 200_000].map((v) => ({ value: v, label: v.toLocaleString("fr-FR") }))} />
            <div className="form-sep" />
            <button className="btn primary" onClick={() => fair.mutate()} disabled={fair.isPending}>
              {fair.isPending ? "Recherche…" : "Calculer le coupon au pair"}
            </button>
            {fair.data && (
              <div className="info-box">
                Coupon qui price la note à 100 % : <b className="num">{fair.data.coupon_rate == null ? "introuvable" : `${pct(fair.data.coupon_rate, 3)} / période`}</b>
                {fair.data.coupon_rate != null && <> ({pct(fair.data.coupon_rate * req.frequency, 2)} / an)</>}
              </div>
            )}
            <ErrorBox error={fair.error} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <div className="grid cols-4">
          <Stat label="Prix (nominal 100)" value={num(data?.price, 3)} foot={data ? `± ${num(data.std_error, 3)} (1 σ MC)` : undefined} busy={isFetching} />
          <Stat label="Durée de vie espérée" value={data ? `${num(data.expected_life, 2)} ans` : "—"} foot={`Maturité max ${num(req.maturity, 1)} ans`} busy={isFetching} />
          <Stat label="Proba de rappel anticipé" value={pct(data ? 1 - data.redemption_probabilities[data.redemption_probabilities.length - 1] : null, 1)} busy={isFetching} />
          <Stat label="Proba de perte en capital" value={pct(data?.loss_probability, 1)} foot={`Sous ${pct(req.protection_barrier, 0)} à l'échéance`} busy={isFetching} />
        </div>
        {g && (
          <div className="grid cols-4">
            <Stat label="Delta" value={num(g.delta, 4)} foot={`Gamma ${num(g.gamma, 5)}`} busy={isFetching} />
            <Stat label="Vega (1 %)" value={num(g.vega, 4)} foot={g.vega < 0 ? "Le porteur est vendeur de volatilité" : "Le porteur est acheteur de volatilité"} busy={isFetching} />
            <Stat label="Rho (1 %)" value={num(g.rho, 4)} busy={isFetching} />
            <Stat label="Theta (1 jour)" value={num(g.theta, 4)} busy={isFetching} />
          </div>
        )}
        <Card title="Probabilités par date d'observation">
          {data ? <EChart option={option} height={440} ariaLabel="Probabilités de remboursement et de coupon par date" /> : <Skeleton height={300} />}
        </Card>
      </div>
    </div>
  );
}
