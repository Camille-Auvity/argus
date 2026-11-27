import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { researchApi, type FactorKey, type VolManagedRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, InfoBox, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { num, pct } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { tr } from "../lib/i18n";

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

const factors = (): { value: FactorKey; label: string }[] => [
  { value: "mkt_rf", label: tr("Marché", "Market") }, { value: "smb", label: tr("Taille", "Size") }, { value: "hml", label: tr("Valeur", "Value") },
  { value: "mom", label: "Momentum" }, { value: "rmw", label: tr("Rentabilité", "Profitability") }, { value: "cma", label: tr("Investissement", "Investment") },
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
      yAxis: { type: "value", name: tr("log richesse", "log wealth"), axisLabel: { formatter: (v: number) => `× ${num(Math.exp(v), v > 3 ? 0 : 1)}` } },
      dataZoom: [{ type: "inside" }],
      series: [
        { type: "line", name: tr(`${d.label} (achat-conservation)`, `${d.label} (buy and hold)`), showSymbol: false, color: p.series[1], lineStyle: { width: 1.6 }, data: d.series.log_wealth_original },
        { type: "line", name: tr("Version volatility-managed (même vol)", "Volatility-managed version (same vol)"), showSymbol: false, color: p.series[0], lineStyle: { width: 2 }, data: d.series.log_wealth_managed },
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
        { type: "value", name: tr("exposition c / RV", "exposure c / RV"), axisLabel: { formatter: (v: number) => `${num(v, 1)}×` } },
        { type: "value", name: tr("vol du mois précédent", "previous month's vol"), splitLine: { show: false }, axisLabel: { formatter: (v: number) => pct(v, 0) } },
      ],
      dataZoom: [{ type: "inside" }],
      series: [
        { type: "line", name: tr("Exposition", "Exposure"), showSymbol: false, color: p.series[0], lineStyle: { width: 1.2 }, areaStyle: { opacity: 0.15 },
          tooltip: { valueFormatter: (v: number) => `${num(v, 2)}×` }, data: d.series.weight },
        { type: "line", name: tr("Vol réalisée du mois précédent", "Previous month's realised vol"), yAxisIndex: 1, showSymbol: false, color: p.series[1], lineStyle: { width: 1 },
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
      xAxis: { type: "category", data: b.map((x) => tr(`Q${x.bucket}\n(vol passée ${pct(x.lagged_vol, 0)})`, `Q${x.bucket}\n(past vol ${pct(x.lagged_vol, 0)})`)) },
      yAxis: [
        { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
        { type: "value", name: tr("moyenne / variance", "mean / variance"), splitLine: { show: false } },
      ],
      series: [
        { type: "bar", name: tr("Rendement moyen suivant", "Next mean return"), color: p.series[0], tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: b.map((x) => x.mean) },
        { type: "bar", name: tr("Volatilité suivante", "Next volatility"), color: p.series[1], tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: b.map((x) => x.vol) },
        { type: "line", name: tr("Moyenne / variance", "Mean / variance"), yAxisIndex: 1, color: p.series[2], symbolSize: 8, lineStyle: { width: 2.5 },
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
      series: [{ type: "bar", name: tr("Alpha annuel", "Annual alpha"), data: d.subperiods.map((x) => ({ value: x.alpha,
        itemStyle: { color: x.alpha >= 0 ? p.diverging[2] : p.diverging[0], borderRadius: x.alpha >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })) }],
    };
  }, [d]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Portefeuilles « volatility-managed »", "Volatility-managed portfolios")}</h1>
          <div className="page-sub">
            {tr(`Réplication de Moreira et Muir (2017, Journal of Finance) sur les facteurs Fama-French quotidiens depuis 1926 (bibliothèque de Kenneth French${summary.data ? `, données jusqu'au ${summary.data.data_end}` : ""}).`,
              `Replication of Moreira and Muir (2017, Journal of Finance) on the daily Fama-French factors since 1926 (Kenneth French data library${summary.data ? `, data up to ${summary.data.data_end}` : ""}).`)}
          </div>
        </div>
      </div>
      <div className="grid">
        <ErrorBox error={summary.error ?? detail.error} />
        <Explainer>
          {tr(<>
            Chaque mois, on investit dans le facteur avec une exposition c / RV<sub>t</sub>, inversement proportionnelle à la variance
            réalisée du mois précédent : f<sup>σ</sup><sub>t+1</sub> = (c / RV<sub>t</sub>) f<sub>t+1</sub>. La constante c donne à la stratégie la
            même volatilité que le facteur. On régresse ensuite f<sup>σ</sup> sur f : un alpha positif signifie que réduire l'exposition
            après les mois agités améliore le couple rendement-risque, parce que la volatilité prédit le risque bien mieux que le rendement.
          </>, <>
            Each month we invest in the factor with an exposure c / RV<sub>t</sub>, inversely proportional to the previous month's realised
            variance: f<sup>σ</sup><sub>t+1</sub> = (c / RV<sub>t</sub>) f<sub>t+1</sub>. The constant c gives the strategy the
            same volatility as the factor. We then regress f<sup>σ</sup> on f: a positive alpha means that cutting exposure
            after turbulent months improves the risk-return trade-off, because volatility predicts risk far better than it predicts returns.
          </>)}
        </Explainer>
        <Card title={tr("Paramètres", "Parameters")}>
          <div className="toolbar-grid">
            <SelectField label={tr("Facteur", "Factor")} value={req.factor} onChange={(factor) => set({ factor })} options={factors()} />
            <Segmented label={tr("Constante c", "Constant c")} value={req.mode} onChange={(mode) => set({ mode })}
              options={[{ value: "full", label: tr("Tout l'échantillon", "Full sample") }, { value: "realtime", label: tr("Temps réel", "Real time") }]} />
            <SelectField label={tr("Levier maximal", "Maximum leverage")} value={req.leverage_cap ?? 0} onChange={(v) => set({ leverage_cap: v === 0 ? null : v })}
              options={[{ value: 0, label: tr("Aucun", "None") }, { value: 1.5, label: tr("1,5×", "1.5×") }, { value: 2, label: "2×" }, { value: 3, label: "3×" }]} />
            <SelectField label={tr("Coûts de transaction", "Transaction costs")} value={req.cost_bp} onChange={(cost_bp) => set({ cost_bp })}
              options={[0, 5, 10, 25].map((v) => ({ value: v, label: v ? `${v} bp` : tr("Aucun", "None") }))} />
            <SelectField label={tr("Début", "Start")} value={req.start ?? ""} onChange={(v) => set({ start: v || null })}
              options={[{ value: "", label: tr("Toutes les données", "All data") }, ...["1946-01", "1963-07", "1980-01", "2000-01"].map((v) => ({ value: v, label: v.slice(0, 4) }))]} />
            <SelectField label={tr("Fin", "End")} value={req.end ?? ""} onChange={(v) => set({ end: v || null })}
              options={[{ value: "", label: tr("Dernier mois", "Latest month") }, { value: "2015-12", label: tr("2015 (fin de l'article)", "2015 (end of the paper)") }, { value: "1999-12", label: "1999" }]} />
          </div>
        </Card>
        <Card title={tr("Tous les facteurs : alpha de la version managée (comme le Tableau I de l'article)", "All factors: alpha of the managed version (as in Table I of the paper)")} flush>
          {summary.data ? (
            <div className={`table-wrap${summary.isFetching ? " busy" : ""}`}>
              <table className="data">
                <thead><tr><th>{tr("Facteur", "Factor")}</th><th>{tr("Période", "Period")}</th><th>{tr("Alpha annuel", "Annual alpha")}</th><th>t (Newey-West)</th><th>{tr("Bêta", "Beta")}</th><th>R²</th><th>Appraisal ratio</th><th>{tr("Sharpe facteur", "Factor Sharpe")}</th><th>{tr("Sharpe managé", "Managed Sharpe")}</th><th>Alpha / FF3</th></tr></thead>
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
          {tr("Sur l'échantillon de l'article (1926-2015), le facteur marché donne ici un alpha de 4,9 % par an, un bêta de 0,60 et un appraisal ratio de 0,33, comme le Tableau I de Moreira et Muir. L'effet est fort sur le marché, le momentum et la rentabilité, faible ou nul sur la taille et l'investissement.",
            "On the paper's sample (1926-2015), the market factor gives here an alpha of 4.9% a year, a beta of 0.60 and an appraisal ratio of 0.33, as in Table I of Moreira and Muir. The effect is strong on the market, momentum and profitability, weak or absent on size and investment.")}
        </InfoBox>
        <div className="grid cols-4">
          <Stat label={tr("Alpha annuel", "Annual alpha")} value={signed(s?.alpha)} foot={s ? tr(`t = ${num(s.alpha_t, 2)} · bêta ${num(s.beta, 2)}`, `t = ${num(s.alpha_t, 2)} · beta ${num(s.beta, 2)}`) : undefined} busy={busy} />
          <Stat label="Sharpe" value={s ? `${num(s.sharpe_original, 2)} → ${num(s.sharpe_managed, 2)}` : "—"} foot={s ? `Appraisal ratio ${num(s.appraisal, 2)}` : undefined} busy={busy} />
          <Stat label={tr("Exposition", "Exposure")} value={s ? tr(`${num(s.weight_median, 2)}× (médiane)`, `${num(s.weight_median, 2)}× (median)`) : "—"} foot={s ? tr(`90e centile ${num(s.weight_p90, 1)}× · max ${num(s.weight_max, 1)}×`, `90th percentile ${num(s.weight_p90, 1)}× · max ${num(s.weight_max, 1)}×`) : undefined} busy={busy} />
          <Stat label={tr("Drawdown maximal", "Maximum drawdown")} value={s ? `${pct(s.mdd_original, 0)} → ${pct(s.mdd_managed, 0)}` : "—"} foot={s ? `Vol ${pct(s.vol_original, 1)} / ${pct(s.vol_managed, 1)}` : undefined} busy={busy} />
        </div>
        <Card title={tr(`Richesse cumulée (échelle log) — ${d?.label ?? ""}`, `Cumulative wealth (log scale) — ${d?.label ?? ""}`)}>
          {d ? <EChart option={wealthOption} height={380} ariaLabel={tr("Richesse cumulée du facteur et de sa version volatility-managed", "Cumulative wealth of the factor and its volatility-managed version")} /> : <Skeleton height={320} />}
        </Card>
        <Card title={tr("Exposition de la stratégie et volatilité du mois précédent", "Strategy exposure and previous month's volatility")}>
          {d ? <EChart option={exposureOption} height={320} ariaLabel={tr("Exposition et volatilité passée", "Exposure and past volatility")} /> : <Skeleton height={280} />}
        </Card>
        <div className="grid cols-2">
          <Card title={tr("Mois classés par volatilité passée (quintiles)", "Months sorted by past volatility (quintiles)")}>
            {d ? <EChart option={bucketOption} height={320} ariaLabel={tr("Rendement et volatilité suivants par quintile de volatilité passée", "Next return and volatility by quintile of past volatility")} /> : <Skeleton height={280} />}
          </Card>
          <Card title={tr("Alpha par décennie", "Alpha by decade")}>
            {d ? <EChart option={decadeOption} height={320} ariaLabel={tr("Alpha de la stratégie par décennie", "Strategy alpha by decade")} /> : <Skeleton height={280} />}
          </Card>
        </div>
        <InfoBox>
          {tr("Le cœur du résultat se lit dans les quintiles : quand la volatilité passée est forte, la volatilité suivante l'est aussi, mais le rendement moyen n'augmente pas en proportion. Le rapport moyenne / variance, qui dicte l'exposition optimale d'un investisseur moyenne-variance, baisse donc : il faut réduire l'exposition après les mois agités.",
            "The heart of the result is in the quintiles: when past volatility is high, the next volatility is high too, but the mean return does not rise in proportion. The mean / variance ratio, which sets the optimal exposure of a mean-variance investor, therefore falls: exposure should be cut after turbulent months.")}
        </InfoBox>
        <Card title={tr("Crises : rendement cumulé sur l'épisode", "Crises: cumulative return over the episode")} flush>
          {d ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{tr("Épisode", "Episode")}</th><th>{tr("Période", "Period")}</th><th>{d.label}</th><th>{tr("Version managée", "Managed version")}</th></tr></thead>
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
          {tr(<>
            Limites, à tester avec les paramètres. <b>Temps réel</b> : avec une constante c estimée sans regarder le futur, l'alpha baisse
            nettement (Cederburg, O'Doherty, Wang et Yan, 2020). <b>Levier</b> : l'exposition dépasse parfois 10× après des mois très calmes,
            et la plafonner réduit l'alpha. <b>Coûts</b> : la stratégie rebalance chaque mois. Le facteur marché est négociable ; les facteurs
            long-short (taille, valeur, momentum…) sont des portefeuilles théoriques, sans coûts d'implémentation.
          </>, <>
            Limits, to test with the parameters. <b>Real time</b>: with a constant c estimated without looking ahead, the alpha falls
            sharply (Cederburg, O'Doherty, Wang and Yan, 2020). <b>Leverage</b>: the exposure sometimes exceeds 10× after very calm months,
            and capping it reduces the alpha. <b>Costs</b>: the strategy rebalances every month. The market factor is tradable; the long-short
            factors (size, value, momentum…) are theoretical portfolios, with no implementation costs.
          </>)}
        </InfoBox>
      </div>
    </>
  );
}
