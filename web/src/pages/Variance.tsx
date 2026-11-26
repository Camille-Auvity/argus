import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ApiError, varianceApi, type VarianceSwapRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, InfoBox, NumberField, SelectField, Skeleton, Stat } from "../components/ui";
import { ccySymbol, money, num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export const VARIANCE_PAGES = [
  { path: "replication", label: "Strike juste et réplication" },
  { path: "prime", label: "Prime de risque de variance" },
] as const;

export default function Variance() {
  const { ticker } = useTicker();
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Swaps de variance et de volatilité — {ticker}</h1>
          <div className="page-sub">
            Strike juste par réplication statique sur le smile, comparaison des modèles, convexité du swap de vol, VIX
            recalculé et prime de risque de variance.
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label="Swaps de variance">
        {VARIANCE_PAGES.map((m) => (
          <NavLink key={m.path} to={`/variance/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

function NotAvailable({ error }: { error: unknown }) {
  if (error instanceof ApiError && error.status === 404) {
    return <InfoBox>{error.message}. Le strike juste se calcule sur un smile coté : choisissez SPY, QQQ, AAPL, MSFT ou NVDA.</InfoBox>;
  }
  return <ErrorBox error={error} />;
}

// ----------------------------------------------------------------------------- replication

export function ReplicationPage() {
  const { ticker, snapshot } = useTicker();
  const ccy = snapshot?.currency ?? "USD";
  const [req, setReq] = useState<VarianceSwapRequest>({ maturity_days: 91, vega_notional: 100_000, strike_vol: null, elapsed_days: 0, n_paths: 20_000 });
  const set = (patch: Partial<VarianceSwapRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 450);
  const term = useQuery({ queryKey: ["var-term", ticker], queryFn: () => varianceApi.term(ticker), retry: false });
  const swap = useQuery({ queryKey: ["var-swap", ticker, debounced], queryFn: () => varianceApi.swap(ticker, debounced),
    placeholderData: keepPreviousData, retry: false });
  const d = swap.data;
  const busy = swap.isFetching;
  const heston = d?.models.find((m) => m.model.startsWith("Heston (formule"));

  const termOption = useCallback((p: ChartPalette) => {
    const rows = term.data?.rows ?? [];
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "value", name: "jours", nameLocation: "middle", nameGap: 26 },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [
        { type: "line", name: "Strike juste √K_var (réplication)", color: p.series[0], symbolSize: 7, lineStyle: { width: 2.5 },
          data: rows.map((r) => [r.days, r.fair_vol]) },
        { type: "line", name: "Vol ATM", color: p.series[1], symbolSize: 6, lineStyle: { width: 2, type: "dashed" }, data: rows.map((r) => [r.days, r.atm_vol]) },
        { type: "line", name: "Heston calibré", color: p.series[2], symbolSize: 5, lineStyle: { width: 1.5 }, data: rows.map((r) => [r.days, r.heston_vol]) },
      ],
    };
  }, [term.data]);

  const densityOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const F = d.replication.F;
    // keep the strikes that actually contribute (the integration grid reaches far into the wings)
    const peak = Math.max(...d.replication.density);
    const pts = d.replication.k.map((k, i) => [F * Math.exp(k), d.replication.density[i]])
      .filter(([, v]) => v > peak * 2e-3);
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 4) },
      xAxis: { type: "value", name: "strike", nameLocation: "middle", nameGap: 26, min: Math.floor(pts[0][0]), max: Math.ceil(pts[pts.length - 1][0]),
        axisLabel: { formatter: (v: number) => num(v, 0) } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => num(v, 2) } },
      series: [
        { type: "line", name: "Puts (K < F)", showSymbol: false, color: p.series[1], areaStyle: { opacity: 0.25 }, lineStyle: { width: 1.5 },
          data: pts.filter(([K]) => K <= F) },
        { type: "line", name: "Calls (K > F)", showSymbol: false, color: p.series[0], areaStyle: { opacity: 0.25 }, lineStyle: { width: 1.5 },
          data: pts.filter(([K]) => K >= F),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dashed", width: 1 },
            label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
            data: [{ xAxis: d.spot, name: "spot" }, { xAxis: F, name: "forward" }] } },
      ],
    };
  }, [d]);

  const listedOption = useCallback((p: ChartPalette) => {
    if (!d?.listed) return {};
    const l = d.listed;
    return {
      grid: { top: 20 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 5) },
      xAxis: { type: "category", name: "strike coté", nameLocation: "middle", nameGap: 26, data: l.strikes.map((k) => num(k, 0)), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value" },
      series: [{ type: "bar", name: "(2/T) e^{rT} ΔK Q(K) / K²", barCategoryGap: "10%",
        data: l.strikes.map((k, i) => ({ value: l.contributions[i], itemStyle: { color: k < l.forward ? p.series[1] : p.series[0] } })) }],
    };
  }, [d]);

  const distOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const { edges, heston: counts } = d.realized_vol_distribution;
    const total = counts.reduce((a, b) => a + b, 0);
    const mid = counts.map((_, i) => (edges[i] + edges[i + 1]) / 2);
    return {
      grid: { top: 20 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 1) },
      xAxis: { type: "value", name: "vol réalisée", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [{ type: "bar", name: "Fréquence", color: p.series[2], barWidth: "90%", data: mid.map((m, i) => [m, counts[i] / total]),
        markLine: { symbol: "none", silent: true, label: { color: p.textSecondary, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: heston ? [
            { xAxis: heston.fair_vol, name: "√E[V] (swap de variance)", lineStyle: { color: p.series[0], width: 2 } },
            { xAxis: heston.vol_swap ?? 0, name: "E[√V] (swap de vol)", lineStyle: { color: p.series[1], width: 2, type: "dashed" } },
          ] : [] } }],
    };
  }, [d, heston]);

  const payoffOption = useCallback((p: ChartPalette) => {
    if (!d) return {};
    const pr = d.contract.profile;
    return {
      legend: {},
      grid: { top: 34, left: 70 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v, ccy) },
      xAxis: { type: "value", name: "vol réalisée (points)", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax" },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v, ccy) } },
      series: [
        { type: "line", name: "Swap de variance", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: pr.realized_vol.map((v, i) => [v, pr.variance_swap[i]]) },
        { type: "line", name: "Swap de vol", showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: pr.realized_vol.map((v, i) => [v, pr.volatility_swap[i]]) },
      ],
    };
  }, [d, ccy]);

  if (swap.error || term.error) return <NotAvailable error={swap.error ?? term.error} />;
  return (
    <div className="split">
      <div className="sticky">
        <Card title="Contrat">
          <div className="form">
            <SelectField label="Maturité" value={req.maturity_days} onChange={(maturity_days) => set({ maturity_days, elapsed_days: Math.min(req.elapsed_days, maturity_days - 1) })}
              options={[30, 61, 91, 182, 273, 365, 547].map((v) => ({ value: v, label: v < 365 ? `${Math.round(v / 30.4)} mois` : `${num(v / 365, 1)} an${v >= 730 ? "s" : ""}` }))} />
            <NumberField label="Notionnel vega" value={req.vega_notional} suffix={ccySymbol(ccy)} min={1} digits={0}
              hint="Gain par point de vol réalisée au-dessus du strike (près du strike)" onChange={(vega_notional) => set({ vega_notional })} />
            <NumberField label="Strike du contrat" value={req.strike_vol ?? 0} suffix="%" scale={100} min={0} digits={2}
              hint="0 = strike juste du jour" onChange={(v) => set({ strike_vol: v > 0 ? v : null })} />
            <NumberField label="Jours déjà écoulés" value={req.elapsed_days} suffix="j" min={0} max={req.maturity_days - 1} digits={0}
              hint="Swap en cours : la variance réalisée vient de l'historique" onChange={(elapsed_days) => set({ elapsed_days })} />
            <SelectField label="Trajectoires Monte Carlo" value={req.n_paths} onChange={(n_paths) => set({ n_paths })}
              options={[5_000, 20_000, 50_000].map((v) => ({ value: v, label: v.toLocaleString("fr-FR") }))} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <Explainer>
          Un swap de variance paie N<sub>var</sub> (σ²<sub>réalisée</sub> − K<sub>var</sub>). La variance réalisée est celle d'un contrat log
          couvert en delta, et ce contrat se réplique par une bande d'options hors de la monnaie pondérées en 1/K² : le strike juste
          ne dépend que du smile du jour, sans modèle. Comme les puts bas sont chers (skew), √K<sub>var</sub> dépasse la vol ATM.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Strike juste √K_var" value={pct(d?.fair_vol, 2)} foot={d ? `Vol ATM ${pct(d.atm_vol, 2)} · prime de skew +${num((d.fair_vol - d.atm_vol) * 100, 2)} pts` : undefined} busy={busy} />
          <Stat label="Part des puts" value={pct(d?.put_share, 1)} foot="Contribution des strikes sous le forward" busy={busy} />
          <Stat label="Swap de vol (Heston, MC)" value={pct(heston?.vol_swap, 2)} foot={heston ? `Convexité ${num((heston.convexity ?? 0) * 100, 2)} pts sous √K_var` : undefined} busy={busy} />
          <Stat label="Strikes cotés (formule du VIX)" value={pct(d?.listed?.listed_vol, 2)}
            foot={d?.listed ? `${d.listed.n_strikes} strikes, échéance ${d.listed.days} j ; surface ${pct(d.listed.surface_vol, 2)}` : "—"} busy={busy} />
        </div>
        <div className="grid cols-4">
          <Stat label="Notionnel variance" value={d ? num(d.contract.variance_notional, 1) : "—"} foot="N_vega / (2 K) par point² de variance" busy={busy} />
          <Stat label="Valeur du contrat" value={money(d?.contract.value, ccy)} foot={d ? `Strike ${pct(d.contract.strike_vol, 2)}` : undefined} busy={busy} />
          <Stat label="Vega (1 pt de vol implicite)" value={money(d?.contract.vega, ccy)} foot="Sur la durée restante" busy={busy} />
          <Stat label="Vol réalisée depuis le départ" value={d && d.contract.elapsed_days > 0 ? pct(d.contract.realized_vol_so_far, 2) : "—"}
            foot={d && d.contract.elapsed_days > 0 ? `${d.contract.elapsed_days} jours d'historique` : "Contrat qui démarre aujourd'hui"} busy={busy} />
        </div>
        <Card title="Structure par terme : strike juste, vol ATM et Heston">
          {term.data ? <EChart option={termOption} height={320} ariaLabel="Strike juste des swaps de variance par échéance" /> : <Skeleton height={280} />}
        </Card>
        <div className="grid cols-2">
          <Card title="Réplication : d'où vient la variance">
            {d ? <EChart option={densityOption} height={320} ariaLabel="Contribution de chaque strike au strike de variance" /> : <Skeleton height={280} />}
          </Card>
          <Card title={d?.listed ? `Strikes cotés : échéance ${d.listed.expiry}` : "Strikes cotés"}>
            {d?.listed ? <EChart option={listedOption} height={320} ariaLabel="Contribution de chaque strike coté" /> : <Skeleton height={280} />}
          </Card>
        </div>
        <InfoBox>
          Avec les seuls strikes cotés (formule du VIX), la bande s'arrête là où les cotations disparaissent : les ailes manquent et
          la variance est un peu sous-estimée par rapport à la surface SVI, qui extrapole les ailes.
        </InfoBox>
        <Card title="Strike juste selon le modèle" flush>
          {d ? (
            <div className={`table-wrap${busy ? " busy" : ""}`}>
              <table className="data">
                <thead><tr><th>Modèle</th><th>Swap de variance √E[V]</th><th>Swap de vol E[√V]</th><th>Convexité</th><th>Écart-type vol réalisée</th><th>Remarque</th></tr></thead>
                <tbody>
                  {d.models.map((m) => (
                    <tr key={m.model}>
                      <td className="strong">{m.model}</td><td className="strong">{pct(m.fair_vol, 2)}</td><td>{pct(m.vol_swap, 2)}</td>
                      <td>{m.convexity != null ? `${num(m.convexity * 100, 2)} pts` : "—"}</td><td>{pct(m.std_realized_vol, 1)}</td>
                      <td className="muted" style={{ textAlign: "left" }}>{m.note}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <div className="card-body"><Skeleton height={160} /></div>}
        </Card>
        <div className="grid cols-2">
          <Card title="Heston : distribution de la vol réalisée">
            {d ? <EChart option={distOption} height={300} ariaLabel="Distribution de la vol réalisée sous Heston" /> : <Skeleton height={260} />}
            {d && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              Approximation de convexité √E[V] − Var(V) / (8 E[V]^3/2) : {pct(d.heston.convexity_approx_vol, 2)} (vol de la variance σ = {num(d.heston.sigma, 2)}).
            </div>}
          </Card>
          <Card title="Payoff selon la vol réalisée">
            {d ? <EChart option={payoffOption} height={300} ariaLabel="Payoff du swap de variance et du swap de vol" /> : <Skeleton height={260} />}
          </Card>
        </div>
        <InfoBox>
          Le payoff du swap de variance est convexe en vol réalisée : l'acheteur gagne davantage sur une forte hausse de vol qu'il ne
          perd sur une baisse. Cette convexité a un prix : le strike d'un swap de vol, linéaire, est sous √K<sub>var</sub>, d'autant
          plus que la vol de la variance est forte. Contrairement au swap de variance, le swap de vol ne se réplique pas sans modèle.
        </InfoBox>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- variance risk premium

export function PremiumPage() {
  const vrp = useQuery({ queryKey: ["vrp"], queryFn: varianceApi.vrp, retry: false });
  const vix = useQuery({ queryKey: ["vix-check"], queryFn: varianceApi.vixCheck, retry: false });
  const s = vrp.data?.summary;

  const seriesOption = useCallback((p: ChartPalette) => {
    if (!vrp.data) return {};
    const a = vrp.data.aligned;
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 1) },
      xAxis: { type: "category", data: a.date, axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", name: "vol (points)" },
      dataZoom: [{ type: "inside" }],
      series: [
        { type: "line", name: "VIX (implicite 30 j)", showSymbol: false, color: p.series[1], lineStyle: { width: 1.5 }, data: a.implied },
        { type: "line", name: "Vol réalisée de SPY sur les 21 jours suivants", showSymbol: false, color: p.series[0], lineStyle: { width: 1.5 }, data: a.realized_next },
      ],
    };
  }, [vrp.data]);

  const monthlyOption = useCallback((p: ChartPalette) => {
    if (!vrp.data) return {};
    const m = vrp.data.monthly;
    return {
      grid: { top: 20 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => `${num(v, 2)} × vega` },
      xAxis: { type: "category", data: m.map((x) => x.date), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", name: "P&L / notionnel vega" },
      series: [{ type: "bar", name: "Vente d'un swap de variance 1 mois", data: m.map((x) => ({ value: x.pnl,
        itemStyle: { color: x.pnl >= 0 ? p.diverging[2] : p.diverging[0], borderRadius: x.pnl >= 0 ? [3, 3, 0, 0] : [0, 0, 3, 3] } })) }],
    };
  }, [vrp.data]);

  const vixOption = useCallback((p: ChartPalette) => {
    if (!vix.data) return {};
    const r = vix.data.rows;
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 2) },
      xAxis: { type: "category", data: r.map((x) => x.date), axisLabel: { hideOverlap: true } },
      yAxis: { type: "value", scale: true },
      series: [
        { type: "line", name: "VIX officiel (CBOE, options S&P 500)", color: p.series[1], symbolSize: 6, lineStyle: { width: 2 }, data: r.map((x) => x.vix) },
        { type: "line", name: "Recalculé par Argus (options SPY en base)", color: p.series[0], symbolSize: 6, lineStyle: { width: 2, type: "dashed" }, data: r.map((x) => x.argus) },
      ],
    };
  }, [vix.data]);

  return (
    <div className="grid">
      <ErrorBox error={vrp.error} />
      <Explainer>
        Le VIX est le strike juste d'un swap de variance à 30 jours sur le S&P 500 (en points de vol). On le compare à la vol que
        SPY réalise ensuite sur 21 jours de bourse : l'écart est la <b>prime de risque de variance</b>, ce que l'acheteur de variance
        paie pour se protéger des hausses de volatilité.
      </Explainer>
      <div className="grid cols-4">
        <Stat label="VIX moyen" value={s ? num(s.mean_implied, 1) : "—"} foot={s ? `Vol réalisée ensuite : ${num(s.mean_realized, 1)}` : undefined} />
        <Stat label="Prime moyenne" value={s ? `+${num(s.mean_premium_vol_pts, 2)} pts` : "—"} foot={s ? `Implicite > réalisée ${pct(s.share_implied_above, 0)} des jours` : undefined} />
        <Stat label="Vente mensuelle de variance" value={s?.monthly_hit_rate != null ? pct(s.monthly_hit_rate, 0) : "—"} foot="Part des mois gagnants" />
        <Stat label="Gain moyen / pire mois" value={s?.monthly_mean_pnl != null ? `${num(s.monthly_mean_pnl, 2)} / ${num(s.monthly_worst_pnl, 1)}` : "—"}
          foot="En multiple du notionnel vega" />
      </div>
      <Card title="VIX contre la vol réalisée qui a suivi">
        {vrp.data ? <EChart option={seriesOption} height={360} ariaLabel="VIX et vol réalisée suivante de SPY" /> : <Skeleton height={300} />}
      </Card>
      <Card title="P&L de la vente d'un swap de variance à 1 mois, chaque mois">
        {vrp.data ? <EChart option={monthlyOption} height={300} ariaLabel="P&L mensuel de la vente de variance" /> : <Skeleton height={260} />}
      </Card>
      <InfoBox>
        Vendre de la variance gagne presque tous les mois une petite prime, mais perd beaucoup lors des chocs de volatilité : le
        profil est celui d'une assurance vendue. C'est le payoff convexe du swap de variance qui crée ces pertes extrêmes.
      </InfoBox>
      <Card title="Validation : le VIX recalculé à partir de nos chaînes d'options">
        <Explainer>
          La formule officielle du CBOE (bande d'options OTM pondérées par ΔK/K², deux échéances interpolées à 30 jours) appliquée
          aux chaînes SPY stockées chaque jour. Écart médian avec le VIX officiel :{" "}
          <b>{vix.data?.summary.median_abs_gap != null ? `${num(vix.data.summary.median_abs_gap, 2)} point` : "…"}</b>{" "}
          sur {vix.data?.summary.n ?? "…"} jours (SPY contre S&P 500, heure du snapshot contre clôture, options américaines).
        </Explainer>
        {vix.error ? <ErrorBox error={vix.error} /> : vix.data ? <EChart option={vixOption} height={300} ariaLabel="VIX officiel et VIX recalculé" /> : <Skeleton height={260} />}
      </Card>
    </div>
  );
}
