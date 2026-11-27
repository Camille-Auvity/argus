import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import { measuresApi, stambaughApi, stochasticApi, theoryApi, vasicekApi, type Hist, type VasicekFreq, type MeasureStats, type HedgeRequest, type ImportanceRequest, type TreeRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, ErrorBox, InfoBox, keepGreek, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { tr } from "../lib/i18n";

export const THEORY_PAGES = [
  { path: "replication", label: ["Réplication sur l'arbre", "Replication on the tree"] },
  { path: "couverture", label: ["Couverture dynamique en delta", "Dynamic delta hedging"] },
  { path: "calcul-stochastique", label: ["Calcul stochastique", "Stochastic calculus"] },
  { path: "girsanov", label: ["Girsanov et échantillonnage préférentiel", "Girsanov and importance sampling"] },
  { path: "p-vs-q", label: ["Monde réel et risque-neutre", "Real world and risk-neutral"] },
  { path: "vasicek", label: ["Taux court : Vasicek", "Short rate: Vasicek"] },
  { path: "stambaugh", label: ["Régression prédictive", "Predictive regression"] },
] as const;

export default function Theory() {
  const nav = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  // the tab bar scrolls sideways on narrow screens: keep the active tab in view
  useEffect(() => {
    const bar = nav.current, link = bar?.querySelector<HTMLElement>("a.on");
    if (bar && link) bar.scrollLeft = Math.max(0, link.offsetLeft - bar.offsetLeft - (bar.clientWidth - link.offsetWidth) / 2);
  }, [pathname]);
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Théorie appliquée", "Applied theory")}</h1>
          <div className="page-sub">
            {tr("Les résultats de la finance en temps continu, recalculés et testés : réplication et probabilité risque-neutre, couverture dynamique, passage au temps continu, modèle de taux court et régression prédictive.",
              "Continuous-time finance results, recomputed and tested: replication and the risk-neutral measure, dynamic hedging, the passage to continuous time, a short-rate model and predictive regression.")}
          </div>
        </div>
      </div>
      <nav ref={nav} className="tabs subnav" aria-label={tr("Théorie appliquée", "Applied theory")}>
        {THEORY_PAGES.map((m) => (
          <NavLink key={m.path} to={`/theory/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{tr(m.label[0], m.label[1])}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

const signedNum = (x: number | null | undefined, d = 3) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${num(x, d)}`);

// ----------------------------------------------------------------------------- binomial replication

export function ReplicationLab() {
  const [req, setReq] = useState<TreeRequest>({ S0: 100, u: 1.2, d: 0.8, R: 1.05, K: 110, option_type: "put", steps: 2, american: false, ask: 12, path: "ud" });
  const set = (patch: Partial<TreeRequest>) => setReq((r) => ({ ...r, ...patch }));
  const path = (req.path ?? "").padEnd(req.steps, "u").slice(0, req.steps);
  const debounced = useDebounced({ ...req, path }, 250);
  const { data, error, isFetching } = useQuery({ queryKey: ["tree", debounced], queryFn: () => theoryApi.tree(debounced), placeholderData: keepPreviousData });
  const root = data?.nodes.find((n) => n.step === 0);
  const mm = data?.market_maker;

  const treeOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const N = data.steps;
    const onPath = new Set<string>(["0-0"]);
    let ups = 0;
    path.split("").forEach((m, i) => { ups += m === "u" ? 1 : 0; onPath.add(`${i + 1}-${ups}`); });
    const nodes = data.nodes.map((n) => ({
      name: `${n.step}-${n.ups}`, x: n.step * 220, y: (N - 2 * n.ups + n.step) * 60,
      symbolSize: 18, itemStyle: { color: n.exercised ? p.critical : onPath.has(`${n.step}-${n.ups}`) ? p.series[1] : p.series[0] },
      label: { show: true, position: "right", distance: 6, fontSize: 11, color: p.text, lineHeight: 15,
        formatter: () => [`S = ${num(n.spot, 2)}`, `V = ${num(n.value, 3)}`, ...(n.delta != null ? [`Δ = ${num(n.delta, 4)}`, `B = ${num(n.bond, 3)}`] : [])].join("\n") },
      tooltip: { formatter: () => tr(`Nœud (t=${n.step}, ${n.ups} hausse${n.ups > 1 ? "s" : ""})`, `Node (t=${n.step}, ${n.ups} up move${n.ups > 1 ? "s" : ""})`) + `<br/>S = ${num(n.spot, 3)} · V = ${num(n.value, 4)}` +
        (n.delta != null ? `<br/>Δ = ${num(n.delta, 4)} · B = ${num(n.bond, 4)}` : `<br/>payoff = ${num(n.payoff, 3)}`) +
        tr(`<br/>Q(atteindre le nœud) = ${num(n.probability, 4)} (${n.path_count} chemin${n.path_count > 1 ? "s" : ""})`,
          `<br/>Q(reach the node) = ${num(n.probability, 4)} (${n.path_count} path${n.path_count > 1 ? "s" : ""})`) },
    }));
    const links = data.nodes.filter((n) => n.step < N).flatMap((n) => [
      { source: `${n.step}-${n.ups}`, target: `${n.step + 1}-${n.ups + 1}`, label: { show: true, formatter: `π = ${num(data.pi, 3)}`, fontSize: 9, color: p.muted } },
      { source: `${n.step}-${n.ups}`, target: `${n.step + 1}-${n.ups}`, label: { show: true, formatter: `1−π = ${num(1 - data.pi, 3)}`, fontSize: 9, color: p.muted } },
    ]).map((l) => ({ ...l, lineStyle: { color: onPath.has(l.source) && onPath.has(l.target) ? p.series[1] : p.muted, width: onPath.has(l.source) && onPath.has(l.target) ? 2.5 : 1.2 } }));
    return { tooltip: {}, series: [{ type: "graph", layout: "none", roam: true, data: nodes, links, edgeSymbol: ["none", "arrow"], edgeSymbolSize: 6,
      left: 30, right: 140, top: 30, bottom: 30 }] };
  }, [data, path]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title={tr("Marché et option", "Market and option")}>
          <div className="form">
            <div className="form-row">
              <NumberField label="Spot S₀" value={req.S0} min={0.01} digits={2} onChange={(S0) => set({ S0 })} />
              <NumberField label="Strike K" value={req.K} min={0.01} digits={2} onChange={(K) => set({ K })} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Hausse u", "Up factor u")} value={req.u} min={1.0001} digits={3} onChange={(u) => set({ u })} />
              <NumberField label={tr("Baisse d", "Down factor d")} value={req.d} min={0.01} max={0.9999} digits={3} onChange={(d) => set({ d })} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Taux brut R / période", "Gross rate R / period")} value={req.R} min={0.5} digits={3} hint={tr("1,05 = 5 % par période", "1.05 = 5% per period")} onChange={(R) => set({ R })} />
              <SelectField label={tr("Périodes", "Periods")} value={req.steps} onChange={(steps) => set({ steps })} options={[1, 2, 3, 4, 5, 6].map((v) => ({ value: v, label: String(v) }))} />
            </div>
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })} options={[{ value: "put", label: "Put" }, { value: "call", label: "Call" }]} />
            <Check label={tr("Exercice américain", "American exercise")} checked={req.american} onChange={(american) => set({ american })} />
            <div className="form-sep" />
            <div className="form-group-title">Market maker</div>
            <NumberField label={tr("Prix de vente (ask)", "Selling price (ask)")} value={req.ask} min={0} digits={2} onChange={(ask) => set({ ask })} />
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>{tr("Chemin suivi", "Path followed")}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {path.split("").map((m, i) => (
                  <button key={i} type="button" className="btn" style={{ padding: "3px 10px" }}
                    onClick={() => set({ path: path.slice(0, i) + (m === "u" ? "d" : "u") + path.slice(i + 1) })}>
                    t{i + 1}{tr(" : ", ": ")}{m === "u" ? tr("hausse", "up") : tr("baisse", "down")}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          {tr(<>
            À chaque nœud, on cherche Δ actions et B en banque qui redonnent la valeur de l'option dans les deux états suivants :
            Δ = (V<sub>u</sub> − V<sub>d</sub>) / (S<sub>u</sub> − S<sub>d</sub>), B = (V<sub>u</sub> − Δ S<sub>u</sub>) / R. Le coût du portefeuille, Δ S + B, est le
            prix sans arbitrage. Il s'écrit aussi [π V<sub>u</sub> + (1 − π) V<sub>d</sub>] / R avec π = (R − d) / (u − d) : une probabilité
            dite risque-neutre, sous laquelle l'action rapporte exactement le taux sans risque. Elle existe si et seulement si d &lt; R &lt; u.
          </>, <>
            At each node we look for Δ shares and B in the bank that give back the option value in both next states:
            Δ = (V<sub>u</sub> − V<sub>d</sub>) / (S<sub>u</sub> − S<sub>d</sub>), B = (V<sub>u</sub> − Δ S<sub>u</sub>) / R. The cost of that portfolio, Δ S + B, is the
            arbitrage-free price. It can also be written [π V<sub>u</sub> + (1 − π) V<sub>d</sub>] / R with π = (R − d) / (u − d): a so-called
            risk-neutral probability, under which the stock earns exactly the risk-free rate. It exists if and only if d &lt; R &lt; u.
          </>)}
        </Explainer>
        <div className="grid cols-4">
          <Stat label={tr("Prix (réplication)", "Price (replication)")} value={num(data?.price, 3)} foot={data?.direct_value != null ? tr(`Σ chemins Q × payoff / Rᴺ = ${num(data.direct_value, 3)}`, `Σ paths Q × payoff / Rᴺ = ${num(data.direct_value, 3)}`) : tr("Américain : induction avec exercice", "American: backward induction with exercise")} busy={isFetching} />
          <Stat label={tr("Probabilité risque-neutre π", "Risk-neutral probability π")} value={num(data?.pi, 4)} foot={`E_Q[S₁/S₀] = ${num(data ? data.pi * req.u + (1 - data.pi) * req.d : null, 3)} = R`} busy={isFetching} />
          <Stat label={tr("Couverture initiale", "Initial hedge")} value={root ? `Δ = ${num(root.delta, 4)}` : "—"} foot={root ? tr(`B = ${num(root.bond, 3)} en banque`, `B = ${num(root.bond, 3)} in the bank`) : undefined} busy={isFetching} />
          <Stat label={tr("Marge du market maker", "Market maker's margin")} value={mm ? num(mm.spread_kept, 3) : "—"} foot={mm ? tr(`Couverture − passif à l'échéance : ${signedNum(mm.net, 6)}`, `Hedge − liability at expiry: ${signedNum(mm.net, 6)}`) : undefined} busy={isFetching} />
        </div>
        <Card title={tr("Arbre : valeur et couverture à chaque nœud (chemin suivi en orange)", "Tree: value and hedge at every node (path followed in orange)")}>
          {data ? <EChart option={treeOption} height={Math.max(320, req.steps * 110)} ariaLabel={tr("Arbre binomial avec les couvertures", "Binomial tree with the hedges")} /> : <Skeleton height={320} />}
        </Card>
        <Card title={tr("Autofinancement : la couverture posée au nœud parent vaut exactement l'option à chaque nœud enfant", "Self-financing: the hedge set at the parent node is worth exactly the option at each child node")} flush>
          {data ? (
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: "auto" }}>
              <table className="data">
                <thead><tr><th>t</th><th>{tr("Hausses", "Ups")}</th><th>S</th><th>V</th><th>Δ</th><th>B</th><th>{tr("Couverture du parent ici", "Parent's hedge here")}</th><th>{tr("Q(nœud)", "Q(node)")}</th><th>{tr("Chemins", "Paths")}</th></tr></thead>
                <tbody>
                  {data.nodes.map((n) => (
                    <tr key={`${n.step}-${n.ups}`}>
                      <td>{n.step}</td><td>{n.ups}</td><td>{num(n.spot, 2)}</td><td className="strong">{num(n.value, 4)}{n.exercised ? tr(" (exercé)", " (exercised)") : ""}</td>
                      <td>{n.delta != null ? num(n.delta, 4) : "—"}</td><td>{n.bond != null ? num(n.bond, 3) : "—"}</td>
                      <td>{n.parent_portfolio_value != null ? num(n.parent_portfolio_value, 4) : "—"}</td>
                      <td>{num(n.probability, 5)}</td><td>{n.path_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={200} /></div>}
        </Card>
        <Card title={tr(`Le market maker vend à ${num(req.ask, 2)} et couvre le long du chemin ${path.toUpperCase()}`, `The market maker sells at ${num(req.ask, 2)} and hedges along the path ${path.toUpperCase()}`)} flush>
          {mm ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>t</th><th>{tr("Mouvement", "Move")}</th><th>S</th><th>{tr("Δ avant → après", "Δ before → after")}</th><th>{tr("Actions échangées", "Shares traded")}</th><th>{tr("Flux du rebalancement", "Rebalancing cash flow")}</th><th>{tr("Cash avant → après", "Cash before → after")}</th><th>{tr("Valeur couverture", "Hedge value")}</th><th>{tr("Valeur option", "Option value")}</th></tr></thead>
                <tbody>
                  {mm.steps.map((s) => (
                    <tr key={s.step}>
                      <td>{s.step}</td><td>{s.move ? (s.move === "u" ? tr("hausse", "up") : tr("baisse", "down")) : tr("départ", "start")}</td><td>{num(s.spot, 2)}</td>
                      <td>{num(s.delta_before, 4)} → {num(s.delta_after, 4)}</td><td>{signedNum(s.shares_traded, 4)}</td>
                      <td>{signedNum(s.trade_cash, 3)}</td><td>{num(s.cash_before, 3)} → {num(s.cash_after, 3)}</td>
                      <td className="strong">{num(s.hedge_value, 3)}</td><td>{num(s.option_value, 3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={140} /></div>}
        </Card>
        <InfoBox>
          {tr("Au départ, le market maker encaisse l'ask, garde la marge (ask − prix) et place le reste dans la couverture. À chaque nœud, le rebalancement est entièrement financé par le compte en banque : on ne rajoute ni ne retire d'argent (autofinancement). À l'échéance, la couverture vaut exactement ce qu'il doit au client, quel que soit le chemin : seule la marge initiale reste.",
            "At the start, the market maker collects the ask, keeps the margin (ask − price) and puts the rest into the hedge. At each node the rebalancing is paid for entirely by the bank account: no money is added or withdrawn (self-financing). At expiry the hedge is worth exactly what is owed to the client, whatever the path: only the initial margin remains.")}
        </InfoBox>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- delta hedging

export function HedgingLab() {
  const [req, setReq] = useState<HedgeRequest>({ S0: 100, K: 100, T: 0.25, r: 0.03, q: 0, sigma_implied: 0.2, sigma_real: 0.2, mu: 0.08,
    n_rebalance: 52, n_paths: 10_000, option_type: "call", hedge_vol: "implied" });
  const set = (patch: Partial<HedgeRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 450);
  const { data, error, isFetching } = useQuery({ queryKey: ["hedge", debounced], queryFn: () => theoryApi.hedge(debounced), placeholderData: keepPreviousData });
  const bt = useQuery({ queryKey: ["hedge-bt"], queryFn: () => theoryApi.hedgeBacktest(21, "call"), retry: false });

  const histOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const h = data.pnl.histogram;
    const total = h.counts.reduce((a, b) => a + b, 0);
    return {
      grid: { top: 20 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 1) },
      xAxis: { type: "value", name: tr("P&L du vendeur couvert", "Hedged seller's P&L"), nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax", axisLabel: { formatter: (v: number) => num(v, 1) } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [{ type: "bar", barWidth: "95%", color: p.series[0], data: h.counts.map((c, i) => [(h.edges[i] + h.edges[i + 1]) / 2, c / total]),
        markLine: { symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: [{ xAxis: data.pnl.mean, name: tr("moyenne", "mean"), lineStyle: { color: p.series[1], width: 2 } },
            ...(req.sigma_real !== req.sigma_implied ? [{ xAxis: data.locked, name: "BS(σᵢ) − BS(σᵣ)", lineStyle: { color: p.critical, type: "dashed" } }] : [])] } }],
    };
  }, [data, req.sigma_real, req.sigma_implied]);

  const convOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "log", name: tr("rebalancements", "rebalancings"), nameLocation: "middle", nameGap: 26, min: 3 },
      yAxis: { type: "log", name: tr("écart-type du P&L", "P&L standard deviation") },
      series: [
        { type: "line", name: "Simulation", symbolSize: 8, color: p.series[0], lineStyle: { width: 2.5 }, data: data.convergence.map((c) => [c.n, c.sd]) },
        { type: "line", name: "√(π/4) · vega · σ / √N (Derman-Kamal)", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" },
          data: data.convergence.map((c) => [c.n, c.derman_kamal]) },
      ],
    };
  }, [data]);

  const mismatchOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const m = data.mismatch;
    const step = m.length > 1 ? m[1].sigma_real - m[0].sigma_real : 0.01;
    return {
      legend: { top: 0 },
      grid: { top: 70, right: 64, left: 56 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "value", name: tr("vol réalisée", "realised vol"), nameLocation: "middle", nameGap: 26, min: m[0].sigma_real - step / 2,
        max: m[m.length - 1].sigma_real + step / 2, axisLabel: { showMinLabel: false, showMaxLabel: false, formatter: (v: number) => pct(v, 0) } },
      yAxis: [{ type: "value", name: tr("P&L moyen", "Mean P&L"), nameTextStyle: { align: "left" } },
        { type: "value", name: tr("écart-type", "std. dev."), nameTextStyle: { align: "right" }, splitLine: { show: false }, min: 0 }],
      series: [
        { type: "bar", name: tr("Écart-type, couverture à σᵢ", "Std. dev., hedged at σᵢ"), yAxisIndex: 1, barWidth: 9, barGap: "20%", color: p.series[0],
          itemStyle: { opacity: 0.35 }, data: m.map((x) => [x.sigma_real, x.implied_hedge_sd]) },
        { type: "bar", name: tr("Écart-type, couverture à σᵣ", "Std. dev., hedged at σᵣ"), yAxisIndex: 1, barWidth: 9, color: p.series[2],
          itemStyle: { opacity: 0.35 }, data: m.map((x) => [x.sigma_real, x.realized_hedge_sd]) },
        { type: "line", name: tr("Moyenne, couverture à σᵢ", "Mean, hedged at σᵢ"), color: p.series[0], symbolSize: 9, lineStyle: { width: 3 }, z: 3,
          data: m.map((x) => [x.sigma_real, x.implied_hedge_mean]) },
        { type: "line", name: tr("Moyenne, couverture à σᵣ", "Mean, hedged at σᵣ"), color: p.series[2], symbol: "diamond", symbolSize: 7, lineStyle: { width: 1.5, type: "dashed" }, z: 4,
          data: m.map((x) => [x.sigma_real, x.realized_hedge_mean]) },
        { type: "line", name: "BS(σᵢ) − BS(σᵣ)", showSymbol: false, color: p.series[1], lineStyle: { width: 1.5, type: "dotted" }, z: 5,
          data: m.map((x) => [x.sigma_real, x.locked]),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dotted" },
            label: { color: p.muted, fontSize: 10, position: "end", formatter: "σᵣ = σᵢ" },
            data: [{ xAxis: req.sigma_implied }] } },
      ],
    };
  }, [data, req.sigma_implied]);

  const pathOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const x = data.path.spot.map((_, i) => i);
    return {
      legend: {},
      grid: { top: 34, right: 60 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "category", name: tr("rebalancement", "rebalancing"), nameLocation: "middle", nameGap: 26, data: x },
      yAxis: [{ type: "value", name: tr("P&L cumulé", "Cumulative P&L") }, { type: "value", name: "spot", scale: true, splitLine: { show: false } }],
      series: [
        { type: "line", name: tr("P&L réel de la position couverte", "Actual P&L of the hedged position"), showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: data.path.pnl },
        { type: "line", name: "Σ ½ Γ S² (σᵢ² dt − (dS/S)²)", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: data.path.gamma_theta },
        { type: "line", name: "Spot", yAxisIndex: 1, showSymbol: false, color: p.muted, lineStyle: { width: 1 }, data: data.path.spot },
      ],
    };
  }, [data]);

  const btOption = useCallback((p: ChartPalette) => {
    if (!bt.data) return {};
    const r = bt.data.rows;
    return {
      legend: {},
      grid: { top: 34, right: 60 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: r.map((x) => x.date), axisLabel: { hideOverlap: true } },
      yAxis: [{ type: "value", name: "P&L / spot", axisLabel: { formatter: (v: number) => pct(v, 1) } },
        { type: "value", name: "vol", splitLine: { show: false }, axisLabel: { formatter: (v: number) => pct(v, 0) } }],
      series: [
        { type: "bar", name: tr("P&L du call vendu et couvert", "P&L of the sold and hedged call"), tooltip: { valueFormatter: (v: number) => pct(v, 2) },
          data: r.map((x) => ({ value: x.pnl_pct, itemStyle: { color: x.pnl_pct >= 0 ? p.diverging[2] : p.diverging[0] } })) },
        { type: "line", name: tr("Vol implicite (VIX)", "Implied vol (VIX)"), yAxisIndex: 1, color: p.series[1], symbolSize: 5, tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: r.map((x) => x.implied) },
        { type: "line", name: tr("Vol réalisée sur le mois", "Realised vol over the month"), yAxisIndex: 1, color: p.series[0], symbolSize: 5, tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: r.map((x) => x.realized) },
      ],
    };
  }, [bt.data]);

  const s = bt.data?.summary;
  return (
    <div className="split">
      <div className="sticky">
        <Card title="Simulation">
          <div className="form">
            <div className="form-row">
              <NumberField label="Spot" value={req.S0} min={0.01} digits={2} onChange={(S0) => set({ S0 })} />
              <NumberField label="Strike" value={req.K} min={0.01} digits={2} onChange={(K) => set({ K })} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Maturité", "Maturity")} value={req.T} suffix={tr("jours", "days")} scale={365} min={5 / 365} max={3} digits={0} onChange={(T) => set({ T })} />
              <NumberField label={tr("Taux", "Rate")} value={req.r} suffix="%" scale={100} digits={2} onChange={(r) => set({ r })} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Vol implicite (prix)", "Implied vol (price)")} value={req.sigma_implied} suffix="%" scale={100} min={0.01} digits={1} onChange={(sigma_implied) => set({ sigma_implied })} />
              <NumberField label={tr("Vol réalisée", "Realised vol")} value={req.sigma_real} suffix="%" scale={100} min={0.01} digits={1} onChange={(sigma_real) => set({ sigma_real })} />
            </div>
            <NumberField label={tr("Drift réel μ (monde P)", "Real drift μ (P world)")} value={req.mu} suffix="%" scale={100} digits={1} hint={tr("N'entre pas dans le prix de l'option", "Does not enter the option price")} onChange={(mu) => set({ mu })} />
            <div className="form-row">
              <SelectField label={tr("Rebalancements", "Rebalancings")} value={req.n_rebalance} onChange={(n_rebalance) => set({ n_rebalance })}
                options={[4, 13, 26, 52, 126, 252].map((v) => ({ value: v, label: String(v) }))} />
              <SelectField label={tr("Trajectoires", "Paths")} value={req.n_paths} onChange={(n_paths) => set({ n_paths })}
                options={[5_000, 10_000, 20_000].map((v) => ({ value: v, label: num(v, 0) }))} />
            </div>
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })} options={[{ value: "call", label: tr("Call vendu", "Short call") }, { value: "put", label: tr("Put vendu", "Short put") }]} />
            <Segmented label={tr("Delta calculé avec", "Delta computed with")} value={req.hedge_vol} onChange={(hedge_vol) => set({ hedge_vol })}
              options={[{ value: "implied", label: tr("Vol implicite", "Implied vol") }, { value: "realized", label: tr("Vol réalisée", "Realised vol") }]} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          {tr("On vend l'option au prix de Black-Scholes et on la couvre en delta N fois jusqu'à l'échéance, sur des trajectoires simulées dans le monde réel (drift μ). C'est la version continue de l'arbre : quand N grandit, la couverture discrète tend vers une réplication parfaite parce que la variation quadratique du sous-jacent, (dS)² = σ²S² dt, devient déterministe.",
            "We sell the option at the Black-Scholes price and delta-hedge it N times until expiry, on paths simulated in the real world (drift μ). It is the continuous version of the tree: as N grows, the discrete hedge tends to a perfect replication because the quadratic variation of the underlying, (dS)² = σ²S² dt, becomes deterministic.")}
        </Explainer>
        <div className="grid cols-4">
          <Stat label={tr("Prime encaissée", "Premium collected")} value={num(data?.premium, 3)} foot={data ? `Vega ${num(data.vega, 2)}` : undefined} busy={isFetching} />
          <Stat label={tr("P&L moyen", "Mean P&L")} value={signedNum(data?.pnl.mean, 3)} foot={data ? tr(`Prévision gamma-theta ${signedNum(data.gamma_theta_mean, 3)}`, `Gamma-theta forecast ${signedNum(data.gamma_theta_mean, 3)}`) : undefined} busy={isFetching} />
          <Stat label={tr("Écart-type du P&L", "P&L std. dev.")} value={num(data?.pnl.sd, 3)} foot={data ? tr(`Derman-Kamal : ${num(data.derman_kamal, 3)}`, `Derman-Kamal: ${num(data.derman_kamal, 3)}`) : undefined} busy={isFetching} />
          <Stat label={tr("Intervalle 90 %", "90% interval")} value={data ? `${signedNum(data.pnl.p05, 2)} / ${signedNum(data.pnl.p95, 2)}` : "—"} foot={tr(`${req.n_rebalance} rebalancements`, `${req.n_rebalance} rebalancings`)} busy={isFetching} />
        </div>
        <div className="grid cols-2">
          <Card title={tr("Distribution du P&L de la position couverte", "P&L distribution of the hedged position")}>
            {data ? <EChart option={histOption} height={300} ariaLabel={tr("Distribution du P&L de couverture", "Hedging P&L distribution")} /> : <Skeleton height={260} />}
          </Card>
          <Card title={tr("Erreur de couverture : décroissance en 1/√N", "Hedging error: decay in 1/√N")}>
            {data ? <EChart option={convOption} height={300} ariaLabel={tr("Écart-type du P&L selon le nombre de rebalancements", "P&L standard deviation by number of rebalancings")} /> : <Skeleton height={260} />}
          </Card>
        </div>
        <Card title={tr("Une trajectoire : le P&L s'explique par gamma et theta", "One path: the P&L is explained by gamma and theta")}>
          {data ? <EChart option={pathOption} height={320} ariaLabel={tr("P&L cumulé d'une trajectoire et approximation gamma-theta", "Cumulative P&L of one path and gamma-theta approximation")} /> : <Skeleton height={280} />}
        </Card>
        <div className="grid cols-2">
          <Card title={tr("Le drift réel ne change pas le P&L moyen", "The real drift does not change the mean P&L")}>
            {data ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{tr("μ (monde réel)", "μ (real world)")}</th>{data.drift.map((x) => <th key={x.mu}>{pct(x.mu, 0)}</th>)}</tr></thead>
                  <tbody><tr><td className="strong">{tr("P&L moyen", "Mean P&L")}</td>{data.drift.map((x) => <td key={x.mu}>{signedNum(x.mean, 3)}</td>)}</tr></tbody>
                </table>
              </div>
            ) : <Skeleton height={80} />}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr("Le prix est le coût de la réplication : il ne dépend pas de μ. C'est la probabilité risque-neutre de la Lecture 2, en continu (Girsanov change le drift, pas la vol). Les petits écarts (moins de 1 % de la prime, 52 rebalancements) viennent de la discrétisation et disparaissent quand N augmente.",
                "The price is the cost of replication: it does not depend on μ. This is the risk-neutral measure of the binomial tree, in continuous time (Girsanov changes the drift, not the vol). The small gaps (under 1% of the premium, 52 rebalancings) come from discretisation and vanish as N grows.")}
            </p>
          </Card>
          <Card title={tr("Vol réalisée ≠ vol implicite", "Realised vol ≠ implied vol")}>
            {data ? <EChart option={mismatchOption} height={340} ariaLabel={tr("P&L moyen et écart-type selon la vol réalisée", "Mean P&L and std. dev. by realised vol")} /> : <Skeleton height={300} />}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr("Les deux couvertures ont le même P&L moyen, BS(σᵢ) − BS(σᵣ) : les courbes se superposent. Ce qui les distingue, c'est la dispersion (barres) : couvert à la vol réalisée, le résultat est presque verrouillé ; couvert à la vol implicite, il dépend du chemin.",
                "Both hedges have the same mean P&L, BS(σᵢ) − BS(σᵣ): the curves overlap. What sets them apart is the dispersion (bars): hedged at the realised vol, the result is almost locked in; hedged at the implied vol, it depends on the path.")}
            </p>
          </Card>
        </div>
        <InfoBox>
          {tr("Sur un pas, la position vendue et couverte gagne ½ Γ S² (σᵢ² dt − (dS/S)²) : le theta encaissé contre les pertes de gamma. Si la vol réalisée est sous la vol implicite, le vendeur gagne en moyenne. Couvert à la vol implicite, son P&L dépend du chemin (le gamma est fort près du strike) ; couvert à la vol réalisée, il verrouille BS(σᵢ) − BS(σᵣ), avec moins de dispersion.",
            "Over one step the short hedged position earns ½ Γ S² (σᵢ² dt − (dS/S)²): theta collected against gamma losses. If the realised vol is below the implied vol, the seller wins on average. Hedged at the implied vol, the P&L depends on the path (gamma is large near the strike); hedged at the realised vol, it locks in BS(σᵢ) − BS(σᵣ), with less dispersion.")}
        </InfoBox>
        <Card title={tr("Sur données réelles : vendre chaque mois un call SPY à 1 mois au VIX et le couvrir chaque jour", "On real data: sell a 1-month SPY call at the VIX every month and hedge it daily")}>
          {bt.error ? <ErrorBox error={bt.error} /> : bt.data && s ? (
            <>
              <div className="grid cols-4" style={{ marginBottom: 12 }}>
                <Stat label={tr("P&L moyen / mois", "Mean P&L / month")} value={pct(s.mean_pnl_pct, 2)} foot={tr("En % du spot", "As % of spot")} />
                <Stat label={tr("Mois gagnants", "Winning months")} value={pct(s.hit_rate, 0)} foot={tr(`${s.n} mois`, `${s.n} months`)} />
                <Stat label={tr("Pire / meilleur mois", "Worst / best month")} value={`${pct(s.worst_pct, 2)} / ${pct(s.best_pct, 2)}`} />
                <Stat label={tr("Corrélation avec gamma-theta", "Correlation with gamma-theta")} value={num(s.corr_gamma_theta, 3)} foot={tr(`VIX moyen ${pct(s.mean_implied, 1)} · réalisée ${pct(s.mean_realized, 1)}`, `Mean VIX ${pct(s.mean_implied, 1)} · realised ${pct(s.mean_realized, 1)}`)} />
              </div>
              <EChart option={btOption} height={340} ariaLabel={tr("P&L mensuel du call vendu et couvert, vol implicite et réalisée", "Monthly P&L of the sold and hedged call, implied and realised vol")} />
            </>
          ) : <Skeleton height={300} />}
        </Card>
        <InfoBox>
          {tr("Chaque mois, le P&L de la position couverte suit presque exactement ½ Σ Γ S² (σᵢ² dt − r²) : il gagne quand la vol réalisée reste sous le VIX, ce qui arrive la plupart du temps (prime de risque de variance), et perd lors des mois agités. C'est le même pari que la vente d'un swap de variance, mais pondéré par le gamma, donc concentré autour du strike.",
            "Each month the P&L of the hedged position tracks ½ Σ Γ S² (σᵢ² dt − r²) almost exactly: it wins when the realised vol stays below the VIX, which happens most of the time (the variance risk premium), and loses in turbulent months. It is the same bet as selling a variance swap, but weighted by gamma, hence concentrated around the strike.")}
        </InfoBox>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- stochastic calculus

