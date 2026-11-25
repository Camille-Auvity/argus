import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet, useOutletContext } from "react-router-dom";
import {
  explainApi, type CalcStep, type Currency, type ExplainGreeks, type ExplainTree, type TreeNode, type VanillaRequest,
} from "../api/client";
import { EChart } from "../components/EChart";
import { defaultMarket } from "../components/pricing";
import { Card, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { ccySymbol, num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export const METHOD_PAGES = [
  { path: "black-scholes", label: "Black-Scholes" },
  { path: "arbre-binomial", label: "Arbre binomial" },
  { path: "monte-carlo", label: "Monte Carlo" },
  { path: "longstaff-schwartz", label: "Longstaff-Schwartz" },
  { path: "grecques", label: "Grecques (différences finies)" },
] as const;

/** Layout shared by the method sub-pages: option parameters on top, the selected method below. */
export default function Methods() {
  const { ticker, snapshot } = useTicker();
  return <MethodsShell key={`${ticker}:${snapshot ? "ready" : "loading"}`} />;
}

function MethodsShell() {
  const { ticker, snapshot } = useTicker();
  const market = defaultMarket(snapshot);
  const ccy = ccySymbol(snapshot?.currency);
  const [req, setReq] = useState<VanillaRequest>({
    ...market, strike: Math.round(market.spot), expiry: 0.5, option_type: "call", exercise: "european",
    tree_steps: 500, mc_paths: 100_000,
  });
  const set = (patch: Partial<VanillaRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req);
  const rate = req.rate;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Méthodes de pricing — {ticker}</h1>
          <div className="page-sub">Chaque méthode, étape par étape : les chiffres intermédiaires et les graphiques viennent du même moteur que les prix de la plateforme.</div>
        </div>
      </div>
      <Card title="Option étudiée" className="param-bar">
        <div className="toolbar-grid">
          <NumberField label={`Spot (${ccy})`} value={req.spot} min={0.0001} digits={2} onChange={(spot) => set({ spot })} />
          <NumberField label="Volatilité" value={req.vol} suffix="%" scale={100} min={0.001} max={5} digits={2} onChange={(vol) => set({ vol })} />
          <NumberField label="Dividend yield" value={req.dividend_yield} suffix="%" scale={100} digits={3} onChange={(dividend_yield) => set({ dividend_yield })} />
          <NumberField label={`Strike (${ccy})`} value={req.strike} min={0.0001} digits={2} onChange={(strike) => set({ strike })} />
          <NumberField label="Maturité" value={req.expiry} suffix="jours" scale={365} min={1 / 365} max={30} digits={0} onChange={(expiry) => set({ expiry })} />
          <SelectField label="Trajectoires MC" value={req.mc_paths} onChange={(mc_paths) => set({ mc_paths })}
            options={[10_000, 50_000, 100_000, 200_000].map((v) => ({ value: v, label: v.toLocaleString("fr-FR") }))} />
          <Segmented label="Type" value={req.option_type} onChange={(option_type) => set({ option_type })}
            options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
          <Segmented label="Exercice" value={req.exercise} onChange={(exercise) => set({ exercise })}
            options={[{ value: "european", label: "Européen" }, { value: "american", label: "Américain" }]} />
          <Segmented label="Taux sans risque" value={rate.mode === "flat" ? "flat" : rate.currency}
            options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }, { value: "flat", label: "Fixe" }]}
            onChange={(v) => set({ rate: v === "flat" ? { ...rate, mode: "flat" } : { ...rate, mode: "curve", currency: v as Currency } })} />
          {rate.mode === "flat" && (
            <NumberField label="Taux fixe" value={rate.flat_rate} suffix="%" scale={100} digits={3}
              onChange={(flat_rate) => set({ rate: { ...rate, flat_rate } })} />
          )}
        </div>
      </Card>
      <nav className="tabs subnav" aria-label="Méthodes">
        {METHOD_PAGES.map((m) => (
          <NavLink key={m.path} to={`/methods/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
        ))}
      </nav>
      <Outlet context={debounced} />
    </>
  );
}

function useMethodReq(): VanillaRequest {
  return useOutletContext<VanillaRequest>();
}

// ----------------------------------------------------------------------------- shared pieces

function StepsTable({ steps, resultLabel }: { steps: CalcStep[]; resultLabel?: string }) {
  return (
    <div className="table-wrap">
      <table className="data steps-table">
        <thead><tr><th>Étape</th><th style={{ textAlign: "left" }}>Formule</th><th>Valeur</th><th style={{ textAlign: "left" }}>Commentaire</th></tr></thead>
        <tbody>
          {steps.map((s, i) => (
            <tr key={s.label} className={s.label === resultLabel ? "result" : ""}>
              <td><span className="step-index">{i + 1}</span>{s.label}</td>
              <td className="formula"><Formula text={s.formula} /></td>
              <td className="strong">{Math.abs(s.value) >= 1000 ? num(s.value, 0) : num(s.value, 4)}</td>
              <td className="note"><Formula text={s.note} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Plain-text maths with ^{...} superscripts and _{...} subscripts. */
function Formula({ text }: { text: string }) {
  const parts = text.split(/([\^_]\{[^}]*\})/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith("^{") ? <sup key={i}>{part.slice(2, -1)}</sup>
          : part.startsWith("_{") ? <sub key={i}>{part.slice(2, -1)}</sub>
            : <span key={i}>{part}</span>)}
    </>
  );
}

function useExplain<T>(key: string, req: unknown, fn: () => Promise<T>) {
  return useQuery({ queryKey: ["explain", key, req], queryFn: fn, placeholderData: keepPreviousData });
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: "0 0 14px" }}>{children}</p>;
}

const markers = (p: ChartPalette, lines: { x: number; name: string; color?: string }[]) => ({
  symbol: "none", silent: true,
  label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
  data: lines.map((l) => ({ xAxis: l.x, name: l.name, lineStyle: { color: l.color ?? p.muted, type: "dashed", width: 1 } })),
});

// ----------------------------------------------------------------------------- Black-Scholes

export function BlackScholesTab() {
  const req = useMethodReq();
  const { data, error, isFetching } = useExplain("bs", req, () => explainApi.blackScholes(req));
  const option = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const call = data.inputs.option_type === "call";
    const pts = data.density.s.map((s, i) => [s, data.density.pdf[i]]);
    const itm = pts.filter(([s]) => (call ? s >= data.inputs.strike : s <= data.inputs.strike));
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
      xAxis: { type: "value", scale: true },
      yAxis: { type: "value", axisLabel: { show: false } },
      series: [
        { type: "line", name: "Densité risque-neutre de S_T", showSymbol: false, color: p.series[0], lineStyle: { width: 2 }, data: pts,
          markLine: markers(p, [{ x: data.inputs.strike, name: "K" }, { x: data.inputs.spot, name: "S" }, { x: data.forward, name: "F" }]) },
        { type: "line", name: `Zone dans la monnaie (proba ${pct(data.prob_itm, 1)})`, showSymbol: false, color: p.series[2],
          lineStyle: { width: 0 }, areaStyle: { opacity: 0.35 }, data: itm },
      ],
    };
  }, [data]);
  return (
    <div className={`grid${isFetching ? " busy" : ""}`}>
      <Explainer>
        Sous la probabilité risque-neutre, <b>ln S_T suit une loi normale</b> de moyenne ln S + (r − q − σ²/2)T et de variance σ²T.
        Le prix est l'espérance actualisée du payoff, qui se calcule exactement : c'est la formule fermée, évaluée ici terme à terme.
      </Explainer>
      <ErrorBox error={error} />
      {!data ? <Skeleton height={300} /> : (
        <>
          <div className="grid cols-4">
            <Stat label="Terme sous-jacent" value={num(data.steps[6].value, 4)} foot={<Formula text={data.steps[6].formula} />} />
            <Stat label="Terme strike" value={num(data.steps[7].value, 4)} foot={<Formula text={data.steps[7].formula} />} />
            <Stat label="Prix" value={num(data.price, 4)} foot="différence des deux termes" />
            <Stat label="Proba de finir dans la monnaie" value={pct(data.prob_itm, 2)} foot="N(d₂) sous la mesure risque-neutre" />
          </div>
          <Card title="Calcul pas à pas" flush><StepsTable steps={data.steps} resultLabel="Prix" /></Card>
          <Card title="Distribution de S_T à l'échéance">
            <EChart option={option} height={460} ariaLabel="Densité risque-neutre du sous-jacent à l'échéance" />
          </Card>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- binomial tree

export function TreeTab() {
  const req = useMethodReq();
  const [displaySteps, setDisplaySteps] = useState(5);
  const body = { ...req, display_steps: displaySteps };
  const { data, error, isFetching } = useExplain("tree", body, () => explainApi.tree(body));

  const convOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
      xAxis: { type: "value", min: 0 },
      yAxis: { type: "value", scale: true },
      series: [{
        type: "line", name: "Prix de l'arbre selon le nombre de pas N", symbol: "circle", symbolSize: 4, color: p.series[0],
        lineStyle: { width: 1.5 }, data: data.convergence.n.map((n, i) => [n, data.convergence.price[i]]),
        markLine: { symbol: "none", silent: true, lineStyle: { color: p.series[1], type: "dashed", width: 1.5 },
          label: { formatter: `${data.reference_label} : ${num(data.reference, 4)}`, color: p.textSecondary, position: "insideEndTop" },
          data: [{ yAxis: data.reference }] },
      }],
    };
  }, [data]);

  const boundaryOption = useCallback((p: ChartPalette) => {
    if (!data?.boundary) return {};
    return {
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 2) },
      xAxis: { type: "value", axisLabel: { formatter: (v: number) => `${num(v * 365, 0)} j` } },
      yAxis: { type: "value", scale: true },
      series: [{ type: "line", name: "Spot critique d'exercice", showSymbol: false, step: "end", color: p.series[0], lineStyle: { width: 2 },
        areaStyle: { opacity: 0.12 }, data: data.boundary.t.map((t, i) => [t, data.boundary!.s[i]]) }],
    };
  }, [data]);

  return (
    <div className={`grid${isFetching ? " busy" : ""}`}>
      <Explainer>
        Le temps est découpé en N pas. À chaque pas le sous-jacent est multiplié par <b>u</b> (hausse) ou <b>d</b> (baisse),
        avec la probabilité risque-neutre <b>p</b>. On part des payoffs à l'échéance (colonne de droite) puis on remonte :
        chaque nœud vaut l'espérance actualisée de ses deux successeurs{req.exercise === "american" ? ", ou la valeur d'exercice si elle est supérieure (nœuds encadrés en rouge)" : ""}.
      </Explainer>
      <ErrorBox error={error} />
      {!data ? <Skeleton height={360} /> : (
        <>
          <div className="grid cols-4">
            <Stat label="u / d" value={`${num(data.params.u, 4)} / ${num(data.params.d, 4)}`} foot={`Δt = ${num(data.params.dt * 365, 1)} jours`} />
            <Stat label="Probabilité p (1er pas)" value={num(data.params.p, 4)} foot={`actualisation ${num(data.params.step_discount, 5)}`} />
            <Stat label={`Prix avec ${data.params.steps} pas`} value={num(data.price_display, 4)} foot="valeur du nœud racine" />
            <Stat label={data.reference_label} value={num(data.reference, 4)} foot={`écart ${num(data.price_display - data.reference, 4)}`} />
          </div>
          <Card title="Arbre (prix du sous-jacent / valeur de l'option)" actions={
            <label className="slider">
              {data.params.steps} pas
              <input type="range" min={1} max={10} value={displaySteps} onChange={(e) => setDisplaySteps(Number(e.target.value))} />
            </label>
          }>
            <TreeDiagram tree={data} />
            <div className="legend" style={{ marginTop: 10 }}>
              <span><i style={{ background: "var(--accent)" }} />racine : prix de l'option aujourd'hui</span>
              {data.boundary && <span><i style={{ background: "var(--critical)" }} />exercice anticipé optimal</span>}
              <span className="muted">Survolez un nœud pour le détail (continuation, valeur d'exercice).</span>
            </div>
          </Card>
          <Card title="Calcul pas à pas" flush><StepsTable steps={data.steps} resultLabel="Valeur d'un nœud" /></Card>
          <div className="grid">
            <Card title="Convergence quand N augmente">
              <EChart option={convOption} height={420} ariaLabel="Convergence du prix de l'arbre" />
            </Card>
            {data.boundary && (
              <Card title="Frontière d'exercice anticipé (arbre 300 pas)">
                <EChart option={boundaryOption} height={420} ariaLabel="Frontière d'exercice anticipé selon le temps" />
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function TreeDiagram({ tree }: { tree: ExplainTree }) {
  const n = tree.params.steps;
  const nodeW = 96, nodeH = 42, colW = 150, rowStep = 30, pad = 16, axisH = 24;
  const width = pad * 2 + n * colW + nodeW;
  const height = pad * 2 + 2 * n * rowStep + nodeH + axisH;
  const pos = (node: { i: number; j: number }) => ({
    x: pad + node.i * colW,
    y: pad + (n - (node.i - 2 * node.j)) * rowStep,
  });
  const byKey = new Map(tree.nodes.map((nd) => [`${nd.i}:${nd.j}`, nd]));
  const detail = (nd: TreeNode) =>
    `t = ${num(nd.t * 365, 1)} j\nS = ${num(nd.spot, 4)}\nValeur = ${num(nd.value, 4)}\nContinuation = ${num(nd.continuation, 4)}\nExercice immédiat = ${num(nd.exercise_value, 4)}${nd.exercised ? "\n→ exercice optimal" : ""}`;

  return (
    <div style={{ overflowX: "auto" }}>
      <svg className="tree-svg" viewBox={`0 0 ${width} ${height}`} style={{ minWidth: Math.min(width, 640) }} role="img"
        aria-label={`Arbre binomial à ${n} pas`}>
        {tree.nodes.filter((nd) => nd.i < n).map((nd) => {
          const a = pos(nd);
          return [0, 1].map((dj) => {
            const child = byKey.get(`${nd.i + 1}:${nd.j + dj}`);
            if (!child) return null;
            const b = pos(child);
            return <line key={`${nd.i}:${nd.j}:${dj}`} className="edge" x1={a.x + nodeW} y1={a.y + nodeH / 2} x2={b.x} y2={b.y + nodeH / 2} />;
          });
        })}
        {tree.nodes.map((nd) => {
          const { x, y } = pos(nd);
          return (
            <g key={`${nd.i}:${nd.j}`} className={`node${nd.exercised ? " exercised" : ""}${nd.i === 0 ? " root" : ""}`} transform={`translate(${x},${y})`}>
              <title>{detail(nd)}</title>
              <rect width={nodeW} height={nodeH} rx={6} />
              <text className="s num" x={nodeW / 2} y={16} textAnchor="middle">S {num(nd.spot, 2)}</text>
              <text className="v num" x={nodeW / 2} y={34} textAnchor="middle">{num(nd.value, 3)}</text>
            </g>
          );
        })}
        {Array.from({ length: n + 1 }, (_, i) => (
          <text key={i} className="axis-label num" x={pad + i * colW + nodeW / 2} y={height - 6} textAnchor="middle">
            {i === 0 ? "t = 0" : `${num((i * tree.params.dt) * 365, 0)} j`}
          </text>
        ))}
      </svg>
    </div>
  );
}

// ----------------------------------------------------------------------------- Monte Carlo

export function MonteCarloTab() {
  const req = useMethodReq();
  const { data, error, isFetching } = useExplain("mc", req, () => explainApi.monteCarlo(req));

  const pathsOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      tooltip: { trigger: "item", formatter: (it: { seriesName: string; value: number[] }) =>
        `${it.seriesName}<br/>t = ${num(it.value[0] * 365, 0)} j · S = ${num(it.value[1], 2)}` },
      xAxis: { type: "value", max: data.paths.t[data.paths.t.length - 1], axisLabel: { formatter: (v: number) => `${num(v * 365, 0)} j` } },
      yAxis: { type: "value", scale: true },
      series: data.paths.s.map((path, k) => ({
        type: "line", name: `Trajectoire ${k + 1}`, showSymbol: false, color: p.series[0],
        lineStyle: { width: 1, opacity: 0.45 }, emphasis: { lineStyle: { width: 2, opacity: 1 } },
        data: path.map((s, i) => [data.paths.t[i], s]),
        markLine: k === 0 ? { symbol: "none", silent: true, lineStyle: { color: p.series[1], type: "dashed", width: 1.5 },
          label: { formatter: `K = ${num(req.strike, 2)}`, color: p.textSecondary, position: "insideEndTop" }, data: [{ yAxis: req.strike }] } : undefined,
      })),
    };
  }, [data, req.strike]);

  const histOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const { edges, counts } = data.terminal_histogram;
    const total = counts.reduce((a, b) => a + b, 0);
    return {
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "value", scale: true },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 1) } },
      series: [{ type: "line", name: "Fréquence de S_T", step: "middle", showSymbol: false, color: p.series[0],
        lineStyle: { width: 1.5 }, areaStyle: { opacity: 0.3 },
        data: counts.map((c, i) => [(edges[i] + edges[i + 1]) / 2, c / total]),
        markLine: markers(p, [{ x: req.strike, name: "K", color: p.series[1] }, { x: req.spot, name: "S" }]) }],
    };
  }, [data, req.strike, req.spot]);

  const convOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const c = data.convergence;
    return {
      legend: { data: ["Estimation Monte Carlo", "Intervalle de confiance 95 %"] },
      grid: { top: 30 },
      tooltip: {
        trigger: "axis",
        formatter: (items: { dataIndex: number }[]) => {
          const i = items[0].dataIndex;
          return `N = ${c.n[i].toLocaleString("fr-FR")}<br/>Estimation <b>${num(c.mean[i], 4)}</b><br/>IC 95 % [${num(c.lo[i], 4)} ; ${num(c.hi[i], 4)}]`;
        },
      },
      // checkpoints are log-spaced, so a category axis reads as a log scale
      xAxis: { type: "category", boundaryGap: false, data: c.n.map((n) => n.toLocaleString("fr-FR")), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", scale: true },
      series: [
        { type: "line", name: "IC bas", stack: "ci", showSymbol: false, lineStyle: { opacity: 0 }, data: c.lo, tooltip: { show: false } },
        { type: "line", name: "Intervalle de confiance 95 %", stack: "ci", showSymbol: false, color: p.series[0], lineStyle: { opacity: 0 },
          areaStyle: { opacity: 0.2 }, data: c.hi.map((h, i) => h - c.lo[i]) },
        { type: "line", name: "Estimation Monte Carlo", showSymbol: false, color: p.series[0], lineStyle: { width: 2 },
          data: c.mean,
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.series[1], type: "dashed", width: 1.5 },
            label: { formatter: `Black-Scholes ${num(data.reference, 4)}`, color: p.textSecondary, position: "insideEndTop" }, data: [{ yAxis: data.reference }] } },
      ],
    };
  }, [data]);

  return (
    <div className={`grid${isFetching ? " busy" : ""}`}>
      <Explainer>
        On simule un grand nombre de valeurs de S_T sous la probabilité risque-neutre, on calcule le payoff de chacune, puis on
        prend la <b>moyenne actualisée</b>. La loi des grands nombres garantit la convergence, à la vitesse <b>1/√N</b> : diviser
        l'erreur par 2 coûte 4 fois plus de trajectoires. Les variables antithétiques (Z et −Z) réduisent la variance gratuitement.
        {req.exercise === "american" && " L'option est traitée ici en européen ; l'exercice américain est dans l'onglet Longstaff-Schwartz."}
      </Explainer>
      <ErrorBox error={error} />
      {!data ? <Skeleton height={360} /> : (
        <>
          <div className="grid cols-4">
            <Stat label="Prix Monte Carlo" value={num(data.price, 4)} foot={`± ${num(1.96 * data.std_error, 4)} (IC 95 %)`} />
            <Stat label="Black-Scholes (exact)" value={num(data.reference, 4)}
              foot={`écart ${num(data.price - data.reference, 4)} = ${num((data.price - data.reference) / data.std_error, 2)} σ`} />
            <Stat label="Erreur standard" value={num(data.std_error, 5)} foot={`sans antithétiques : ${num(data.antithetic.without.std_error, 5)}`} />
            <Stat label="Gain des antithétiques" value={data.antithetic.variance_reduction ? `× ${num(data.antithetic.variance_reduction, 1)}` : "—"}
              foot="réduction de variance à N égal" />
          </div>
          <Card title={`${data.paths.s.length} trajectoires simulées (illustration)`}>
            <EChart option={pathsOption} height={480} ariaLabel="Trajectoires simulées du sous-jacent" />
          </Card>
          <Card title="Distribution des S_T simulés">
            <EChart option={histOption} height={420} ariaLabel="Histogramme des valeurs finales simulées" />
          </Card>
          <Card title="Convergence de l'estimation">
            <EChart option={convOption} height={440} ariaLabel="Convergence de l'estimation Monte Carlo avec intervalle de confiance" />
          </Card>
          <Card title="Calcul pas à pas" flush><StepsTable steps={data.steps} resultLabel="Prix" /></Card>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- Longstaff-Schwartz

export function LsmTab() {
  const req = useMethodReq();
  const [lsmSteps] = useState(50);
  const [snapshot, setSnapshot] = useState(25);
  const body = { ...req, exercise: "american" as const, mc_paths: Math.min(req.mc_paths, 100_000), lsm_steps: lsmSteps, snapshot_step: snapshot };
  const { data, error, isFetching } = useExplain("lsm", body, () => explainApi.lsm(body));

  const regOption = useCallback((p: ChartPalette) => {
    const r = data?.regression;
    if (!r) return {};
    const pts = r.points.s.map((s, i) => [s, r.points.cashflow[i], r.points.exercised[i]] as const);
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "item", formatter: (it: { seriesName: string; value: number[] }) =>
        `${it.seriesName}<br/>S = ${num(it.value[0], 2)} · ${num(it.value[1], 3)}` },
      xAxis: { type: "value", scale: true },
      yAxis: { type: "value" },
      series: [
        { type: "scatter", name: "Trajectoire : on continue", symbolSize: 4, color: p.series[0], itemStyle: { opacity: 0.45 },
          data: pts.filter((x) => !x[2]).map((x) => [x[0], x[1]]) },
        { type: "scatter", name: "Trajectoire : on exerce", symbolSize: 4, color: p.series[1], itemStyle: { opacity: 0.55 },
          data: pts.filter((x) => x[2]).map((x) => [x[0], x[1]]) },
        { type: "line", name: "Continuation estimée (régression)", showSymbol: false, color: p.text, lineStyle: { width: 2 },
          data: r.fit.s.map((s, i) => [s, r.fit.continuation[i]]) },
        { type: "line", name: "Valeur d'exercice immédiat", showSymbol: false, color: p.series[2], lineStyle: { width: 2, type: "dashed" },
          data: r.fit.s.map((s, i) => [s, r.fit.exercise[i]]) },
      ],
    };
  }, [data]);

  const boundaryOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 2) },
      xAxis: { type: "value", min: 0, max: req.expiry, axisLabel: { formatter: (v: number) => `${num(v * 365, 0)} j` } },
      yAxis: { type: "value", scale: true },
      series: [
        { type: "line", name: "Frontière de l'arbre (300 pas)", showSymbol: false, step: "end", color: p.series[1], lineStyle: { width: 2 },
          data: data.tree_boundary.t.map((t, i) => [t, data.tree_boundary.s[i]]) },
        { type: "scatter", name: "Frontière estimée par LSM", symbolSize: 7, color: p.series[0],
          itemStyle: { borderColor: p.surface, borderWidth: 1 }, data: data.boundary.t.map((t, i) => [t, data.boundary.s[i]]) },
      ],
    };
  }, [data, req.expiry]);

  const r = data?.regression;
  return (
    <div className={`grid${isFetching ? " busy" : ""}`}>
      <Explainer>
        Pour une option américaine, il faut décider à chaque date s'il vaut mieux exercer. Longstaff-Schwartz remonte le temps
        sur les trajectoires simulées : à chaque date, on <b>régresse les cash-flows futurs actualisés sur le spot</b> (polynôme de
        degré 3, trajectoires dans la monnaie seulement) pour estimer la valeur de continuation, puis on exerce là où la valeur
        d'exercice la dépasse. {req.exercise === "european" && "L'option du panneau est traitée ici en américaine."}
      </Explainer>
      <ErrorBox error={error} />
      {req.option_type === "call" && req.dividend_yield <= 0 && (
        <InfoBox>Sans dividende, exercer un call américain avant l'échéance n'est jamais optimal : la frontière est vide. Passez en put pour voir l'exercice anticipé.</InfoBox>
      )}
      {!data ? <Skeleton height={360} /> : (
        <>
          <div className="grid cols-4">
            <Stat label="Prix LSM" value={num(data.price, 4)} foot={`± ${num(1.96 * data.std_error, 4)} (IC 95 %)`} />
            <Stat label="Arbre 1000 pas (référence)" value={num(data.tree_price, 4)} foot={`écart ${num(data.price - data.tree_price, 4)}`} />
            <Stat label="Européenne (Black-Scholes)" value={num(data.european_price, 4)} />
            <Stat label="Prime d'exercice anticipé" value={num(data.price - data.european_price, 4)} foot={pct((data.price - data.european_price) / data.european_price, 1)} />
          </div>
          <Card title={r ? `Régression à la date ${snapshot + 1} / ${data.lsm_steps} (t = ${num(r.t * 365, 0)} j)` : "Régression"} actions={
            <label className="slider">
              Date
              <input type="range" min={0} max={data.lsm_steps - 2} value={snapshot} onChange={(e) => setSnapshot(Number(e.target.value))} />
            </label>
          }>
            {r ? (
              <>
                <EChart option={regOption} height={500} ariaLabel="Régression de Longstaff-Schwartz à une date" />
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {r.n_itm.toLocaleString("fr-FR")} trajectoires dans la monnaie à cette date, dont {r.n_exercised.toLocaleString("fr-FR")} exercées.
                  Coefficients (x = S/K) : {r.coefficients.map((c) => num(c, 3)).join(" ; ")}.
                </div>
              </>
            ) : <div className="empty">Aucune trajectoire dans la monnaie à cette date.</div>}
          </Card>
          <Card title="Frontière d'exercice : LSM vs arbre">
            <EChart option={boundaryOption} height={440} ariaLabel="Frontière d'exercice estimée par LSM et par l'arbre" />
            <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              La frontière LSM découle d'une régression polynomiale, donc approximative. Le prix reste précis : se tromper de
              décision près de la frontière, là où exercer et continuer valent presque autant, ne coûte presque rien.
            </div>
          </Card>
          <Card title="Calcul pas à pas" flush><StepsTable steps={data.steps} resultLabel="Prix LSM" /></Card>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- finite-difference Greeks

const GREEK_LABEL: Record<string, string> = { delta: "Delta", gamma: "Gamma", vega: "Vega", theta: "Theta", rho: "Rho" };

export function GreeksTab() {
  const req = useMethodReq();
  const [method, setMethod] = useState<"tree" | "mc">("tree");
  const body = { ...req, method };
  const { data, error, isFetching } = useExplain("greeks", body, () => explainApi.greeks(body));
  return (
    <div className={`grid${isFetching ? " busy" : ""}`}>
      <Explainer>
        Les méthodes numériques n'ont pas de formule pour les grecques : on <b>re-price l'option avec un paramètre légèrement décalé</b>{" "}
        (« bump ») et on applique une différence finie centrée. Ce code est écrit une seule fois dans la classe parente commune.
        En Monte Carlo, chaque repricing réutilise les mêmes nombres aléatoires, sans quoi le bruit écraserait la différence.
        Les valeurs sont des dérivées brutes (vega et rho pour 1,00 de vol ou de taux, theta par an).
      </Explainer>
      <Segmented value={method} onChange={setMethod} options={[{ value: "tree", label: "Arbre binomial" }, { value: "mc", label: "Monte Carlo" }]} />
      <ErrorBox error={error} />
      {!data ? <Skeleton height={260} /> : <GreeksBreakdown data={data} />}
    </div>
  );
}

function GreeksBreakdown({ data }: { data: ExplainGreeks }) {
  return (
    <Card title={`Repricings — ${data.method}`} flush>
      <div className="table-wrap">
        <table className="data steps-table">
          <thead>
            <tr>
              <th>Grecque et formule</th><th>Bump</th>
              <th style={{ textAlign: "left" }}>Prix re-calculés</th><th>Différence finie</th><th>Formule fermée</th><th>Écart</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => {
              const closed = data.closed_form?.[r.greek];
              return (
                <tr key={r.greek}>
                  <td>
                    <div className="strong">{GREEK_LABEL[r.greek]}</div>
                    <div className="muted" style={{ fontFamily: "var(--mono)", fontSize: 11.5, marginTop: 2 }}><Formula text={r.formula} /></div>
                  </td>
                  <td><span className="num">{num(r.bump, r.bump < 0.01 ? 5 : 4)}</span><div className="muted" style={{ fontSize: 11 }}>{r.bump_label}</div></td>
                  <td className="note" style={{ minWidth: 0 }}>
                    {Object.entries(r.prices).map(([k, v]) => <div key={k} className="num">{k} = {num(v, 5)}</div>)}
                  </td>
                  <td className="strong">{num(r.value, 5)}</td>
                  <td>{closed === undefined ? "—" : num(closed, 5)}</td>
                  <td className="muted">{closed === undefined ? "—" : num(r.value - closed, 5)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {!data.closed_form && <div className="card-body muted" style={{ fontSize: 12 }}>Pas de formule fermée pour l'exercice américain.</div>}
    </Card>
  );
}
