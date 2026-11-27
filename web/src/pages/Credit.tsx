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
import { tr } from "../lib/i18n";

export const CREDIT_PAGES = [
  { path: "cds", label: ["CDS : courbe de défaut et risques", "CDS: default curve and risks"] },
  { path: "merton", label: ["Modèle de Merton", "Merton model"] },
] as const;

export default function Credit() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Crédit", "Credit")}</h1>
          <div className="page-sub">
            {tr("CDS (modèle à intensité, bootstrap de la courbe de défaut façon ISDA) et modèle structurel de Merton, calibré sur le bilan et le marché actions.",
              "CDS (intensity model, ISDA-style default curve bootstrap) and Merton's structural model, calibrated on the balance sheet and the equity market.")}
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label={tr("Crédit", "Credit")}>
        {CREDIT_PAGES.map((m) => (
          <NavLink key={m.path} to={`/credit/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{tr(m.label[0], m.label[1])}</NavLink>
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
  x == null || !Number.isFinite(x) ? "—" : tr(`${num(x / 1e9, 1)} Md${ccy === "EUR" ? "€" : "$"}`, `${ccy === "EUR" ? "€" : "$"}${num(x / 1e9, 1)}bn`);

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
    setSource(tr("Courbe saisie", "Curve entered"));
    set({ spreads_bp: req.spreads_bp.map((s, j) => (j === i ? v : s)) });
  };

  const survivalOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34, right: 56 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
    xAxis: { type: "value", name: tr("années", "years"), nameLocation: "middle", nameGap: 26 },
    yAxis: [
      { type: "value", name: tr("proba de défaut cumulée", "cumulative default probability"), axisLabel: { formatter: (v: number) => pct(v, 0) } },
      { type: "value", name: tr("intensité λ", "intensity λ"), axisLabel: { formatter: (v: number) => pct(v, 1) }, splitLine: { show: false } },
    ],
    series: [
      { type: "line", name: tr("Proba de défaut cumulée", "Cumulative default probability"), showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.08 }, data: data?.curves.t.map((t, i) => [t, data.curves.default_probability[i]]) ?? [] },
      { type: "line", name: tr("Intensité de défaut λ(t)", "Default intensity λ(t)"), step: "start", showSymbol: false, yAxisIndex: 1, color: p.series[0],
        lineStyle: { width: 2 }, data: data?.curves.t.map((t, i) => [t, data.curves.hazard[i]]) ?? [] },
    ],
  }), [data]);

  const parOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => `${num(v, 1)} bp` },
    xAxis: { type: "value", name: tr("maturité (ans)", "maturity (years)"), nameLocation: "middle", nameGap: 26 },
    yAxis: { type: "value", scale: true, name: "bp" },
    series: [
      { type: "line", name: tr("Spread au pair du modèle", "Model par spread"), showSymbol: false, color: p.series[0], lineStyle: { width: 2 },
        data: data?.par_curve.map((c) => [c.maturity, c.par_bp]) ?? [] },
      { type: "scatter", name: tr("Spreads cotés", "Quoted spreads"), symbolSize: 10, color: p.series[1], itemStyle: { borderColor: p.surface, borderWidth: 2 },
        data: data?.table.map((r) => [r.tenor, r.quoted_bp]) ?? [] },
    ],
  }), [data]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title={tr("Paramètres", "Parameters")}>
          <div className="form">
            <div className="form-group-title">{tr("Courbe de spreads CDS", "CDS spread curve")}</div>
            <SelectField label={tr("Profil de crédit", "Credit profile")} value={preset} onChange={applyPreset}
              options={[...Object.entries(PRESETS).map(([value, p]) => ({ value, label: p.label })), { value: "custom", label: tr("Personnalisée", "Custom") }]} />
            <div className="tenor-grid">
              {req.tenors.map((t, i) => (
                <NumberField key={t} label={tr(`${t} an${t > 1 ? "s" : ""}`, `${t} year${t > 1 ? "s" : ""}`)} value={req.spreads_bp[i]} suffix="bp" min={0.01} digits={2} onChange={setSpread(i)} />
              ))}
            </div>
            <div className="form-row">
              <NumberField label={tr("Recouvrement", "Recovery")} value={req.recovery} suffix="%" scale={100} min={0} max={0.95} digits={0} onChange={(recovery) => set({ recovery })} />
              <Segmented label={tr("Courbe d'actualisation", "Discount curve")} value={req.rate.currency} onChange={(currency) => set({ rate: { ...req.rate, currency } })}
                options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }]} />
            </div>
            <div className="form-sep" />
            <div className="form-group-title">{tr("Contrat", "Contract")}</div>
            <Segmented value={req.side} onChange={(side) => set({ side })}
              options={[{ value: "buyer", label: tr("Achat de protection", "Buy protection") }, { value: "seller", label: tr("Vente de protection", "Sell protection") }]} />
            <div className="form-row">
              <NumberField label={tr("Maturité", "Maturity")} value={req.maturity} suffix={tr("ans", "years")} min={0.25} max={30} digits={2} onChange={(maturity) => set({ maturity })} />
              <SelectField label={tr("Coupon standard", "Standard coupon")} value={req.coupon_bp} onChange={(coupon_bp) => set({ coupon_bp })}
                options={[{ value: 100, label: "100 bp (IG)" }, { value: 500, label: "500 bp (HY)" }, { value: 25, label: "25 bp" }, { value: 1000, label: tr("1 000 bp", "1,000 bp") }]} />
            </div>
            <NumberField label={tr("Nominal", "Notional")} value={req.notional} suffix={ccy === "EUR" ? "€" : "$"} min={1} digits={0} onChange={(notional) => set({ notional })} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          {tr(<>
            Source de la courbe : <b>{source}</b>. On cherche l'intensité de défaut λ(t), constante par morceaux, qui fait
            valoir chaque CDS coté exactement au pair (protection = prime). Le contrat se traite ensuite avec un coupon standard :
            l'écart entre ce coupon et le spread au pair se règle en points d'upfront.
          </>, <>
            Curve source: <b>{source}</b>. We look for the piecewise-constant default intensity λ(t) that makes
            each quoted CDS worth exactly par (protection = premium). The contract then trades with a standard coupon:
            the gap between that coupon and the par spread is settled in upfront points.
          </>)}
        </Explainer>
        <div className="grid cols-4">
          <Stat label={tr("Spread au pair", "Par spread")} value={risk ? bps(risk.par_spread * 1e4) : "—"} foot={tr(`Maturité ${num(req.maturity, 2)} ans`, `Maturity ${num(req.maturity, 2)} years`)} busy={isFetching} />
          <Stat label="Upfront" value={risk ? `${num(risk.upfront * 100, 3)} pts` : "—"}
            foot={risk ? (risk.upfront >= 0 ? tr("Payé par l'acheteur de protection", "Paid by the protection buyer") : tr("Reçu par l'acheteur de protection", "Received by the protection buyer")) : undefined} busy={isFetching} />
          <Stat label={tr("Valeur de marché", "Market value")} value={money(risk?.value, ccy)} foot={req.side === "buyer" ? tr("Côté acheteur", "Buyer side") : tr("Côté vendeur", "Seller side")} busy={isFetching} />
          <Stat label={tr("RPV01 (duration risquée)", "RPV01 (risky duration)")} value={num(risk?.rpv01, 3)} foot={tr("Valeur de 1 de prime par an", "Value of 1 of premium a year")} busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label={tr("CS01 (+1 bp de spread)", "CS01 (+1 bp spread)")} value={money(risk?.cs01, ccy)} foot={tr("Courbe re-bootstrapée", "Curve re-bootstrapped")} busy={isFetching} />
          <Stat label={tr("IR01 (+1 bp de taux)", "IR01 (+1 bp rate)")} value={money(risk?.ir01, ccy)} foot={tr("Spreads cotés inchangés", "Quoted spreads unchanged")} busy={isFetching} />
          <Stat label={tr("Recouvrement +1 %", "Recovery +1%")} value={money(risk?.rec01, ccy)} foot={tr("Spreads cotés inchangés", "Quoted spreads unchanged")} busy={isFetching} />
          <Stat label="Jump-to-default" value={money(risk?.jump_to_default, ccy)} foot={risk ? tr(`Portage 1 jour ${money(risk.carry_1d, ccy)}`, `1-day carry ${money(risk.carry_1d, ccy)}`) : undefined} busy={isFetching} />
        </div>
        <Card title={tr("Bootstrap : chaque CDS coté est repricé au pair", "Bootstrap: each quoted CDS is repriced at par")} flush>
          {data ? (
            <div className={`table-wrap${isFetching ? " busy" : ""}`}>
              <table className="data">
                <thead><tr><th>{tr("Maturité", "Maturity")}</th><th>{tr("Spread coté", "Quoted spread")}</th><th>{tr("Spread modèle", "Model spread")}</th><th>{tr("λ du segment", "Segment λ")}</th><th>{tr("Survie", "Survival")}</th><th>{tr("Proba de défaut", "Default probability")}</th><th>RPV01</th><th>Upfront 100 bp</th><th>Upfront 500 bp</th></tr></thead>
                <tbody>
                  {data.table.map((r) => (
                    <tr key={r.tenor}>
                      <td className="strong">{tr(`${r.tenor} an${r.tenor > 1 ? "s" : ""}`, `${r.tenor} year${r.tenor > 1 ? "s" : ""}`)}</td><td>{bps(r.quoted_bp)}</td><td>{num(r.model_bp, 4)} bp</td>
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
          {tr(<>
            Triangle du crédit : λ ≈ spread / (1 − R). Une courbe de spreads croissante implique des intensités <i>forward</i> encore
            plus élevées sur les segments longs, comme une courbe de taux zéro croissante implique des forwards plus hauts. Une
            courbe trop inversée n'a pas de solution (intensité négative) : le bootstrap la rejette.
          </>, <>
            Credit triangle: λ ≈ spread / (1 − R). An upward-sloping spread curve implies even higher <i>forward</i> intensities
            on the long segments, just as an upward-sloping zero curve implies higher forwards. A curve that is too
            inverted has no solution (negative intensity): the bootstrap rejects it.
          </>)}
        </InfoBox>
        <div className="grid cols-2">
          <Card title={tr("Probabilité de défaut et intensité", "Default probability and intensity")}>
            {data ? <EChart option={survivalOption} height={340} ariaLabel={tr("Probabilité de défaut cumulée et intensité de défaut", "Cumulative default probability and default intensity")} /> : <Skeleton height={300} />}
          </Card>
          <Card title={tr("Courbe des spreads au pair", "Par spread curve")}>
            {data ? <EChart option={parOption} height={340} ariaLabel={tr("Spreads au pair du modèle et spreads cotés", "Model par spreads and quoted spreads")} /> : <Skeleton height={300} />}
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
    return <InfoBox>{error.message}. {tr("Choisissez une action dans la barre du haut (AAPL, MSFT, NVDA, MC.PA, TTE.PA, AIR.PA…).", "Pick a stock in the top bar (AAPL, MSFT, NVDA, MC.PA, TTE.PA, AIR.PA…).")}</InfoBox>;
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
    xAxis: { type: "value", name: tr("maturité de la dette (ans)", "debt maturity (years)"), nameLocation: "middle", nameGap: 26 },
    yAxis: [
      { type: "value", name: "spread (bp)" },
      { type: "value", name: tr("proba de défaut", "default probability"), axisLabel: { formatter: (v: number) => pct(v, 1) }, splitLine: { show: false } },
    ],
    series: [
      { type: "line", name: tr("Spread de la dette", "Debt spread"), showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 },
        tooltip: { valueFormatter: (v: number) => bps(v) }, data: data?.term_structure.T.map((t, i) => [t, data.term_structure.spread_bp[i]]) ?? [] },
      { type: "line", name: tr("Proba de défaut (risque-neutre)", "Default probability (risk-neutral)"), showSymbol: false, yAxisIndex: 1, color: p.series[1], lineStyle: { width: 2, type: "dashed" },
        tooltip: { valueFormatter: (v: number) => pct(v, 3) }, data: data?.term_structure.T.map((t, i) => [t, data.term_structure.default_probability[i]]) ?? [] },
    ],
  }), [data]);

  const volOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => bps(v) },
    grid: { top: 20 },
    xAxis: { type: "value", name: tr("volatilité action", "equity volatility"), nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax",
      axisLabel: { formatter: (v: number) => pct(v, 0) } },
    yAxis: { type: "value", name: "spread (bp)" },
    series: [{ type: "line", name: "Spread", symbolSize: 6, color: p.series[0], lineStyle: { width: 2 },
      data: data?.by_vol.map((r) => [r.equity_vol, r.spread_bp]) ?? [],
      markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dashed", width: 1 },
        label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" }, data: [{ xAxis: req.equity_vol, name: tr("actuelle", "current") }] } }],
  }), [data, req.equity_vol]);

  const equityOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => bps(v) },
    grid: { top: 20 },
    xAxis: { type: "value", name: tr("variation de la capitalisation", "change in market cap"), nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax",
      axisLabel: { formatter: (v: number) => pct(v, 0) } },
    yAxis: { type: "value", name: "spread (bp)" },
    series: [{ type: "line", name: "Spread", symbolSize: 6, color: p.series[2], lineStyle: { width: 2 },
      data: data?.by_equity.map((r) => [r.move, r.spread_bp]) ?? [] }],
  }), [data]);

  const cdsOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => bps(v) },
    grid: { top: 20 },
    xAxis: { type: "category", data: data?.cds.tenors.map((t) => tr(`${t} an${t > 1 ? "s" : ""}`, `${t}y`)) ?? [] },
    yAxis: { type: "value", name: "bp" },
    series: [{ type: "bar", name: tr("CDS implicite", "Implied CDS"), color: p.series[0], itemStyle: { borderRadius: [4, 4, 0, 0] }, data: data?.cds.spreads_bp ?? [],
      markLine: req.market_spread_bp ? { symbol: "none", silent: true, lineStyle: { color: p.critical, width: 1.5 },
        label: { color: p.muted, fontSize: 10, formatter: tr("CDS 5 ans de marché", "Market 5-year CDS"), position: "insideEndTop" },
        data: [{ yAxis: req.market_spread_bp }] } : undefined }],
  }), [data, req.market_spread_bp]);

  const toCds = () => data && navigate("/credit/cds", {
    state: { merton: { spreads: data.cds.spreads_bp, recovery: req.recovery, currency: ccy, label: tr(`Merton implicite — ${inputs.ticker}`, `Merton-implied — ${inputs.ticker}`) } },
  });

  return (
    <div className="split">
      <div className="sticky">
        <Card title={tr(`Paramètres — ${inputs.name}`, `Parameters — ${inputs.name}`)}>
          <div className="form">
            <div className="form-group-title">{tr("Actions", "Equity")}</div>
            <NumberField label={tr("Capitalisation boursière E", "Market capitalisation E")} value={req.equity / 1e9} suffix={tr(`Md${ccy === "EUR" ? "€" : "$"}`, `bn ${ccy === "EUR" ? "€" : "$"}`)} min={0.001} digits={2}
              hint={tr(`${num(inputs.shares_outstanding / 1e6, 0)} M d'actions × ${num(inputs.spot, 2)}`, `${num(inputs.shares_outstanding / 1e6, 0)} M shares × ${num(inputs.spot, 2)}`)} onChange={(v) => set({ equity: v * 1e9 })} />
            <NumberField label={tr("Volatilité action σE", "Equity volatility σE")} value={req.equity_vol} suffix="%" scale={100} min={0.01} max={5} digits={1}
              hint={tr(`Par défaut : ${inputs.equity_vol_source}`, `Default: ${inputs.equity_vol_source}`)} onChange={(equity_vol) => set({ equity_vol })} />
            <div className="form-sep" />
            <div className="form-group-title">{tr(`Dette (bilan ${inputs.financial_currency})`, `Debt (${inputs.financial_currency} balance sheet)`)}</div>
            <SelectField label={tr("Point de défaut D", "Default point D")} value={debt} onChange={setDebt}
              options={[{ value: "kmv", label: tr("KMV : CT + ½ LT", "KMV: ST + ½ LT") }, { value: "total", label: tr("Dette totale", "Total debt") }, { value: "custom", label: tr("Personnalisé", "Custom") }]} />
            <NumberField label={tr("Nominal de la dette D", "Debt face value D")} value={req.debt_face / 1e9} suffix={tr(`Md${ccy === "EUR" ? "€" : "$"}`, `bn ${ccy === "EUR" ? "€" : "$"}`)} min={0.001} digits={2}
              hint={tr(`CT ${bn(inputs.short_term_debt, ccy)} · LT ${bn(inputs.long_term_debt, ccy)}`, `ST ${bn(inputs.short_term_debt, ccy)} · LT ${bn(inputs.long_term_debt, ccy)}`)}
              onChange={(v) => { setDebt("custom"); set({ debt_face: v * 1e9 }); }} />
            <div className="form-row">
              <NumberField label="Horizon T" value={req.horizon} suffix={tr("ans", "years")} min={0.1} max={30} digits={1} onChange={(horizon) => set({ horizon })} />
              <NumberField label={tr("Recouvrement (CDS)", "Recovery (CDS)")} value={req.recovery} suffix="%" scale={100} min={0} max={0.95} digits={0} onChange={(recovery) => set({ recovery })} />
            </div>
            <div className="form-sep" />
            <div className="form-group-title">{tr("Comparaison au marché", "Comparison with the market")}</div>
            <NumberField label={tr("CDS 5 ans observé (optionnel)", "Observed 5-year CDS (optional)")} value={req.market_spread_bp ?? 0} suffix="bp" min={0} digits={1}
              hint={tr("0 = pas de comparaison", "0 = no comparison")} onChange={(v) => set({ market_spread_bp: v > 0 ? v : null })} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          {tr(<>
            Les actionnaires détiennent un call sur les actifs de l'entreprise, de strike la dette D : E = V N(d₁) − D e<sup>−rT</sup> N(d₂),
            avec σ<sub>E</sub> E = N(d₁) σ<sub>V</sub> V. On résout ces deux équations pour retrouver la valeur V et la volatilité
            σ<sub>V</sub> des actifs, qui ne sont pas observables. La dette vaut D e<sup>−rT</sup> moins un put sur V : son spread
            rémunère ce put.
          </>, <>
            Shareholders hold a call on the firm's assets, struck at the debt D: E = V N(d₁) − D e<sup>−rT</sup> N(d₂),
            with σ<sub>E</sub> E = N(d₁) σ<sub>V</sub> V. We solve these two equations to recover the value V and the volatility
            σ<sub>V</sub> of the assets, which are not observable. The debt is worth D e<sup>−rT</sup> minus a put on V: its spread
            pays for that put.
          </>)}
        </Explainer>
        <div className="grid cols-4">
          <Stat label={tr("Valeur des actifs V", "Asset value V")} value={bn(f?.assets, ccy)} foot={f ? tr(`Levier D e⁻ʳᵀ / V = ${pct(f.leverage, 1)}`, `Leverage D e⁻ʳᵀ / V = ${pct(f.leverage, 1)}`) : undefined} busy={isFetching} />
          <Stat label={tr("Volatilité des actifs σV", "Asset volatility σV")} value={pct(f?.asset_vol, 1)} foot={f ? `σE = ${pct(f.equity_vol, 1)} · N(d₁) = ${num(f.equity_delta, 4)}` : undefined} busy={isFetching} />
          <Stat label={tr("Distance au défaut", "Distance to default")} value={f ? `${num(f.d2, 2)} σ` : "—"} foot={tr("d₂ : écarts-types entre V et D à l'horizon", "d₂: standard deviations between V and D at the horizon")} busy={isFetching} />
          <Stat label={tr(`Proba de défaut ${num(req.horizon, 1)} an`, `${num(req.horizon, 1)}-year default probability`)} value={f ? (f.default_probability < 1e-4 ? f.default_probability.toExponential(2) : pct(f.default_probability, 3)) : "—"}
            foot={tr("Risque-neutre : N(−d₂)", "Risk-neutral: N(−d₂)")} busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label={tr(`Spread de la dette ${num(req.horizon, 1)} an`, `${num(req.horizon, 1)}-year debt spread`)} value={bps(data?.spread_bp)} foot={f ? tr(`Taux sans risque ${pct(data!.rate, 2)}`, `Risk-free rate ${pct(data!.rate, 2)}`) : undefined} busy={isFetching} />
          <Stat label={tr("CDS 5 ans implicite", "Implied 5-year CDS")} value={bps(data?.cds.spreads_bp[3])} foot={tr(`Recouvrement ${pct(req.recovery, 0)}`, `Recovery ${pct(req.recovery, 0)}`)} busy={isFetching} />
          <Stat label={tr("Recouvrement implicite", "Implied recovery")} value={pct(f?.recovery, 1)} foot={tr("E[V_T | défaut] / D", "E[V_T | default] / D")} busy={isFetching} />
          <Stat label={tr("Action −1 %", "Equity −1%")} value={data ? `${data.spread_change_for_equity_down_1pct_bp >= 0 ? "+" : ""}${bps(data.spread_change_for_equity_down_1pct_bp)}` : "—"}
            foot={tr("Variation du spread : lien actions / crédit", "Spread change: equity / credit link")} busy={isFetching} />
        </div>
        {data && req.market_spread_bp != null && (
          <InfoBox>
            {tr(<>
              Pour que Merton redonne le CDS 5 ans observé de {num(req.market_spread_bp, 0)} bp, il faudrait une volatilité action de{" "}
              <b>{data.implied_equity_vol != null ? pct(data.implied_equity_vol, 1) : "plus de 300 %"}</b>, contre {pct(req.equity_vol, 1)} observée.
              {data.implied_equity_vol != null && data.implied_equity_vol > req.equity_vol * 1.2
                ? " Le marché du crédit price plus de risque que ne l'explique le marché actions : c'est le « credit spread puzzle »."
                : ""}
            </>, <>
              For Merton to give back the observed 5-year CDS of {num(req.market_spread_bp, 0)} bp, it would need an equity volatility of{" "}
              <b>{data.implied_equity_vol != null ? pct(data.implied_equity_vol, 1) : "more than 300%"}</b>, against {pct(req.equity_vol, 1)} observed.
              {data.implied_equity_vol != null && data.implied_equity_vol > req.equity_vol * 1.2
                ? " The credit market prices more risk than the equity market explains: this is the \"credit spread puzzle\"."
                : ""}
            </>)}
          </InfoBox>
        )}
        <InfoBox>
          {tr("Merton sous-estime presque toujours les spreads des grandes entreprises, surtout à court terme : V suit une diffusion sans saut, donc une firme loin de son point de défaut ne peut pas y arriver en quelques mois et le spread court tend vers 0. Les modèles à sauts, à barrière (Black-Cox) ou à point de défaut incertain (CreditGrades) corrigent ce défaut.",
            "Merton almost always underestimates the spreads of large firms, especially at short maturities: V follows a diffusion without jumps, so a firm far from its default point cannot get there within a few months and the short spread tends to 0. Jump models, barrier models (Black-Cox) and uncertain default points (CreditGrades) fix this.")}
        </InfoBox>
        <Card title={tr("Structure par terme : spread et probabilité de défaut", "Term structure: spread and default probability")} actions={
          <button className="btn" onClick={toCds} disabled={!data}>{tr("Pricer un CDS sur cette courbe", "Price a CDS on this curve")}</button>
        }>
          {data ? <EChart option={termOption} height={360} ariaLabel={tr("Spread et probabilité de défaut selon la maturité", "Spread and default probability by maturity")} /> : <Skeleton height={300} />}
        </Card>
        <div className="grid cols-2">
          <Card title={tr("Spread selon la volatilité action", "Spread by equity volatility")}>
            {data ? <EChart option={volOption} height={300} ariaLabel={tr("Spread selon la volatilité action", "Spread by equity volatility")} /> : <Skeleton height={260} />}
          </Card>
          <Card title={tr("Spread selon le cours de l'action (dette fixe)", "Spread by share price (debt fixed)")}>
            {data ? <EChart option={equityOption} height={300} ariaLabel={tr("Spread selon la capitalisation", "Spread by market cap")} /> : <Skeleton height={260} />}
          </Card>
        </div>
        <Card title={tr("Courbe CDS implicite (même survie, recouvrement de marché)", "Implied CDS curve (same survival, market recovery)")}>
          {data ? <EChart option={cdsOption} height={300} ariaLabel={tr("Spreads CDS implicites du modèle de Merton", "CDS spreads implied by the Merton model")} /> : <Skeleton height={260} />}
        </Card>
      </div>
    </div>
  );
}