export function StochasticLab() {
  const { data, error } = useQuery({ queryKey: ["brownian"], queryFn: stochasticApi.brownian });

  const pathsOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const t = data.paths.t;
    return {
      grid: { top: 20 },
      tooltip: { show: false },
      xAxis: { type: "value", name: "t", nameLocation: "middle", nameGap: 26, min: 0, max: 1 },
      yAxis: { type: "value" },
      series: [
        ...data.paths.paths.map((path) => ({ type: "line", showSymbol: false, silent: true, color: p.series[0],
          lineStyle: { width: 0.8, opacity: 0.45 }, data: path.map((v, i) => [t[i], v]) })),
        { type: "line", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: t.map((x, i) => [x, data.paths.band[i]]) },
        { type: "line", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: t.map((x, i) => [x, -data.paths.band[i]]) },
      ],
    };
  }, [data]);

  const variationOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const v = data.variations;
    return {
      legend: {},
      grid: { top: 34, right: 60 },
      tooltip: { trigger: "axis", valueFormatter: (x: number) => num(x, 3) },
      xAxis: { type: "log", name: tr("nombre de pas N", "number of steps N"), nameLocation: "middle", nameGap: 26, min: 2 },
      yAxis: [{ type: "log", name: "Σ |ΔB|" }, { type: "value", name: "Σ (ΔB)²", min: 0, max: 2, splitLine: { show: false } }],
      series: [
        { type: "line", name: tr("Variation totale (simulée)", "Total variation (simulated)"), color: p.series[0], symbolSize: 7, data: v.map((x) => [x.n, x.total_variation]) },
        { type: "line", name: "√(2N/π)", color: p.series[0], showSymbol: false, lineStyle: { type: "dashed" }, data: v.map((x) => [x.n, x.total_variation_theory]) },
        { type: "line", name: tr("Variation quadratique ± 1 écart-type", "Quadratic variation ± 1 std. dev."), yAxisIndex: 1, color: p.series[1], symbolSize: 7, data: v.map((x) => [x.n, x.quadratic_variation]) },
        { type: "line", yAxisIndex: 1, color: p.series[1], showSymbol: false, lineStyle: { width: 1, type: "dotted" }, data: v.map((x) => [x.n, x.quadratic_variation + x.quadratic_variation_sd]) },
        { type: "line", yAxisIndex: 1, color: p.series[1], showSymbol: false, lineStyle: { width: 1, type: "dotted" }, data: v.map((x) => [x.n, x.quadratic_variation - x.quadratic_variation_sd]) },
      ],
    };
  }, [data]);

  const itoOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const h = data.ito.histogram;
    const mid = h.left.map((_, i) => (h.edges[i] + h.edges[i + 1]) / 2);
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "value", min: "dataMin", max: "dataMax", axisLabel: { formatter: (v: number) => num(v, 1) } },
      yAxis: { type: "value" },
      series: [
        { type: "bar", name: tr("Somme au point gauche (Itô)", "Left-point sum (Itô)"), color: p.series[0], barGap: "-100%", itemStyle: { opacity: 0.6 }, data: mid.map((m, i) => [m, h.left[i]]),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.series[0] }, label: { formatter: "E = 0", color: p.muted }, data: [{ xAxis: data.ito.mean_left }] } },
        { type: "bar", name: tr("Somme au point droit", "Right-point sum"), color: p.series[1], itemStyle: { opacity: 0.6 }, data: mid.map((m, i) => [m, h.right[i]]),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.series[1] }, label: { formatter: "E = T", color: p.muted }, data: [{ xAxis: data.ito.mean_right }] } },
      ],
    };
  }, [data]);

  const exampleOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const e = data.ito.example;
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "category", data: e.t.map((x) => num(x, 2)), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value" },
      series: [
        { type: "line", name: "B_t", showSymbol: false, color: p.muted, lineStyle: { width: 1 }, data: e.B },
        { type: "line", name: "Σ B_{tᵢ} ΔB (Itô)", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: e.left_running },
        { type: "line", name: "½ B_t² − ½ t", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: e.ito_running },
      ],
    };
  }, [data]);

  const martOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const m = data.martingales;
    return {
      legend: { type: "scroll" },
      grid: { top: 40 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "category", data: m.t.map((x) => num(x, 1)), name: "t", nameLocation: "middle", nameGap: 26 },
      yAxis: { type: "value" },
      series: Object.entries(m.series).map(([name, s], i) => ({ type: "line", name: `E[${name}]${s.martingale ? " (martingale)" : ""}`, showSymbol: false,
        color: p.series[i % p.series.length], lineStyle: { width: s.martingale ? 2.5 : 1.5, type: s.martingale ? "solid" : "dashed" }, data: s.mean })),
    };
  }, [data]);

  const last = data?.variations[data.variations.length - 1];
  return (
    <div className="grid">
      <ErrorBox error={error} />
      <Explainer>
        {tr("Les exercices de la Lecture 3, vérifiés sur des milliers de trajectoires simulées : un mouvement brownien n'a pas de longueur finie mais sa variation quadratique est déterministe, (dB)² = dt. C'est ce qui oblige à choisir un point d'évaluation dans l'intégrale stochastique et qui crée le terme ½ σ² f'' du lemme d'Itô.",
          "Classic stochastic-calculus facts, checked on thousands of simulated paths: a Brownian motion has no finite length but its quadratic variation is deterministic, (dB)² = dt. This is what forces a choice of evaluation point in the stochastic integral and what creates the ½ σ² f'' term of Itô's lemma.")}
      </Explainer>
      <div className="grid cols-4">
        <Stat label={tr("Variation totale (N = 4 096)", "Total variation (N = 4,096)")} value={last ? num(last.total_variation, 1) : "—"} foot={last ? `√(2N/π) = ${num(last.total_variation_theory, 1)} → ∞` : undefined} />
        <Stat label={tr("Variation quadratique", "Quadratic variation")} value={last ? num(last.quadratic_variation, 4) : "—"} foot={last ? tr(`écart-type ${num(last.quadratic_variation_sd, 4)} (théorie √(2/N) = ${num(last.quadratic_variation_sd_theory, 4)})`, `std. dev. ${num(last.quadratic_variation_sd, 4)} (theory √(2/N) = ${num(last.quadratic_variation_sd_theory, 4)})`) : undefined} />
        <Stat label={tr("E[Σ B ΔB] point gauche", "E[Σ B ΔB] left point")} value={data ? num(data.ito.mean_left, 3) : "—"} foot={tr("Théorie : 0 (l'intégrale d'Itô est une martingale)", "Theory: 0 (the Itô integral is a martingale)")} />
        <Stat label={tr("E[Σ B ΔB] point droit", "E[Σ B ΔB] right point")} value={data ? num(data.ito.mean_right, 3) : "—"} foot={data ? tr(`Théorie : T = ${num(data.ito.T, 0)}`, `Theory: T = ${num(data.ito.T, 0)}`) : undefined} />
      </div>
      <div className="grid cols-2">
        <Card title={tr("Trajectoires browniennes et bande ±1,96 √t", "Brownian paths and the ±1.96 √t band")}>
          {data ? <EChart option={pathsOption} height={320} ariaLabel={tr("Trajectoires browniennes", "Brownian paths")} /> : <Skeleton height={280} />}
        </Card>
        <Card title={tr("Variation totale contre variation quadratique", "Total variation against quadratic variation")}>
          {data ? <EChart option={variationOption} height={320} ariaLabel={tr("Variations totale et quadratique selon le nombre de pas", "Total and quadratic variation by number of steps")} /> : <Skeleton height={280} />}
        </Card>
      </div>
      <div className="grid cols-2">
        <Card title={tr("∫ B dB : le point d'évaluation change le résultat", "∫ B dB: the evaluation point changes the result")}>
          {data ? <EChart option={itoOption} height={300} ariaLabel={tr("Distribution des sommes à gauche et à droite", "Distribution of the left and right sums")} /> : <Skeleton height={260} />}
        </Card>
        <Card title={tr("Une trajectoire : la somme d'Itô suit ½ B_t² − ½ t", "One path: the Itô sum tracks ½ B_t² − ½ t")}>
          {data ? <EChart option={exampleOption} height={300} ariaLabel={tr("Somme d'Itô le long d'une trajectoire", "Itô sum along one path")} /> : <Skeleton height={260} />}
        </Card>
      </div>
      <InfoBox>
        {tr(<>
          R<sub>N</sub> − L<sub>N</sub> = Σ (ΔB)² → T : évaluer l'intégrande à droite ajoute exactement la variation quadratique. La convention d'Itô
          (à gauche : on choisit sa position avant de voir le choc) donne une martingale, et le lemme d'Itô retrouve d(B²) = 2B dB + dt.
        </>, <>
          R<sub>N</sub> − L<sub>N</sub> = Σ (ΔB)² → T: evaluating the integrand on the right adds exactly the quadratic variation. The Itô convention
          (on the left: the position is chosen before the shock is seen) gives a martingale, and Itô's lemma recovers d(B²) = 2B dB + dt.
        </>)}
      </InfoBox>
      <Card title={tr(`Martingales et non-martingales (λ = ${data ? num(data.martingales.lambda, 1) : "…"})`, `Martingales and non-martingales (λ = ${data ? num(data.martingales.lambda, 1) : "…"})`)}>
        {data ? <EChart option={martOption} height={340} ariaLabel={tr("Espérances de martingales et de processus qui n'en sont pas", "Expectations of martingales and of processes that are not")} /> : <Skeleton height={300} />}
      </Card>
      <InfoBox>
        {tr(<>
          B<sub>t</sub>, B<sub>t</sub>² − t et e^(λB<sub>t</sub> − λ²t/2) gardent une espérance constante (exercice 6 du cours). Sans leur terme
          correctif, B<sub>t</sub>² et e^(λB<sub>t</sub>) dérivent : E[B<sub>t</sub>²] = t et E[e^(λB<sub>t</sub>)] = e^(λ²t/2), la transformée de Laplace
          de l'exercice 3. C'est la même correction qui rend e^(−σ²t/2 + σB<sub>t</sub>) martingale dans le prix actualisé de Black-Scholes.
        </>, <>
          B<sub>t</sub>, B<sub>t</sub>² − t and e^(λB<sub>t</sub> − λ²t/2) keep a constant expectation. Without their correction
          term, B<sub>t</sub>² and e^(λB<sub>t</sub>) drift: E[B<sub>t</sub>²] = t and E[e^(λB<sub>t</sub>)] = e^(λ²t/2), the Laplace transform
          of the normal law. The same correction makes e^(−σ²t/2 + σB<sub>t</sub>) a martingale in the discounted Black-Scholes price.
        </>)}
      </InfoBox>
    </div>
  );
}

