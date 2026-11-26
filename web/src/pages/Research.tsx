import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { researchApi, type FactorKey, type VolManagedRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, InfoBox, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { num, pct } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

const FACTORS: { value: FactorKey; label: string }[] = [
  { value: "mkt_rf", label: "Marché" }, { value: "smb", label: "Taille" }, { value: "hml", label: "Valeur" },
  { value: "mom", label: "Momentum" }, { value: "rmw", label: "Rentabilité" }, { value: "cma", label: "Investissement" },
];

const signed = (x: number | null | undefined, digits = 2) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${pct(x, digits)}`);

export default function Research() {
  const [req, setReq] = useState<VolManagedRequest>({ factor: "mkt_rf", mode: "full", leverage_cap: null, cost_bp: 0, start: null, end: null });
  const set = (patch: Partial<VolManagedRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 300);
  const { factor, ...common } = debounced;
  const summary = useQuery({ queryKey: ["vm-summary", common], queryFn: () => researchApi.volManagedSummary(common), placeholderData: keepPreviousData });
  const detail = useQuery({ queryKey: ["vm-detail", debounced], queryFn: () => researchApi.volManaged(debounced), placeholderData: keepPreviousData });
  const d = detail.data;
  const s = d?.stats;
  const busy = detail.isFetching;

  const wealthOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => `× ${num(Math.exp(v), 2)}` },
      xAxis: { type: "category", data: d.series.dates, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", name: "log richesse", axisLabel: { formatter: (v: number) => `× ${num(Math.exp(v), v > 3 ? 0 : 1)}` } },
      dataZoom: [{ type: "inside" }],
      series: [
        { type: "line", name: `${d.label} (achat-conservation)`, showSymbol: false, color: p.series[1], lineStyle: { width: 1.6 }, data: d.series.log_wealth_original },
        { type: "line", name: "Version volatility-managed (même vol)", showSymbol: false, color: p.series[0], lineStyle: { width: 2 }, data: d.series.log_wealth_managed },
      ],
    };
  }, [d]);

  const exposureOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    return {
      legend: {},
      grid: { top: 34, right: 60 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: d.series.dates, axisLabel: { hideOverlap: true } },
      yAxis: [
        { type: "value", name: "exposition c / RV", axisLabel: { formatter: (v: number) => `${num(v, 1)}×` } },
        { type: "value", name: "vol du mois précédent", splitLine: { show: false }, axisLabel: { formatter: (v: number) => pct(v, 0) } },
      ],
      dataZoom: [{ type: "inside" }],
      series: [
        { type: "line", name: "Exposition", showSymbol: false, color: p.series[0], lineStyle: { width: 1.2 }, areaStyle: { opacity: 0.15 },
          tooltip: { valueFormatter: (v: number) => `${num(v, 2)}×` }, data: d.series.weight },
        { type: "line", name: "Vol réalisée du mois précédent", yAxisIndex: 1, showSymbol: false, color: p.series[1], lineStyle: { width: 1 },
          tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: d.series.lagged_vol },
      ],
    };
  }, [d]);

  const bucketOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const b = d.buckets;
    return {
      legend: {},
      grid: { top: 34, right: 60 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: b.map((x) => `Q${x.bucket}\n(vol passée ${pct(x.lagged_vol, 0)})`) },
      yAxis: [
        { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
        { type: "value", name: "moyenne / variance", splitLine: { show: false } },
      ],
      series: [
        { type: "bar", name: "Rendement moyen suivant", color: p.series[0], tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: b.map((x) => x.mean) },
        { type: "bar", name: "Volatilité suivante", color: p.series[1], tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: b.map((x) => x.vol) },
        { type: "line", name: "Moyenne / variance", yAxisIndex: 1, color: p.series[2], symbolSize: 8, lineStyle: { width: 2.5 },
          tooltip: { valueFormatter: (v: number) => num(v, 2) }, data: b.map((x) => x.mean_over_var) },
      ],
    };
  }, [d]);

  const decadeOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    return {
      grid: { top: 20 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "category", data: d.subperiods.map((x) => x.period), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [{ type: "bar", name: "Alpha annuel", data: d.subperiods.map((x) => ({ value: x.alpha,
        itemStyle: { color: x.alpha >= 0 ? p.diverging[2] : p.diverging[0], borderRadius: x.alpha >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })) }],
    };
  }, [d]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Portefeuilles « volatility-managed »</h1>
          <div className="page-sub">
            Réplication de Moreira et Muir (2017, Journal of Finance) sur les facteurs Fama-French quotidiens depuis 1926
            (bibliothèque de Kenneth French{summary.data ? `, données jusqu'au ${summary.data.data_end}` : ""}).
          </div>
        </div>
      </div>
      <div className="grid">
        <ErrorBox error={summary.error ?? detail.error} />
        <Explainer>
          Chaque mois, on investit dans le facteur avec une exposition c / RV<sub>t</sub>, inversement proportionnelle à la variance
          réalisée du mois précédent : f<sup>σ</sup><sub>t+1</sub> = (c / RV<sub>t</sub>) f<sub>t+1</sub>. La constante c donne à la stratégie la
          même volatilité que le facteur. On régresse ensuite f<sup>σ</sup> sur f : un alpha positif signifie que réduire l'exposition
          après les mois agités améliore le couple rendement-risque, parce que la volatilité prédit le risque bien mieux que le rendement.
        </Explainer>
        <Card title="Paramètres">
          <div className="toolbar-grid">
            <SelectField label="Facteur" value={req.factor} onChange={(factor) => set({ factor })} options={FACTORS} />
            <Segmented label="Constante c" value={req.mode} onChange={(mode) => set({ mode })}
              options={[{ value: "full", label: "Tout l'échantillon" }, { value: "realtime", label: "Temps réel" }]} />
            <SelectField label="Levier maximal" value={req.leverage_cap ?? 0} onChange={(v) => set({ leverage_cap: v === 0 ? null : v })}
              options={[{ value: 0, label: "Aucun" }, { value: 1.5, label: "1,5×" }, { value: 2, label: "2×" }, { value: 3, label: "3×" }]} />
            <SelectField label="Coûts de transaction" value={req.cost_bp} onChange={(cost_bp) => set({ cost_bp })}
              options={[0, 5, 10, 25].map((v) => ({ value: v, label: v ? `${v} bp` : "Aucun" }))} />
            <SelectField label="Début" value={req.start ?? ""} onChange={(v) => set({ start: v || null })}
              options={[{ value: "", label: "Toutes les données" }, ...["1946-01", "1963-07", "1980-01", "2000-01"].map((v) => ({ value: v, label: v.slice(0, 4) }))]} />
            <SelectField label="Fin" value={req.end ?? ""} onChange={(v) => set({ end: v || null })}
              options={[{ value: "", label: "Dernier mois" }, { value: "2015-12", label: "2015 (fin de l'article)" }, { value: "1999-12", label: "1999" }]} />
          </div>
        </Card>
        <Card title="Tous les facteurs : alpha de la version managée (comme le Tableau I de l'article)" flush>
          {summary.data ? (
            <div className={`table-wrap${summary.isFetching ? " busy" : ""}`}>
              <table className="data">
                <thead><tr><th>Facteur</th><th>Période</th><th>Alpha annuel</th><th>t (Newey-West)</th><th>Bêta</th><th>R²</th><th>Appraisal ratio</th><th>Sharpe facteur</th><th>Sharpe managé</th><th>Alpha / FF3</th></tr></thead>
                <tbody>
                  {summary.data.rows.map((r) => (
                    <tr key={r.factor} onClick={() => set({ factor: r.factor })} style={{ cursor: "pointer", fontWeight: r.factor === req.factor ? 600 : undefined }}>
                      <td className="strong" style={{ textAlign: "left" }}>{r.label}</td><td className="muted">{r.start} → {r.end}</td>
                      <td className={r.alpha_t > 1.96 ? "up" : r.alpha_t < -1.96 ? "down" : ""}>{signed(r.alpha)}</td><td>{num(r.alpha_t, 2)}</td>
                      <td>{num(r.beta, 2)}</td><td>{num(r.r2, 2)}</td><td>{num(r.appraisal, 2)}</td>
                      <td>{num(r.sharpe_original, 2)}</td><td className="strong">{num(r.sharpe_managed, 2)}</td>
                      <td className="muted">{r.alpha_ff3 ? `${signed(r.alpha_ff3.alpha)} (t ${num(r.alpha_ff3.t, 1)})` : "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={200} /></div>}
        </Card>
        <InfoBox>
          Sur l'échantillon de l'article (1926-2015), le facteur marché donne ici un alpha de 4,9 % par an, un bêta de 0,60 et un appraisal
          ratio de 0,33, comme le Tableau I de Moreira et Muir. L'effet est fort sur le marché, le momentum et la rentabilité, faible ou nul
          sur la taille et l'investissement.
        </InfoBox>
        <div className="grid cols-4">
          <Stat label="Alpha annuel" value={signed(s?.alpha)} foot={s ? `t = ${num(s.alpha_t, 2)} · bêta ${num(s.beta, 2)}` : undefined} busy={busy} />
          <Stat label="Sharpe" value={s ? `${num(s.sharpe_original, 2)} → ${num(s.sharpe_managed, 2)}` : "—"} foot={s ? `Appraisal ratio ${num(s.appraisal, 2)}` : undefined} busy={busy} />
          <Stat label="Exposition" value={s ? `${num(s.weight_median, 2)}× (médiane)` : "—"} foot={s ? `90e centile ${num(s.weight_p90, 1)}× · max ${num(s.weight_max, 1)}×` : undefined} busy={busy} />
          <Stat label="Drawdown maximal" value={s ? `${pct(s.mdd_original, 0)} → ${pct(s.mdd_managed, 0)}` : "—"} foot={s ? `Vol ${pct(s.vol_original, 1)} / ${pct(s.vol_managed, 1)}` : undefined} busy={busy} />
        </div>
        <Card title={`Richesse cumulée (échelle log) — ${d?.label ?? ""}`}>
          {d ? <EChart option={wealthOption} height={380} ariaLabel="Richesse cumulée du facteur et de sa version volatility-managed" /> : <Skeleton height={320} />}
        </Card>
        <Card title="Exposition de la stratégie et volatilité du mois précédent">
          {d ? <EChart option={exposureOption} height={320} ariaLabel="Exposition et volatilité passée" /> : <Skeleton height={280} />}
        </Card>
        <div className="grid cols-2">
          <Card title="Mois classés par volatilité passée (quintiles)">
            {d ? <EChart option={bucketOption} height={320} ariaLabel="Rendement et volatilité suivants par quintile de volatilité passée" /> : <Skeleton height={280} />}
          </Card>
          <Card title="Alpha par décennie">
            {d ? <EChart option={decadeOption} height={320} ariaLabel="Alpha de la stratégie par décennie" /> : <Skeleton height={280} />}
          </Card>
        </div>
        <InfoBox>
          Le cœur du résultat se lit dans les quintiles : quand la volatilité passée est forte, la volatilité suivante l'est aussi, mais le
          rendement moyen n'augmente pas en proportion. Le rapport moyenne / variance, qui dicte l'exposition optimale d'un investisseur
          moyenne-variance, baisse donc : il faut réduire l'exposition après les mois agités.
        </InfoBox>
        <Card title="Crises : rendement cumulé sur l'épisode" flush>
          {d ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Épisode</th><th>Période</th><th>{d.label}</th><th>Version managée</th></tr></thead>
                <tbody>
                  {d.episodes.map((e) => (
                    <tr key={e.episode}>
                      <td className="strong" style={{ textAlign: "left" }}>{e.episode}</td><td className="muted">{e.start} → {e.end}</td>
                      <td className={e.original < 0 ? "down" : "up"}>{signed(e.original, 1)}</td>
                      <td className={e.managed < 0 ? "down" : "up"}>{signed(e.managed, 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={160} /></div>}
        </Card>
        <InfoBox>
          Limites, à tester avec les paramètres. <b>Temps réel</b> : avec une constante c estimée sans regarder le futur, l'alpha baisse
          nettement (Cederburg, O'Doherty, Wang et Yan, 2020). <b>Levier</b> : l'exposition dépasse parfois 10× après des mois très calmes,
          et la plafonner réduit l'alpha. <b>Coûts</b> : la stratégie rebalance chaque mois. Le facteur marché est négociable ; les facteurs
          long-short (taille, valeur, momentum…) sont des portefeuilles théoriques, sans coûts d'implémentation.
        </InfoBox>
      </div>
    </>
  );
}
