import { useMutation, useQuery } from "@tanstack/react-query";
import { CheckCircle2, XCircle } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import {
  ApiError, modelsApi, type ExoticsRequest, type HestonResponse, type ModelRow, type PathDependentRequest, type SurfaceResponse,
} from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { num, pct } from "../lib/format";
import { useTicker } from "../lib/hooks";
import { useTheme, type ChartPalette, type ThemeMode } from "../lib/theme";
import { locale, tr } from "../lib/i18n";

export const MODEL_PAGES = [
  { path: "heston", label: ["Heston (volatilité stochastique)", "Heston (stochastic volatility)"] },
  { path: "surface", label: ["Surface SVI & volatilité locale", "SVI surface & local volatility"] },
  { path: "exotiques", label: ["Barrière & autocall : BS vs Heston vs locale", "Barrier & autocall: BS vs Heston vs local"] },
  { path: "path-dependent", label: ["Digitale, asiatique, cliquet", "Digital, Asian, cliquet"] },
] as const;

export default function Models() {
  const { ticker } = useTicker();
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Modèles de volatilité", "Volatility models")} — {ticker}</h1>
          <div className="page-sub">{tr("Modèles calibrés sur la dernière chaîne d'options en base : Heston, surface SVI sans arbitrage, volatilité locale de Dupire.", "Models calibrated on the latest stored option chain: Heston, an arbitrage-free SVI surface, Dupire local volatility.")}</div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label={tr("Modèles", "Models")}>
        {MODEL_PAGES.map((m) => (
          <NavLink key={m.path} to={`/models/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{tr(m.label[0], m.label[1])}</NavLink>
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
    return <InfoBox>{error.message}. {tr("Les modèles de volatilité se calibrent sur les sous-jacents US (SPY, QQQ, AAPL, MSFT, NVDA).", "Volatility models are calibrated on the US underlyings (SPY, QQQ, AAPL, MSFT, NVDA).")}</InfoBox>;
  }
  return <ErrorBox error={error} />;
}

// sequential ramp (blue), stepped per mode so the low end recedes into the surface
const RAMP: Record<ThemeMode, string[]> = {
  light: ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95", "#0d366b"],
  dark: ["#0d366b", "#184f95", "#256abf", "#3987e5", "#6da7ec", "#9ec5f4", "#cde2fb"],
};

/** Dot plot of one product's price per model: prices are close, so a free scale with dots shows the gaps honestly. */
const modelDotPlot = (rows: ModelRow[], digits = 3) => (p: ChartPalette) => ({
  grid: { left: 8, right: 70, top: 8, bottom: 8, containLabel: true },
  tooltip: { trigger: "item", formatter: (it: { name: string; value: number; dataIndex: number }) =>
    `${it.name}<br/>${tr("Prix", "Price")} <b>${num(it.value, digits)}</b>${rows[it.dataIndex].std_error ? ` ± ${num(1.96 * rows[it.dataIndex].std_error!, digits)}` : ""}` },
  xAxis: { type: "value", scale: true },
  yAxis: { type: "category", data: rows.map((r) => r.model), axisLine: { show: false }, inverse: true, splitLine: { show: true } },
  series: [{
    type: "scatter", symbolSize: 14,
    data: rows.map((r, i) => ({ value: r.price, itemStyle: { color: p.series[i % p.series.length], borderColor: p.surface, borderWidth: 2 } })),
    label: { show: true, position: "right", distance: 10, color: p.textSecondary, formatter: (it: { value: number }) => num(it.value, digits) },
  }],
});

// ----------------------------------------------------------------------------- Heston

const paramInfo = (): { key: keyof HestonResponse["params"]; label: string; fmt: (v: number) => string; meaning: string }[] => [
  { key: "v0", label: tr("v₀ — variance initiale", "v₀ — initial variance"), fmt: (v) => `${num(v, 4)} (vol ${pct(Math.sqrt(v), 1)})`, meaning: tr("niveau de volatilité aujourd'hui", "volatility level today") },
  { key: "theta", label: tr("θ — variance long terme", "θ — long-run variance"), fmt: (v) => `${num(v, 4)} (vol ${pct(Math.sqrt(v), 1)})`, meaning: tr("niveau vers lequel la variance revient", "level the variance reverts to") },
  { key: "kappa", label: tr("κ — vitesse de retour", "κ — mean-reversion speed"), fmt: (v) => tr(`${num(v, 3)} (demi-vie ${num(0.6931 / v, 2)} an)`, `${num(v, 3)} (half-life ${num(0.6931 / v, 2)} y)`), meaning: tr("pente de la structure par terme", "slope of the term structure") },
  { key: "sigma", label: tr("σ — vol de la variance", "σ — vol of variance"), fmt: (v) => num(v, 3), meaning: tr("convexité du smile (ailes)", "smile convexity (wings)") },
  { key: "rho", label: tr("ρ — corrélation spot / vol", "ρ — spot / vol correlation"), fmt: (v) => num(v, 3), meaning: tr("pente du smile : ρ < 0 crée le skew baissier", "smile slope: ρ < 0 creates the downside skew") },
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
      { type: "scatter", name: tr("Marché (toutes les options)", "Market (all options)"), symbolSize: 4, color: p.muted, itemStyle: { opacity: 0.5 },
        data: c.market.strike.map((k, i) => [k, c.market.iv[i]]) },
      { type: "scatter", name: tr("Points de calibration", "Calibration points"), symbolSize: 6, color: p.series[0], itemStyle: { borderColor: p.surface, borderWidth: 1 },
        data: c.calibrated_on.strike.map((k, i) => [k, c.calibrated_on.iv[i]]) },
      { type: "line", name: tr("Heston calibré", "Calibrated Heston"), showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 },
        data: c.model.strike.map((k, i) => [k, c.model.iv[i]]) },
    ],
  }), []);

  return (
    <div className="grid">
      <Explainer>
        {tr(<>
          Dans le modèle de Heston, la variance n'est plus constante : elle suit un processus qui revient vers θ à la vitesse κ,
          avec sa propre volatilité σ, et elle est <b>corrélée (ρ) aux mouvements du sous-jacent</b>. Une corrélation négative
          reproduit le skew baissier des indices. Les prix européens se calculent par la formule semi-analytique de Lewis
          (fonction caractéristique), ce qui permet de calibrer les 5 paramètres en une fraction de seconde par moindres carrés
          sur les volatilités implicites de la zone liquide (échéances ≥ 14 jours, moneyness proche de la monnaie).
        </>, <>
          In the Heston model the variance is no longer constant: it follows a process that reverts to θ at speed κ,
          with its own volatility σ, and it is <b>correlated (ρ) with the moves of the underlying</b>. A negative correlation
          reproduces the downside skew of equity indices. European prices come from Lewis's semi-analytic formula
          (characteristic function), so the 5 parameters are calibrated in a fraction of a second by least squares
          on the implied vols of the liquid region (expiries ≥ 14 days, moneyness close to the money).
        </>)}
      </Explainer>
      <NotAvailable error={error} />
      {isLoading && <Skeleton height={400} />}
      {data && (
        <>
          <div className="grid cols-4">
            <Stat label={tr("Erreur moyenne (RMSE)", "Mean error (RMSE)")} value={tr(`${num(data.quality.rmse_vol * 100, 2)} pts de vol`, `${num(data.quality.rmse_vol * 100, 2)} vol pts`)}
              foot={`max ${num(data.quality.max_error_vol * 100, 2)} pts · ${data.quality.n_points} options`} />
            <Stat label={tr("Vol initiale → long terme", "Initial → long-run vol")} value={`${pct(data.derived.vol_initiale, 1)} → ${pct(data.derived.vol_long_terme, 1)}`}
              foot={tr(`demi-vie ${num(data.derived.demi_vie_ans, 2)} an`, `half-life ${num(data.derived.demi_vie_ans, 2)} y`)} />
            <Stat label={tr("Corrélation ρ", "Correlation ρ")} value={num(data.params.rho, 3)} foot={tr("spot / volatilité", "spot / volatility")} />
            <Stat label={tr("Condition de Feller 2κθ − σ²", "Feller condition 2κθ − σ²")} value={num(data.derived.feller, 3)}
              foot={data.derived.feller > 0 ? tr("respectée : la variance ne touche pas 0", "met: the variance never reaches 0") : tr("violée : la variance peut toucher 0 (fréquent sur actions)", "violated: the variance can reach 0 (common on equities)")} />
          </div>
          <Card title={tr("Paramètres calibrés", "Calibrated parameters")} flush>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{tr("Paramètre", "Parameter")}</th><th>{tr("Valeur", "Value")}</th><th style={{ textAlign: "left" }}>{tr("Rôle", "Role")}</th></tr></thead>
                <tbody>
                  {paramInfo().map((p) => (
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
              Snapshot {new Date(data.asof).toLocaleString(locale())} · {data.quality.n_evaluations} {tr("évaluations", "evaluations")} · {num(data.quality.elapsed_s, 2)} s
            </div>
          </Card>
          <div className="grid cols-2">
            {data.curves.map((c) => (
              <Card key={c.expiry} title={tr(`${c.expiry} · ${c.days} j`, `${c.expiry} · ${c.days} d`)} actions={<span className="muted num">RMSE {num(c.rmse_vol * 100, 2)} pts</span>}>
                <EChart option={sliceOption(c)} height={330} ariaLabel={tr(`Smile marché et Heston, échéance ${c.expiry}`, `Market and Heston smile, expiry ${c.expiry}`)} />
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
        `k = ln(K/F) ${num(g.k[it.value[0]], 3)}<br/>T = ${num(g.T[it.value[1]] * 365, 0)} ${tr("j", "d")}<br/>${kind === "implied" ? tr("Vol implicite", "Implied vol") : tr("Vol locale", "Local vol")} <b>${it.value[2] == null ? "— (arbitrage)" : pct(it.value[2], 2)}</b>` },
      xAxis: { type: "category", data: g.k.map((k) => num(k, 2)), name: "k = ln(K/F)", nameLocation: "middle", nameGap: 26, splitLine: { show: false } },
      yAxis: { type: "category", data: g.T.map((t) => `${num(t * 365, 0)} ${tr("j", "d")}`), splitLine: { show: false } },
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
      { type: "scatter", name: tr("Marché", "Market"), symbolSize: 5, color: p.series[0], itemStyle: { opacity: 0.7 }, data: s.market.k.map((k, i) => [k, s.market.iv[i]]) },
      { type: "line", name: tr("SVI (implicite)", "SVI (implied)"), showSymbol: false, color: p.series[1], lineStyle: { width: 2.5 }, data: s.fit.k.map((k, i) => [k, s.fit.iv[i]]) },
      { type: "line", name: tr("Vol locale (Dupire)", "Local vol (Dupire)"), showSymbol: false, color: p.series[2], lineStyle: { width: 2, type: "dashed" }, data: s.fit.k.map((k, i) => [k, s.fit.local[i]]) },
    ],
  }), []);

  const arbOk = data && data.arbitrage.butterfly.every((b) => b.ok) && data.arbitrage.calendar.every((c) => c.ok);
  return (
    <div className="grid">
      <Explainer>
        {tr(<>
          Chaque échéance est ajustée par une paramétrisation <b>SVI</b> de la variance totale w(k) = σ²T, contrainte à rester sans
          arbitrage (densité positive, variance totale croissante avec la maturité). Entre les échéances, on interpole la variance totale.
          La <b>volatilité locale de Dupire</b> σ_loc(K, T) est l'unique fonction de (spot, temps) qui reproduit tous les prix européens ;
          on la calcule à partir des dérivées de la surface : σ²_loc = (∂w/∂T) / g(k).
        </>, <>
          Each expiry is fitted with an <b>SVI</b> parametrisation of the total variance w(k) = σ²T, constrained to stay arbitrage-free
          (positive density, total variance increasing with maturity). Between expiries the total variance is interpolated.
          <b> Dupire local volatility</b> σ_loc(K, T) is the unique function of (spot, time) that reproduces every European price;
          it is computed from the derivatives of the surface: σ²_loc = (∂w/∂T) / g(k).
        </>)}
      </Explainer>
      <NotAvailable error={error} />
      {isLoading && <Skeleton height={460} />}
      {data && (
        <>
          <div className="grid cols-4">
            <Stat label={tr("Échéances ajustées", "Expiries fitted")} value={data.slices.length} foot={tr(`${num(data.slices[0].days, 0)} j → ${num(data.slices[data.slices.length - 1].days, 0)} j`, `${num(data.slices[0].days, 0)} d → ${num(data.slices[data.slices.length - 1].days, 0)} d`)} />
            <Stat label={tr("Erreur SVI moyenne", "Mean SVI error")} value={`${num((data.slices.reduce((a, s) => a + s.rmse_vol, 0) / data.slices.length) * 100, 2)} pts`} foot={tr("volatilité implicite", "implied volatility")} />
            <Stat label={tr("Vol ATM 1 an", "1-year ATM vol")} value={pct(interpAtm(data, 1.0), 2)} />
            <Stat label={tr("Absence d'arbitrage", "No arbitrage")} value={arbOk ? tr("Vérifiée", "Checked") : tr("Violations", "Violations")} foot={tr("papillon et calendrier, |k| ≤ 0,5", "butterfly and calendar, |k| ≤ 0.5")} />
          </div>
          <Card title={kind === "implied" ? tr("Surface de volatilité implicite", "Implied volatility surface") : tr("Surface de volatilité locale (Dupire)", "Local volatility surface (Dupire)")} actions={
            <Segmented value={kind} onChange={setKind} options={[{ value: "implied", label: tr("Implicite", "Implied") }, { value: "local", label: tr("Locale", "Local") }]} />
          }>
            <EChart option={heatOption} height={520} ariaLabel={tr("Carte de chaleur de la surface de volatilité", "Heat map of the volatility surface")} />
          </Card>
          <div className="grid cols-2">
            {data.slices.map((s) => (
              <Card key={s.T} title={tr(`${s.days} jours`, `${s.days} days`)} actions={<span className="muted num">RMSE {num(s.rmse_vol * 100, 2)} pts</span>}>
                <EChart option={sliceOption(s)} height={320} ariaLabel={tr(`Ajustement SVI à ${s.days} jours`, `SVI fit at ${s.days} days`)} />
              </Card>
            ))}
          </div>
          <div className="grid cols-2">
            <Card title={tr("Paramètres SVI par échéance", "SVI parameters by expiry")} flush>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{tr("Échéance", "Expiry")}</th><th>a</th><th>b</th><th><span className="keep-case">ρ</span></th><th>m</th><th>s</th><th>RMSE</th></tr></thead>
                  <tbody>
                    {data.slices.map((s) => (
                      <tr key={s.T}>
                        <td className="strong">{s.days} {tr("j", "d")}</td><td>{num(s.a, 4)}</td><td>{num(s.b, 4)}</td><td>{num(s.rho, 3)}</td>
                        <td>{num(s.m, 4)}</td><td>{num(s.s, 4)}</td><td className="muted">{num(s.rmse_vol * 100, 2)} pts</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
            <Card title={tr("Contrôles d'arbitrage", "Arbitrage checks")} flush>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{tr("Contrôle", "Check")}</th><th>{tr("Échéance(s)", "Expiry(ies)")}</th><th>Minimum</th><th>{tr("Statut", "Status")}</th></tr></thead>
                  <tbody>
                    {data.arbitrage.butterfly.map((b) => (
                      <tr key={`b${b.T}`}><td>{tr("Papillon : g(k) ≥ 0", "Butterfly: g(k) ≥ 0")}</td><td>{num(b.T * 365, 0)} {tr("j", "d")}</td><td>{num(b.min_g, 4)}</td><td><OkBadge ok={b.ok} /></td></tr>
                    ))}
                    {data.arbitrage.calendar.map((c) => (
                      <tr key={`c${c.T1}`}><td>{tr("Calendrier : w croissant", "Calendar: w increasing")}</td><td>{num(c.T1 * 365, 0)} → {num(c.T2 * 365, 0)} {tr("j", "d")}</td><td>{num(c.min_gap, 5)}</td><td><OkBadge ok={c.ok} /></td></tr>
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
    <span className="down" style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><XCircle size={14} /> {tr("Violation", "Violation")}</span>
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

  const barOption = modelDotPlot;

  const redemptionOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 1) },
      xAxis: { type: "category", data: data.autocall.observation_times.map((t) => `${num(t, 2)} ${tr("an", "y")}`), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: data.autocall.rows.map((r, i) => ({ type: "line", name: r.model, symbolSize: 6, color: p.series[i], lineStyle: { width: 2 },
        data: r.redemption_probabilities })),
    };
  }, [data]);

  return (
    <div className="grid">
      <Explainer>
        {tr(<>
          Le même produit, pricé avec trois hypothèses de volatilité : <b>Black-Scholes</b> avec la vol implicite ATM de la maturité
          du produit, <b>Heston</b> calibré et <b>volatilité locale</b>. Les trois modèles redonnent le même prix ATM, mais pas le
          même smile ni la même dynamique : l'écart de prix mesure le <b>risque de modèle</b>. Les produits sensibles au skew (barrières
          basses, autocalls avec protection) sont typiquement surévalués par une vol plate.
        </>, <>
          The same product, priced under three volatility assumptions: <b>Black-Scholes</b> with the ATM implied vol at the product's
          maturity, calibrated <b>Heston</b> and <b>local volatility</b>. The three models give back the same ATM price, but not the
          same smile nor the same dynamics: the price gap measures <b>model risk</b>. Skew-sensitive products (low barriers,
          autocalls with protection) are typically overpriced by a flat vol.
        </>)}
      </Explainer>
      <Card title={tr("Produits comparés", "Products compared")} actions={
        <button className="btn primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? tr("Simulation… (≈ 5 s)", "Simulating… (≈ 5 s)") : tr("Lancer la comparaison", "Run the comparison")}</button>
      }>
        <div className="grid cols-2">
          <div className="form">
            <div className="form-group-title">{tr("Option à barrière (observation quotidienne)", "Barrier option (daily monitoring)")}</div>
            <div className="form-row">
              <SelectField label="Type" value={req.barrier.barrier_type} onChange={(barrier_type) => setB({ barrier_type })}
                options={["down-and-out", "down-and-in", "up-and-out", "up-and-in"].map((v) => ({ value: v as ExoticsRequest["barrier"]["barrier_type"], label: v }))} />
              <Segmented label="Call / put" value={req.barrier.option_type} onChange={(option_type) => setB({ option_type })}
                options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
            </div>
            <div className="toolbar-grid">
              <NumberField label={tr("Maturité", "Maturity")} value={req.barrier.expiry} suffix={tr("ans", "years")} min={0.05} max={3} digits={2} onChange={(expiry) => setB({ expiry })} />
              <NumberField label="Strike" value={req.barrier.strike_pct} suffix="% spot" scale={100} min={0.01} digits={1} onChange={(strike_pct) => setB({ strike_pct })} />
              <NumberField label={tr("Barrière", "Barrier")} value={req.barrier.barrier_pct} suffix="% spot" scale={100} min={0.01} digits={1} onChange={(barrier_pct) => setB({ barrier_pct })} />
            </div>
          </div>
          <div className="form">
            <div className="form-group-title">Autocall Phoenix</div>
            <div className="toolbar-grid">
              <NumberField label={tr("Maturité", "Maturity")} value={req.autocall.maturity} suffix={tr("ans", "years")} min={0.25} max={5} digits={1} onChange={(maturity) => setA({ maturity })} />
              <SelectField label={tr("Observations", "Observations")} value={req.autocall.frequency} onChange={(frequency) => setA({ frequency })}
                options={[{ value: 12, label: tr("Mensuelles", "Monthly") }, { value: 4, label: tr("Trimestrielles", "Quarterly") }, { value: 2, label: tr("Semestrielles", "Semi-annual") }, { value: 1, label: tr("Annuelles", "Annual") }]} />
              <NumberField label={tr("Coupon / période", "Coupon / period")} value={req.autocall.coupon_rate} suffix="%" scale={100} min={0} max={0.5} digits={2} onChange={(coupon_rate) => setA({ coupon_rate })} />
              <NumberField label={tr("Barrière autocall", "Autocall barrier")} value={req.autocall.autocall_barrier} suffix="%" scale={100} min={0.01} digits={1} onChange={(autocall_barrier) => setA({ autocall_barrier })} />
              <NumberField label={tr("Barrière coupon", "Coupon barrier")} value={req.autocall.coupon_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(coupon_barrier) => setA({ coupon_barrier })} />
              <NumberField label="Protection" value={req.autocall.protection_barrier} suffix="%" scale={100} min={0} digits={1} onChange={(protection_barrier) => setA({ protection_barrier })} />
            </div>
            <Check label={tr("Effet mémoire", "Memory effect")} checked={req.autocall.memory} onChange={(memory) => setA({ memory })} />
          </div>
        </div>
      </Card>
      <NotAvailable error={run.error} />
      {!data && !run.isPending && <div className="empty card">{tr("Réglez les produits puis lancez la comparaison.", "Set the products, then run the comparison.")}</div>}
      {run.isPending && <Skeleton height={300} />}
      {data && (
        <>
          <div className="grid cols-2">
            <Card title={tr(`Barrière — prix selon le modèle (vol ATM ${pct(data.barrier.atm_vol, 1)})`, `Barrier — price by model (ATM vol ${pct(data.barrier.atm_vol, 1)})`)}>
              <EChart option={barOption(data.barrier.rows)} height={300} ariaLabel={tr("Prix de la barrière selon le modèle", "Barrier price by model")} />
            </Card>
            <Card title={tr(`Autocall — prix pour 100 de nominal (vol ATM ${pct(data.autocall.atm_vol, 1)})`, `Autocall — price per 100 notional (ATM vol ${pct(data.autocall.atm_vol, 1)})`)}>
              <EChart option={barOption(data.autocall.rows)} height={300} ariaLabel={tr("Prix de l'autocall selon le modèle", "Autocall price by model")} />
            </Card>
          </div>
          <Card title={tr("Autocall — détail par modèle", "Autocall — detail by model")} flush>
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>{tr("Modèle", "Model")}</th><th>{tr("Prix", "Price")}</th><th>{tr("IC 95 %", "95% CI")}</th><th>{tr("Proba de perte", "Loss probability")}</th><th>{tr("Durée de vie", "Expected life")}</th><th>{tr("Temps", "Time")}</th></tr></thead>
                <tbody>
                  {data.autocall.rows.map((r) => (
                    <tr key={r.model}>
                      <td className="strong">{r.model}</td><td className="strong">{num(r.price, 3)}</td><td className="muted">± {num(1.96 * r.std_error, 3)}</td>
                      <td>{pct(r.loss_probability, 2)}</td><td>{num(r.expected_life, 2)} {tr("ans", "years")}</td><td className="muted">{num(r.elapsed_ms, 0)} ms</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
          <Card title={tr("Probabilité de remboursement à chaque date", "Redemption probability at each date")}>
            <EChart option={redemptionOption} height={380} ariaLabel={tr("Probabilités de remboursement de l'autocall par modèle", "Autocall redemption probabilities by model")} />
          </Card>
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------------------------- digital / Asian / cliquet

function ModelTable({ rows, digits = 3 }: { rows: ModelRow[]; digits?: number }) {
  const ref = rows[0]?.price;
  return (
    <div className="table-wrap">
      <table className="data">
        <thead><tr><th>{tr("Modèle", "Model")}</th><th>{tr("Prix", "Price")}</th><th>{tr("Écart vs BS ATM", "Gap vs ATM BS")}</th><th>{tr("IC 95 %", "95% CI")}</th><th>{tr("Temps", "Time")}</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model}>
              <td className="strong">{r.model}</td>
              <td className="strong">{num(r.price, digits)}</td>
              <td>{ref ? pct(r.price / ref - 1, 1) : "—"}</td>
              <td className="muted">{r.std_error != null ? `± ${num(1.96 * r.std_error, digits)}` : tr("exact", "exact")}</td>
              <td className="muted">{r.elapsed_ms != null ? `${num(r.elapsed_ms, 0)} ms` : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PathDependentPage() {
  const { ticker } = useTicker();
  const [req, setReq] = useState<PathDependentRequest>({
    digital: { expiry: 0.5, strike_pct: 1, option_type: "call" },
    asian: { expiry: 1, strike_pct: 1, n_fixings: 12, option_type: "call" },
    cliquet: { maturity: 2, frequency: 4, local_floor: -0.05, local_cap: 0.05, global_floor: 0, global_cap: null },
    n_paths: 40_000,
  });
  const run = useMutation({ mutationFn: () => modelsApi.pathDependent(ticker, req) });
  const setD = (p: Partial<PathDependentRequest["digital"]>) => setReq((r) => ({ ...r, digital: { ...r.digital, ...p } }));
  const setA = (p: Partial<PathDependentRequest["asian"]>) => setReq((r) => ({ ...r, asian: { ...r.asian, ...p } }));
  const setC = (p: Partial<PathDependentRequest["cliquet"]>) => setReq((r) => ({ ...r, cliquet: { ...r.cliquet, ...p } }));
  const data = run.data;

  return (
    <div className="grid">
      <Explainer>
        {tr(<>
          Trois produits qui ne regardent pas le smile de la même façon. La <b>digitale</b> dépend de la <b>pente</b> du smile au
          strike : une vol plate l'ignore complètement. L'<b>asiatique</b> dépend surtout du niveau de vol sur la durée de
          moyennage. Le <b>cliquet</b> dépend du smile <b>forward</b> : la vol locale l'aplatit avec le temps, tandis que Heston le
          conserve. C'est le cas d'école où les deux modèles, calibrés sur les mêmes vanilles, divergent le plus.
        </>, <>
          Three products that read the smile in different ways. The <b>digital</b> depends on the <b>slope</b> of the smile at the
          strike: a flat vol ignores it entirely. The <b>Asian</b> depends mostly on the vol level over the averaging
          period. The <b>cliquet</b> depends on the <b>forward</b> smile: local vol flattens it over time, while Heston
          keeps it. It is the textbook case where the two models, calibrated on the same vanillas, diverge the most.
        </>)}
      </Explainer>
      <Card title={tr("Produits comparés", "Products compared")} actions={
        <button className="btn primary" onClick={() => run.mutate()} disabled={run.isPending}>{run.isPending ? tr("Simulation… (≈ 5 s)", "Simulating… (≈ 5 s)") : tr("Lancer la comparaison", "Run the comparison")}</button>
      }>
        <div className="grid cols-3">
          <div className="form">
            <div className="form-group-title">{tr("Digitale cash-or-nothing (paye 100)", "Cash-or-nothing digital (pays 100)")}</div>
            <Segmented value={req.digital.option_type} onChange={(option_type) => setD({ option_type })}
              options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
            <div className="form-row">
              <NumberField label={tr("Maturité", "Maturity")} value={req.digital.expiry} suffix={tr("ans", "years")} min={0.05} max={3} digits={2} onChange={(expiry) => setD({ expiry })} />
              <NumberField label="Strike" value={req.digital.strike_pct} suffix="% spot" scale={100} min={0.01} digits={1} onChange={(strike_pct) => setD({ strike_pct })} />
            </div>
          </div>
          <div className="form">
            <div className="form-group-title">{tr("Asiatique arithmétique", "Arithmetic Asian")}</div>
            <Segmented value={req.asian.option_type} onChange={(option_type) => setA({ option_type })}
              options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
            <div className="form-row">
              <NumberField label={tr("Maturité", "Maturity")} value={req.asian.expiry} suffix={tr("ans", "years")} min={0.05} max={3} digits={2} onChange={(expiry) => setA({ expiry })} />
              <NumberField label="Strike" value={req.asian.strike_pct} suffix="% spot" scale={100} min={0.01} digits={1} onChange={(strike_pct) => setA({ strike_pct })} />
            </div>
            <SelectField label="Fixings" value={req.asian.n_fixings} onChange={(n_fixings) => setA({ n_fixings })}
              options={[4, 12, 52].map((v) => ({ value: v, label: String(v) }))} />
          </div>
          <div className="form">
            <div className="form-group-title">{tr("Cliquet (% du nominal)", "Cliquet (% of notional)")}</div>
            <div className="form-row">
              <NumberField label={tr("Maturité", "Maturity")} value={req.cliquet.maturity} suffix={tr("ans", "years")} min={0.25} max={5} digits={2} onChange={(maturity) => setC({ maturity })} />
              <SelectField label="Resets" value={req.cliquet.frequency} onChange={(frequency) => setC({ frequency })}
                options={[{ value: 12, label: tr("Mensuels", "Monthly") }, { value: 4, label: tr("Trimestriels", "Quarterly") }, { value: 2, label: tr("Semestriels", "Semi-annual") }, { value: 1, label: tr("Annuels", "Annual") }]} />
            </div>
            <div className="form-row">
              <NumberField label={tr("Floor local", "Local floor")} value={req.cliquet.local_floor ?? -1} suffix="%" scale={100} min={-1} digits={1} onChange={(local_floor) => setC({ local_floor })} />
              <NumberField label={tr("Cap local", "Local cap")} value={req.cliquet.local_cap ?? 1} suffix="%" scale={100} min={-1} digits={1} onChange={(local_cap) => setC({ local_cap })} />
            </div>
            <NumberField label={tr("Floor global", "Global floor")} value={req.cliquet.global_floor ?? 0} suffix="%" scale={100} digits={1} onChange={(global_floor) => setC({ global_floor })} />
          </div>
        </div>
      </Card>
      <NotAvailable error={run.error} />
      {!data && !run.isPending && <div className="empty card">{tr("Réglez les produits puis lancez la comparaison.", "Set the products, then run the comparison.")}</div>}
      {run.isPending && <Skeleton height={300} />}
      {data && (
        <>
          <Card title={tr(`Digitale — vol ATM ${pct(data.digital.atm_vol, 1)}, vol au strike ${pct(data.digital.strike_vol, 1)}`, `Digital — ATM vol ${pct(data.digital.atm_vol, 1)}, vol at the strike ${pct(data.digital.strike_vol, 1)}`)}>
            <Explainer>
              {tr(<>
                Une digitale vaut −∂C/∂K. Avec un smile σ(K) : D = D<sub>BS</sub>(σ(K)) − Vega<sub>BS</sub> · ∂σ/∂K. Avec un
                skew négatif, ∂σ/∂K &lt; 0 et le call digital est nettement plus cher que ne le dit Black-Scholes. La vol locale
                (qui reprice exactement les vanilles) doit retrouver le prix « BS + pente du smile » : c'est un test de cohérence
                de la surface.
              </>, <>
                A digital is worth −∂C/∂K. With a smile σ(K): D = D<sub>BS</sub>(σ(K)) − Vega<sub>BS</sub> · ∂σ/∂K. With a
                negative skew, ∂σ/∂K &lt; 0 and the digital call is clearly more expensive than Black-Scholes says. Local vol
                (which reprices the vanillas exactly) must recover the "BS + smile slope" price: it is a consistency test
                of the surface.
              </>)}
            </Explainer>
            <EChart option={modelDotPlot(data.digital.rows)} height={280} ariaLabel={tr("Prix de la digitale selon le modèle", "Digital price by model")} />
          </Card>
          <Card title={tr("Digitale — détail", "Digital — detail")} flush><ModelTable rows={data.digital.rows} /></Card>
          <div className="grid cols-2">
            <Card title={tr(`Asiatique — vol ATM ${pct(data.asian.atm_vol, 1)}`, `Asian — ATM vol ${pct(data.asian.atm_vol, 1)}`)}>
              <EChart option={modelDotPlot(data.asian.rows)} height={240} ariaLabel={tr("Prix de l'asiatique selon le modèle", "Asian price by model")} />
            </Card>
            <Card title={tr(`Cliquet — vol ATM ${pct(data.cliquet.atm_vol, 1)}`, `Cliquet — ATM vol ${pct(data.cliquet.atm_vol, 1)}`)}>
              <EChart option={modelDotPlot(data.cliquet.rows)} height={240} ariaLabel={tr("Prix du cliquet selon le modèle", "Cliquet price by model")} />
            </Card>
          </div>
          <div className="grid cols-2">
            <Card title={tr("Asiatique — détail", "Asian — detail")} flush><ModelTable rows={data.asian.rows} /></Card>
            <Card title={tr("Cliquet — détail", "Cliquet — detail")} flush><ModelTable rows={data.cliquet.rows} /></Card>
          </div>
          <InfoBox>
            {tr("Heston n'est aussi crédible que sa calibration : si l'onglet Heston affiche des paramètres en butée (ρ proche de −1, κ très grand), l'écart sur le cliquet mesure surtout la limite du modèle sur ce marché.",
              "Heston is only as credible as its calibration: if the Heston tab shows parameters at their bounds (ρ close to −1, very large κ), the gap on the cliquet mostly measures the model's limit on this market.")}
          </InfoBox>
        </>
      )}
    </div>
  );
}