// ----------------------------------------------------------------------------- Girsanov and importance sampling

export function GirsanovLab() {
  const [theta, setTheta] = useState(1.0);
  const [T, setT] = useState(1.0);
  const [req, setReq] = useState<ImportanceRequest>({ S0: 100, K: 150, T: 0.5, r: 0.03, q: 0, vol: 0.2, product: "call", n_paths: 20_000 });
  const set = (patch: Partial<ImportanceRequest>) => setReq((r) => ({ ...r, ...patch }));
  const g = useQuery({ queryKey: ["girsanov", theta, T], queryFn: () => stochasticApi.girsanov(theta, T), placeholderData: keepPreviousData });
  const debounced = useDebounced(req, 400);
  const imp = useQuery({ queryKey: ["importance", debounced], queryFn: () => stochasticApi.importance(debounced), placeholderData: keepPreviousData });
  const d = imp.data;

  const densityOption = useCallback((p: ChartPalette) => {
    if (!g.data) return {};
    const x = g.data;
    return {
      legend: {},
      grid: { top: 34, right: 60 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "value", name: "B_T", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax" },
      yAxis: [{ type: "value", name: tr("densité", "density") }, { type: "value", name: tr("poids Y", "weight Y"), splitLine: { show: false } }],
      series: [
        { type: "line", name: tr("Densité sous P : N(0, T)", "Density under P: N(0, T)"), showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 },
          data: x.b.map((b, i) => [b, x.density_P[i]]) },
        { type: "line", name: tr("Densité sous Q : N(θT, T)", "Density under Q: N(θT, T)"), showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 },
          data: x.b.map((b, i) => [b, x.density_Q[i]]) },
        { type: "line", name: "Y = dQ/dP = exp(θB_T − θ²T/2)", yAxisIndex: 1, showSymbol: false, color: p.muted, lineStyle: { width: 1.5, type: "dashed" },
          data: x.b.map((b, i) => [b, Math.min(x.weight[i], 20)]) },
      ],
    };
  }, [g.data]);

  const thetaOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    return {
      grid: { top: 20 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 6) },
      xAxis: { type: "value", name: tr("décalage θ", "shift θ"), nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax",
        axisLabel: { formatter: (v: number) => num(v, 1) } },
      yAxis: { type: "log", name: tr("erreur standard", "standard error") },
      series: [{ type: "line", name: tr("Erreur standard", "Standard error"), symbolSize: 6, color: p.series[0], lineStyle: { width: 2 }, data: d.theta_grid.map((x) => [x.theta, Math.max(x.se, 1e-12)]),
        markLine: { symbol: "none", silent: true, lineStyle: { color: p.series[1], type: "dashed" }, label: { formatter: tr("θ* (médiane au strike)", "θ* (median at the strike)"), color: p.muted },
          data: [{ xAxis: d.theta_star }] } }],
    };
  }, [d]);

  const convOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const band = (key: "plain" | "importance", seKey: "plain_se" | "importance_se", sign: number) => d.convergence.map((c) => [c.n, c[key] + sign * 1.96 * c[seKey]]);
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
      xAxis: { type: "log", name: tr("trajectoires", "paths"), nameLocation: "middle", nameGap: 26, min: 800 },
      yAxis: { type: "value", scale: true },
      series: [
        { type: "line", name: tr("Monte Carlo simple", "Plain Monte Carlo"), color: p.series[1], symbolSize: 6, data: d.convergence.map((c) => [c.n, c.plain]) },
        { type: "line", color: p.series[1], showSymbol: false, lineStyle: { type: "dotted", width: 1 }, data: band("plain", "plain_se", 1) },
        { type: "line", color: p.series[1], showSymbol: false, lineStyle: { type: "dotted", width: 1 }, data: band("plain", "plain_se", -1) },
        { type: "line", name: tr("Échantillonnage préférentiel", "Importance sampling"), color: p.series[0], symbolSize: 6, lineStyle: { width: 2 }, data: d.convergence.map((c) => [c.n, c.importance]) },
        { type: "line", name: tr("Prix exact", "Exact price"), color: p.muted, showSymbol: false, lineStyle: { type: "dashed" }, data: d.convergence.map((c) => [c.n, d.exact]) },
      ],
    };
  }, [d]);

  return (
    <div className="grid">
      <ErrorBox error={g.error ?? imp.error} />
      <Explainer>
        {tr(<>
          Radon-Nikodym et Girsanov : multiplier par Y = exp(θB<sub>T</sub> − θ²T/2) définit une nouvelle probabilité Q, sous laquelle
          B<sub>T</sub> suit N(θT, T) et B<sub>t</sub> − θt est un mouvement brownien. Les trajectoires possibles sont les mêmes, seuls leurs poids
          changent : la dérive bouge, pas la volatilité.
        </>, <>
          Radon-Nikodym and Girsanov: multiplying by Y = exp(θB<sub>T</sub> − θ²T/2) defines a new probability Q, under which
          B<sub>T</sub> follows N(θT, T) and B<sub>t</sub> − θt is a Brownian motion. The possible paths are the same, only their weights
          change: the drift moves, not the volatility.
        </>)}
      </Explainer>
      <Card title={tr("Changement de mesure", "Change of measure")}>
        <div className="toolbar-grid" style={{ marginBottom: 12 }}>
          <NumberField label={tr("θ (dérive sous Q)", "θ (drift under Q)")} value={theta} min={-3} max={3} digits={2} onChange={setTheta} />
          <NumberField label="T" value={T} min={0.1} max={5} digits={2} onChange={setT} />
          <Stat label="E_P[Y]" value={g.data ? num(g.data.mean_weight, 4) : "—"} foot={g.data ? tr(`± ${num(g.data.mean_weight_se, 4)} : Y est une densité`, `± ${num(g.data.mean_weight_se, 4)}: Y is a density`) : undefined} />
          <Stat label="E_P[Y B_T] = E_Q[B_T]" value={g.data ? num(g.data.q_mean_by_weighting, 3) : "—"} foot={g.data ? tr(`théorie θT = ${num(g.data.q_mean_theory, 3)}`, `theory θT = ${num(g.data.q_mean_theory, 3)}`) : undefined} />
        </div>
        {g.data ? <EChart option={densityOption} height={320} ariaLabel={tr("Densités de B_T sous P et sous Q", "Densities of B_T under P and under Q")} /> : <Skeleton height={280} />}
      </Card>
      <Card title={tr("Application : échantillonnage préférentiel dans le Monte Carlo", "Application: importance sampling in Monte Carlo")}>
        <Explainer>
          {tr(<>
            Pour une option très hors de la monnaie, presque toutes les trajectoires finissent à zéro et l'estimateur est très bruité. On
            simule donc sous Q, avec une dérive θ qui amène la médiane de S<sub>T</sub> au strike, et on corrige chaque trajectoire par
            dP/dQ = exp(−θW<sub>T</sub> + θ²T/2) : E<sub>P</sub>[payoff] = E<sub>Q</sub>[payoff · dP/dQ]. Le prix reste sans biais, la variance s'effondre.
            L'option est disponible dans les pricers Monte Carlo de la plateforme (vanilles et exotiques).
          </>, <>
            For a far out-of-the-money option almost every path ends at zero and the estimator is very noisy. So we
            simulate under Q, with a drift θ that brings the median of S<sub>T</sub> to the strike, and correct each path by
            dP/dQ = exp(−θW<sub>T</sub> + θ²T/2): E<sub>P</sub>[payoff] = E<sub>Q</sub>[payoff · dP/dQ]. The price stays unbiased and the variance collapses.
            The option is available in the platform's Monte Carlo pricers (vanillas and exotics).
          </>)}
        </Explainer>
        <div className="toolbar-grid" style={{ margin: "12px 0" }}>
          <SelectField label={tr("Produit", "Product")} value={req.product} onChange={(product) => set({ product, K: product === "put" ? 65 : product === "digital" ? 140 : 150 })}
            options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }, { value: "digital", label: tr("Digitale (cash)", "Digital (cash)") }]} />
          <NumberField label="Strike" value={req.K} min={1} digits={1} onChange={(K) => set({ K })} />
          <NumberField label={tr("Maturité", "Maturity")} value={req.T} suffix={tr("ans", "years")} min={0.02} max={5} digits={2} onChange={(T) => set({ T })} />
          <NumberField label="Vol" value={req.vol} suffix="%" scale={100} min={0.01} digits={1} onChange={(vol) => set({ vol })} />
          <SelectField label={tr("Trajectoires", "Paths")} value={req.n_paths} onChange={(n_paths) => set({ n_paths })}
            options={[5_000, 20_000, 50_000].map((v) => ({ value: v, label: num(v, 0) }))} />
        </div>
        <div className="grid cols-4">
          <Stat label={tr("Prix exact", "Exact price")} value={num(d?.exact, 6)} foot={d ? tr(`Proba de finir dans la monnaie ${pct(d.itm_probability, 2)}`, `Probability of ending in the money ${pct(d.itm_probability, 2)}`) : undefined} busy={imp.isFetching} />
          <Stat label={tr("Monte Carlo simple", "Plain Monte Carlo")} value={d ? num(d.plain.price, 6) : "—"} foot={d ? `± ${num(1.96 * d.plain.se, 6)}` : undefined} busy={imp.isFetching} />
          <Stat label={tr("Échantillonnage préférentiel", "Importance sampling")} value={d ? num(d.importance.price, 6) : "—"} foot={d ? `± ${num(1.96 * d.importance.se, 6)} (θ* = ${num(d.theta_star, 2)})` : undefined} busy={imp.isFetching} />
          <Stat label={tr("Variance divisée par", "Variance divided by")} value={d?.variance_reduction != null ? num(d.variance_reduction, 0) : "—"} foot={tr("À nombre de trajectoires égal", "For the same number of paths")} busy={imp.isFetching} />
        </div>
      </Card>
      <div className="grid cols-2">
        <Card title={tr("Erreur standard selon le décalage θ", "Standard error by shift θ")}>
          {d ? <EChart option={thetaOption} height={300} ariaLabel={tr("Erreur standard selon le décalage de Girsanov", "Standard error by Girsanov shift")} /> : <Skeleton height={260} />}
        </Card>
        <Card title={tr("Convergence : intervalle de confiance à 95 %", "Convergence: 95% confidence interval")}>
          {d ? <EChart option={convOption} height={300} ariaLabel={tr("Convergence du Monte Carlo simple et préférentiel", "Convergence of plain and importance-sampled Monte Carlo")} /> : <Skeleton height={260} />}
        </Card>
      </div>
      <InfoBox>
        {tr(<>
          Le décalage optimal est proche de θ*, qui place la médiane de S<sub>T</sub> au strike ; trop décaler dégrade à nouveau l'estimateur,
          car quelques poids deviennent énormes. À la monnaie, il n'y a presque rien à gagner. C'est la même mécanique que le passage de la
          probabilité réelle à la probabilité risque-neutre : Girsanov change les poids des trajectoires, pas les trajectoires.
        </>, <>
          The optimal shift is close to θ*, which puts the median of S<sub>T</sub> at the strike; shifting too far degrades the estimator again,
          because a few weights become huge. At the money there is almost nothing to gain. It is the same mechanism as the move from the
          real-world to the risk-neutral probability: Girsanov changes the weights of the paths, not the paths.
        </>)}
      </InfoBox>
    </div>
  );
}

