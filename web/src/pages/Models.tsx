import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ApiError, modelsApi, type ExoticsRequest, type HestonResponse, type SurfaceResponse } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { num, pct } from "../lib/format";
import { useTicker } from "../lib/hooks";
import { useTheme, type ChartPalette, type ThemeMode } from "../lib/theme";

export const MODEL_PAGES = [
  { path: "heston", label: "Heston (volatilité stochastique)" },
  { path: "surface", label: "Surface SVI & volatilité locale" },
  { path: "exotiques", label: "Exotiques : BS vs Heston vs locale" },
] as const;

export default function Models() {
  const { ticker } = useTicker();
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Modèles de volatilité — {ticker}</h1>
          <div className="page-sub">Modèles calibrés sur la dernière chaîne d'options en base : Heston, surface SVI sans arbitrage, volatilité locale de Dupire.</div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label="Modèles">
        {MODEL_PAGES.map((m) => (
          <NavLink key={m.path} to={`/models/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: "0 0 14px" }}>{children}</p>;
}

function NotAvailable({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return <InfoBox>{error.message}. Les modèles de volatilité se calibrent sur les sous-jacents US (SPY, QQQ, AAPL, MSFT, NVDA).</InfoBox>;
  }
  return <ErrorBox error={error} />;
}

// sequential ramp (blue), stepped per mode so the low end recedes into the surface
const RAMP: Record<ThemeMode, string[]> = {
  light: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  dark: ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
};

// ----------------------------------------------------------------------------- Heston

const PARAM_INFO: { key: keyof HestonResponse["params"]; label: string; fmt: (v: number) => string; meaning: string }[] = [
  { key: "v0", label: "v₀ — variance initiale", fmt: (v) => `${num(v, 4)} (vol ${pct(Math.sqrt(v), 1)})`, meaning: "niveau de volatilité aujourd'hui" },
  { key: "theta", label: "θ — variance long terme", fmt: (v) => `${num(v, 4)} (vol ${pct(Math.sqrt(v), 1)})`, meaning: "niveau vers lequel la variance revient" },
  { key: "kappa", label: "κ — vitesse de retour", fmt: (v) => `${num(v, 3)} (demi-vie ${num(0.6931 / v, 2)} an)`, meaning: "pente de la structure par terme" },
  { key: "sigma", label: "σ — vol de la variance", fmt: (v) => num(v, 3), meaning: "convexité du smile (ailes)" },
  { key: "rho", label: "ρ — corrélation spot / vol", fmt: (v) => num(v, 3), meaning: "pente du smile : ρ < 0 crée le skew baissier" },
];

export function HestonPage() {
  const { ticker } = useTicker();
  const { data, error, isLoading } = useQuery({ queryKey: ["heston", ticker], queryFn: () => modelsApi.heston(ticker), retry: false });

  const sliceOption = useCallback((c: HestonResponse["curves"][number]) => (p: ChartPalette) => ({
    legend: {},
    grid: { top: 30 },
    tooltip: { trigger: "item", formatter: (it: { seriesName: string; value: number[] }) => `${it.seriesName}<br/>K ${num(it.value[0], 1)} · IV <b>${pct(it.value[1], 2)}</b>` },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 0) } },
    series: [
      { type: "scatter", name: "Marché (toutes les options)", symbolSize: 4, color: p.muted, itemStyle: { opacity: 0.5 },
        data: c.market.strike.map((k, i) => [k, c.market.iv[i]]) },
      { type: "scatter", name: "Points de calibration", symbolSize: 6, color: p.series[0], itemStyle: { borderColor: p.surface, borderWidth: 1 },
        data: c.calibrated_on.strike.map((k, i) => [k, c.calibrated_on.iv[i]]) },
      { type: "line", name: "Heston calibré", showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 },
        data: c.model.strike.map((k, i) => [k, c.model.iv[i]]) },
    ],
  }), []);

  return (
    <div className="grid">
      <Explainer>
        Dans le modèle de Heston, la variance n'est plus constante : elle suit un processus qui revient vers θ à la vitesse κ,
        avec sa propre volatilité σ, et elle est <b>corrélée (ρ) aux mouvements du sous-jacent</b>. Une corrélation négative
        reproduit le skew baissier des indices. Les prix européens se calculent par la formule semi-analytique de Lewis
        (fonction caractéristique), ce qui permet de calibrer les 5 paramètres en une fraction de seconde par moindres carrés
        sur les volatilités implicites de la zone liquide (échéances ≥ 14 jours, moneyness proche de la monnaie).
      </Explainer>
      <NotAvailable error={error} />
      {isLoading && <Skeleton height={400} />}
      {data && (
        <>
          <div className="grid cols-4">
            <Stat label="Erreur moyenne (RMSE)" value={`${num(data.quality.rmse_vol * 100, 2)} pts de vol`}
              foot={`max ${num(data.quality.max_error_vol * 100, 2)} pts · ${data.quality.n_points} options`} />
            <Stat label="Vol initiale → long terme" value={`${pct(data.derived.vol_initiale, 1)} → ${pct(data.derived.vol_long_terme, 1)}`}
              foot={`demi-vie ${num(data.derived.demi_vie_ans, 2)} an`} />
            <Stat label="Corrélation ρ" value={num(data.params.rho, 3)} foot="spot / volatilité" />
            <Stat label="Condition de Feller 2κθ − σ²" value={num(data.derived.feller, 3)}
              foot={data.derived.feller > 0 ? "respectée : la variance ne touche pas 0" : "violée : la variance peut toucher 0 (fréquent sur actions)"} />
          </div>
          <Card title="Paramètres calibrés" flush>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Paramètre</th><th>Valeur</th><th style={{ textAlign: "left" }}>Rôle</th></tr></thead>
                <tbody>
                  {PARAM_INFO.map((p) => (
                    <tr key={p.key}>
                      <td className="strong">{p.label}</td>
                      <td className="num">{p.fmt(data.params[p.key])}</td>
                      <td className="muted" style={{ textAlign: "left", whiteSpace: "normal" }}>{p.meaning}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="card-body muted" style={{ fontSize: 12 }}>
              Snapshot {new Date(data.asof).toLocaleString("fr-FR")} · {data.quality.n_evaluations} évaluations · {num(data.quality.elapsed_s, 2)} s
            </div>
          </Card>
          <div className="grid cols-2">
            {data.curves.map((c) => (
              <Card key={c.expiry} title={`${c.expiry} · ${c.days} j`} actions={<span className="muted num">RMSE {num(c.rmse_vol * 100, 2)} pts</span>}>
                <EChart option={sliceOption(c)} height={330} ariaLabel={`Smile marché et Heston, échéance ${c.expiry}`} />
              </Card>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- SVI surface & local vol

export function SurfacePage() {
  const { ticker } = useTicker();
  const { mode } = useTheme();
  const { data, error, isLoading } = useQuery({ queryKey: ["surface", ticker], queryFn: () => modelsApi.surface(ticker), retry: false });
  const [kind, setKind] = useState<"implied" | "local">("implied");

  const heatOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const g = data.grid;
    const values = kind === "implied" ? g.implied : g.local;
    const cells: [number, number, number | null][] = [];
    values.forEach((row, ti) => row.forEach((v, ki) => cells.push([ki, ti, v])));
    // colour scale on the 2nd-98th percentiles: the very short-dated wings would otherwise flatten the rest
    const finite = cells.map((c) => c[2]).filter((v): v is number => v !== null).sort((a, b) => a - b);
    const q = (x: number) => finite[Math.min(finite.length - 1, Math.max(0, Math.round(x * (finite.length - 1))))];
    const lo = q(0.02), hi = q(0.98);
    return {
      grid: { left: 8, right: 90, top: 10, bottom: 24, containLabel: true },
      tooltip: { trigger: "item", formatter: (it: { value: [number, number, number | null] }) =>
        `k = ln(K/F) ${num(g.k[it.value[0]], 3)}<br/>T = ${num(g.T[it.value[1]] * 365, 0)} j<br/>${kind === "implied" ? "Vol implicite" : "Vol locale"} <b>${it.value[2] == null ? "— (arbitrage)" : pct(it.value[2], 2)}</b>` },
      xAxis: { type: "category", data: g.k.map((k) => num(k, 2)), name: "k = ln(K/F)", nameLocation: "middle", nameGap: 26, splitLine: { show: false } },
      yAxis: { type: "category", data: g.T.map((t) => `${num(t * 365, 0)} j`), splitLine: { show: false } },
      visualMap: { min: lo, max: hi, calculable: true, orient: "vertical", right: 0, top: "middle", itemHeight: 220,
        inRange: { color: RAMP[mode] }, textStyle: { color: p.textSecondary }, formatter: (v: number) => pct(v, 0) },
      series: [{ type: "heatmap", data: cells, progressive: 0, emphasis: { itemStyle: { borderColor: p.text, borderWidth: 1 } } }],
    };
  }, [data, kind, mode]);

  const sliceOption = useCallback((s: SurfaceResponse["slices"][number]) => (p: ChartPalette) => ({
    legend: {},
    grid: { top: 30 },
    tooltip: { trigger: "item", formatter: (it: { seriesName: string; value: number[] }) => `${it.seriesName}<br/>k ${num(it.value[0], 3)} · <b>${pct(it.value[1], 2)}</b>` },
    xAxis: { type: "value", scale: true },
    // axis bounded by the market range: local vol can explode in the short-dated wings
    yAxis: { type: "value", min: 0, max: Math.ceil(Math.max(...s.market.iv, ...s.fit.iv) * 1.3 * 20) / 20,
      axisLabel: { formatter: (v: number) => pct(v, 0) } },
    series: [
      { type: "scatter", name: "Marché", symbolSize: 5, color: p.series[0], itemStyle: { opacity: 0.7 }, data: s.market.k.map((k, i) => [k, s.market.iv[i]]) },
      { type: "line", name: "SVI (implicite)", showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 }, data: s.fit.k.map((k, i) => [k, s.fit.iv[i]]) },
      { type: "line", name: "Vol locale (Dupire)", showSymbol: false, color: p.series[2], lineStyle: { width: 2, type: "dashed" }, data: s.fit.k.map((k, i) => [k, s.fit.local[i]]) },
    ],
  }), []);

  const arbOk = data && data.arbitrage.butterfly.every((b) => b.ok) && data.arbitrage.calendar.every((c) => c.ok);
  return (
    <div className="grid">
      <Explainer>
        Chaque échéance est ajustée par une paramétrisation <b>SVI</b> de la variance totale w(k) = σ²T, contrainte à rester sans
        arbitrage (densité positive, variance totale croissante avec la maturité). Entre les échéances, on interpole la variance totale.
        La <b>volatilité locale de Dupire</b> σ_loc(K, T) est l'unique fonction de (spot, temps) qui reproduit tous les prix européens ;
        on la calcule à partir des dérivées de la surface : σ²_loc = (∂w/∂T) / g(k).
      </Explainer>
      <NotAvailable error={error} />
      {isLoading && <Skeleton height={460} />}
      {data && (
        <>
          <div className="grid cols-4">
            <Stat label="Échéances ajustées" value={data.slices.length} foot={`${num(data.slices[0].days, 0)} j → ${num(data.slices[data.slices.length - 1].days, 0)} j`} />
            <Stat label="Erreur SVI moyenne" value={`${num((data.slices.reduce((a, s) => a + s.rmse_vol, 0) / data.slices.length) * 100, 2)} pts`} foot="volatilité implicite" />
            <Stat label="Vol ATM 1 an" value={pct(interpAtm(data, 1.0), 2)} />
            <Stat label="Absence d'arbitrage" value={arbOk ? "Vérifiée" : "Violations"} foot="papillon et calendrier, |k| ≤ 0,5" />
          </div>
          <Card title={kind === "implied" ? "Surface de volatilité implicite" : "Surface de volatilité locale (Dupire)"} actions={
            <Segmented value={kind} onChange={setKind} options={[{ value: "implied", label: "Implicite" }, { value: "local", label: "Locale" }]} />
          }>
            <EChart option={heatOption} height={520} ariaLabel="Carte de chaleur de la surface de volatilité" />
          </Card>
          <div className="grid cols-2">
            {data.slices.map((s) => (
              <Card key={s.T} title={`${s.days} jours`} actions={<span className="muted num">RMSE {num(s.rmse_vol * 100, 2)} pts</span>}>
                <EChart option={sliceOption(s)} height={320} ariaLabel={`Ajustement SVI à ${s.days} jours`} />
              </Card>
            ))}
          </div>
          <div className="grid cols-2">
            <Card title="Paramètres SVI par échéance" flush>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Échéance</th><th>a</th><th>b</th><th>ρ</th><th>m</th><th>s</th><th>RMSE</th></tr></thead>
                  <tbody>
                    {data.slices.map((s) => (
                      <tr key={s.T}>
                        <td className="strong">{s.days} j</td><td>{num(s.a, 4)}</td><td>{num(s.b, 4)}</td><td>{num(s.rho, 3)}</td>
                        <td>{num(s.m, 4)}</td><td>{num(s.s, 4)}</td><td className="muted">{num(s.rmse_vol * 100, 2)} pts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title="Contrôles d'arbitrage" flush>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Contrôle</th><th>Échéance(s)</th><th>Minimum</th><th>Statut</th></tr></thead>
                  <tbody>
                    {data.arbitrage.butterfly.map((b) => (
                      <tr key={`b${b.T}`}><td>Papillon : g(k) ≥ 0</td><td>{num(b.T * 365, 0)} j</td><td>{num(b.min_g, 4)}</td><td><OkBadge ok={b.ok} /></td></tr>
                    ))}
                    {data.arbitrage.calendar.map((c) => (
                      <tr key={`c${c.T1}`}><td>Calendrier : w croissant</td><td>{num(c.T1 * 365, 0)} → {num(c.T2 * 365, 0)} j</td><td>{num(c.min_gap, 5)}</td><td><OkBadge ok={c.ok} /></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}

function interpAtm(data: SurfaceResponse, T: number): number | null {
  const ti = data.grid.T.findIndex((t) => t >= T);
  const ki = data.grid.k.findIndex((k) => Math.abs(k) < 1e-9);
  if (ti < 0 || ki < 0) return null;
  return data.grid.implied[ti][ki];
}

function OkBadge({ ok }: { ok: boolean }) {
  return ok ? (
    <span className="up" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><CheckCircle2 size={14} /> OK</span>
  ) : (
    <span className="down" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><XCircle size={14} /> Violation</span>
  );
}

// ----------------------------------------------------------------------------- exotics under each model

export function ExoticsPage() {
  const { ticker } = useTicker();
  const [req, setReq] = useState<ExoticsRequest>({
    barrier: { expiry: 1, strike_pct: 1, barrier_pct: 0.8, barrier_type: "down-and-out", option_type: "call" },
    autocall: { maturity: 3, frequency: 4, coupon_rate: 0.02, autocall_barrier: 1, coupon_barrier: 0.7, protection_barrier: 0.6, memory: true },
    n_paths: 40_000,
  });
  const run = useMutation({ mutationFn: () => modelsApi.exotics(ticker, req) });
  const setB = (p: Partial<ExoticsRequest["barrier"]>) => setReq((r) => ({ ...r, barrier: { ...r.barrier, ...p } }));
  const setA = (p: Partial<ExoticsRequest["autocall"]>) => setReq((r) => ({ ...r, autocall: { ...r.autocall, ...p } }));
  const data = run.data;

  const barOption = useCallback((rows: { model: string; price: number; std_error: number | null }[]) => (p: ChartPalette) => ({
    grid: { left: 8, right: 60, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: "item", formatter: (it: { name: string; value: number; dataIndex: number }) =>
      `${it.name}<br/>Prix <b>${num(it.value, 3)}</b>${rows[it.dataIndex].std_error ? ` ± ${num(1.96 * rows[it.dataIndex].std_error!, 3)}` : ""}` },
    xAxis: { type: "value", scale: true },
    yAxis: { type: "category", data: rows.map((r) => r.model), axisLine: { show: false }, inverse: true,
      splitLine: { show: true } },
    // dot plot: prices are close, so a free scale with dots (not truncated bars) shows the gaps honestly
    series: [{
      type: "scatter", symbolSize: 14,
      data: rows.map((r, i) => ({ value: r.price, itemStyle: { color: p.series[i % p.series.length], borderColor: p.surface, borderWidth: 2 } })),
      label: { show: true, position: "right", distance: 10, color: p.textSecondary, formatter: (it: { value: number }) => num(it.value, 3) },
    }],
  }), []);

  const redemptionOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 1) },
      xAxis: { type: "category", data: data.autocall.observation_times.map((t) => `${num(t, 2)} an`), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: data.autocall.rows.map((r, i) => ({ type: "line", name: r.model, symbolSize: 6, color: p.series[i], lineStyle: { width: 2 },
        data: r.redemption_probabilities })),
    };
  }, [data]);

  return (
    <div className="grid">
      <Explainer>
        Le même produit, pricé avec trois hypothèses de volatilité : <b>Black-Scholes</b> avec la vol implicite ATM de la maturité
        du produit, <b>Heston</b> calibré et <b>volatilité locale</b>. Les trois modèles redonnent le même prix ATM, mais pas le
        même smile ni la même dynamique : l'écart de prix mesure le <b>risque de modèle</b>. Les produits sensibles au skew (barrières
        basses, autocalls avec protection) sont typiquement surévalués par une vol plate.
      </Explainer>
      <Card title="Produits comparés" actions={
        <button className="btn primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? "Simulation… (≈ 5 s)" : "Lancer la comparaison"}</button>
      }>
        <div className="grid cols-2">
          <div className="form">
            <div className="form-group-title">Option à barrière (observation quotidienne)</div>
            <div className="form-row">
              <SelectField label="Type" value={req.barrier.barrier_type} onChange={(barrier_type) => setB({ barrier_type })}
                options={["down-and-out", "down-and-in", "up-and-out", "up-and-in"].map((v) => ({ value: v as ExoticsRequest["barrier"]["barrier_type"], label: v }))} />
              <Segmented label="Call / put" value={req.barrier.option_type} onChange={(option_type) => setB({ option_type })}
                options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
            </div>
            <div className="toolbar-grid">
              <NumberField label="Maturité" value={req.barrier.expiry} suffix="ans" min={0.05} max={3} digits={2} onChange={(expiry) => setB({ expiry })} />
              <NumberField label="Strike" value={req.barrier.strike_pct} suffix="% spot" scale={100} min={0.01} digits={1} onChange={(strike_pct) => setB({ strike_pct })} />
              <NumberField label="Barrière" value={req.barrier.barrier_pct} suffix="% spot" scale={100} min={0.01} digits={1} onChange={(barrier_pct) => setB({ barrier_pct })} />
            </div>
          </div>
          <div className="form">
            <div className="form-group-title">Autocall Phoenix</div>
            <div className="toolbar-grid">
              <NumberField label="Maturité" value={req.autocall.maturity} suffix="ans" min={0.25} max={5} digits={1} onChange={(maturity) => setA({ maturity })} />
              <SelectField label="Observations" value={req.autocall.frequency} onChange={(frequency) => setA({ frequency })}
                options={[{ value: 12, label: "Mensuelles" }, { value: 4, label: "Trimestrielles" }, { value: 2, label: "Semestrielles" }, { value: 1, label: "Annuelles" }]} />
              <NumberField label="Coupon / période" value={req.autocall.coupon_rate} suffix="%" scale={100} min={0} max={0.5} digits={2} onChange={(coupon_rate) => setA({ coupon_rate })} />
              <NumberField label="Barrière autocall" value={req.autocall.autocall_barrier} suffix="%" scale={100} min={0.01} digits={1} onChange={(autocall_barrier) => setA({ autocall_barrier })} />
              <NumberField label="Barrière coupon" value={req.autocall.coupon_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(coupon_barrier) => setA({ coupon_barrier })} />
              <NumberField label="Protection" value={req.autocall.protection_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(protection_barrier) => setA({ protection_barrier })} />
            </div>
            <Check label="Effet mémoire" checked={req.autocall.memory} onChange={(memory) => setA({ memory })} />
          </div>
        </div>
      </Card>
      <NotAvailable error={run.error} />
      {!data && !run.isPending && <div className="empty card">Réglez les produits puis lancez la comparaison.</div>}
      {run.isPending && <Skeleton height={300} />}
      {data && (
        <>
          <div className="grid cols-2">
            <Card title={`Barrière — prix selon le modèle (vol ATM ${pct(data.barrier.atm_vol, 1)})`}>
              <EChart option={barOption(data.barrier.rows)} height={300} ariaLabel="Prix de la barrière selon le modèle" />
            </Card>
            <Card title={`Autocall — prix pour 100 de nominal (vol ATM ${pct(data.autocall.atm_vol, 1)})`}>
              <EChart option={barOption(data.autocall.rows)} height={300} ariaLabel="Prix de l'autocall selon le modèle" />
            </Card>
          </div>
          <Card title="Autocall — détail par modèle" flush>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Modèle</th><th>Prix</th><th>IC 95 %</th><th>Proba de perte</th><th>Durée de vie</th><th>Temps</th></tr></thead>
                <tbody>
                  {data.autocall.rows.map((r) => (
                    <tr key={r.model}>
                      <td className="strong">{r.model}</td><td className="strong">{num(r.price, 3)}</td><td className="muted">± {num(1.96 * r.std_error, 3)}</td>
                      <td>{pct(r.loss_probability, 2)}</td><td>{num(r.expected_life, 2)} ans</td><td className="muted">{num(r.elapsed_ms, 0)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title="Probabilité de remboursement à chaque date">
            <EChart option={redemptionOption} height={380} ariaLabel="Probabilités de remboursement de l'autocall par modèle" />
          </Card>
        </>
      )}
    </div>
  );
}
