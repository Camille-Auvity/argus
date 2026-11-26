import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { allocationApi, type BacktestRequest, type OptimizeRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { num, pct } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export const ALLOCATION_PAGES = [
  { path: "optimisation", label: "Optimisation et frontière" },
  { path: "lasso", label: "Régularisation (LASSO)" },
  { path: "backtest", label: "Backtest hors échantillon" },
] as const;

export default function Allocation() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Allocation de portefeuille</h1>
          <div className="page-sub">
            Moyenne-variance sous contraintes sur l'univers de la plateforme (rendements en euros) : shrinkage des estimateurs,
            vente à découvert, LASSO / elastic-net, coûts de transaction et test hors échantillon.
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label="Allocation">
        {ALLOCATION_PAGES.map((m) => (
          <NavLink key={m.path} to={`/allocation/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

/** Ticker checklist; at least two assets stay selected. */
function UniversePicker({ value, onChange }: { value: string[]; onChange: (v: string[]) => void }) {
  const { data } = useQuery({ queryKey: ["alloc-universe"], queryFn: allocationApi.universe });
  if (!data) return <Skeleton height={80} />;
  const toggle = (t: string) => {
    const next = value.includes(t) ? value.filter((x) => x !== t) : [...value, t];
    if (next.length >= 2) onChange(next);
  };
  return (
    <div>
      <div className="form-group-title">Univers ({value.length} actifs, en {data.base_currency})</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
        {data.assets.map((a) => (
          <button key={a.ticker} type="button" title={`${a.name} · ${a.currency}`} onClick={() => toggle(a.ticker)}
            className={`btn${value.includes(a.ticker) ? " primary" : " ghost"}`} style={{ padding: "3px 8px", fontSize: 12 }}>
            {a.ticker}
          </button>
        ))}
      </div>
    </div>
  );
}

const DEFAULT_TICKERS = ["SPY", "QQQ", "AAPL", "MSFT", "NVDA", "^STOXX50E", "^FCHI", "MC.PA", "TTE.PA", "AIR.PA", "SAN.PA", "ASML.AS", "SAP.DE"];

// ----------------------------------------------------------------------------- optimisation

export function OptimisationPage() {
  const [req, setReq] = useState<OptimizeRequest>({
    tickers: DEFAULT_TICKERS, lookback_days: 504, mean_method: "sample", cov_method: "ledoit-wolf", objective: "mean-variance",
    gamma: 5, long_only: true, short_max: 0.3, w_max: 1, l1: 0, l2: 0, cost: 0, holding_days: 21,
  });
  const set = (patch: Partial<OptimizeRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 400);
  const { data, error, isFetching } = useQuery({ queryKey: ["alloc-opt", debounced], queryFn: () => allocationApi.optimize(debounced),
    placeholderData: keepPreviousData });
  const o = data?.optimal;
  const tickers = data?.estimates.tickers ?? [];

  const frontierOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const pt = (name: string, pf: typeof data.optimal, color: string, symbol = "circle") => ({
      type: "scatter", name, symbol, symbolSize: 14, color, itemStyle: { borderColor: p.surface, borderWidth: 2 }, z: 5,
      data: [[pf.volatility, pf.expected_return]] });
    return {
      legend: { top: 0, type: "scroll" },
      grid: { top: 50 },
      tooltip: { trigger: "item", formatter: (it: { seriesName: string; value: number[]; name?: string }) =>
        `${it.name || it.seriesName}<br/>vol ${pct(it.value[0], 1)} · rendement ${pct(it.value[1], 1)}` },
      xAxis: { type: "value", name: "volatilité annuelle", nameLocation: "middle", nameGap: 26, min: 0, axisLabel: { formatter: (v: number) => pct(v, 0) } },
      yAxis: { type: "value", name: "rendement espéré", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [
        { type: "line", name: "Frontière sans contrainte (formule fermée)", showSymbol: false, color: p.muted, lineStyle: { width: 1.5, type: "dotted" },
          data: data.frontier.unconstrained.map((x) => [x.vol, x.ret]) },
        { type: "line", name: `Frontière avec shorts ≤ ${pct(req.short_max, 0)}`, showSymbol: false, color: p.series[2], lineStyle: { width: 2, type: "dashed" },
          data: data.frontier.with_shorts.map((x) => [x.vol, x.ret]) },
        { type: "line", name: "Frontière long-only", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 },
          data: data.frontier.long_only.map((x) => [x.vol, x.ret]) },
        { type: "scatter", name: "Actifs", symbolSize: 8, color: p.textSecondary,
          label: { show: true, position: "right", fontSize: 10, color: p.textSecondary, formatter: (it: { name: string }) => it.name },
          data: tickers.map((t, i) => ({ name: t, value: [data.estimates.vol[i], data.estimates.mu[i]] })) },
        pt("1/N", data.equal_weight, p.series[3], "diamond"),
        pt("Minimum variance", data.min_variance, p.series[4], "triangle"),
        pt("Tangence (Sharpe max, long-only)", data.tangency, p.series[5], "rect"),
        pt("Portefeuille optimisé", data.optimal, p.series[1], "pin"),
      ],
    };
  }, [data, tickers, req.short_max]);

  const weightsOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: {},
      grid: { top: 34, left: 70 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 1) },
      xAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      yAxis: { type: "category", data: tickers, inverse: true },
      series: [
        { type: "bar", name: "Poids optimisé", color: p.series[1], data: tickers.map((t) => data.optimal.weights[t]) },
        { type: "bar", name: "Contribution au risque", color: p.series[0], data: tickers.map((t) => data.optimal.risk_contributions[t]) },
        { type: "bar", name: "1/N", color: p.muted, data: tickers.map((t) => data.equal_weight.weights[t]) },
      ],
    };
  }, [data, tickers]);

  const corrOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const c = data.estimates.corr;
    return {
      tooltip: { formatter: (it: { value: number[] }) => `${tickers[it.value[0]]} / ${tickers[it.value[1]]} : <b>${num(it.value[2], 2)}</b>` },
      grid: { top: 10, left: 80, bottom: 70 },
      xAxis: { type: "category", data: tickers, axisLabel: { rotate: 45, fontSize: 10 } },
      yAxis: { type: "category", data: tickers, axisLabel: { fontSize: 10 }, inverse: true },
      visualMap: { min: -1, max: 1, show: false, inRange: { color: [p.diverging[0], p.diverging[1], p.diverging[2]] } },
      series: [{ type: "heatmap", data: c.flatMap((row, i) => row.map((v, j) => [j, i, v])),
        label: { show: tickers.length <= 10, fontSize: 9, formatter: (it: { value: number[] }) => num(it.value[2], 1) } }],
    };
  }, [data, tickers]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <UniversePicker value={req.tickers} onChange={(tickers) => set({ tickers })} />
            <div className="form-sep" />
            <div className="form-group-title">Estimation</div>
            <SelectField label="Historique" value={req.lookback_days} onChange={(lookback_days) => set({ lookback_days })}
              options={[{ value: 126, label: "6 mois" }, { value: 252, label: "1 an" }, { value: 504, label: "2 ans" }]} />
            <div className="form-row">
              <SelectField label="Rendements espérés" value={req.mean_method} onChange={(mean_method) => set({ mean_method })}
                options={[{ value: "sample", label: "Moyenne empirique" }, { value: "shrunk", label: "James-Stein" }, { value: "zero", label: "Ignorés" }]} />
              <SelectField label="Covariance" value={req.cov_method} onChange={(cov_method) => set({ cov_method })}
                options={[{ value: "ledoit-wolf", label: "Ledoit-Wolf" }, { value: "sample", label: "Empirique" }]} />
            </div>
            <div className="form-sep" />
            <div className="form-group-title">Objectif et contraintes</div>
            <Segmented value={req.objective} onChange={(objective) => set({ objective })}
              options={[{ value: "mean-variance", label: "Moy.-var." }, { value: "min-variance", label: "Min var." }, { value: "max-sharpe", label: "Sharpe max" }]} />
            {req.objective === "mean-variance" && <NumberField label="Aversion au risque γ" value={req.gamma} min={0.1} max={200} digits={1} onChange={(gamma) => set({ gamma })} />}
            <Check label="Long-only (pas de vente à découvert)" checked={req.long_only} onChange={(long_only) => set({ long_only })} />
            <div className="form-row">
              {!req.long_only && <NumberField label="Short max / actif" value={req.short_max} suffix="%" scale={100} min={0} max={2} digits={0} onChange={(short_max) => set({ short_max })} />}
              <NumberField label="Poids max / actif" value={req.w_max} suffix="%" scale={100} min={0.05} max={1} digits={0} onChange={(w_max) => set({ w_max })} />
            </div>
            <div className="form-row">
              <NumberField label="LASSO λ₁" value={req.l1} min={0} max={1} digits={4} hint="Pénalité sur Σ|wᵢ| (active seulement avec des shorts)" onChange={(l1) => set({ l1 })} />
              <NumberField label="Ridge λ₂" value={req.l2} min={0} max={10} digits={3} hint="Pénalité sur Σwᵢ²" onChange={(l2) => set({ l2 })} />
            </div>
            <div className="form-row">
              <NumberField label="Coûts de transaction" value={req.cost} suffix="bp" scale={1e4} min={0} max={0.05} digits={0} hint="Depuis le 1/N, amortis sur la durée de détention" onChange={(cost) => set({ cost })} />
              <SelectField label="Durée de détention" value={req.holding_days} onChange={(holding_days) => set({ holding_days })}
                options={[{ value: 5, label: "1 semaine" }, { value: 21, label: "1 mois" }, { value: 63, label: "3 mois" }, { value: 252, label: "1 an" }]} />
            </div>
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          Markowitz : on cherche le portefeuille qui maximise μ'w − (γ/2) w'Σw sous les contraintes choisies. Les entrées μ et Σ sont
          estimées sur {data ? `${data.n_obs} jours (${data.start} → ${data.end})` : "l'historique"} de rendements en euros : les
          actifs américains incluent le risque de change EUR/USD.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Rendement espéré" value={pct(o?.expected_return, 2)} foot={data ? `Taux sans risque ${pct(data.risk_free, 2)}` : undefined} busy={isFetching} />
          <Stat label="Volatilité" value={pct(o?.volatility, 2)} foot={o ? `Sharpe ${num(o.sharpe, 2)}` : undefined} busy={isFetching} />
          <Stat label="Actifs détenus" value={o ? `${o.n_active} / ${tickers.length}` : "—"} foot={o ? `N effectif ${num(o.effective_n, 1)} · exposition brute ${pct(o.gross_exposure, 0)}` : undefined} busy={isFetching} />
          <Stat label="Rotation depuis 1/N" value={pct(o?.turnover, 0)} foot={data ? `Shrinkage Σ ${pct(data.estimates.cov_shrinkage, 1)} · μ ${pct(data.estimates.mean_shrinkage, 0)}` : undefined} busy={isFetching} />
        </div>
        <Card title="Frontière efficiente">
          {data ? <EChart option={frontierOption} height={460} ariaLabel="Frontière efficiente et portefeuilles" /> : <Skeleton height={400} />}
        </Card>
        <InfoBox>
          Plus les contraintes sont fortes, plus la frontière recule vers la droite : la frontière sans contrainte (formule fermée de
          Markowitz) est la meilleure en théorie, mais elle s'appuie sur des positions courtes énormes, construites sur des moyennes
          historiques très bruitées. Avec 2 ans de données, le rétrécissement de James-Stein ramène toutes les espérances à leur moyenne
          commune : statistiquement, on ne sait pas distinguer les rendements des actifs.
        </InfoBox>
        <div className="grid cols-2">
          <Card title="Poids et contributions au risque">
            {data ? <EChart option={weightsOption} height={Math.max(320, tickers.length * 30)} ariaLabel="Poids et contributions au risque" /> : <Skeleton height={300} />}
          </Card>
          <Card title={`Corrélations (${data?.estimates.cov_shrinkage ? "Ledoit-Wolf" : "empiriques"})`}>
            {data ? <EChart option={corrOption} height={Math.max(320, tickers.length * 30)} ariaLabel="Matrice de corrélation" /> : <Skeleton height={300} />}
          </Card>
        </div>
        <Card title="Estimations par actif" flush>
          {data ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Actif</th><th>Moyenne empirique</th><th>μ utilisé</th><th>Volatilité</th><th>Poids</th><th>Contribution au risque</th></tr></thead>
                <tbody>
                  {tickers.map((t, i) => (
                    <tr key={t}>
                      <td className="strong">{t}</td><td>{pct(data.estimates.sample_mu[i], 1)}</td><td>{pct(data.estimates.mu[i], 1)}</td>
                      <td>{pct(data.estimates.vol[i], 1)}</td><td className="strong">{pct(data.optimal.weights[t], 1)}</td><td>{pct(data.optimal.risk_contributions[t], 1)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={200} /></div>}
        </Card>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- LASSO path

export function LassoPage() {
  const [tickers, setTickers] = useState<string[]>(DEFAULT_TICKERS);
  const [shortMax, setShortMax] = useState(0.5);
  const req: OptimizeRequest = { tickers, lookback_days: 504, mean_method: "zero", cov_method: "sample", objective: "min-variance",
    gamma: 5, long_only: false, short_max: shortMax, w_max: 1, l1: 0, l2: 0, cost: 0, holding_days: 21 };
  const debounced = useDebounced(req, 400);
  const { data, error, isFetching } = useQuery({ queryKey: ["alloc-lasso", debounced], queryFn: () => allocationApi.optimize(debounced),
    placeholderData: keepPreviousData });
  const path = data?.lasso_path ?? [];
  const names = data?.estimates.tickers ?? [];
  const best = path.length ? path.reduce((a, b) => (b.out_of_sample_vol < a.out_of_sample_vol ? b : a)) : undefined;

  const pathOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34, right: 60 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", name: "λ₁", nameLocation: "middle", nameGap: 26, data: path.map((x) => String(x.lambda)) },
    yAxis: [
      { type: "value", name: "vol annuelle", scale: true, axisLabel: { formatter: (v: number) => pct(v, 1) } },
      { type: "value", name: "actifs", splitLine: { show: false } },
    ],
    series: [
      { type: "line", name: "Vol hors échantillon", color: p.series[1], symbolSize: 7, lineStyle: { width: 2.5 },
        tooltip: { valueFormatter: (v: number) => pct(v, 2) }, data: path.map((x) => x.out_of_sample_vol) },
      { type: "line", name: "Vol dans l'échantillon", color: p.series[0], symbolSize: 6, lineStyle: { width: 2, type: "dashed" },
        tooltip: { valueFormatter: (v: number) => pct(v, 2) }, data: path.map((x) => x.in_sample_vol) },
      { type: "bar", name: "Actifs détenus", yAxisIndex: 1, color: p.muted, itemStyle: { opacity: 0.35 }, barWidth: "40%", data: path.map((x) => x.n_active) },
    ],
  }), [path]);

  const weightsOption = useCallback((p: ChartPalette) => ({
    legend: { type: "scroll" },
    grid: { top: 40 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 1) },
    xAxis: { type: "category", name: "λ₁", nameLocation: "middle", nameGap: 26, data: path.map((x) => String(x.lambda)) },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
    series: names.map((t, i) => ({ type: "line", name: t, symbolSize: 4, color: p.series[i % p.series.length], lineStyle: { width: 1.5 },
      data: path.map((x) => x.weights[t]) })),
  }), [path, names]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <UniversePicker value={tickers} onChange={setTickers} />
            <div className="form-sep" />
            <NumberField label="Short max / actif" value={shortMax} suffix="%" scale={100} min={0.05} max={2} digits={0} onChange={setShortMax} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          Portefeuille de variance minimale avec une pénalité λ₁ Σ|wᵢ| (Brodie et al., 2009 ; DeMiguel et al., 2009). La
          covariance est estimée sur les 60 % premiers jours, la volatilité est mesurée sur les 40 % suivants. Plus λ₁ augmente,
          plus les positions courtes disparaissent et plus le portefeuille se concentre sur quelques actifs.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Sans pénalité" value={pct(path[0]?.out_of_sample_vol, 2)} foot={path[0] ? `${path[0].n_active} actifs, exposition brute ${pct(path[0].gross_exposure, 0)}` : undefined} busy={isFetching} />
          <Stat label="Meilleur λ₁ hors échantillon" value={best ? String(best.lambda) : "—"} foot={best ? `vol ${pct(best.out_of_sample_vol, 2)}, ${best.n_active} actifs` : undefined} busy={isFetching} />
          <Stat label="Gain de volatilité" value={best && path[0] ? `${num((path[0].out_of_sample_vol - best.out_of_sample_vol) * 100, 2)} pts` : "—"} foot="Hors échantillon, contre λ₁ = 0" busy={isFetching} />
          <Stat label="Exposition brute au meilleur λ₁" value={pct(best?.gross_exposure, 0)} foot="100 % = plus aucune vente à découvert" busy={isFetching} />
        </div>
        <Card title="Chemin de régularisation : volatilité et nombre d'actifs">
          {data ? <EChart option={pathOption} height={360} ariaLabel="Volatilité et nombre d'actifs selon lambda" /> : <Skeleton height={300} />}
        </Card>
        <Card title="Poids selon λ₁">
          {data ? <EChart option={weightsOption} height={360} ariaLabel="Poids de chaque actif selon lambda" /> : <Skeleton height={300} />}
        </Card>
        <InfoBox>
          En long-only, Σ|wᵢ| = Σwᵢ = 1 : la pénalité est constante et ne change rien. C'est la contrainte de non-vente à découvert
          qui joue alors le rôle de régularisation (Jagannathan et Ma, 2003). La pénalité ne mord que si l'on autorise les shorts.
        </InfoBox>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- backtest

export function BacktestPage() {
  const [req, setReq] = useState<BacktestRequest>({ tickers: DEFAULT_TICKERS, window: 126, rebalance_days: 21, cost: 0.001, gamma: 5,
    short_max: 0.3, w_max: 0.4, l1: 0.002 });
  const set = (patch: Partial<BacktestRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 500);
  const { data, error, isFetching } = useQuery({ queryKey: ["alloc-bt", debounced], queryFn: () => allocationApi.backtest(debounced),
    placeholderData: keepPreviousData });

  const wealthOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: { type: "scroll" },
      grid: { top: 40 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "category", data: data.dates, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", min: (v: { min: number }) => Math.floor(v.min * 20) / 20, max: (v: { max: number }) => Math.ceil(v.max * 20) / 20 },
      series: data.strategies.map((s, i) => ({ type: "line", name: s.name, showSymbol: false, color: p.series[i % p.series.length],
        lineStyle: { width: s.name === "1/N" ? 3 : 1.8 }, data: s.wealth })),
    };
  }, [data]);

  const best = data ? data.strategies.reduce((a, b) => (b.stats.sharpe > a.stats.sharpe ? b : a)) : undefined;
  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <UniversePicker value={req.tickers} onChange={(tickers) => set({ tickers })} />
            <div className="form-sep" />
            <div className="form-row">
              <SelectField label="Fenêtre d'estimation" value={req.window} onChange={(window) => set({ window })}
                options={[{ value: 63, label: "3 mois" }, { value: 126, label: "6 mois" }, { value: 252, label: "1 an" }]} />
              <SelectField label="Rebalancement" value={req.rebalance_days} onChange={(rebalance_days) => set({ rebalance_days })}
                options={[{ value: 5, label: "Hebdo" }, { value: 21, label: "Mensuel" }, { value: 63, label: "Trimestriel" }]} />
            </div>
            <div className="form-row">
              <NumberField label="Coûts" value={req.cost} suffix="bp" scale={1e4} min={0} max={0.05} digits={0} onChange={(cost) => set({ cost })} />
              <NumberField label="Aversion γ" value={req.gamma} min={0.1} max={200} digits={1} onChange={(gamma) => set({ gamma })} />
            </div>
            <div className="form-row">
              <NumberField label="Short max" value={req.short_max} suffix="%" scale={100} min={0} max={2} digits={0} onChange={(short_max) => set({ short_max })} />
              <NumberField label="Poids max" value={req.w_max} suffix="%" scale={100} min={0.05} max={1} digits={0} onChange={(w_max) => set({ w_max })} />
            </div>
            <NumberField label="Elastic-net λ₁" value={req.l1} min={0} max={1} digits={4} onChange={(l1) => set({ l1 })} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          Walk-forward : à chaque rebalancement, chaque règle n'utilise que les {req.window} jours de rendements précédents, puis les
          poids dérivent avec les prix jusqu'au rebalancement suivant ; les coûts sont prélevés sur le montant échangé. C'est le test
          de DeMiguel, Garlappi et Uppal (2009) : un portefeuille optimisé bat-il le 1/N une fois l'erreur d'estimation et les coûts
          pris en compte ?
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Meilleur Sharpe net" value={best ? num(best.stats.sharpe, 2) : "—"} foot={best?.name} busy={isFetching} />
          <Stat label="1/N" value={data ? num(data.strategies[0].stats.sharpe, 2) : "—"} foot={data ? `vol ${pct(data.strategies[0].stats.volatility, 1)}` : undefined} busy={isFetching} />
          <Stat label="Rebalancements" value={data ? String(data.strategies[0].n_rebalances) : "—"} foot={data ? `${data.dates[0]} → ${data.dates[data.dates.length - 1]}` : undefined} busy={isFetching} />
          <Stat label="Taux sans risque" value={pct(data?.risk_free, 2)} foot="EUR 3 mois, pour le Sharpe" busy={isFetching} />
        </div>
        <Card title="Richesse nette de coûts (départ = 1)">
          {data ? <EChart option={wealthOption} height={400} ariaLabel="Richesse cumulée de chaque stratégie" /> : <Skeleton height={340} />}
        </Card>
        <Card title="Performances hors échantillon" flush>
          {data ? (
            <div className={`table-wrap${isFetching ? " busy" : ""}`}>
              <table className="data">
                <thead><tr><th>Stratégie</th><th>Rendement annuel</th><th>Volatilité</th><th>Sharpe</th><th>Drawdown max</th><th>Rotation / rebal.</th><th>Coûts cumulés</th><th style={{ textAlign: "left" }}>Règle</th></tr></thead>
                <tbody>
                  {data.strategies.map((s) => (
                    <tr key={s.name}>
                      <td className="strong" style={{ textAlign: "left" }}>{s.name}</td><td>{pct(s.stats.annual_return, 1)}</td><td>{pct(s.stats.volatility, 1)}</td>
                      <td className="strong">{num(s.stats.sharpe, 2)}</td><td>{pct(s.stats.max_drawdown, 1)}</td><td>{pct(s.turnover, 0)}</td>
                      <td>{pct(s.total_cost, 2)}</td><td className="muted" style={{ textAlign: "left", whiteSpace: "normal", minWidth: 260, fontSize: 12 }}>{s.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={200} /></div>}
        </Card>
        <InfoBox>
          Résultat typique : la moyenne-variance aux moyennes empiriques, avec shorts, empile des paris extrêmes sur des moyennes bruitées
          (rotation énorme, volatilité élevée) et perd contre 1/N. Les contraintes (long-only, poids plafonnés), le shrinkage et la
          pénalisation des coûts réduisent l'erreur d'estimation et la rotation. Le minimum variance, qui n'utilise pas les moyennes,
          délivre en général la volatilité la plus basse. Avec 2 ans d'historique, l'échantillon reste court : ces écarts sont indicatifs.
        </InfoBox>
      </div>
    </div>
  );
}