// ----------------------------------------------------------------------------- real world P vs risk-neutral Q

const horizons = () => [{ value: 30, label: tr("1 mois", "1 month") }, { value: 91, label: tr("3 mois", "3 months") }, { value: 182, label: tr("6 mois", "6 months") }, { value: 365, label: tr("1 an", "1 year") }];
type MuSource = "capm" | "history" | "custom";

export function MeasuresLab() {
  const { ticker } = useTicker();
  const [days, setDays] = useState(91);
  const [source, setSource] = useState<MuSource>("capm");
  const [mu, setMu] = useState(0.08);
  const debouncedMu = useDebounced(mu, 400);
  const { data: d, error, isFetching } = useQuery({
    queryKey: ["measures", ticker, days, source, debouncedMu],
    queryFn: () => measuresApi.get(ticker, days, source, debouncedMu), placeholderData: keepPreviousData, retry: false,
  });
  const fit = d && d.ticker === ticker;

  const densityOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const k = d.density.K;
    const lo = d.stats.Q_smile.quantiles["0.05"] * 0.75, hi = d.stats.P.quantiles["0.95"] * 1.15;
    const inRange = (i: number) => k[i] >= lo && k[i] <= hi;
    const line = (arr: number[]) => k.map((x, i) => [x, arr[i]]).filter((_, i) => inRange(i));
    const series: object[] = [
      { type: "line", name: tr("P : lognormale, dérive μ", "P: lognormal, drift μ"), showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: line(d.density.P),
        markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dotted" }, label: { color: p.muted, fontSize: 10, position: "end" },
          data: [{ xAxis: d.S0, label: { formatter: "S₀" } }] } },
      { type: "line", name: tr("Q : lognormale, dérive r", "Q: lognormal, drift r"), showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: line(d.density.Q) },
      { type: "line", name: tr("Q du marché : smile SVI (Breeden-Litzenberger)", "Market Q: SVI smile (Breeden-Litzenberger)"), showSymbol: false, color: p.series[2], lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.12 }, data: line(d.density.Q_smile) },
    ];
    if (d.empirical_hist) {
      const e = d.empirical_hist;
      series.push({ type: "bar", name: tr("P empirique (historique)", "Empirical P (history)"), color: p.muted, itemStyle: { opacity: 0.35 }, barWidth: "90%", barGap: "-100%",
        data: e.density.map((v, i) => [(e.edges[i] + e.edges[i + 1]) / 2, v]).filter((x) => x[0] >= lo && x[0] <= hi) });
    }
    return {
      legend: { top: 0 },
      grid: { top: 60, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
      xAxis: { type: "value", name: "S_T", nameLocation: "middle", nameGap: 26, min: lo, max: hi, axisLabel: { showMinLabel: false, showMaxLabel: false, formatter: (v: number) => num(v, 0) } },
      yAxis: { type: "value", name: tr("densité", "density"), axisLabel: { formatter: (v: number) => num(v, 3) } },
      series,
    };
  }, [d]);

  const fanOption = useCallback((p: ChartPalette) => {
    if (!d?.fan) return {};
    const rows = d.fan.rows;
    const x = rows.map((r) => Math.round(r.T * 365));
    const mk = (key: "P" | "Q" | "Q_smile", idx: number, name: string | undefined, color: string, type: string, width: number) => ({
      type: "line", name, showSymbol: false, color, lineStyle: { width, type }, data: rows.map((r, i) => [x[i], r[key][idx]]),
    });
    return {
      legend: { top: 0 },
      grid: { top: 40, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 2) },
      xAxis: { type: "value", name: tr("jours", "days"), nameLocation: "middle", nameGap: 26, min: 0, max: x[x.length - 1] },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => num(v, 0) } },
      series: [
        mk("P", 2, tr("P : médiane", "P: median"), p.series[0], "solid", 2.5), mk("P", 0, tr("P : quantiles 5 % et 95 %", "P: 5% and 95% quantiles"), p.series[0], "dotted", 1.2), mk("P", 4, undefined, p.series[0], "dotted", 1.2),
        mk("Q", 2, tr("Q lognormale : médiane", "Lognormal Q: median"), p.series[1], "dashed", 2), mk("Q", 0, undefined, p.series[1], "dotted", 1), mk("Q", 4, undefined, p.series[1], "dotted", 1),
        mk("Q_smile", 2, tr("Q du marché : médiane", "Market Q: median"), p.series[2], "solid", 2), mk("Q_smile", 0, tr("Q du marché : quantiles 5 % et 95 %", "Market Q: 5% and 95% quantiles"), p.series[2], "dashed", 1.2),
        mk("Q_smile", 4, undefined, p.series[2], "dashed", 1.2),
      ],
    };
  }, [d]);

  const kernelOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const k = d.kernel;
    return {
      legend: { top: 0 },
      grid: { top: 40, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "value", name: "S_T", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax", axisLabel: { showMinLabel: false, showMaxLabel: false, formatter: (v: number) => num(v, 0) } },
      yAxis: { type: "log", name: "q / p", axisLabel: { formatter: (v: number) => num(v, v < 1 ? 2 : 0) } },
      series: [
        { type: "line", name: tr("Smile du marché / P", "Market smile / P"), showSymbol: false, color: p.series[2], lineStyle: { width: 2.5 },
          data: k.K.map((x, i) => [x, Math.max(k.smile[i], 1e-3)]) },
        { type: "line", name: tr("Lognormale Q / P (Girsanov)", "Lognormal Q / P (Girsanov)"), showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" },
          data: k.K.map((x, i) => [x, k.lognormal[i]]),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dotted" }, label: { show: false }, data: [{ yAxis: 1 }] } },
      ],
    };
  }, [d]);

  const cols: { key: keyof MeasuresResponseStats; label: string }[] = [
    { key: "P", label: tr("P (lognormale)", "P (lognormal)") }, { key: "Q", label: tr("Q (lognormale)", "Q (lognormal)") }, { key: "Q_smile", label: tr("Q du marché (smile)", "Market Q (smile)") },
    ...(d?.stats.P_empirical ? [{ key: "P_empirical" as const, label: tr("P empirique", "Empirical P") }] : []),
  ];
  const rows: { label: string; get: (s: MeasureStats) => string }[] = [
    { label: tr("Moyenne", "Mean"), get: (s) => num(s.mean, 2) },
    { label: tr("Médiane", "Median"), get: (s) => num(s.median, 2) },
    { label: "Mode", get: (s) => (s.mode == null ? "—" : num(s.mode, 2)) },
    { label: tr("Quantile 5 %", "5% quantile"), get: (s) => num(s.quantiles["0.05"], 2) },
    { label: tr("Quantile 95 %", "95% quantile"), get: (s) => num(s.quantiles["0.95"], 2) },
    { label: "P(S_T < S₀)", get: (s) => pct(s.prob_below["1.00"], 1) },
    { label: tr("P(S_T < 90 % S₀)", "P(S_T < 90% S₀)"), get: (s) => pct(s.prob_below["0.90"], 1) },
    { label: tr("P(S_T < 80 % S₀)", "P(S_T < 80% S₀)"), get: (s) => pct(s.prob_below["0.80"], 1) },
  ];
  const sourceFoot = d ? {
    capm: tr(`r + β · prime de marché = ${pct(d.r, 2)} + ${num(d.drift.beta, 2)} × ${pct(d.drift.equity_premium, 1)} (Fama-French depuis 1926)`,
      `r + β · market premium = ${pct(d.r, 2)} + ${num(d.drift.beta, 2)} × ${pct(d.drift.equity_premium, 1)} (Fama-French since 1926)`),
    history: tr(`${num(d.drift.history_years, 1)} ans d'historique : ± ${pct(1.96 * d.drift.history_se, 0)} à 95 %`,
      `${num(d.drift.history_years, 1)} years of history: ± ${pct(1.96 * d.drift.history_se, 0)} at 95%`),
    custom: tr("Valeur libre", "Free value"),
  }[source] : undefined;

  return (
    <div className="grid">
      <ErrorBox error={error} />
      <Explainer>
        {tr(<>
          Le prix d'une option ne dépend pas de μ, mais S<sub>T</sub> a bien deux lois. Sous la probabilité réelle P, l'action croît au
          rendement espéré μ ; sous la probabilité risque-neutre Q, elle croît au taux sans risque r. Girsanov passe de l'une à l'autre en
          changeant la dérive, pas la volatilité. Le marché, lui, publie sa propre loi Q à travers le smile : la dérivée seconde du prix des
          calls par rapport au strike donne la densité risque-neutre (Breeden-Litzenberger, 1978).
        </>, <>
          The price of an option does not depend on μ, but S<sub>T</sub> does have two laws. Under the real-world probability P the stock grows at
          the expected return μ; under the risk-neutral probability Q it grows at the risk-free rate r. Girsanov moves from one to the other by
          changing the drift, not the volatility. The market publishes its own Q through the smile: the second derivative of call prices
          with respect to the strike gives the risk-neutral density (Breeden-Litzenberger, 1978).
        </>)}
      </Explainer>
      <Card title={tr(`Paramètres — ${ticker}`, `Parameters — ${ticker}`)}>
        <div className="toolbar-grid">
          <SelectField label={tr("Horizon", "Horizon")} value={days} onChange={setDays} options={horizons()} />
          <SelectField label={tr("Rendement espéré μ", "Expected return μ")} value={source} onChange={setSource}
            options={[{ value: "capm", label: "CAPM" }, { value: "history", label: tr("Historique", "History") }, { value: "custom", label: tr("Libre", "Free") }]} />
          {source === "custom" && <NumberField label="μ" value={mu} suffix="%" scale={100} min={-1} max={1} digits={1} onChange={setMu} />}
        </div>
      </Card>
      <div className="grid cols-4">
        <Stat label={tr("Rendement espéré (sous P)", "Expected return (under P)")} value={fit ? pct(d.mu, 1) : "—"} foot={sourceFoot} busy={isFetching} />
        <Stat label={tr("Taux sans risque (sous Q)", "Risk-free rate (under Q)")} value={fit ? pct(d.r, 2) : "—"} foot={fit ? tr(`Dividende q = ${pct(d.q, 2)}, forward ${num(d.forward, 2)}`, `Dividend q = ${pct(d.q, 2)}, forward ${num(d.forward, 2)}`) : undefined} busy={isFetching} />
        <Stat label={tr("Vol implicite à la monnaie", "At-the-money implied vol")} value={fit ? pct(d.sigma, 1) : "—"} foot={fit ? tr(`La même sous P et Q · vol réalisée ${pct(d.drift.realized_vol, 1)}`, `The same under P and Q · realised vol ${pct(d.drift.realized_vol, 1)}`) : undefined} busy={isFetching} />
        <Stat label={tr("Prix de marché du risque", "Market price of risk")} value={fit ? num(d.market_price_of_risk, 2) : "—"} foot={tr("λ = (μ − r) / σ, la dérive de Girsanov", "λ = (μ − r) / σ, the Girsanov drift")} busy={isFetching} />
      </div>
      <Card title={tr(`Loi du cours dans ${days} jours`, `Distribution of the price in ${days} days`)}>
        {fit ? <EChart option={densityOption} height={360} ariaLabel={tr("Densités de S_T sous P, sous Q et sous le Q du marché", "Densities of S_T under P, under Q and under the market Q")} /> : <Skeleton height={320} />}
        {fit && (
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            {tr(<>
              Contrôles de la densité extraite du smile : masse {num(d.checks.mass, 4)}, E<sub>Q</sub>[S<sub>T</sub>] = {num(d.checks.mean, 2)} contre
              un forward de {num(d.checks.forward, 2)} (le prix actualisé est une martingale sous Q). L'histogramme empirique empile
              {d.stats.P_empirical ? ` ${d.stats.P_empirical.n}` : ""} rendements sur {days} jours qui se chevauchent : ils sont très corrélés entre eux.
            </>, <>
              Checks of the density extracted from the smile: mass {num(d.checks.mass, 4)}, E<sub>Q</sub>[S<sub>T</sub>] = {num(d.checks.mean, 2)} against
              a forward of {num(d.checks.forward, 2)} (the discounted price is a martingale under Q). The empirical histogram stacks
              {d.stats.P_empirical ? ` ${d.stats.P_empirical.n}` : ""} overlapping {days}-day returns: they are highly correlated with each other.
            </>)}
          </p>
        )}
      </Card>
      <Card title={tr("Mode, médiane, moyenne et probabilités de baisse", "Mode, median, mean and probabilities of a fall")}>
        {fit ? (
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th />{cols.map((c) => <th key={c.key}>{c.label}</th>)}</tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.label}><td className="strong">{r.label}</td>
                    {cols.map((c) => { const st = d.stats[c.key]; return <td key={c.key}>{st ? r.get(st) : "—"}</td>; })}</tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <Skeleton height={260} />}
        <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
          {tr("Sous une lognormale, mode < médiane < moyenne : la plupart des trajectoires finissent sous l'espérance, tirée par quelques fortes hausses. Le smile renverse en partie cet ordre : sa queue gauche épaisse (krachs chers) déplace de la masse vers les fortes baisses, et pour garder la moyenne au forward, la médiane et le mode remontent.",
            "Under a lognormal, mode < median < mean: most paths end below the expectation, which is pulled up by a few large rises. The smile partly reverses this order: its fat left tail (expensive crashes) moves mass toward large falls, and to keep the mean at the forward, the median and the mode move up.")}
        </p>
      </Card>
      <div className="grid cols-2">
        <Card title={tr("Éventail des quantiles selon l'horizon", "Quantile fan by horizon")}>
          {fit && d.fan ? <EChart option={fanOption} height={320} ariaLabel={tr("Quantiles 5, 50 et 95 % de S_T selon l'horizon", "5%, 50% and 95% quantiles of S_T by horizon")} /> : <Skeleton height={280} />}
        </Card>
        <Card title={tr("Noyau de prix : densité risque-neutre / densité réelle", "Pricing kernel: risk-neutral density / real-world density")}>
          {fit ? <EChart option={kernelOption} height={320} ariaLabel={tr("Rapport des densités risque-neutre et réelle", "Ratio of the risk-neutral and real-world densities")} /> : <Skeleton height={280} />}
        </Card>
      </div>
      <InfoBox>
        {tr(<>
          Le rapport q / p est la densité des prix d'état, au facteur d'actualisation près : le prix d'un euro reçu si S<sub>T</sub> tombe
          dans un intervalle, divisé par la probabilité réelle de cet intervalle. Avec μ &gt; r, il décroît : un euro dans les états de krach
          vaut plus que sa probabilité, car c'est là que tout le monde en manque. Le smile accentue fortement la pente à gauche. Un rapport
          non monotone autour du spot est le « pricing kernel puzzle » (Jackwerth, 2000). Enfin, μ est très mal estimé : avec deux ans
          d'historique, l'intervalle de confiance couvre plusieurs dizaines de points de rendement, d'où le CAPM par défaut.
        </>, <>
          The ratio q / p is the state-price density, up to the discount factor: the price of one unit paid if S<sub>T</sub> falls
          in an interval, divided by the real-world probability of that interval. With μ &gt; r it decreases: a unit paid in crash states
          is worth more than its probability, because that is where everyone is short of money. The smile steepens the left side sharply. A ratio
          that is not monotonic around the spot is the "pricing kernel puzzle" (Jackwerth, 2000). Finally, μ is very poorly estimated: with two years
          of history the confidence interval spans tens of points of return, hence CAPM by default.
        </>)}
      </InfoBox>
    </div>
  );
}

