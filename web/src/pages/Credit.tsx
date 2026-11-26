import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { ApiError, creditApi, type CDSRequest, type Currency, type MertonInputs, type MertonRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { money, num, pct } from "../lib/format";
import { CDS_PRESETS as PRESETS, CDS_TENORS as TENORS } from "../lib/credit";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export const CREDIT_PAGES = [
  { path: "cds", label: "CDS : courbe de défaut et risques" },
  { path: "merton", label: "Modèle de Merton" },
] as const;

export default function Credit() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Crédit</h1>
          <div className="page-sub">
            CDS (modèle à intensité, bootstrap de la courbe de défaut façon ISDA) et modèle structurel de Merton, calibré sur
            le bilan et le marché actions.
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label="Crédit">
        {CREDIT_PAGES.map((m) => (
          <NavLink key={m.path} to={`/credit/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

/** Basis points with enough decimals for the tiny spreads of the structural model. */
const bps = (x: number | null | undefined) =>
  x == null || !Number.isFinite(x) ? "—" : `${num(x, Math.abs(x) < 1 ? 3 : 1)} bp`;
const bn = (x: number | null | undefined, ccy: string) =>
  x == null || !Number.isFinite(x) ? "—" : `${num(x / 1e9, 1)} Md${ccy === "EUR" ? "€" : "$"}`;

// ----------------------------------------------------------------------------- CDS

interface MertonHandoff {
  spreads: number[];
  recovery: number;
  currency: Currency;
  label: string;
}

export function CDSPage() {
  const handoff = (useLocation().state as { merton?: MertonHandoff } | null)?.merton;
  const [preset, setPreset] = useState(handoff ? "custom" : "bbb");
  const [source, setSource] = useState(handoff?.label ?? PRESETS.bbb.label);
  const [req, setReq] = useState<CDSRequest>({
    tenors: TENORS, spreads_bp: handoff?.spreads.map((s) => Math.max(s, 0.01)) ?? PRESETS.bbb.spreads,
    recovery: handoff?.recovery ?? 0.4, rate: { mode: "curve", currency: handoff?.currency ?? "USD", flat_rate: 0.03 },
    maturity: 5, coupon_bp: 100, notional: 10_000_000, side: "buyer",
  });
  const set = (patch: Partial<CDSRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req);
  const { data, error, isFetching } = useQuery({ queryKey: ["cds", debounced], queryFn: () => creditApi.cds(debounced), placeholderData: keepPreviousData });
  const risk = data?.risk;
  const ccy = req.rate.currency;

  const applyPreset = (key: string) => {
    setPreset(key);
    if (PRESETS[key]) {
      setSource(PRESETS[key].label);
      set({ spreads_bp: PRESETS[key].spreads, recovery: PRESETS[key].recovery });
    }
  };
  const setSpread = (i: number) => (v: number) => {
    setPreset("custom");
    setSource("Courbe saisie");
    set({ spreads_bp: req.spreads_bp.map((s, j) => (j === i ? v : s)) });
  };

  const survivalOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34, right: 56 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
    xAxis: { type: "value", name: "années", nameLocation: "middle", nameGap: 26 },
    yAxis: [
      { type: "value", name: "proba de défaut cumulée", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      { type: "value", name: "intensité λ", axisLabel: { formatter: (v: number) => pct(v, 1) }, splitLine: { show: false } },
    ],
    series: [
      { type: "line", name: "Proba de défaut cumulée", showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.08 }, data: data?.curves.t.map((t, i) => [t, data.curves.default_probability[i]]) ?? [] },
      { type: "line", name: "Intensité de défaut λ(t)", step: "start", showSymbol: false, yAxisIndex: 1, color: p.series[0],
        lineStyle: { width: 2 }, data: data?.curves.t.map((t, i) => [t, data.curves.hazard[i]]) ?? [] },
    ],
  }), [data]);

  const parOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => `${num(v, 1)} bp` },
    xAxis: { type: "value", name: "maturité (ans)", nameLocation: "middle", nameGap: 26 },
    yAxis: { type: "value", scale: true, name: "bp" },
    series: [
      { type: "line", name: "Spread au pair du modèle", showSymbol: false, color: p.series[0], lineStyle: { width: 2 },
        data: data?.par_curve.map((c) => [c.maturity, c.par_bp]) ?? [] },
      { type: "scatter", name: "Spreads cotés", symbolSize: 10, color: p.series[1], itemStyle: { borderColor: p.surface, borderWidth: 2 },
        data: data?.table.map((r) => [r.tenor, r.quoted_bp]) ?? [] },
    ],
  }), [data]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <div className="form-group-title">Courbe de spreads CDS</div>
            <SelectField label="Profil de crédit" value={preset} onChange={applyPreset}
              options={[...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })), { value: "custom", label: "Personnalisée" }]} />
            <div className="tenor-grid">
              {req.tenors.map((t, i) => (
                <NumberField key={t} label={`${t} an${t > 1 ? "s" : ""}`} value={req.spreads_bp[i]} suffix="bp" min={0.01} digits={2} onChange={setSpread(i)} />
              ))}
            </div>
            <div className="form-row">
              <NumberField label="Recouvrement" value={req.recovery} suffix="%" scale={100} min={0} max={0.95} digits={0} onChange={(recovery) => set({ recovery })} />
              <Segmented label="Courbe d'actualisation" value={req.rate.currency} onChange={(currency) => set({ rate: { ...req.rate, currency } })}
                options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }]} />
            </div>
            <div className="form-sep" />
            <div className="form-group-title">Contrat</div>
            <Segmented value={req.side} onChange={(side) => set({ side })}
              options={[{ value: "buyer", label: "Achat de protection" }, { value: "seller", label: "Vente de protection" }]} />
            <div className="form-row">
              <NumberField label="Maturité" value={req.maturity} suffix="ans" min={0.25} max={30} digits={2} onChange={(maturity) => set({ maturity })} />
              <SelectField label="Coupon standard" value={req.coupon_bp} onChange={(coupon_bp) => set({ coupon_bp })}
                options={[{ value: 100, label: "100 bp (IG)" }, { value: 500, label: "500 bp (HY)" }, { value: 25, label: "25 bp" }, { value: 1000, label: "1 000 bp" }]} />
            </div>
            <NumberField label="Nominal" value={req.notional} suffix={ccy === "EUR" ? "€" : "$"} min={1} digits={0} onChange={(notional) => set({ notional })} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          Source de la courbe : <b>{source}</b>. On cherche l'intensité de défaut λ(t), constante par morceaux, qui fait
          valoir chaque CDS coté exactement au pair (protection = prime). Le contrat se traite ensuite avec un coupon standard :
          l'écart entre ce coupon et le spread au pair se règle en points d'upfront.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Spread au pair" value={risk ? bps(risk.par_spread * 1e4) : "—"} foot={`Maturité ${num(req.maturity, 2)} ans`} busy={isFetching} />
          <Stat label="Upfront" value={risk ? `${num(risk.upfront * 100, 3)} pts` : "—"}
            foot={risk ? (risk.upfront >= 0 ? "Payé par l'acheteur de protection" : "Reçu par l'acheteur de protection") : undefined} busy={isFetching} />
          <Stat label="Valeur de marché" value={money(risk?.value, ccy)} foot={req.side === "buyer" ? "Côté acheteur" : "Côté vendeur"} busy={isFetching} />
          <Stat label="RPV01 (duration risquée)" value={num(risk?.rpv01, 3)} foot="Valeur de 1 de prime par an" busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label="CS01 (+1 bp de spread)" value={money(risk?.cs01, ccy)} foot="Courbe re-bootstrapée" busy={isFetching} />
          <Stat label="IR01 (+1 bp de taux)" value={money(risk?.ir01, ccy)} foot="Spreads cotés inchangés" busy={isFetching} />
          <Stat label="Recouvrement +1 %" value={money(risk?.rec01, ccy)} foot="Spreads cotés inchangés" busy={isFetching} />
          <Stat label="Jump-to-default" value={money(risk?.jump_to_default, ccy)} foot={risk ? `Portage 1 jour ${money(risk.carry_1d, ccy)}` : undefined} busy={isFetching} />
        </div>
        <Card title="Bootstrap : chaque CDS coté est repricé au pair" flush>
          {data ? (
            <div className={`table-wrap${isFetching ? " busy" : ""}`}>
              <table className="data">
                <thead><tr><th>Maturité</th><th>Spread coté</th><th>Spread modèle</th><th>λ du segment</th><th>Survie</th><th>Proba de défaut</th><th>RPV01</th><th>Upfront 100 bp</th><th>Upfront 500 bp</th></tr></thead>
                <tbody>
                  {data.table.map((r) => (
                    <tr key={r.tenor}>
                      <td className="strong">{r.tenor} an{r.tenor > 1 ? "s" : ""}</td><td>{bps(r.quoted_bp)}</td><td>{num(r.model_bp, 4)} bp</td>
                      <td>{pct(r.hazard, 2)}</td><td>{pct(r.survival, 2)}</td><td className="strong">{pct(r.default_probability, 2)}</td>
                      <td>{num(r.rpv01, 3)}</td><td>{num(r.upfront_100 * 100, 2)} pts</td><td>{num(r.upfront_500 * 100, 2)} pts</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={160} /></div>}
        </Card>
        <InfoBox>
          Triangle du crédit : λ ≈ spread / (1 − R). Une courbe de spreads croissante implique des intensités <i>forward</i> encore
          plus élevées sur les segments longs, comme une courbe de taux zéro croissante implique des forwards plus hauts. Une
          courbe trop inversée n'a pas de solution (intensité négative) : le bootstrap la rejette.
        </InfoBox>
        <div className="grid cols-2">
          <Card title="Probabilité de défaut et intensité">
            {data ? <EChart option={survivalOption} height={340} ariaLabel="Probabilité de défaut cumulée et intensité de défaut" /> : <Skeleton height={300} />}
          </Card>
          <Card title="Courbe des spreads au pair">
            {data ? <EChart option={parOption} height={340} ariaLabel="Spreads au pair du modèle et spreads cotés" /> : <Skeleton height={300} />}
          </Card>
        </div>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- Merton

export function MertonPage() {
  const { ticker } = useTicker();
  const inputs = useQuery({ queryKey: ["merton-inputs", ticker], queryFn: () => creditApi.mertonInputs(ticker), retry: false });
  return inputs.isLoading ? <Skeleton height={300} />
    : inputs.error ? <MertonUnavailable error={inputs.error} />
      : inputs.data ? <MertonDesk key={ticker} inputs={inputs.data} /> : null;
}

function MertonUnavailable({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return <InfoBox>{error.message}. Choisissez une action dans la barre du haut (AAPL, MSFT, NVDA, MC.PA, TTE.PA, AIR.PA…).</InfoBox>;
  }
  return <ErrorBox error={error} />;
}

type DebtChoice = "kmv" | "total" | "custom";

function MertonDesk({ inputs }: { inputs: MertonInputs }) {
  const navigate = useNavigate();
  const ccy = inputs.currency;
  const [debt, setDebt] = useState<DebtChoice>("kmv");
  const [req, setReq] = useState<MertonRequest>({
    equity: inputs.equity, equity_vol: inputs.equity_vol, debt_face: inputs.kmv_default_point, horizon: 1,
    currency: ccy, recovery: 0.4, market_spread_bp: null,
  });
  const set = (patch: Partial<MertonRequest>) => setReq((r) => ({ ...r, ...patch }));
  useEffect(() => {
    if (debt === "kmv") set({ debt_face: inputs.kmv_default_point });
    if (debt === "total") set({ debt_face: inputs.total_debt });
  }, [debt, inputs]);
  const debounced = useDebounced(req);
  const { data, error, isFetching } = useQuery({ queryKey: ["merton", debounced], queryFn: () => creditApi.merton(debounced), placeholderData: keepPreviousData });
  const f = data?.fit;

  const termOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34, right: 60 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "value", name: "maturité de la dette (ans)", nameLocation: "middle", nameGap: 26 },
    yAxis: [
      { type: "value", name: "spread (bp)" },
      { type: "value", name: "proba de défaut", axisLabel: { formatter: (v: number) => pct(v, 1) }, splitLine: { show: false } },
    ],
    series: [
      { type: "line", name: "Spread de la dette", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 },
        tooltip: { valueFormatter: (v: number) => bps(v) }, data: data?.term_structure.T.map((t, i) => [t, data.term_structure.spread_bp[i]]) ?? [] },
      { type: "line", name: "Proba de défaut (risque-neutre)", showSymbol: false, yAxisIndex: 1, color: p.series[1], lineStyle: { width: 2, type: "dashed" },
        tooltip: { valueFormatter: (v: number) => pct(v, 3) }, data: data?.term_structure.T.map((t, i) => [t, data.term_structure.default_probability[i]]) ?? [] },
    ],
  }), [data]);

  const volOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => bps(v) },
    grid: { top: 20 },
    xAxis: { type: "value", name: "volatilité action", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax",
      axisLabel: { formatter: (v: number) => pct(v, 0) } },
    yAxis: { type: "value", name: "spread (bp)" },
    series: [{ type: "line", name: "Spread", symbolSize: 6, color: p.series[0], lineStyle: { width: 2 },
      data: data?.by_vol.map((r) => [r.equity_vol, r.spread_bp]) ?? [],
      markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dashed", width: 1 },
        label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" }, data: [{ xAxis: req.equity_vol, name: "actuelle" }] } }],
  }), [data, req.equity_vol]);

  const equityOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => bps(v) },
    grid: { top: 20 },
    xAxis: { type: "value", name: "variation de la capitalisation", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax",
      axisLabel: { formatter: (v: number) => pct(v, 0) } },
    yAxis: { type: "value", name: "spread (bp)" },
    series: [{ type: "line", name: "Spread", symbolSize: 6, color: p.series[2], lineStyle: { width: 2 },
      data: data?.by_equity.map((r) => [r.move, r.spread_bp]) ?? [] }],
  }), [data]);

  const cdsOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => bps(v) },
    grid: { top: 20 },
    xAxis: { type: "category", data: data?.cds.tenors.map((t) => `${t} an${t > 1 ? "s" : ""}`) ?? [] },
    yAxis: { type: "value", name: "bp" },
    series: [{ type: "bar", name: "CDS implicite", color: p.series[0], itemStyle: { borderRadius: [4, 4, 0, 0] }, data: data?.cds.spreads_bp ?? [],
      markLine: req.market_spread_bp ? { symbol: "none", silent: true, lineStyle: { color: p.critical, width: 1.5 },
        label: { color: p.muted, fontSize: 10, formatter: "CDS 5 ans de marché", position: "insideEndTop" },
        data: [{ yAxis: req.market_spread_bp }] } : undefined }],
  }), [data, req.market_spread_bp]);

  const toCds = () => data && navigate("/credit/cds", {
    state: { merton: { spreads: data.cds.spreads_bp, recovery: req.recovery, currency: ccy, label: `Merton implicite — ${inputs.ticker}` } },
  });

  return (
    <div className="split">
      <div className="sticky">
        <Card title={`Paramètres — ${inputs.name}`}>
          <div className="form">
            <div className="form-group-title">Actions</div>
            <NumberField label="Capitalisation boursière E" value={req.equity / 1e9} suffix={`Md${ccy === "EUR" ? "€" : "$"}`} min={0.001} digits={2}
              hint={`${num(inputs.shares_outstanding / 1e6, 0)} M d'actions × ${num(inputs.spot, 2)}`} onChange={(v) => set({ equity: v * 1e9 })} />
            <NumberField label="Volatilité action σE" value={req.equity_vol} suffix="%" scale={100} min={0.01} max={5} digits={1}
              hint={`Par défaut : ${inputs.equity_vol_source}`} onChange={(equity_vol) => set({ equity_vol })} />
            <div className="form-sep" />
            <div className="form-group-title">Dette (bilan {inputs.financial_currency})</div>
            <SelectField label="Point de défaut D" value={debt} onChange={setDebt}
              options={[{ value: "kmv", label: "KMV : CT + ½ LT" }, { value: "total", label: "Dette totale" }, { value: "custom", label: "Personnalisé" }]} />
            <NumberField label="Nominal de la dette D" value={req.debt_face / 1e9} suffix={`Md${ccy === "EUR" ? "€" : "$"}`} min={0.001} digits={2}
              hint={`CT ${bn(inputs.short_term_debt, ccy)} · LT ${bn(inputs.long_term_debt, ccy)}`}
              onChange={(v) => { setDebt("custom"); set({ debt_face: v * 1e9 }); }} />
            <div className="form-row">
              <NumberField label="Horizon T" value={req.horizon} suffix="ans" min={0.1} max={30} digits={1} onChange={(horizon) => set({ horizon })} />
              <NumberField label="Recouvrement (CDS)" value={req.recovery} suffix="%" scale={100} min={0} max={0.95} digits={0} onChange={(recovery) => set({ recovery })} />
            </div>
            <div className="form-sep" />
            <div className="form-group-title">Comparaison au marché</div>
            <NumberField label="CDS 5 ans observé (optionnel)" value={req.market_spread_bp ?? 0} suffix="bp" min={0} digits={1}
              hint="0 = pas de comparaison" onChange={(v) => set({ market_spread_bp: v > 0 ? v : null })} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          Les actionnaires détiennent un call sur les actifs de l'entreprise, de strike la dette D : E = V N(d₁) − D e<sup>−rT</sup> N(d₂),
          avec σ<sub>E</sub> E = N(d₁) σ<sub>V</sub> V. On résout ces deux équations pour retrouver la valeur V et la volatilité
          σ<sub>V</sub> des actifs, qui ne sont pas observables. La dette vaut D e<sup>−rT</sup> moins un put sur V : son spread
          rémunère ce put.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Valeur des actifs V" value={bn(f?.assets, ccy)} foot={f ? `Levier D e⁻ʳᵀ / V = ${pct(f.leverage, 1)}` : undefined} busy={isFetching} />
          <Stat label="Volatilité des actifs σV" value={pct(f?.asset_vol, 1)} foot={f ? `σE = ${pct(f.equity_vol, 1)} · N(d₁) = ${num(f.equity_delta, 4)}` : undefined} busy={isFetching} />
          <Stat label="Distance au défaut" value={f ? `${num(f.d2, 2)} σ` : "—"} foot="d₂ : écarts-types entre V et D à l'horizon" busy={isFetching} />
          <Stat label={`Proba de défaut ${num(req.horizon, 1)} an`} value={f ? (f.default_probability < 1e-4 ? f.default_probability.toExponential(2) : pct(f.default_probability, 3)) : "—"}
            foot="Risque-neutre : N(−d₂)" busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label={`Spread de la dette ${num(req.horizon, 1)} an`} value={bps(data?.spread_bp)} foot={f ? `Taux sans risque ${pct(data!.rate, 2)}` : undefined} busy={isFetching} />
          <Stat label="CDS 5 ans implicite" value={bps(data?.cds.spreads_bp[3])} foot={`Recouvrement ${pct(req.recovery, 0)}`} busy={isFetching} />
          <Stat label="Recouvrement implicite" value={pct(f?.recovery, 1)} foot="E[V_T | défaut] / D" busy={isFetching} />
          <Stat label="Action −1 %" value={data ? `${data.spread_change_for_equity_down_1pct_bp >= 0 ? "+" : ""}${bps(data.spread_change_for_equity_down_1pct_bp)}` : "—"}
            foot="Variation du spread : lien actions / crédit" busy={isFetching} />
        </div>
        {data && req.market_spread_bp != null && (
          <InfoBox>
            Pour que Merton redonne le CDS 5 ans observé de {num(req.market_spread_bp, 0)} bp, il faudrait une volatilité action de{" "}
            <b>{data.implied_equity_vol != null ? pct(data.implied_equity_vol, 1) : "plus de 300 %"}</b>, contre {pct(req.equity_vol, 1)} observée.
            {data.implied_equity_vol != null && data.implied_equity_vol > req.equity_vol * 1.2
              ? " Le marché du crédit price plus de risque que ne l'explique le marché actions : c'est le « credit spread puzzle »."
              : ""}
          </InfoBox>
        )}
        <InfoBox>
          Merton sous-estime presque toujours les spreads des grandes entreprises, surtout à court terme : V suit une diffusion
          sans saut, donc une firme loin de son point de défaut ne peut pas y arriver en quelques mois et le spread court tend vers 0.
          Les modèles à sauts, à barrière (Black-Cox) ou à point de défaut incertain (CreditGrades) corrigent ce défaut.
        </InfoBox>
        <Card title="Structure par terme : spread et probabilité de défaut" actions={
          <button className="btn" onClick={toCds} disabled={!data}>Pricer un CDS sur cette courbe</button>
        }>
          {data ? <EChart option={termOption} height={360} ariaLabel="Spread et probabilité de défaut selon la maturité" /> : <Skeleton height={300} />}
        </Card>
        <div className="grid cols-2">
          <Card title="Spread selon la volatilité action">
            {data ? <EChart option={volOption} height={300} ariaLabel="Spread selon la volatilité action" /> : <Skeleton height={260} />}
          </Card>
          <Card title="Spread selon le cours de l'action (dette fixe)">
            {data ? <EChart option={equityOption} height={300} ariaLabel="Spread selon la capitalisation" /> : <Skeleton height={260} />}
          </Card>
        </div>
        <Card title="Courbe CDS implicite (même survie, recouvrement de marché)">
          {data ? <EChart option={cdsOption} height={300} ariaLabel="Spreads CDS implicites du modèle de Merton" /> : <Skeleton height={260} />}
        </Card>
      </div>
    </div>
  );
}
