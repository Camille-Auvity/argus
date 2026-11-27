import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { measuresApi, stochasticApi, theoryApi, type MeasureStats, type HedgeRequest, type ImportanceRequest, type TreeRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
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
] as const;

export default function Theory() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Théorie appliquée", "Applied theory")}</h1>
          <div className="page-sub">
            {tr("Les résultats du cours de finance en temps continu, recalculés et testés : réplication et probabilité risque-neutre, couverture dynamique et passage au temps continu.",
              "Continuous-time finance results, recomputed and tested: replication and the risk-neutral measure, dynamic hedging and the passage to continuous time.")}
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label={tr("Théorie appliquée", "Applied theory")}>
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
