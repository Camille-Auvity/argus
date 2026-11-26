import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { measuresApi, stochasticApi, theoryApi, type MeasureStats, type HedgeRequest, type ImportanceRequest, type TreeRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export const THEORY_PAGES = [
  { path: "replication", label: "Réplication sur l'arbre" },
  { path: "couverture", label: "Couverture dynamique en delta" },
  { path: "calcul-stochastique", label: "Calcul stochastique" },
  { path: "girsanov", label: "Girsanov et échantillonnage préférentiel" },
  { path: "p-vs-q", label: "Monde réel et risque-neutre" },
] as const;

export default function Theory() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Théorie appliquée</h1>
          <div className="page-sub">
            Les résultats du cours de finance en temps continu, recalculés et testés : réplication et probabilité risque-neutre,
            couverture dynamique et passage au temps continu.
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label="Théorie appliquée">
        {THEORY_PAGES.map((m) => (
          <NavLink key={m.path} to={`/theory/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
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
      tooltip: { formatter: () => `Nœud (t=${n.step}, ${n.ups} hausse${n.ups > 1 ? "s" : ""})<br/>S = ${num(n.spot, 3)} · V = ${num(n.value, 4)}` +
        (n.delta != null ? `<br/>Δ = ${num(n.delta, 4)} · B = ${num(n.bond, 4)}` : `<br/>payoff = ${num(n.payoff, 3)}`) +
        `<br/>Q(atteindre le nœud) = ${num(n.probability, 4)} (${n.path_count} chemin${n.path_count > 1 ? "s" : ""})` },
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
        <Card title="Marché et option">
          <div className="form">
            <div className="form-row">
              <NumberField label="Spot S₀" value={req.S0} min={0.01} digits={2} onChange={(S0) => set({ S0 })} />
              <NumberField label="Strike K" value={req.K} min={0.01} digits={2} onChange={(K) => set({ K })} />
            </div>
            <div className="form-row">
              <NumberField label="Hausse u" value={req.u} min={1.0001} digits={3} onChange={(u) => set({ u })} />
              <NumberField label="Baisse d" value={req.d} min={0.01} max={0.9999} digits={3} onChange={(d) => set({ d })} />
            </div>
            <div className="form-row">
              <NumberField label="Taux brut R / période" value={req.R} min={0.5} digits={3} hint="1,05 = 5 % par période" onChange={(R) => set({ R })} />
              <SelectField label="Périodes" value={req.steps} onChange={(steps) => set({ steps })} options={[1, 2, 3, 4, 5, 6].map((v) => ({ value: v, label: String(v) }))} />
            </div>
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })} options={[{ value: "put", label: "Put" }, { value: "call", label: "Call" }]} />
            <Check label="Exercice américain" checked={req.american} onChange={(american) => set({ american })} />
            <div className="form-sep" />
            <div className="form-group-title">Market maker</div>
            <NumberField label="Prix de vente (ask)" value={req.ask} min={0} digits={2} onChange={(ask) => set({ ask })} />
            <div>
              <div className="field-label" style={{ marginBottom: 6 }}>Chemin suivi</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {path.split("").map((m, i) => (
                  <button key={i} type="button" className="btn" style={{ padding: "3px 10px" }}
                    onClick={() => set({ path: path.slice(0, i) + (m === "u" ? "d" : "u") + path.slice(i + 1) })}>
                    t{i + 1} : {m === "u" ? "hausse" : "baisse"}
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
          À chaque nœud, on cherche Δ actions et B en banque qui redonnent la valeur de l'option dans les deux états suivants :
          Δ = (V<sub>u</sub> − V<sub>d</sub>) / (S<sub>u</sub> − S<sub>d</sub>), B = (V<sub>u</sub> − Δ S<sub>u</sub>) / R. Le coût du portefeuille, Δ S + B, est le
          prix sans arbitrage. Il s'écrit aussi [π V<sub>u</sub> + (1 − π) V<sub>d</sub>] / R avec π = (R − d) / (u − d) : une probabilité
          dite risque-neutre, sous laquelle l'action rapporte exactement le taux sans risque. Elle existe si et seulement si d &lt; R &lt; u.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Prix (réplication)" value={num(data?.price, 3)} foot={data?.direct_value != null ? `Σ chemins Q × payoff / Rᴺ = ${num(data.direct_value, 3)}` : "Américain : induction avec exercice"} busy={isFetching} />
          <Stat label="Probabilité risque-neutre π" value={num(data?.pi, 4)} foot={`E_Q[S₁/S₀] = ${num(data ? data.pi * req.u + (1 - data.pi) * req.d : null, 3)} = R`} busy={isFetching} />
          <Stat label="Couverture initiale" value={root ? `Δ = ${num(root.delta, 4)}` : "—"} foot={root ? `B = ${num(root.bond, 3)} en banque` : undefined} busy={isFetching} />
          <Stat label="Marge du market maker" value={mm ? num(mm.spread_kept, 3) : "—"} foot={mm ? `Couverture − passif à l'échéance : ${signedNum(mm.net, 6)}` : undefined} busy={isFetching} />
        </div>
        <Card title="Arbre : valeur et couverture à chaque nœud (chemin suivi en orange)">
          {data ? <EChart option={treeOption} height={Math.max(320, req.steps * 110)} ariaLabel="Arbre binomial avec les couvertures" /> : <Skeleton height={320} />}
        </Card>
        <Card title="Autofinancement : la couverture posée au nœud parent vaut exactement l'option à chaque nœud enfant" flush>
          {data ? (
            <div className="table-wrap" style={{ maxHeight: 320, overflowY: "auto" }}>
              <table className="data">
                <thead><tr><th>t</th><th>Hausses</th><th>S</th><th>V</th><th>Δ</th><th>B</th><th>Couverture du parent ici</th><th>Q(nœud)</th><th>Chemins</th></tr></thead>
                <tbody>
                  {data.nodes.map((n) => (
                    <tr key={`${n.step}-${n.ups}`}>
                      <td>{n.step}</td><td>{n.ups}</td><td>{num(n.spot, 2)}</td><td className="strong">{num(n.value, 4)}{n.exercised ? " (exercé)" : ""}</td>
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
        <Card title={`Le market maker vend à ${num(req.ask, 2)} et couvre le long du chemin ${path.toUpperCase()}`} flush>
          {mm ? (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>t</th><th>Mouvement</th><th>S</th><th>Δ avant → après</th><th>Actions échangées</th><th>Flux du rebalancement</th><th>Cash avant → après</th><th>Valeur couverture</th><th>Valeur option</th></tr></thead>
                <tbody>
                  {mm.steps.map((s) => (
                    <tr key={s.step}>
                      <td>{s.step}</td><td>{s.move ? (s.move === "u" ? "hausse" : "baisse") : "départ"}</td><td>{num(s.spot, 2)}</td>
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
          Au départ, le market maker encaisse l'ask, garde la marge (ask − prix) et place le reste dans la couverture. À chaque nœud, le
          rebalancement est entièrement financé par le compte en banque : on ne rajoute ni ne retire d'argent (autofinancement). À
          l'échéance, la couverture vaut exactement ce qu'il doit au client, quel que soit le chemin : seule la marge initiale reste.
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
      xAxis: { type: "value", name: "P&L du vendeur couvert", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax", axisLabel: { formatter: (v: number) => num(v, 1) } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [{ type: "bar", barWidth: "95%", color: p.series[0], data: h.counts.map((c, i) => [(h.edges[i] + h.edges[i + 1]) / 2, c / total]),
        markLine: { symbol: "none", silent: true, label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: [{ xAxis: data.pnl.mean, name: "moyenne", lineStyle: { color: p.series[1], width: 2 } },
            ...(req.sigma_real !== req.sigma_implied ? [{ xAxis: data.locked, name: "BS(σᵢ) − BS(σᵣ)", lineStyle: { color: p.critical, type: "dashed" } }] : [])] } }],
    };
  }, [data, req.sigma_real, req.sigma_implied]);

  const convOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 3) },
      xAxis: { type: "log", name: "rebalancements", nameLocation: "middle", nameGap: 26, min: 3 },
      yAxis: { type: "log", name: "écart-type du P&L" },
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
      xAxis: { type: "value", name: "vol réalisée", nameLocation: "middle", nameGap: 26, min: m[0].sigma_real - step / 2,
        max: m[m.length - 1].sigma_real + step / 2, axisLabel: { showMinLabel: false, showMaxLabel: false, formatter: (v: number) => pct(v, 0) } },
      yAxis: [{ type: "value", name: "P&L moyen", nameTextStyle: { align: "left" } },
        { type: "value", name: "écart-type", nameTextStyle: { align: "right" }, splitLine: { show: false }, min: 0 }],
      series: [
        { type: "bar", name: "Écart-type, couverture à σᵢ", yAxisIndex: 1, barWidth: 9, barGap: "20%", color: p.series[0],
          itemStyle: { opacity: 0.35 }, data: m.map((x) => [x.sigma_real, x.implied_hedge_sd]) },
        { type: "bar", name: "Écart-type, couverture à σᵣ", yAxisIndex: 1, barWidth: 9, color: p.series[2],
          itemStyle: { opacity: 0.35 }, data: m.map((x) => [x.sigma_real, x.realized_hedge_sd]) },
        { type: "line", name: "Moyenne, couverture à σᵢ", color: p.series[0], symbolSize: 9, lineStyle: { width: 3 }, z: 3,
          data: m.map((x) => [x.sigma_real, x.implied_hedge_mean]) },
        { type: "line", name: "Moyenne, couverture à σᵣ", color: p.series[2], symbol: "diamond", symbolSize: 7, lineStyle: { width: 1.5, type: "dashed" }, z: 4,
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
      xAxis: { type: "category", name: "rebalancement", nameLocation: "middle", nameGap: 26, data: x },
      yAxis: [{ type: "value", name: "P&L cumulé" }, { type: "value", name: "spot", scale: true, splitLine: { show: false } }],
      series: [
        { type: "line", name: "P&L réel de la position couverte", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: data.path.pnl },
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
        { type: "bar", name: "P&L du call vendu et couvert", tooltip: { valueFormatter: (v: number) => pct(v, 2) },
          data: r.map((x) => ({ value: x.pnl_pct, itemStyle: { color: x.pnl_pct >= 0 ? p.diverging[2] : p.diverging[0] } })) },
        { type: "line", name: "Vol implicite (VIX)", yAxisIndex: 1, color: p.series[1], symbolSize: 5, tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: r.map((x) => x.implied) },
        { type: "line", name: "Vol réalisée sur le mois", yAxisIndex: 1, color: p.series[0], symbolSize: 5, tooltip: { valueFormatter: (v: number) => pct(v, 1) }, data: r.map((x) => x.realized) },
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
              <NumberField label="Maturité" value={req.T} suffix="jours" scale={365} min={5 / 365} max={3} digits={0} onChange={(T) => set({ T })} />
              <NumberField label="Taux" value={req.r} suffix="%" scale={100} digits={2} onChange={(r) => set({ r })} />
            </div>
            <div className="form-row">
              <NumberField label="Vol implicite (prix)" value={req.sigma_implied} suffix="%" scale={100} min={0.01} digits={1} onChange={(sigma_implied) => set({ sigma_implied })} />
              <NumberField label="Vol réalisée" value={req.sigma_real} suffix="%" scale={100} min={0.01} digits={1} onChange={(sigma_real) => set({ sigma_real })} />
            </div>
            <NumberField label="Drift réel μ (monde P)" value={req.mu} suffix="%" scale={100} digits={1} hint="N'entre pas dans le prix de l'option" onChange={(mu) => set({ mu })} />
            <div className="form-row">
              <SelectField label="Rebalancements" value={req.n_rebalance} onChange={(n_rebalance) => set({ n_rebalance })}
                options={[4, 13, 26, 52, 126, 252].map((v) => ({ value: v, label: String(v) }))} />
              <SelectField label="Trajectoires" value={req.n_paths} onChange={(n_paths) => set({ n_paths })}
                options={[5_000, 10_000, 20_000].map((v) => ({ value: v, label: v.toLocaleString("fr-FR") }))} />
            </div>
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })} options={[{ value: "call", label: "Call vendu" }, { value: "put", label: "Put vendu" }]} />
            <Segmented label="Delta calculé avec" value={req.hedge_vol} onChange={(hedge_vol) => set({ hedge_vol })}
              options={[{ value: "implied", label: "Vol implicite" }, { value: "realized", label: "Vol réalisée" }]} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          On vend l'option au prix de Black-Scholes et on la couvre en delta N fois jusqu'à l'échéance, sur des trajectoires simulées
          dans le monde réel (drift μ). C'est la version continue de l'arbre : quand N grandit, la couverture discrète tend vers une
          réplication parfaite parce que la variation quadratique du sous-jacent, (dS)² = σ²S² dt, devient déterministe.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Prime encaissée" value={num(data?.premium, 3)} foot={data ? `Vega ${num(data.vega, 2)}` : undefined} busy={isFetching} />
          <Stat label="P&L moyen" value={signedNum(data?.pnl.mean, 3)} foot={data ? `Prévision gamma-theta ${signedNum(data.gamma_theta_mean, 3)}` : undefined} busy={isFetching} />
          <Stat label="Écart-type du P&L" value={num(data?.pnl.sd, 3)} foot={data ? `Derman-Kamal : ${num(data.derman_kamal, 3)}` : undefined} busy={isFetching} />
          <Stat label="Intervalle 90 %" value={data ? `${signedNum(data.pnl.p05, 2)} / ${signedNum(data.pnl.p95, 2)}` : "—"} foot={`${req.n_rebalance} rebalancements`} busy={isFetching} />
        </div>
        <div className="grid cols-2">
          <Card title="Distribution du P&L de la position couverte">
            {data ? <EChart option={histOption} height={300} ariaLabel="Distribution du P&L de couverture" /> : <Skeleton height={260} />}
          </Card>
          <Card title="Erreur de couverture : décroissance en 1/√N">
            {data ? <EChart option={convOption} height={300} ariaLabel="Écart-type du P&L selon le nombre de rebalancements" /> : <Skeleton height={260} />}
          </Card>
        </div>
        <Card title="Une trajectoire : le P&L s'explique par gamma et theta">
          {data ? <EChart option={pathOption} height={320} ariaLabel="P&L cumulé d'une trajectoire et approximation gamma-theta" /> : <Skeleton height={280} />}
        </Card>
        <div className="grid cols-2">
          <Card title="Le drift réel ne change pas le P&L moyen">
            {data ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>μ (monde réel)</th>{data.drift.map((x) => <th key={x.mu}>{pct(x.mu, 0)}</th>)}</tr></thead>
                  <tbody><tr><td className="strong">P&L moyen</td>{data.drift.map((x) => <td key={x.mu}>{signedNum(x.mean, 3)}</td>)}</tr></tbody>
                </table>
              </div>
            ) : <Skeleton height={80} />}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              Le prix est le coût de la réplication : il ne dépend pas de μ. C'est la probabilité risque-neutre de la Lecture 2, en continu (Girsanov change le drift, pas la vol).
              Les petits écarts (moins de 1 % de la prime, 52 rebalancements) viennent de la discrétisation et disparaissent quand N augmente.
            </p>
          </Card>
          <Card title="Vol réalisée ≠ vol implicite">
            {data ? <EChart option={mismatchOption} height={340} ariaLabel="P&L moyen et écart-type selon la vol réalisée" /> : <Skeleton height={300} />}
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              Les deux couvertures ont le même P&L moyen, BS(σᵢ) − BS(σᵣ) : les courbes se superposent. Ce qui les distingue, c'est la dispersion (barres) :
              couvert à la vol réalisée, le résultat est presque verrouillé ; couvert à la vol implicite, il dépend du chemin.
            </p>
          </Card>
        </div>
        <InfoBox>
          Sur un pas, la position vendue et couverte gagne ½ Γ S² (σᵢ² dt − (dS/S)²) : le theta encaissé contre les pertes de gamma.
          Si la vol réalisée est sous la vol implicite, le vendeur gagne en moyenne. Couvert à la vol implicite, son P&L dépend du chemin
          (le gamma est fort près du strike) ; couvert à la vol réalisée, il verrouille BS(σᵢ) − BS(σᵣ), avec moins de dispersion.
        </InfoBox>
        <Card title="Sur données réelles : vendre chaque mois un call SPY à 1 mois au VIX et le couvrir chaque jour">
          {bt.error ? <ErrorBox error={bt.error} /> : bt.data && s ? (
            <>
              <div className="grid cols-4" style={{ marginBottom: 12 }}>
                <Stat label="P&L moyen / mois" value={pct(s.mean_pnl_pct, 2)} foot="En % du spot" />
                <Stat label="Mois gagnants" value={pct(s.hit_rate, 0)} foot={`${s.n} mois`} />
                <Stat label="Pire / meilleur mois" value={`${pct(s.worst_pct, 2)} / ${pct(s.best_pct, 2)}`} />
                <Stat label="Corrélation avec gamma-theta" value={num(s.corr_gamma_theta, 3)} foot={`VIX moyen ${pct(s.mean_implied, 1)} · réalisée ${pct(s.mean_realized, 1)}`} />
              </div>
              <EChart option={btOption} height={340} ariaLabel="P&L mensuel du call vendu et couvert, vol implicite et réalisée" />
            </>
          ) : <Skeleton height={300} />}
        </Card>
        <InfoBox>
          Chaque mois, le P&L de la position couverte suit presque exactement ½ Σ Γ S² (σᵢ² dt − r²) : il gagne quand la vol réalisée reste
          sous le VIX, ce qui arrive la plupart du temps (prime de risque de variance), et perd lors des mois agités. C'est le même pari que la
          vente d'un swap de variance, mais pondéré par le gamma, donc concentré autour du strike.
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
      xAxis: { type: "log", name: "nombre de pas N", nameLocation: "middle", nameGap: 26, min: 2 },
      yAxis: [{ type: "log", name: "Σ |ΔB|" }, { type: "value", name: "Σ (ΔB)²", min: 0, max: 2, splitLine: { show: false } }],
      series: [
        { type: "line", name: "Variation totale (simulée)", color: p.series[0], symbolSize: 7, data: v.map((x) => [x.n, x.total_variation]) },
        { type: "line", name: "√(2N/π)", color: p.series[0], showSymbol: false, lineStyle: { type: "dashed" }, data: v.map((x) => [x.n, x.total_variation_theory]) },
        { type: "line", name: "Variation quadratique ± 1 écart-type", yAxisIndex: 1, color: p.series[1], symbolSize: 7, data: v.map((x) => [x.n, x.quadratic_variation]) },
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
        { type: "bar", name: "Somme au point gauche (Itô)", color: p.series[0], barGap: "-100%", itemStyle: { opacity: 0.6 }, data: mid.map((m, i) => [m, h.left[i]]),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.series[0] }, label: { formatter: "E = 0", color: p.muted }, data: [{ xAxis: data.ito.mean_left }] } },
        { type: "bar", name: "Somme au point droit", color: p.series[1], itemStyle: { opacity: 0.6 }, data: mid.map((m, i) => [m, h.right[i]]),
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
        Les exercices de la Lecture 3, vérifiés sur des milliers de trajectoires simulées : un mouvement brownien n'a pas de longueur
        finie mais sa variation quadratique est déterministe, (dB)² = dt. C'est ce qui oblige à choisir un point d'évaluation dans
        l'intégrale stochastique et qui crée le terme ½ σ² f'' du lemme d'Itô.
      </Explainer>
      <div className="grid cols-4">
        <Stat label="Variation totale (N = 4 096)" value={last ? num(last.total_variation, 1) : "—"} foot={last ? `√(2N/π) = ${num(last.total_variation_theory, 1)} → ∞` : undefined} />
        <Stat label="Variation quadratique" value={last ? num(last.quadratic_variation, 4) : "—"} foot={last ? `écart-type ${num(last.quadratic_variation_sd, 4)} (théorie √(2/N) = ${num(last.quadratic_variation_sd_theory, 4)})` : undefined} />
        <Stat label="E[Σ B ΔB] point gauche" value={data ? num(data.ito.mean_left, 3) : "—"} foot="Théorie : 0 (l'intégrale d'Itô est une martingale)" />
        <Stat label="E[Σ B ΔB] point droit" value={data ? num(data.ito.mean_right, 3) : "—"} foot={data ? `Théorie : T = ${num(data.ito.T, 0)}` : undefined} />
      </div>
      <div className="grid cols-2">
        <Card title="Trajectoires browniennes et bande ±1,96 √t">
          {data ? <EChart option={pathsOption} height={320} ariaLabel="Trajectoires browniennes" /> : <Skeleton height={280} />}
        </Card>
        <Card title="Variation totale contre variation quadratique">
          {data ? <EChart option={variationOption} height={320} ariaLabel="Variations totale et quadratique selon le nombre de pas" /> : <Skeleton height={280} />}
        </Card>
      </div>
      <div className="grid cols-2">
        <Card title="∫ B dB : le point d'évaluation change le résultat">
          {data ? <EChart option={itoOption} height={300} ariaLabel="Distribution des sommes à gauche et à droite" /> : <Skeleton height={260} />}
        </Card>
        <Card title="Une trajectoire : la somme d'Itô suit ½ B_t² − ½ t">
          {data ? <EChart option={exampleOption} height={300} ariaLabel="Somme d'Itô le long d'une trajectoire" /> : <Skeleton height={260} />}
        </Card>
      </div>
      <InfoBox>
        R<sub>N</sub> − L<sub>N</sub> = Σ (ΔB)² → T : évaluer l'intégrande à droite ajoute exactement la variation quadratique. La convention d'Itô
        (à gauche : on choisit sa position avant de voir le choc) donne une martingale, et le lemme d'Itô retrouve d(B²) = 2B dB + dt.
      </InfoBox>
      <Card title={`Martingales et non-martingales (λ = ${data ? num(data.martingales.lambda, 1) : "…"})`}>
        {data ? <EChart option={martOption} height={340} ariaLabel="Espérances de martingales et de processus qui n'en sont pas" /> : <Skeleton height={300} />}
      </Card>
      <InfoBox>
        B<sub>t</sub>, B<sub>t</sub>² − t et e^(λB<sub>t</sub> − λ²t/2) gardent une espérance constante (exercice 6 du cours). Sans leur terme
        correctif, B<sub>t</sub>² et e^(λB<sub>t</sub>) dérivent : E[B<sub>t</sub>²] = t et E[e^(λB<sub>t</sub>)] = e^(λ²t/2), la transformée de Laplace
        de l'exercice 3. C'est la même correction qui rend e^(−σ²t/2 + σB<sub>t</sub>) martingale dans le prix actualisé de Black-Scholes.
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
      yAxis: [{ type: "value", name: "densité" }, { type: "value", name: "poids Y", splitLine: { show: false } }],
      series: [
        { type: "line", name: "Densité sous P : N(0, T)", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 },
          data: x.b.map((b, i) => [b, x.density_P[i]]) },
        { type: "line", name: "Densité sous Q : N(θT, T)", showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 }, areaStyle: { opacity: 0.12 },
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
      xAxis: { type: "value", name: "décalage θ", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax",
        axisLabel: { formatter: (v: number) => num(v, 1) } },
      yAxis: { type: "log", name: "erreur standard" },
      series: [{ type: "line", name: "Erreur standard", symbolSize: 6, color: p.series[0], lineStyle: { width: 2 }, data: d.theta_grid.map((x) => [x.theta, Math.max(x.se, 1e-12)]),
        markLine: { symbol: "none", silent: true, lineStyle: { color: p.series[1], type: "dashed" }, label: { formatter: "θ* (médiane au strike)", color: p.muted },
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
      xAxis: { type: "log", name: "trajectoires", nameLocation: "middle", nameGap: 26, min: 800 },
      yAxis: { type: "value", scale: true },
      series: [
        { type: "line", name: "Monte Carlo simple", color: p.series[1], symbolSize: 6, data: d.convergence.map((c) => [c.n, c.plain]) },
        { type: "line", color: p.series[1], showSymbol: false, lineStyle: { type: "dotted", width: 1 }, data: band("plain", "plain_se", 1) },
        { type: "line", color: p.series[1], showSymbol: false, lineStyle: { type: "dotted", width: 1 }, data: band("plain", "plain_se", -1) },
        { type: "line", name: "Échantillonnage préférentiel", color: p.series[0], symbolSize: 6, lineStyle: { width: 2 }, data: d.convergence.map((c) => [c.n, c.importance]) },
        { type: "line", name: "Prix exact", color: p.muted, showSymbol: false, lineStyle: { type: "dashed" }, data: d.convergence.map((c) => [c.n, d.exact]) },
      ],
    };
  }, [d]);

  return (
    <div className="grid">
      <ErrorBox error={g.error ?? imp.error} />
      <Explainer>
        Radon-Nikodym et Girsanov : multiplier par Y = exp(θB<sub>T</sub> − θ²T/2) définit une nouvelle probabilité Q, sous laquelle
        B<sub>T</sub> suit N(θT, T) et B<sub>t</sub> − θt est un mouvement brownien. Les trajectoires possibles sont les mêmes, seuls leurs poids
        changent : la dérive bouge, pas la volatilité.
      </Explainer>
      <Card title="Changement de mesure">
        <div className="toolbar-grid" style={{ marginBottom: 12 }}>
          <NumberField label="θ (dérive sous Q)" value={theta} min={-3} max={3} digits={2} onChange={setTheta} />
          <NumberField label="T" value={T} min={0.1} max={5} digits={2} onChange={setT} />
          <Stat label="E_P[Y]" value={g.data ? num(g.data.mean_weight, 4) : "—"} foot={g.data ? `± ${num(g.data.mean_weight_se, 4)} : Y est une densité` : undefined} />
          <Stat label="E_P[Y B_T] = E_Q[B_T]" value={g.data ? num(g.data.q_mean_by_weighting, 3) : "—"} foot={g.data ? `théorie θT = ${num(g.data.q_mean_theory, 3)}` : undefined} />
        </div>
        {g.data ? <EChart option={densityOption} height={320} ariaLabel="Densités de B_T sous P et sous Q" /> : <Skeleton height={280} />}
      </Card>
      <Card title="Application : échantillonnage préférentiel dans le Monte Carlo">
        <Explainer>
          Pour une option très hors de la monnaie, presque toutes les trajectoires finissent à zéro et l'estimateur est très bruité. On
          simule donc sous Q, avec une dérive θ qui amène la médiane de S<sub>T</sub> au strike, et on corrige chaque trajectoire par
          dP/dQ = exp(−θW<sub>T</sub> + θ²T/2) : E<sub>P</sub>[payoff] = E<sub>Q</sub>[payoff · dP/dQ]. Le prix reste sans biais, la variance s'effondre.
          L'option est disponible dans les pricers Monte Carlo de la plateforme (vanilles et exotiques).
        </Explainer>
        <div className="toolbar-grid" style={{ margin: "12px 0" }}>
          <SelectField label="Produit" value={req.product} onChange={(product) => set({ product, K: product === "put" ? 65 : product === "digital" ? 140 : 150 })}
            options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }, { value: "digital", label: "Digitale (cash)" }]} />
          <NumberField label="Strike" value={req.K} min={1} digits={1} onChange={(K) => set({ K })} />
          <NumberField label="Maturité" value={req.T} suffix="ans" min={0.02} max={5} digits={2} onChange={(T) => set({ T })} />
          <NumberField label="Vol" value={req.vol} suffix="%" scale={100} min={0.01} digits={1} onChange={(vol) => set({ vol })} />
          <SelectField label="Trajectoires" value={req.n_paths} onChange={(n_paths) => set({ n_paths })}
            options={[5_000, 20_000, 50_000].map((v) => ({ value: v, label: v.toLocaleString("fr-FR") }))} />
        </div>
        <div className="grid cols-4">
          <Stat label="Prix exact" value={num(d?.exact, 6)} foot={d ? `Proba de finir dans la monnaie ${pct(d.itm_probability, 2)}` : undefined} busy={imp.isFetching} />
          <Stat label="Monte Carlo simple" value={d ? num(d.plain.price, 6) : "—"} foot={d ? `± ${num(1.96 * d.plain.se, 6)}` : undefined} busy={imp.isFetching} />
          <Stat label="Échantillonnage préférentiel" value={d ? num(d.importance.price, 6) : "—"} foot={d ? `± ${num(1.96 * d.importance.se, 6)} (θ* = ${num(d.theta_star, 2)})` : undefined} busy={imp.isFetching} />
          <Stat label="Variance divisée par" value={d?.variance_reduction != null ? num(d.variance_reduction, 0) : "—"} foot="À nombre de trajectoires égal" busy={imp.isFetching} />
        </div>
      </Card>
      <div className="grid cols-2">
        <Card title="Erreur standard selon le décalage θ">
          {d ? <EChart option={thetaOption} height={300} ariaLabel="Erreur standard selon le décalage de Girsanov" /> : <Skeleton height={260} />}
        </Card>
        <Card title="Convergence : intervalle de confiance à 95 %">
          {d ? <EChart option={convOption} height={300} ariaLabel="Convergence du Monte Carlo simple et préférentiel" /> : <Skeleton height={260} />}
        </Card>
      </div>
      <InfoBox>
        Le décalage optimal est proche de θ*, qui place la médiane de S<sub>T</sub> au strike ; trop décaler dégrade à nouveau l'estimateur,
        car quelques poids deviennent énormes. À la monnaie, il n'y a presque rien à gagner. C'est la même mécanique que le passage de la
        probabilité réelle à la probabilité risque-neutre : Girsanov change les poids des trajectoires, pas les trajectoires.
      </InfoBox>
    </div>
  );
}

// ----------------------------------------------------------------------------- real world P vs risk-neutral Q

const HORIZONS = [{ value: 30, label: "1 mois" }, { value: 91, label: "3 mois" }, { value: 182, label: "6 mois" }, { value: 365, label: "1 an" }];
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
      { type: "line", name: "P : lognormale, dérive μ", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: line(d.density.P),
        markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dotted" }, label: { color: p.muted, fontSize: 10, position: "end" },
          data: [{ xAxis: d.S0, label: { formatter: "S₀" } }] } },
      { type: "line", name: "Q : lognormale, dérive r", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: line(d.density.Q) },
      { type: "line", name: "Q du marché : smile SVI (Breeden-Litzenberger)", showSymbol: false, color: p.series[2], lineStyle: { width: 2.5 },
        areaStyle: { opacity: 0.12 }, data: line(d.density.Q_smile) },
    ];
    if (d.empirical_hist) {
      const e = d.empirical_hist;
      series.push({ type: "bar", name: "P empirique (historique)", color: p.muted, itemStyle: { opacity: 0.35 }, barWidth: "90%", barGap: "-100%",
        data: e.density.map((v, i) => [(e.edges[i] + e.edges[i + 1]) / 2, v]).filter((x) => x[0] >= lo && x[0] <= hi) });
    }
    return {
      legend: { top: 0 },
      grid: { top: 60, right: 24 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
      xAxis: { type: "value", name: "S_T", nameLocation: "middle", nameGap: 26, min: lo, max: hi, axisLabel: { showMinLabel: false, showMaxLabel: false, formatter: (v: number) => num(v, 0) } },
      yAxis: { type: "value", name: "densité", axisLabel: { formatter: (v: number) => num(v, 3) } },
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
      xAxis: { type: "value", name: "jours", nameLocation: "middle", nameGap: 26, min: 0, max: x[x.length - 1] },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => num(v, 0) } },
      series: [
        mk("P", 2, "P : médiane", p.series[0], "solid", 2.5), mk("P", 0, "P : quantiles 5 % et 95 %", p.series[0], "dotted", 1.2), mk("P", 4, undefined, p.series[0], "dotted", 1.2),
        mk("Q", 2, "Q lognormale : médiane", p.series[1], "dashed", 2), mk("Q", 0, undefined, p.series[1], "dotted", 1), mk("Q", 4, undefined, p.series[1], "dotted", 1),
        mk("Q_smile", 2, "Q du marché : médiane", p.series[2], "solid", 2), mk("Q_smile", 0, "Q du marché : quantiles 5 % et 95 %", p.series[2], "dashed", 1.2),
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
        { type: "line", name: "Smile du marché / P", showSymbol: false, color: p.series[2], lineStyle: { width: 2.5 },
          data: k.K.map((x, i) => [x, Math.max(k.smile[i], 1e-3)]) },
        { type: "line", name: "Lognormale Q / P (Girsanov)", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" },
          data: k.K.map((x, i) => [x, k.lognormal[i]]),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dotted" }, label: { show: false }, data: [{ yAxis: 1 }] } },
      ],
    };
  }, [d]);

  const cols: { key: keyof MeasuresResponseStats; label: string }[] = [
    { key: "P", label: "P (lognormale)" }, { key: "Q", label: "Q (lognormale)" }, { key: "Q_smile", label: "Q du marché (smile)" },
    ...(d?.stats.P_empirical ? [{ key: "P_empirical" as const, label: "P empirique" }] : []),
  ];
  const rows: { label: string; get: (s: MeasureStats) => string }[] = [
    { label: "Moyenne", get: (s) => num(s.mean, 2) },
    { label: "Médiane", get: (s) => num(s.median, 2) },
    { label: "Mode", get: (s) => (s.mode == null ? "—" : num(s.mode, 2)) },
    { label: "Quantile 5 %", get: (s) => num(s.quantiles["0.05"], 2) },
    { label: "Quantile 95 %", get: (s) => num(s.quantiles["0.95"], 2) },
    { label: "P(S_T < S₀)", get: (s) => pct(s.prob_below["1.00"], 1) },
    { label: "P(S_T < 90 % S₀)", get: (s) => pct(s.prob_below["0.90"], 1) },
    { label: "P(S_T < 80 % S₀)", get: (s) => pct(s.prob_below["0.80"], 1) },
  ];
  const sourceFoot = d ? {
    capm: `r + β · prime de marché = ${pct(d.r, 2)} + ${num(d.drift.beta, 2)} × ${pct(d.drift.equity_premium, 1)} (Fama-French depuis 1926)`,
    history: `${num(d.drift.history_years, 1)} ans d'historique : ± ${pct(1.96 * d.drift.history_se, 0)} à 95 %`,
    custom: "Valeur libre",
  }[source] : undefined;

  return (
    <div className="grid">
      <ErrorBox error={error} />
      <Explainer>
        Le prix d'une option ne dépend pas de μ, mais S<sub>T</sub> a bien deux lois. Sous la probabilité réelle P, l'action croît au
        rendement espéré μ ; sous la probabilité risque-neutre Q, elle croît au taux sans risque r. Girsanov passe de l'une à l'autre en
        changeant la dérive, pas la volatilité. Le marché, lui, publie sa propre loi Q à travers le smile : la dérivée seconde du prix des
        calls par rapport au strike donne la densité risque-neutre (Breeden-Litzenberger, 1978).
      </Explainer>
      <Card title={`Paramètres — ${ticker}`}>
        <div className="toolbar-grid">
          <SelectField label="Horizon" value={days} onChange={setDays} options={HORIZONS} />
          <SelectField label="Rendement espéré μ" value={source} onChange={setSource}
            options={[{ value: "capm", label: "CAPM" }, { value: "history", label: "Historique" }, { value: "custom", label: "Libre" }]} />
          {source === "custom" && <NumberField label="μ" value={mu} suffix="%" scale={100} min={-1} max={1} digits={1} onChange={setMu} />}
        </div>
      </Card>
      <div className="grid cols-4">
        <Stat label="Rendement espéré (sous P)" value={fit ? pct(d.mu, 1) : "—"} foot={sourceFoot} busy={isFetching} />
        <Stat label="Taux sans risque (sous Q)" value={fit ? pct(d.r, 2) : "—"} foot={fit ? `Dividende q = ${pct(d.q, 2)}, forward ${num(d.forward, 2)}` : undefined} busy={isFetching} />
        <Stat label="Vol implicite à la monnaie" value={fit ? pct(d.sigma, 1) : "—"} foot={fit ? `La même sous P et Q · vol réalisée ${pct(d.drift.realized_vol, 1)}` : undefined} busy={isFetching} />
        <Stat label="Prix de marché du risque" value={fit ? num(d.market_price_of_risk, 2) : "—"} foot="λ = (μ − r) / σ, la dérive de Girsanov" busy={isFetching} />
      </div>
      <Card title={`Loi du cours dans ${days} jours`}>
        {fit ? <EChart option={densityOption} height={360} ariaLabel="Densités de S_T sous P, sous Q et sous le Q du marché" /> : <Skeleton height={320} />}
        {fit && (
          <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
            Contrôles de la densité extraite du smile : masse {num(d.checks.mass, 4)}, E<sub>Q</sub>[S<sub>T</sub>] = {num(d.checks.mean, 2)} contre
            un forward de {num(d.checks.forward, 2)} (le prix actualisé est une martingale sous Q). L'histogramme empirique empile
            {d.stats.P_empirical ? ` ${d.stats.P_empirical.n}` : ""} rendements sur {days} jours qui se chevauchent : ils sont très corrélés entre eux.
          </p>
        )}
      </Card>
      <Card title="Mode, médiane, moyenne et probabilités de baisse">
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
          Sous une lognormale, mode &lt; médiane &lt; moyenne : la plupart des trajectoires finissent sous l'espérance, tirée par quelques
          fortes hausses. Le smile renverse en partie cet ordre : sa queue gauche épaisse (krachs chers) déplace de la masse vers les fortes
          baisses, et pour garder la moyenne au forward, la médiane et le mode remontent.
        </p>
      </Card>
      <div className="grid cols-2">
        <Card title="Éventail des quantiles selon l'horizon">
          {fit && d.fan ? <EChart option={fanOption} height={320} ariaLabel="Quantiles 5, 50 et 95 % de S_T selon l'horizon" /> : <Skeleton height={280} />}
        </Card>
        <Card title="Noyau de prix : densité risque-neutre / densité réelle">
          {fit ? <EChart option={kernelOption} height={320} ariaLabel="Rapport des densités risque-neutre et réelle" /> : <Skeleton height={280} />}
        </Card>
      </div>
      <InfoBox>
        Le rapport q / p est la densité des prix d'état, au facteur d'actualisation près : le prix d'un euro reçu si S<sub>T</sub> tombe
        dans un intervalle, divisé par la probabilité réelle de cet intervalle. Avec μ &gt; r, il décroît : un euro dans les états de krach
        vaut plus que sa probabilité, car c'est là que tout le monde en manque. Le smile accentue fortement la pente à gauche. Un rapport
        non monotone autour du spot est le « pricing kernel puzzle » (Jackwerth, 2000). Enfin, μ est très mal estimé : avec deux ans
        d'historique, l'intervalle de confiance couvre plusieurs dizaines de points de rendement, d'où le CAPM par défaut.
      </InfoBox>
    </div>
  );
}

type MeasuresResponseStats = { P: MeasureStats; Q: MeasureStats; Q_smile: MeasureStats; P_empirical?: MeasureStats };
