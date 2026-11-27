import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, type AutocallRequest, type BarrierRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { defaultMarket, GreekCharts, GreeksTable, MarketForm } from "../components/pricing";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { ccySymbol, num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { tr } from "../lib/i18n";

export default function Structured() {
  const { ticker, snapshot } = useTicker();
  const [tab, setTab] = useState<"barrier" | "autocall">("autocall");
  const key = `${ticker}:${snapshot ? "ready" : "loading"}`;
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Produits structurés", "Structured products")} — {ticker}</h1>
          <div className="page-sub">{tr("Moteur d'options + courbe de taux : barrières (formule fermée et Monte Carlo) et autocalls Phoenix / Athena.", "Option engine + rate curve: barriers (closed form and Monte Carlo) and Phoenix / Athena autocalls.")}</div>
        </div>
      </div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "autocall"} className={tab === "autocall" ? "on" : ""} onClick={() => setTab("autocall")}>Autocall</button>
        <button role="tab" aria-selected={tab === "barrier"} className={tab === "barrier" ? "on" : ""} onClick={() => setTab("barrier")}>{tr("Option à barrière", "Barrier option")}</button>
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
      type: "line", name: tr("Prix (formule fermée)", "Price (closed form)"), showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
      data: data?.profile.spots.map((s, i) => [s, data.profile.series.price[i]]) ?? [],
      markLine: { symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
        data: [
          { xAxis: req.barrier, name: tr("barrière", "barrier"), lineStyle: { color: p.critical, type: "solid", width: 1.5 } },
          { xAxis: req.spot, name: "spot", lineStyle: { color: p.muted, type: "dashed", width: 1 } },
          { xAxis: req.strike, name: "K", lineStyle: { color: p.muted, type: "dotted", width: 1 } },
        ] },
    }],
  }), [data, req.barrier, req.spot, req.strike]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title={tr("Paramètres", "Parameters")}>
          <div className="form">
            <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
            <div className="form-sep" />
            <div className="form-group-title">{tr("Contrat", "Contract")}</div>
            <SelectField label={tr("Type de barrière", "Barrier type")} value={req.barrier_type} onChange={(barrier_type) => set({ barrier_type })}
              options={[{ value: "down-and-out", label: "Down-and-out" }, { value: "down-and-in", label: "Down-and-in" },
                { value: "up-and-out", label: "Up-and-out" }, { value: "up-and-in", label: "Up-and-in" }]} />
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })}
              options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
            <div className="form-row">
              <NumberField label="Strike" value={req.strike} suffix={ccy} min={0.0001} digits={2} onChange={(strike) => set({ strike })} />
              <NumberField label={tr("Barrière", "Barrier")} value={req.barrier} suffix={ccy} min={0.0001} digits={2} onChange={(barrier) => set({ barrier })} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Maturité", "Maturity")} value={req.expiry} suffix={tr("ans", "years")} min={0.01} max={30} digits={2} onChange={(expiry) => set({ expiry })} />
              <NumberField label="Rebate" value={req.rebate} suffix={ccy} min={0} digits={2} onChange={(rebate) => set({ rebate })} />
            </div>
            <SelectField label={tr("Observation de la barrière", "Barrier monitoring")} value={req.monitoring_per_year ?? 0}
              onChange={(v) => set({ monitoring_per_year: v === 0 ? null : v })}
              options={[{ value: 0, label: tr("Continue", "Continuous") }, { value: 252, label: tr("Quotidienne", "Daily") }, { value: 52, label: tr("Hebdomadaire", "Weekly") }, { value: 12, label: tr("Mensuelle", "Monthly") }]} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <div className="grid cols-4">
          <Stat label={tr("Prix barrière", "Barrier price")} value={ref ? `${num(ref.greeks.price, 4)} ${ccy}` : "—"} busy={isFetching} />
          <Stat label={tr("Vanille équivalente", "Equivalent vanilla")} value={data ? `${num(data.vanilla_price, 4)} ${ccy}` : "—"}
            foot={data && data.vanilla_price > 0 ? tr(`Barrière = ${pct(ref!.greeks.price / data.vanilla_price, 1)} de la vanille`, `Barrier = ${pct(ref!.greeks.price / data.vanilla_price, 1)} of the vanilla`) : undefined} busy={isFetching} />
          <Stat label="Delta" value={num(ref?.greeks.delta, 4)} foot={ref ? `Gamma ${num(ref.greeks.gamma, 5)}` : undefined} busy={isFetching} />
          <Stat label={tr("Vega (1 %)", "Vega (1%)")} value={num(ref?.greeks.vega, 4)} foot={ref ? tr(`Theta 1j ${num(ref.greeks.theta, 4)}`, `Theta 1d ${num(ref.greeks.theta, 4)}`) : undefined} busy={isFetching} />
        </div>
        <Card title={tr("Formule fermée vs Monte Carlo", "Closed form vs Monte Carlo")} flush>
          {data ? <GreeksTable results={data.results} busy={isFetching} /> : <div className="card-body"><Skeleton height={90} /></div>}
        </Card>
        {req.rebate > 0 && req.monitoring_per_year === null && (
          <InfoBox>{tr("Rebate en observation continue : seule la formule fermée est disponible.", "Rebate with continuous monitoring: only the closed form is available.")}</InfoBox>
        )}
        <Card title={tr("Prix en fonction du spot", "Price as a function of spot")}>
          {data ? <EChart option={option} height={440} ariaLabel={tr("Prix de la barrière selon le spot", "Barrier price by spot")} /> : <Skeleton height={300} />}
        </Card>
        {data && <GreekCharts profile={data.profile} keys={["delta", "gamma", "vega"]}
          markers={[{ x: req.spot, name: "spot" }, { x: req.strike, name: "K" }, { x: req.barrier, name: tr("barrière", "barrier"), strong: true }]} />}
        <InfoBox>
          {tr(<>
            À la barrière, la valeur d'une <i>out</i> tombe au rebate : le delta y varie brutalement et le gamma explose (pic
            positif pour un down-and-out call, très négatif pour un up-and-out call, dont la valeur s'effondre juste avant la touche).
            Le vega peut changer de signe, car plus de volatilité augmente aussi la probabilité d'être désactivé.
          </>, <>
            At the barrier the value of an <i>out</i> option drops to the rebate: delta jumps there and gamma explodes (a positive
            spike for a down-and-out call, very negative for an up-and-out call, whose value collapses just before the touch).
            Vega can change sign, because more volatility also raises the probability of being knocked out.
          </>)}
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
      { type: "bar", name: tr("Remboursement à la date", "Redemption at the date"), color: p.series[0], barGap: "10%", itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: data?.redemption_probabilities ?? [] },
      { type: "bar", name: tr("Paiement d'un coupon", "Coupon payment"), color: p.series[2], itemStyle: { borderRadius: [4, 4, 0, 0] },
        data: data?.coupon_probabilities ?? [] },
    ],
  }), [data]);

  const g = data?.greeks;
  return (
    <div className="split">
      <div className="sticky">
        <Card title={tr("Paramètres", "Parameters")}>
          <div className="form">
            <MarketForm value={req} onChange={(m) => set(m)} currency={ccy} />
            <div className="form-sep" />
            <div className="form-group-title">Structure</div>
            <div className="form-row">
              <NumberField label={tr("Maturité", "Maturity")} value={req.maturity} suffix={tr("ans", "years")} min={0.5} max={15} digits={1} onChange={(maturity) => set({ maturity })} />
              <SelectField label={tr("Observations", "Observations")} value={req.frequency} onChange={(frequency) => set({ frequency })}
                options={[{ value: 12, label: tr("Mensuelles", "Monthly") }, { value: 4, label: tr("Trimestrielles", "Quarterly") }, { value: 2, label: tr("Semestrielles", "Semi-annual") }, { value: 1, label: tr("Annuelles", "Annual") }]} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Coupon / période", "Coupon / period")} value={req.coupon_rate} suffix="%" scale={100} min={0} max={1} digits={3} onChange={(coupon_rate) => set({ coupon_rate })} />
              <NumberField label={tr("Barrière autocall", "Autocall barrier")} value={req.autocall_barrier} suffix="%" scale={100} min={0.01} digits={1} onChange={(autocall_barrier) => set({ autocall_barrier })} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Barrière coupon", "Coupon barrier")} value={req.coupon_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(coupon_barrier) => set({ coupon_barrier })} />
              <NumberField label={tr("Protection capital", "Capital protection")} value={req.protection_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(protection_barrier) => set({ protection_barrier })} />
            </div>
            <Check label={tr("Effet mémoire sur les coupons", "Memory effect on coupons")} checked={req.memory} onChange={(memory) => set({ memory })} />
            <Check label={tr("Calculer les grecques (≈ 9 repricings)", "Compute the Greeks (≈ 9 repricings)")} checked={req.with_greeks} onChange={(with_greeks) => set({ with_greeks })} />
            <SelectField label={tr("Trajectoires Monte Carlo", "Monte Carlo paths")} value={req.mc_paths} onChange={(mc_paths) => set({ mc_paths })}
              options={[20_000, 50_000, 100_000, 200_000].map((v) => ({ value: v, label: num(v, 0) }))} />
            <div className="form-sep" />
            <button className="btn primary" onClick={() => fair.mutate()} disabled={fair.isPending}>
              {fair.isPending ? tr("Recherche…", "Searching…") : tr("Calculer le coupon au pair", "Compute the par coupon")}
            </button>
            {fair.data && (
              <div className="info-box">
                {tr("Coupon qui price la note à 100 % :", "Coupon that prices the note at 100%:")} <b className="num">{fair.data.coupon_rate == null ? tr("introuvable", "not found") : tr(`${pct(fair.data.coupon_rate, 3)} / période`, `${pct(fair.data.coupon_rate, 3)} / period`)}</b>
                {fair.data.coupon_rate != null && <> ({pct(fair.data.coupon_rate * req.frequency, 2)} {tr("/ an", "/ year")})</>}
              </div>
            )}
            <ErrorBox error={fair.error} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <div className="grid cols-4">
          <Stat label={tr("Prix (nominal 100)", "Price (100 notional)")} value={num(data?.price, 3)} foot={data ? `± ${num(data.std_error, 3)} (1 σ MC)` : undefined} busy={isFetching} />
          <Stat label={tr("Durée de vie espérée", "Expected life")} value={data ? tr(`${num(data.expected_life, 2)} ans`, `${num(data.expected_life, 2)} years`) : "—"} foot={tr(`Maturité max ${num(req.maturity, 1)} ans`, `Max maturity ${num(req.maturity, 1)} years`)} busy={isFetching} />
          <Stat label={tr("Proba de rappel anticipé", "Early-call probability")} value={pct(data ? 1 - data.redemption_probabilities[data.redemption_probabilities.length - 1] : null, 1)} busy={isFetching} />
          <Stat label={tr("Proba de perte en capital", "Capital loss probability")} value={pct(data?.loss_probability, 1)} foot={tr(`Sous ${pct(req.protection_barrier, 0)} à l'échéance`, `Below ${pct(req.protection_barrier, 0)} at maturity`)} busy={isFetching} />
        </div>
        {g && (
          <div className="grid cols-4">
            <Stat label="Delta" value={num(g.delta, 4)} foot={`Gamma ${num(g.gamma, 5)}`} busy={isFetching} />
            <Stat label={tr("Vega (1 %)", "Vega (1%)")} value={num(g.vega, 4)} foot={g.vega < 0 ? tr("Le porteur est vendeur de volatilité", "The holder is short volatility") : tr("Le porteur est acheteur de volatilité", "The holder is long volatility")} busy={isFetching} />
            <Stat label={tr("Rho (1 %)", "Rho (1%)")} value={num(g.rho, 4)} busy={isFetching} />
            <Stat label={tr("Theta (1 jour)", "Theta (1 day)")} value={num(g.theta, 4)} busy={isFetching} />
          </div>
        )}
        <Card title={tr("Probabilités par date d'observation", "Probabilities by observation date")}>
          {data ? <EChart option={option} height={440} ariaLabel={tr("Probabilités de remboursement et de coupon par date", "Redemption and coupon probabilities by date")} /> : <Skeleton height={300} />}
        </Card>
      </div>
    </div>
  );
}