type MeasuresResponseStats = { P: MeasureStats; Q: MeasureStats; Q_smile: MeasureStats; P_empirical?: MeasureStats };

// ----------------------------------------------------------------------------- Ornstein-Uhlenbeck and Vasicek

const years = (x: number | null | undefined, d = 1) => (x == null ? "∞" : tr(`${num(x, d)} ans`, `${num(x, d)} years`));
const bp = (x: number | null | undefined, d = 0) => (x == null ? "—" : `${x >= 0 ? "+" : ""}${num(x * 1e4, d)} bp`);

export function VasicekLab() {
  const [currency, setCurrency] = useState<"USD" | "EUR">("USD");
  const [start, setStart] = useState<number | null>(null);
  const [freq, setFreq] = useState<VasicekFreq>("monthly");
  const { data: d, error, isFetching } = useQuery({
    queryKey: ["vasicek", currency, start, freq],
    queryFn: () => vasicekApi.get(currency, start, freq), placeholderData: keepPreviousData, retry: false,
  });
  const fit = d && d.currency === currency;
  const e = fit ? d.estimate : undefined;
  const ts = fit ? d.term_structure : undefined;
  const freqLabel = { monthly: tr("mensuelles", "monthly"), weekly: tr("hebdomadaires", "weekly"), daily: tr("quotidiennes", "daily") }[freq];

  const historyOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const est = d.estimate;
    const series: object[] = [
      { type: "line", name: tr("Taux 3 mois", "3-month rate"), showSymbol: false, color: p.series[0], lineStyle: { width: 1.5 }, data: d.history.rates,
        markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dotted" }, label: { show: false }, data: [{ yAxis: 0 }] } },
    ];
    if (est.mean_reverting && est.theta != null && est.stationary_sd != null) {
      const lo = est.theta - 1.645 * est.stationary_sd, hi = est.theta + 1.645 * est.stationary_sd;
      series.push(
        { type: "line", name: tr("θ, moyenne de long terme", "θ, long-run mean"), showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: d.history.rates.map(() => est.theta) },
        { type: "line", name: tr("Loi stationnaire : 5 % et 95 %", "Stationary law: 5% and 95%"), showSymbol: false, color: p.series[1], lineStyle: { width: 1, type: "dotted" }, data: d.history.rates.map(() => lo) },
        { type: "line", showSymbol: false, color: p.series[1], lineStyle: { width: 1, type: "dotted" }, data: d.history.rates.map(() => hi) },
      );
    }
    return {
      legend: { top: 0 },
      grid: { top: 40, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "category", data: d.history.dates, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series,
    };
  }, [d]);

  const estimatorOption = useCallback((p: ChartPalette) => {
    const s = d?.simulation;
    if (!s) return {};
    const centers = s.hist.counts.map((_, i) => (s.hist.edges[i] + s.hist.edges[i + 1]) / 2);
    const marks = [{ xAxis: s.kappa_true, label: { formatter: tr("κ vrai", "true κ") }, lineStyle: { color: p.series[0], type: "solid", width: 2 } }];
    if (s.kappa_mean != null) marks.push({ xAxis: s.kappa_mean, label: { formatter: tr("moyenne de κ̂", "mean of κ̂") }, lineStyle: { color: p.series[2], type: "dashed", width: 2 } });
    return {
      grid: { top: 30, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 0) },
      xAxis: { type: "value", name: "κ̂", nameLocation: "middle", nameGap: 26, min: 0, max: s.hist.edges[s.hist.edges.length - 1], axisLabel: { formatter: (v: number) => num(v, 2) } },
      yAxis: { type: "value", name: tr("simulations", "simulations") },
      series: [{ type: "bar", name: tr("Estimations de κ", "Estimates of κ"), color: p.muted, itemStyle: { opacity: 0.55 }, barWidth: "95%",
        data: centers.map((c, i) => [c, s.hist.counts[i]]),
        markLine: { symbol: "none", silent: true, label: { color: p.textSecondary, fontSize: 10, position: "end" }, data: marks } }],
    };
  }, [d]);

  const curveOption = useCallback((p: ChartPalette) => {
    if (!ts) return {};
    const line = (arr: number[]) => ts.grid.map((t, i) => [t, arr[i]]);
    const series: object[] = [
      { type: "line", name: tr("Courbe zéro du marché", "Market zero curve"), showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: line(ts.market) },
      { type: "scatter", name: tr("Piliers ajustés", "Fitted pillars"), color: p.series[0], symbolSize: 7, data: ts.pillars.map((t, i) => [t, ts.market_pillars[i]]) },
      { type: "line", name: tr("Vasicek sous Q (calibré)", "Vasicek under Q (calibrated)"), showSymbol: false, color: p.series[2], lineStyle: { width: 2 }, data: line(ts.vasicek_q) },
    ];
    if (ts.vasicek_p) series.push({ type: "line", name: tr("Vasicek sous P (historique)", "Vasicek under P (history)"), showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: line(ts.vasicek_p) });
    return {
      legend: { top: 0 },
      grid: { top: 60, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "value", name: tr("maturité (ans)", "maturity (years)"), nameLocation: "middle", nameGap: 26, min: 0, max: 30 },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 1) } },
      series,
    };
  }, [ts]);

  const fanOption = useCallback((p: ChartPalette) => {
    if (!ts) return {};
    const f = ts.fan;
    const line = (arr: number[]) => f.t.map((t, i) => [t, arr[i]]);
    const series: object[] = [
      { type: "line", name: tr("Forwards du marché", "Market forwards"), showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: line(f.market_forward) },
      { type: "line", name: tr("Forwards de Vasicek (Q)", "Vasicek forwards (Q)"), showSymbol: false, color: p.series[2], lineStyle: { width: 2 }, data: line(f.q_forward) },
    ];
    if (f.p_mean && f.p_low && f.p_high) {
      series.push(
        { type: "line", name: tr("E_P[r_t] : taux attendu", "E_P[r_t]: expected rate"), showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: line(f.p_mean) },
        { type: "line", name: tr("Sous P : quantiles 5 % et 95 %", "Under P: 5% and 95% quantiles"), showSymbol: false, color: p.series[1], lineStyle: { width: 1, type: "dotted" }, data: line(f.p_low) },
        { type: "line", showSymbol: false, color: p.series[1], lineStyle: { width: 1, type: "dotted" }, data: line(f.p_high),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dotted" }, label: { show: false }, data: [{ yAxis: 0 }] } },
      );
    }
    return {
      legend: { top: 0 },
      grid: { top: 60, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "value", name: tr("horizon (ans)", "horizon (years)"), nameLocation: "middle", nameGap: 26, min: 0, max: 10 },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 1) } },
      series,
    };
  }, [ts]);

  const sim = fit ? d.simulation : null;
  return (
    <div className="grid">
      <ErrorBox error={error} />
      <Explainer>
        {tr(<>
          Le taux court suit un processus d'Ornstein-Uhlenbeck, dr = κ(θ − r)dt + σ dW : il est rappelé vers θ à la vitesse κ. Échantillonné
          à pas fixe, ce processus est exactement un AR(1), r<sub>t+Δt</sub> = a + b r<sub>t</sub> + ε avec b = e<sup>−κΔt</sup> : une simple
          régression sur des décennies de taux 3 mois donne κ, θ et σ. Le modèle de Vasicek (1977) en déduit toute la courbe des taux, en
          formule fermée. Sous la probabilité risque-neutre, Girsanov change θ (et éventuellement κ) mais pas σ.
        </>, <>
          The short rate follows an Ornstein-Uhlenbeck process, dr = κ(θ − r)dt + σ dW: it is pulled back towards θ at speed κ. Sampled
          on a fixed step, this process is exactly an AR(1), r<sub>t+Δt</sub> = a + b r<sub>t</sub> + ε with b = e<sup>−κΔt</sup>: a plain
          regression on decades of 3-month rates gives κ, θ and σ. The Vasicek (1977) model derives the whole yield curve from it in
          closed form. Under the risk-neutral measure, Girsanov changes θ (and possibly κ) but not σ.
        </>)}
      </Explainer>
      <Card title={tr("Paramètres", "Parameters")}>
        <div className="toolbar-grid">
          <SelectField label={tr("Taux 3 mois", "3-month rate")} value={currency} onChange={(c) => { setCurrency(c); setStart(null); }}
            options={[{ value: "USD", label: tr("USD : bons du Trésor (depuis 1990)", "USD: Treasury bills (since 1990)") }, { value: "EUR", label: tr("EUR : courbe AAA de la BCE (depuis 2004)", "EUR: ECB AAA curve (since 2004)") }]} />
          <SelectField label={tr("Début de l'échantillon", "Sample start")} value={start ?? (fit ? d.start : 0)} onChange={(v) => setStart(v)}
            options={(fit ? d.starts : []).map((y) => ({ value: y, label: String(y) }))} />
          <SelectField label={tr("Observations", "Observations")} value={freq} onChange={setFreq}
            options={[{ value: "monthly", label: tr("Mensuelles", "Monthly") }, { value: "weekly", label: tr("Hebdomadaires", "Weekly") }, { value: "daily", label: tr("Quotidiennes", "Daily") }]} />
        </div>
      </Card>
      {fit && !d.estimate.mean_reverting && (
        <InfoBox>
          {tr(<>
            Sur cet échantillon, la pente estimée b = {num(d.estimate.b, 4)} est supérieure ou égale à 1 : les taux ont surtout monté (ou baissé)
            sans revenir vers une moyenne, et la régression ne détecte aucun rappel. Le processus n'est pas un Ornstein-Uhlenbeck sur cette période ;
            la courbe sous Q reste calibrée, avec la volatilité des variations de taux.
          </>, <>
            On this sample the estimated slope b = {num(d.estimate.b, 4)} is greater than or equal to 1: rates mostly trended up (or down)
            without returning to a mean, and the regression detects no pull-back. The process is not Ornstein-Uhlenbeck over this period;
            the curve under Q is still calibrated, with the volatility of rate changes.
          </>)}
        </InfoBox>
      )}
      <div className="grid cols-4">
        <Stat label={tr("Vitesse de rappel κ", "Mean-reversion speed κ")} value={e?.kappa != null ? num(e.kappa, 3) : "—"}
          foot={e?.kappa != null && e.se_kappa != null ? tr(`± ${num(1.96 * e.se_kappa, 3)} à 95 % · b = ${num(e.b, 4)}`, `± ${num(1.96 * e.se_kappa, 3)} at 95% · b = ${num(e.b, 4)}`) : undefined} busy={isFetching} />
        <Stat label={tr("Demi-vie ln 2 / κ", "Half-life ln 2 / κ")} value={e?.half_life != null ? years(e.half_life) : "—"}
          foot={e?.half_life != null ? tr(`Intervalle à 95 % : ${years(e.half_life_low)} à ${years(e.half_life_high)}`, `95% interval: ${years(e.half_life_low)} to ${years(e.half_life_high)}`) : undefined} busy={isFetching} />
        <Stat label={tr("Moyenne de long terme θ", "Long-run mean θ")} value={e?.theta != null ? pct(e.theta, 2) : "—"}
          foot={e?.theta != null && e.se_theta != null ? tr(`± ${pct(1.96 * e.se_theta, 2)} à 95 %`, `± ${pct(1.96 * e.se_theta, 2)} at 95%`) : undefined} busy={isFetching} />
        <Stat label={tr("Volatilité σ", "Volatility σ")} value={e?.sigma != null ? bp(e.sigma).replace("+", "") : "—"}
          foot={e?.stationary_sd != null ? tr(`par an · écart-type stationnaire ${pct(e.stationary_sd, 2)}`, `per year · stationary sd ${pct(e.stationary_sd, 2)}`) : undefined} busy={isFetching} />
      </div>
      <Card title={fit ? tr(`Taux 3 mois ${currency}, observations ${freqLabel} (${d.first} → ${d.last})`, `${currency} 3-month rate, ${freqLabel} observations (${d.first} → ${d.last})`) : tr("Taux 3 mois", "3-month rate")}>
        {fit ? <EChart option={historyOption} height={320} ariaLabel={tr("Historique du taux 3 mois, moyenne de long terme et bande stationnaire", "3-month rate history, long-run mean and stationary band")} /> : <Skeleton height={300} />}
        {fit && e && (
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            {tr(<>
              Régression sur {e.n} variations : a = {num(e.a * 1e4, 2)} bp, b = {num(e.b, 4)} (écart-type {num(e.se_b, 4)}), R² = {num(e.r2, 3)},
              écart-type des résidus {num(e.resid_sd * 1e4, 1)} bp. σ découle de la variance exacte des résidus, σ²(1 − b²) / (2κ).
              {e.prob_negative_stationary != null && <> Sous la loi stationnaire, P(r &lt; 0) = {pct(e.prob_negative_stationary, 1)} : le modèle gaussien autorise des taux négatifs.</>}
            </>, <>
              Regression on {e.n} changes: a = {num(e.a * 1e4, 2)} bp, b = {num(e.b, 4)} (standard error {num(e.se_b, 4)}), R² = {num(e.r2, 3)},
              residual standard deviation {num(e.resid_sd * 1e4, 1)} bp. σ follows from the exact variance of the residuals, σ²(1 − b²) / (2κ).
              {e.prob_negative_stationary != null && <> Under the stationary law, P(r &lt; 0) = {pct(e.prob_negative_stationary, 1)}: the Gaussian model allows negative rates.</>}
            </>)}
          </p>
        )}
      </Card>
      <div className="grid cols-2">
        <Card title={tr("Les paramètres dépendent de la période", "The parameters depend on the period")}>
          {fit ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr>{[tr("Depuis", "Since"), "n", tr("Moyenne", "Mean"), "b", "κ", "θ", "σ", tr("Demi-vie", "Half-life")].map((h) => <th key={h}>{keepGreek(h)}</th>)}</tr></thead>
                <tbody>
                  {d.windows.map((w) => (
                    <tr key={w.start} className={w.start === d.start ? "strong" : undefined}>
                      <td>{w.first.slice(0, 7)}</td><td>{w.n}</td><td>{pct(w.mean, 2)}</td><td>{num(w.b, 4)}</td>
                      <td>{w.kappa != null ? num(w.kappa, 3) : "—"}</td><td>{w.theta != null ? pct(w.theta, 2) : "—"}</td>
                      <td>{w.sigma != null ? `${num(w.sigma * 1e4, 0)} bp` : "—"}</td>
                      <td>{w.half_life != null ? years(w.half_life) : tr("pas de rappel", "no reversion")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Skeleton height={200} />}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            {currency === "USD"
              ? tr("Depuis 2009, les taux sont partis de zéro pour finir vers 4 à 5 % : en échantillon, la série monte au lieu de revenir vers une moyenne.",
                "Since 2009 rates started at zero and ended around 4 to 5%: in sample, the series trends instead of returning to a mean.")
              : tr("Depuis 2009, les taux de l'euro sont passés sous zéro jusqu'en 2022, puis sont remontés d'un coup : en échantillon, aucune moyenne n'attire la série.",
                "Since 2009, euro rates went below zero until 2022, then rose abruptly: in sample, no mean pulls the series back.")}
            {" "}{tr("θ et la demi-vie changent du tout au tout d'une période à l'autre : un modèle à paramètres constants résume mal plusieurs régimes de politique monétaire.",
              "θ and the half-life change completely from one period to the next: a constant-parameter model summarises several monetary-policy regimes poorly.")}
          </p>
        </Card>
        <Card title={tr("Le biais de l'estimateur : κ̂ surestime le rappel", "The estimator's bias: κ̂ overstates the pull-back")}>
          {sim ? <EChart option={estimatorOption} height={260} ariaLabel={tr("Distribution simulée de l'estimateur de κ", "Simulated distribution of the κ estimator")} /> : <Skeleton height={240} />}
          {sim && e && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr(<>
                {sim.n_sims} trajectoires simulées de {sim.n} pas, avec κ = {num(sim.kappa_true, 3)} pris comme vrai : la moyenne de κ̂ vaut {sim.kappa_mean != null ? num(sim.kappa_mean, 3) : "—"},
                et 90 % des estimations tombent entre {sim.kappa_q05 != null ? num(sim.kappa_q05, 3) : "—"} et {sim.kappa_q95 != null ? num(sim.kappa_q95, 3) : "—"}.
                La pente b̂ est biaisée vers le bas d'environ (1 + 3b) / n (Kendall, 1954) : simulé {num(sim.b_bias, 5)}, formule {num(sim.b_bias_kendall, 5)}.
                Corrigée, la demi-vie passe à {years(e.half_life_corrected)}. ({sim.hist.beyond} estimations au-delà de {num(sim.hist.edges[sim.hist.edges.length - 1], 2)} ne sont pas tracées.)
              </>, <>
                {sim.n_sims} simulated paths of {sim.n} steps, with κ = {num(sim.kappa_true, 3)} taken as the truth: the mean of κ̂ is {sim.kappa_mean != null ? num(sim.kappa_mean, 3) : "—"},
                and 90% of the estimates fall between {sim.kappa_q05 != null ? num(sim.kappa_q05, 3) : "—"} and {sim.kappa_q95 != null ? num(sim.kappa_q95, 3) : "—"}.
                The slope b̂ is biased downwards by about (1 + 3b) / n (Kendall, 1954): simulated {num(sim.b_bias, 5)}, formula {num(sim.b_bias_kendall, 5)}.
                Corrected, the half-life becomes {years(e.half_life_corrected)}. ({sim.hist.beyond} estimates above {num(sim.hist.edges[sim.hist.edges.length - 1], 2)} are not plotted.)
              </>)}
            </p>
          )}
          {fit && !sim && <p className="muted" style={{ fontSize: 12 }}>{tr("Pas de simulation sans retour à la moyenne estimé.", "No simulation without an estimated mean reversion.")}</p>}
        </Card>
      </div>
      <div className="grid cols-4">
        <Stat label={tr("κ sous Q (calibré)", "κ under Q (calibrated)")} value={ts ? num(ts.calibration.kappa, 3) : "—"}
          foot={ts ? tr(`Demi-vie ${years(ts.calibration.half_life)} · σ fixé à ${num(ts.sigma * 1e4, 0)} bp`, `Half-life ${years(ts.calibration.half_life)} · σ fixed at ${num(ts.sigma * 1e4, 0)} bp`) : undefined} busy={isFetching} />
        <Stat label={tr("θ sous Q (calibré)", "θ under Q (calibrated)")} value={ts ? pct(ts.calibration.theta, 2) : "—"}
          foot={ts?.theta_gap != null ? tr(`${bp(ts.theta_gap)} par rapport au θ historique`, `${bp(ts.theta_gap)} against the historical θ`) : undefined} busy={isFetching} />
        <Stat label={tr("Écart d'ajustement", "Fit error")} value={ts ? `${num(ts.calibration.rmse * 1e4, 1)} bp` : "—"}
          foot={ts ? tr(`Moyenne quadratique sur ${ts.pillars.length} piliers · max ${num(ts.calibration.max_abs_error * 1e4, 1)} bp${ts.p_rmse != null ? ` · sous P ${num(ts.p_rmse * 1e4, 0)} bp` : ""}`,
            `Root mean square over ${ts.pillars.length} pillars · max ${num(ts.calibration.max_abs_error * 1e4, 1)} bp${ts.p_rmse != null ? ` · under P ${num(ts.p_rmse * 1e4, 0)} bp` : ""}`) : undefined} busy={isFetching} />
        <Stat label={tr("Prime de terme à 10 ans", "10-year term premium")} value={ts?.term_premium_10y != null ? bp(ts.term_premium_10y) : "—"}
          foot={tr("Taux 10 ans sous Q moins taux 10 ans sous P", "10-year yield under Q minus 10-year yield under P")} busy={isFetching} />
      </div>
      <div className="grid cols-2">
        <Card title={ts ? tr(`Courbe zéro-coupon du ${ts.asof} : marché et Vasicek`, `Zero-coupon curve of ${ts.asof}: market and Vasicek`) : tr("Courbe zéro-coupon", "Zero-coupon curve")}>
          {ts ? <EChart option={curveOption} height={320} ariaLabel={tr("Courbe zéro du marché, Vasicek sous Q et sous P", "Market zero curve, Vasicek under Q and under P")} /> : <Skeleton height={300} />}
        </Card>
        <Card title={tr("Où le marché attend-il les taux ?", "Where does the market expect rates?")}>
          {ts ? <EChart option={fanOption} height={320} ariaLabel={tr("Forwards du marché, forwards de Vasicek et loi du taux court sous P", "Market forwards, Vasicek forwards and the law of the short rate under P")} /> : <Skeleton height={300} />}
        </Card>
      </div>
      <InfoBox>
        {tr(<>
          Avec le même σ, la courbe sous P (les anticipations seules, sans prime de risque) reste sous la courbe du marché : l'écart est la prime
          de terme, que l'investisseur exige pour porter une obligation longue. Sous Q, il suffit de relever θ pour ajuster la courbe à quelques
          points de base près, mais pas exactement : avec deux paramètres constants, Vasicek ne peut pas reproduire toutes les bosses. Hull-White
          rend θ dépendant du temps pour coller exactement à la courbe ; CIR remplace σ par σ√r pour interdire les taux négatifs. Enfin, un seul
          facteur fait bouger tous les taux ensemble : la pente et la courbure de la courbe ne varient jamais indépendamment.
          {ts?.prob_negative && <> Sous P, la probabilité d'un taux court négatif vaut {pct(ts.prob_negative["1"], 1)} à 1 an et {pct(ts.prob_negative["5"], 1)} à 5 ans.</>}
        </>, <>
          With the same σ, the curve under P (expectations alone, no risk premium) stays below the market curve: the gap is the term premium
          that investors demand to hold a long bond. Under Q, raising θ is enough to fit the curve to within a few basis points, but not exactly:
          with two constant parameters, Vasicek cannot reproduce every hump. Hull-White makes θ time-dependent to fit the curve exactly; CIR
          replaces σ with σ√r to rule out negative rates. Finally, a single factor moves all rates together: the slope and curvature of the curve
          never change independently.
          {ts?.prob_negative && <> Under P, the probability of a negative short rate is {pct(ts.prob_negative["1"], 1)} at 1 year and {pct(ts.prob_negative["5"], 1)} at 5 years.</>}
        </>)}
      </InfoBox>
    </div>
  );
}

// ----------------------------------------------------------------------------- predictive regression and the Stambaugh bias

const signed = (x: number | null | undefined, d = 4) => (x == null || !Number.isFinite(x) ? "—" : `${x >= 0 ? "+" : ""}${num(x, d)}`);
const pval = (p: number | null | undefined) => (p == null ? "—" : p < 0.001 ? tr("< 0,001", "< 0.001") : num(p, 3));
const centers = (h: Hist) => h.counts.map((_, i) => (h.edges[i] + h.edges[i + 1]) / 2);

function nullOption(p: ChartPalette, h: Hist, beta: number, betaAh: number, scale: number, unit: string) {
  return {
    grid: { top: 30, right: 24, bottom: 44 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 0) },
    xAxis: { type: "value", name: unit, nameLocation: "middle", nameGap: 28, min: h.edges[0] * scale, max: h.edges[h.edges.length - 1] * scale,
      axisLabel: { formatter: (v: number) => num(v, scale === 1 ? 3 : 0) } },
    yAxis: { type: "value" },
    series: [{ type: "bar", name: tr("β̂ quand les rendements sont imprévisibles", "β̂ when returns are unpredictable"), color: p.muted, itemStyle: { opacity: 0.55 }, barWidth: "95%",
      data: centers(h).map((c, i) => [c * scale, h.counts[i]]),
      markLine: { symbol: "none", silent: true, label: { color: p.textSecondary, fontSize: 10, position: "end" }, data: [
        { xAxis: 0, label: { show: false }, lineStyle: { color: p.muted, type: "dotted" } },
        { xAxis: beta * scale, label: { formatter: tr("β̂ observé", "observed β̂") }, lineStyle: { color: p.series[0], type: "solid", width: 2 } },
        { xAxis: betaAh * scale, label: { formatter: tr("β corrigé", "corrected β"), position: "insideEndTop" }, lineStyle: { color: p.series[2], type: "dashed", width: 2 } },
      ] } }],
  };
}

export function StambaughLab() {
  const simRef = useRef<HTMLDivElement>(null);
  const [start, setStart] = useState(1950);
  const [target, setTarget] = useState("US");
  const [halflife, setHalflife] = useState(3);
  const [sim, setSim] = useState({ rho: 0.98, corr: -0.9, n: 240 });
  const simQ = useDebounced(sim, 350);

  const dp = useQuery({ queryKey: ["stambaugh-dp", start], queryFn: () => stambaughApi.dividendYield(start), placeholderData: keepPreviousData, retry: false });
  const mc = useQuery({ queryKey: ["stambaugh-sim", simQ.rho, simQ.corr, simQ.n], queryFn: () => stambaughApi.simulate(simQ.rho, simQ.corr, simQ.n), placeholderData: keepPreviousData, retry: false });
  const se = useQuery({ queryKey: ["stambaugh-sent", target, halflife], queryFn: () => stambaughApi.sentiment(target, halflife), placeholderData: keepPreviousData, retry: false });

  const d = dp.data, s = mc.data, st = se.data;
  const e = d?.estimate, b = d?.bootstrap;
  const loadSim = (rho: number, corr: number, n: number) => {
    setSim({ rho: Math.min(0.999, Math.max(0, Number(rho.toFixed(4)))), corr: Math.min(0.99, Math.max(-0.99, Number(corr.toFixed(3)))), n: Math.min(2000, Math.max(20, n)) });
    simRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const dpOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    return {
      grid: { top: 20, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "category", data: d.history.months, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [{ type: "line", name: tr("Rendement du dividende D/P", "Dividend yield D/P"), showSymbol: false, color: p.series[0], lineStyle: { width: 1.5 }, data: d.history.dividend_yield,
        markArea: { silent: true, itemStyle: { color: p.muted, opacity: 0.08 }, data: [[{ xAxis: d.first }, { xAxis: d.history.months[d.history.months.length - 1] }]] } }],
    };
  }, [d]);

  const dpNullOption = useCallback((p: ChartPalette) => (d ? nullOption(p, d.bootstrap.hist, d.estimate.beta, d.estimate.beta_ah, 1, "β") : {}), [d]);

  const scatterOption = useCallback((p: ChartPalette) => {
    if (!s) return {};
    const xs = s.scatter.rho_err;
    const lo = Math.min(...xs), hi = Math.max(...xs);
    return {
      grid: { top: 30, right: 24, bottom: 44 },
      tooltip: { trigger: "item", formatter: (q: { value: number[] }) => `ρ̂ − ρ = ${num(q.value[0], 4)}<br/>β̂ = ${num(q.value[1], 4)}` },
      legend: { top: 0 },
      xAxis: { type: "value", name: tr("erreur sur la persistance ρ̂ − ρ", "error on the persistence ρ̂ − ρ"), nameLocation: "middle", nameGap: 28, scale: true, axisLabel: { formatter: (v: number) => num(v, 2) } },
      yAxis: { type: "value", name: "β̂", scale: true, axisLabel: { formatter: (v: number) => num(v, 2) } },
      series: [
        { type: "scatter", name: tr("Un échantillon simulé", "One simulated sample"), color: p.series[0], symbolSize: 4, itemStyle: { opacity: 0.45 }, data: xs.map((x, i) => [x, s.scatter.beta_hat[i]]) },
        { type: "line", name: tr("β̂ − β = γ (ρ̂ − ρ)", "β̂ − β = γ (ρ̂ − ρ)"), showSymbol: false, color: p.series[2], lineStyle: { width: 2 }, data: [[lo, s.gamma * lo], [hi, s.gamma * hi]] },
      ],
    };
  }, [s]);

  const tOption = useCallback((p: ChartPalette) => {
    if (!s) return {};
    const c = centers(s.t_hist.ols);
    const w = s.t_hist.ols.edges[1] - s.t_hist.ols.edges[0];
    const normal = c.map((x) => [x, (s.n_sims * w * Math.exp(-0.5 * x * x)) / Math.sqrt(2 * Math.PI)]);
    const crit = s.gamma <= 0 ? 1.645 : -1.645;
    return {
      legend: { top: 0 },
      grid: { top: 40, right: 24, bottom: 44 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 0) },
      xAxis: { type: "value", name: tr("t de Student de β̂ (vrai β = 0)", "t-statistic of β̂ (true β = 0)"), nameLocation: "middle", nameGap: 28, min: -4.5, max: 5.5 },
      yAxis: { type: "value" },
      series: [
        { type: "bar", name: tr("MCO", "OLS"), color: p.series[0], itemStyle: { opacity: 0.45 }, barGap: "-100%", barWidth: "95%", data: c.map((x, i) => [x, s.t_hist.ols.counts[i]]),
          markLine: { symbol: "none", silent: true, label: { color: p.textSecondary, fontSize: 10, position: "end", formatter: tr("seuil 5 %", "5% threshold") }, lineStyle: { color: p.muted, type: "dashed" }, data: [{ xAxis: crit }] } },
        { type: "bar", name: "Amihud-Hurvich", color: p.series[2], itemStyle: { opacity: 0.45 }, barWidth: "95%", data: c.map((x, i) => [x, s.t_hist.ah.counts[i]]) },
        { type: "line", name: tr("Loi normale supposée", "Assumed normal law"), showSymbol: false, smooth: true, color: p.textSecondary, lineStyle: { width: 1.5, type: "dotted" }, data: normal },
      ],
    };
  }, [s]);

  const sentOption = useCallback((p: ChartPalette) => {
    if (!st) return {};
    const idx = st.series.dates.map((_, i) => i).filter((i) => st.series.raw[i] != null || st.series.signal[i] != null);
    const first = idx.length ? Math.max(0, idx[0] - 2) : 0;
    const dates = st.series.dates.slice(first);
    const at = (arr: (number | null)[]) => arr.slice(first);
    return {
      legend: { top: 0 },
      grid: { top: 40, right: 56 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "category", data: dates, axisLabel: { hideOverlap: true } },
      yAxis: [
        { type: "value", name: tr("score", "score"), axisLabel: { formatter: (v: number) => num(v, 2) } },
        { type: "value", name: tr("rendement", "return"), axisLabel: { formatter: (v: number) => pct(v, 1) }, splitLine: { show: false } },
      ],
      series: [
        { type: "bar", name: tr("Score du jour", "Day's score"), color: p.muted, itemStyle: { opacity: 0.55 }, data: at(st.series.raw), tooltip: { valueFormatter: (v: number | null) => num(v, 3) } },
        { type: "line", name: tr("Signal x_t (lissé)", "Signal x_t (smoothed)"), showSymbol: true, symbolSize: 4, connectNulls: false, color: p.series[0], lineStyle: { width: 2 }, data: at(st.series.signal), tooltip: { valueFormatter: (v: number | null) => num(v, 3) } },
        { type: "line", yAxisIndex: 1, name: tr(`Rendement suivant de ${st.price_ticker}`, `Next ${st.price_ticker} return`), showSymbol: false, color: p.series[2], lineStyle: { width: 1.2, type: "dashed" }, data: at(st.series.return_next), tooltip: { valueFormatter: (v: number | null) => pct(v, 2) } },
      ],
    };
  }, [st]);

  const sentNullOption = useCallback((p: ChartPalette) => (st?.estimate && st.bootstrap ? nullOption(p, st.bootstrap.hist, st.estimate.beta, st.estimate.beta_ah, 1e3, tr("β (bp pour +0,1 de score)", "β (bp per +0.1 of score)")) : {}), [st]);

  const sentLabel = (t: string) => (t === "US" ? tr("Marché US (5 titres → SPY)", "US market (5 names → SPY)") : t);
  const se_ = st?.estimate;

  return (
    <div className="grid">
      <ErrorBox error={dp.error ?? mc.error ?? se.error} />
      <Explainer>
        {tr(<>
          Une régression prédictive explique le rendement du mois suivant par une variable connue aujourd'hui : r<sub>t+1</sub> = α + β x<sub>t</sub> + u<sub>t+1</sub>.
          Le piège vient du prédicteur : un ratio de valorisation comme le rendement du dividende est très persistant, x<sub>t+1</sub> = μ + ρ x<sub>t</sub> + v<sub>t+1</sub> avec ρ proche de 1,
          et ses chocs sont liés à ceux du rendement (quand le prix monte, D/P baisse le même mois). L'estimateur ρ̂ est biaisé vers le bas en petit échantillon,
          et cette erreur se reporte sur β̂ : E[β̂ − β] = γ E[ρ̂ − ρ] avec γ = Cov(u, v) / Var(v) (Stambaugh, 1999). Résultat : un prédicteur inutile paraît
          utile, et le t de Student rejette trop souvent l'absence de prévisibilité.
        </>, <>
          A predictive regression explains next month's return with a variable known today: r<sub>t+1</sub> = α + β x<sub>t</sub> + u<sub>t+1</sub>.
          The trap is the predictor: a valuation ratio like the dividend yield is highly persistent, x<sub>t+1</sub> = μ + ρ x<sub>t</sub> + v<sub>t+1</sub> with ρ close to 1,
          and its shocks are tied to the return's (when the price rises, D/P falls in the same month). The estimator ρ̂ is biased downwards in small samples,
          and that error carries over to β̂: E[β̂ − β] = γ E[ρ̂ − ρ] with γ = Cov(u, v) / Var(v) (Stambaugh, 1999). The result: a useless predictor looks
          useful, and the t-test rejects "no predictability" too often.
        </>)}
      </Explainer>

      <Card title={tr("Le rendement du dividende prédit-il le S&P 500 ?", "Does the dividend yield predict the S&P 500?")}>
        <div className="toolbar-grid">
          <SelectField label={tr("Début de l'échantillon", "Sample start")} value={start} onChange={setStart} options={(d?.starts ?? [1871, 1927, 1950, 1990]).map((y) => ({ value: y, label: String(y) }))} />
        </div>
        <p className="muted" style={{ fontSize: 12, marginTop: 0 }}>
          {tr(<>Données mensuelles de Robert Shiller sur l'indice composite S&P depuis 1871 : r<sub>t+1</sub> = ln((P<sub>t+1</sub> + D<sub>t+1</sub>/12) / P<sub>t</sub>), x<sub>t</sub> = ln(D<sub>t</sub>/P<sub>t</sub>).</>,
            <>Robert Shiller's monthly data on the S&P composite since 1871: r<sub>t+1</sub> = ln((P<sub>t+1</sub> + D<sub>t+1</sub>/12) / P<sub>t</sub>), x<sub>t</sub> = ln(D<sub>t</sub>/P<sub>t</sub>).</>)}
        </p>
        {d ? <EChart option={dpOption} height={220} ariaLabel={tr("Rendement du dividende du S&P depuis 1871", "S&P dividend yield since 1871")} /> : <Skeleton height={220} />}
      </Card>
      <div className="grid cols-4">
        <Stat label={tr("β̂ par les MCO", "OLS β̂")} value={e ? signed(e.beta) : "—"}
          foot={e ? tr(`t = ${num(e.t, 2)} · n = ${e.n} mois`, `t = ${num(e.t, 2)} · n = ${e.n} months`) : undefined} busy={dp.isFetching} />
        <Stat label={tr("Biais de Stambaugh estimé", "Estimated Stambaugh bias")} value={e ? signed(e.beta_bias) : "—"}
          foot={e ? tr(`${num((100 * e.beta_bias) / Math.abs(e.beta || 1e-12), 0)} % de β̂ · ρ̂ = ${num(e.rho, 4)}, corr(u, v) = ${num(e.corr_uv, 2)}`, `${num((100 * e.beta_bias) / Math.abs(e.beta || 1e-12), 0)}% of β̂ · ρ̂ = ${num(e.rho, 4)}, corr(u, v) = ${num(e.corr_uv, 2)}`) : undefined} busy={dp.isFetching} />
        <Stat label={tr("β corrigé (Amihud-Hurvich)", "Corrected β (Amihud-Hurvich)")} value={e ? signed(e.beta_ah) : "—"}
          foot={e ? tr(`t = ${num(e.t_ah, 2)} · Stambaugh : ${signed(e.beta_stambaugh)}`, `t = ${num(e.t_ah, 2)} · Stambaugh: ${signed(e.beta_stambaugh)}`) : undefined} busy={dp.isFetching} />
        <Stat label={tr("p-valeur par bootstrap", "Bootstrap p-value")} value={b ? pval(b.p_one_sided) : "—"}
          foot={b ? tr(`Seuil réel du t à 5 % : ${num(b.t_crit_95, 2)} au lieu de 1,65`, `Actual 5% t threshold: ${num(b.t_crit_95, 2)} instead of 1.65`) : undefined} busy={dp.isFetching} />
      </div>
      <div className="grid cols-2">
        <Card title={tr("β̂ quand rien n'est prévisible", "β̂ when nothing is predictable")}>
          {d ? <EChart option={dpNullOption} height={260} ariaLabel={tr("Distribution de β̂ sous l'hypothèse nulle, par bootstrap", "Bootstrap distribution of β̂ under the null")} /> : <Skeleton height={260} />}
          {b && e && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr(<>
                {b.n_boot} historiques simulés où les rendements sont leur moyenne plus des chocs tirés parmi les résidus, D/P gardant sa persistance
                et sa corrélation avec les rendements. Sans aucune prévisibilité, β̂ vaut en moyenne {signed(b.beta_null_mean)}, pas 0 : {pct(b.p_one_sided, 1)} des
                historiques donnent un β̂ au moins aussi grand que celui observé.
              </>, <>
                {b.n_boot} simulated histories where returns are their mean plus shocks drawn from the residuals, with D/P keeping its persistence
                and its correlation with returns. With no predictability at all, β̂ averages {signed(b.beta_null_mean)}, not 0: {pct(b.p_one_sided, 1)} of the
                histories give a β̂ at least as large as the one observed.
              </>)}
            </p>
          )}
        </Card>
        <Card title={tr("Selon la date de départ", "By start date")}
          actions={e && <button type="button" className="btn" onClick={() => loadSim(e.rho, e.corr_uv, e.n)}>{tr("Simuler ce cas", "Simulate this case")}</button>}>
          {d ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr>{[tr("Depuis", "Since"), "n", "ρ̂", "corr(u, v)", "β̂", "t", tr("Biais", "Bias"), tr("β corrigé", "Corrected β"), tr("t corrigé", "Corrected t")].map((h) => <th key={h}>{keepGreek(h)}</th>)}</tr></thead>
                <tbody>
                  {d.windows.map((w) => (
                    <tr key={w.start} className={w.start === d.start ? "strong" : undefined}>
                      <td>{w.first}</td><td>{w.n}</td><td>{num(w.rho, 4)}</td><td>{num(w.corr_uv, 2)}</td><td>{signed(w.beta)}</td>
                      <td>{num(w.t, 2)}</td><td>{signed(w.beta_bias)}</td><td>{signed(w.beta_ah)}</td><td>{num(w.t_ah, 2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Skeleton height={180} />}
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            {tr("Plus l'échantillon est court, plus le biais pèse : depuis 1950, la régression classique paraît significative au seuil usuel, mais le biais estimé en absorbe l'essentiel ; depuis 1990, il dépasse même le coefficient. Une fois corrigé, aucun échantillon ne montre de prévisibilité mensuelle significative. Les prix de Shiller sont des moyennes mensuelles des clôtures, ce qui ajoute un peu d'autocorrélation aux rendements.",
              "The shorter the sample, the more the bias weighs: since 1950 the classic regression looks significant at the usual level, but the estimated bias absorbs most of it; since 1990 it even exceeds the coefficient. Once corrected, no sample shows significant monthly predictability. Shiller's prices are monthly averages of closes, which adds a little autocorrelation to returns.")}
          </p>
        </Card>
      </div>

      <div ref={simRef} style={{ scrollMarginTop: 80 }}>
        <Card title={tr("Le mécanisme, simulé : des rendements imprévisibles par construction", "The mechanism, simulated: returns unpredictable by construction")}>
          <div className="toolbar-grid">
            <NumberField label={tr("Persistance ρ du prédicteur", "Predictor persistence ρ")} value={sim.rho} step={0.005} min={0} max={0.999} digits={4} onChange={(v) => setSim({ ...sim, rho: Math.min(0.999, Math.max(0, v)) })} />
            <NumberField label={tr("Corrélation des chocs corr(u, v)", "Shock correlation corr(u, v)")} value={sim.corr} step={0.05} min={-0.99} max={0.99} digits={3} onChange={(v) => setSim({ ...sim, corr: Math.min(0.99, Math.max(-0.99, v)) })} />
            <NumberField label={tr("Taille d'échantillon n", "Sample size n")} value={sim.n} step={20} min={20} max={2000} digits={0} onChange={(v) => setSim({ ...sim, n: Math.round(Math.min(2000, Math.max(20, v))) })} />
          </div>
        </Card>
      </div>
      <div className="grid cols-4">
        <Stat label={tr("Biais moyen de β̂", "Mean bias of β̂")} value={s ? signed(s.beta_bias, 4) : "—"}
          foot={s ? tr(`Formule de Stambaugh : ${signed(s.beta_bias_stambaugh, 4)} · en unités σ_u / σ_v`, `Stambaugh's formula: ${signed(s.beta_bias_stambaugh, 4)} · in σ_u / σ_v units`) : undefined} busy={mc.isFetching} />
        <Stat label={tr("Biais de ρ̂", "Bias of ρ̂")} value={s ? signed(s.rho_bias, 4) : "—"}
          foot={s ? tr(`Kendall, −(1 + 3ρ) / n : ${signed(s.rho_bias_kendall, 4)}`, `Kendall, −(1 + 3ρ) / n: ${signed(s.rho_bias_kendall, 4)}`) : undefined} busy={mc.isFetching} />
        <Stat label={tr("Faux positifs du t des MCO", "False positives of the OLS t-test")} value={s ? pct(s.size_ols_one_sided, 1) : "—"}
          foot={s ? tr(`au lieu de 5 % (test unilatéral) · bilatéral ${pct(s.size_ols_two_sided, 1)}`, `instead of 5% (one-sided) · two-sided ${pct(s.size_ols_two_sided, 1)}`) : undefined} busy={mc.isFetching} />
        <Stat label={tr("Faux positifs après correction", "False positives after correction")} value={s ? pct(s.size_ah_one_sided, 1) : "—"}
          foot={s ? tr(`Amihud-Hurvich · β moyen ${signed(s.beta_ah_mean, 4)}`, `Amihud-Hurvich · mean β ${signed(s.beta_ah_mean, 4)}`) : undefined} busy={mc.isFetching} />
      </div>
      <div className="grid cols-2">
        <Card title={tr("L'erreur sur ρ se reporte sur β", "The error on ρ carries over to β")}>
          {s ? <EChart option={scatterOption} height={280} ariaLabel={tr("Nuage des erreurs de ρ̂ et de β̂ simulées", "Scatter of simulated errors in ρ̂ and β̂")} /> : <Skeleton height={280} />}
          {s && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr(<>
                Chaque point est un échantillon de {s.n} observations ({s.scatter.rho_err.length} tracés sur {s.n_sims}). Comme u = γ v + bruit, β̂ − β = γ (ρ̂ − ρ) + bruit :
                ρ̂ sous-estime la persistance en moyenne, donc β̂ est poussé du côté opposé au signe de γ = {num(s.gamma, 2)}.
              </>, <>
                Each point is one sample of {s.n} observations ({s.scatter.rho_err.length} plotted out of {s.n_sims}). Since u = γ v + noise, β̂ − β = γ (ρ̂ − ρ) + noise:
                ρ̂ underestimates the persistence on average, so β̂ is pushed away from the sign of γ = {num(s.gamma, 2)}.
              </>)}
            </p>
          )}
        </Card>
        <Card title={tr("Le t de Student n'est plus normal", "The t-statistic is no longer normal")}>
          {s ? <EChart option={tOption} height={280} ariaLabel={tr("Distribution simulée du t de Student, MCO et Amihud-Hurvich", "Simulated distribution of the t-statistic, OLS and Amihud-Hurvich")} /> : <Skeleton height={280} />}
          {s && (
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr(<>
                Le vrai β est nul. Le t des MCO est décalé (moyenne {num(s.t_ols_mean, 2)}) et son quantile à 95 % vaut {num(s.t_ols_q95, 2)} au lieu de 1,65.
                La régression augmentée d'Amihud et Hurvich (2004) ajoute les résidus corrigés du prédicteur comme second régresseur : elle retire le biais et donne
                un écart-type utilisable.
              </>, <>
                The true β is zero. The OLS t is shifted (mean {num(s.t_ols_mean, 2)}) and its 95% quantile is {num(s.t_ols_q95, 2)} instead of 1.65.
                The augmented regression of Amihud and Hurvich (2004) adds the predictor's corrected residuals as a second regressor: it removes the bias and gives
                a usable standard error.
              </>)}
            </p>
          )}
        </Card>
      </div>

      <Card title={tr("Le score de sentiment des news prédit-il le rendement du lendemain ?", "Does the news sentiment score predict the next day's return?")}>
        <div className="toolbar-grid">
          <SelectField label={tr("Score et rendement", "Score and return")} value={target} onChange={setTarget}
            options={(st?.targets ?? ["US", "SPY", "QQQ", "AAPL", "MSFT", "NVDA"]).map((t) => ({ value: t, label: sentLabel(t) }))} />
          <SelectField label={tr("Lissage du score", "Score smoothing")} value={halflife} onChange={setHalflife}
            options={[{ value: 0, label: tr("Aucun", "None") }, { value: 3, label: tr("Demi-vie 3 séances", "3-session half-life") }, { value: 10, label: tr("Demi-vie 10 séances", "10-session half-life") }]} />
        </div>
        <p className="muted" style={{ fontSize: 12 }}>
          {tr("x_t est la moyenne des scores de Claude (−1 à +1) des titres publiés avant la clôture de 16 h à New York ; une news publiée après compte pour la séance suivante. « Marché US » regroupe les news de SPY, QQQ, AAPL, MSFT et NVDA face au rendement du SPY ; un titre seul est confronté à son propre rendement. Lisser le score (moyenne exponentielle) le rend persistant : c'est précisément ce qui l'expose au biais de Stambaugh.",
            "x_t is the average Claude score (−1 to +1) of the headlines published before the 4 pm New York close; a headline published later counts for the next session. \"US market\" pools the news on SPY, QQQ, AAPL, MSFT and NVDA against the SPY return; a single name faces its own return. Smoothing the score (exponential average) makes it persistent: that is exactly what exposes it to the Stambaugh bias.")}
        </p>
        {st ? <EChart option={sentOption} height={260} ariaLabel={tr("Score de sentiment quotidien et rendement du lendemain", "Daily sentiment score and next-day return")} /> : <Skeleton height={260} />}
      </Card>
      {st && !se_ && (
        <InfoBox>
          {tr(<>
            Pas encore assez de données : {st.n_headlines} titres notés couvrent {st.n_sessions_covered} séances ({st.first} → {st.last}), soit seulement {st.n} couples
            de séances consécutives exploitables (il en faut au moins 10 pour estimer quoi que ce soit, et plusieurs centaines pour conclure). La notation a été
            interrompue du 21 octobre au 23 novembre ; la série s'allonge à chaque séance. Le simulateur ci-dessus montre ce qu'on peut attendre d'un si petit
            échantillon.
          </>, <>
            Not enough data yet: {st.n_headlines} scored headlines cover {st.n_sessions_covered} sessions ({st.first} → {st.last}), only {st.n} usable pairs of
            consecutive sessions (at least 10 are needed to estimate anything, and several hundred to conclude). Scoring was interrupted from 21 October to
            23 November; the series grows with every session. The simulator above shows what to expect from such a small sample.
          </>)}
        </InfoBox>
      )}
      {st && se_ && st.bootstrap && (
        <>
          <div className="grid cols-4">
            <Stat label={tr("β̂ par les MCO", "OLS β̂")} value={`${signed(se_.beta * 1e3, 0)} bp`}
              foot={tr(`pour +0,1 de score · t = ${num(se_.t, 2)} · n = ${se_.n} séances`, `per +0.1 of score · t = ${num(se_.t, 2)} · n = ${se_.n} sessions`)} busy={se.isFetching} />
            <Stat label={tr("Persistance du signal ρ̂", "Signal persistence ρ̂")} value={num(se_.rho, 3)}
              foot={tr(`corr(u, v) = ${num(se_.corr_uv, 2)} · biais estimé ${signed(se_.beta_bias * 1e3, 0)} bp`, `corr(u, v) = ${num(se_.corr_uv, 2)} · estimated bias ${signed(se_.beta_bias * 1e3, 0)} bp`)} busy={se.isFetching} />
            <Stat label={tr("β corrigé (Amihud-Hurvich)", "Corrected β (Amihud-Hurvich)")} value={`${signed(se_.beta_ah * 1e3, 0)} bp`}
              foot={`t = ${num(se_.t_ah, 2)}`} busy={se.isFetching} />
            <Stat label={tr("p-valeur par bootstrap", "Bootstrap p-value")} value={pval(st.bootstrap.p_two_sided)}
              foot={tr("bilatérale : le signe attendu n'est pas connu d'avance", "two-sided: the expected sign is not known in advance")} busy={se.isFetching} />
          </div>
          <Card title={tr("β̂ du sentiment quand rien n'est prévisible", "Sentiment β̂ when nothing is predictable")}
            actions={<button type="button" className="btn" onClick={() => loadSim(se_.rho, se_.corr_uv, se_.n)}>{tr("Simuler ce cas", "Simulate this case")}</button>}>
            <EChart option={sentNullOption} height={240} ariaLabel={tr("Distribution de β̂ du sentiment sous l'hypothèse nulle", "Null distribution of the sentiment β̂")} />
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr(`${st.n} couples de séances seulement (${st.first} → ${st.last}) : sous l'hypothèse nulle, 90 % des β̂ tombent entre ${signed(st.bootstrap.beta_null_q05 * 1e3, 0)} et ${signed(st.bootstrap.beta_null_q95 * 1e3, 0)} bp (pour +0,1 de score).`,
                `Only ${st.n} pairs of sessions (${st.first} → ${st.last}): under the null, 90% of the β̂ fall between ${signed(st.bootstrap.beta_null_q05 * 1e3, 0)} and ${signed(st.bootstrap.beta_null_q95 * 1e3, 0)} bp (per +0.1 of score).`)}{" "}
              {st.bootstrap.p_two_sided < 0.05
                ? tr("Le coefficient sort de cet intervalle, mais sur quelques semaines, avec quelques journées extrêmes qui pèsent lourd, et après avoir essayé six séries et trois lissages : un tel résultat doit être confirmé sur de nouvelles données avant d'y croire. Un β négatif signifierait que les bonnes nouvelles du jour précèdent un repli le lendemain (surréaction puis retour).",
                  "The coefficient falls outside that interval, but over a few weeks, with a few extreme days weighing heavily, and after trying six series and three smoothings: such a result must be confirmed on new data before it is believed. A negative β would mean that the day's good news precedes a pull-back the next day (overreaction, then reversal).")
                : tr("Le coefficient reste dans l'intervalle : rien ne distingue ce signal du bruit sur si peu de données.",
                  "The coefficient stays within that interval: nothing tells this signal apart from noise with so little data.")}
            </p>
          </Card>
        </>
      )}
      <InfoBox>
        {tr(<>
          Le même biais touche tout prédicteur persistant dont les chocs sont corrélés au rendement : rendement du dividende, PER, taux courts, écarts de crédit,
          volatilité réalisée. C'est l'une des raisons pour lesquelles la prévisibilité des rendements boursiers, si nette dans les régressions classiques,
          résiste mal aux corrections et aux tests hors échantillon (Goyal et Welch, 2008). La volatilité, à l'inverse, se prévoit très bien : c'est l'idée
          des portefeuilles gérés par la volatilité.
        </>, <>
          The same bias hits any persistent predictor whose shocks are correlated with the return: dividend yield, P/E, short rates, credit spreads, realised
          volatility. It is one of the reasons why stock-return predictability, so clear in classic regressions, holds up poorly against corrections and
          out-of-sample tests (Goyal and Welch, 2008). Volatility, by contrast, is highly predictable: that is the idea behind volatility-managed portfolios.
        </>)}
      </InfoBox>
    </div>
  );
}
