import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ApiError, varianceApi, type VarianceSwapRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, InfoBox, NumberField, SelectField, Skeleton, Stat } from "../components/ui";
import { ccySymbol, money, num, pct } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { tr } from "../lib/i18n";

export const VARIANCE_PAGES = [
  { path: "replication", label: ["Strike juste et réplication", "Fair strike and replication"] },
  { path: "prime", label: ["Prime de risque de variance", "Variance risk premium"] },
] as const;

export default function Variance() {
  const { ticker } = useTicker();
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Swaps de variance et de volatilité", "Variance and volatility swaps")} — {ticker}</h1>
          <div className="page-sub">
            {tr("Strike juste par réplication statique sur le smile, comparaison des modèles, convexité du swap de vol, VIX recalculé et prime de risque de variance.",
              "Fair strike by static replication on the smile, model comparison, vol swap convexity, recomputed VIX and the variance risk premium.")}
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label={tr("Swaps de variance", "Variance swaps")}>
        {VARIANCE_PAGES.map((m) => (
          <NavLink key={m.path} to={`/variance/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{tr(m.label[0], m.label[1])}</NavLink>
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
    return <InfoBox>{error.message}. {tr("Le strike juste se calcule sur un smile coté : choisissez SPY, QQQ, AAPL, MSFT ou NVDA.", "The fair strike needs a quoted smile: pick SPY, QQQ, AAPL, MSFT or NVDA.")}</InfoBox>;
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
  const heston = d?.models.find((m) => m.model.startsWith("Heston (formule") || m.model.startsWith("Heston (closed"));

  const termOption = useCallback((p: ChartPalette) => {
    const rows = term.data?.rows ?? [];
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "value", name: tr("jours", "days"), nameLocation: "middle", nameGap: 26 },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [
        { type: "line", name: tr("Strike juste √K_var (réplication)", "Fair strike √K_var (replication)"), color: p.series[0], symbolSize: 7, lineStyle: { width: 2.5 },
          data: rows.map((r) => [r.days, r.fair_vol]) },
        { type: "line", name: "Vol ATM", color: p.series[1], symbolSize: 6, lineStyle: { width: 2, type: "dashed" }, data: rows.map((r) => [r.days, r.atm_vol]) },
        { type: "line", name: tr("Heston calibré", "Calibrated Heston"), color: p.series[2], symbolSize: 5, lineStyle: { width: 1.5 }, data: rows.map((r) => [r.days, r.heston_vol]) },
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
      xAxis: { type: "category", name: tr("strike coté", "listed strike"), nameLocation: "middle", nameGap: 26, data: l.strikes.map((k) => num(k, 0)), axisLabel: { hideOverlap: true } },
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
      xAxis: { type: "value", name: tr("vol réalisée", "realised vol"), nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => pct(v, 0) } },
      series: [{ type: "bar", name: tr("Fréquence", "Frequency"), color: p.series[2], barWidth: "90%", data: mid.map((m, i) => [m, counts[i] / total]),
        markLine: { symbol: "none", silent: true, label: { color: p.textSecondary, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: heston ? [
            { xAxis: heston.fair_vol, name: tr("√E[V] (swap de variance)", "√E[V] (variance swap)"), lineStyle: { color: p.series[0], width: 2 } },
            { xAxis: heston.vol_swap ?? 0, name: tr("E[√V] (swap de vol)", "E[√V] (vol swap)"), lineStyle: { color: p.series[1], width: 2, type: "dashed" } },
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
      xAxis: { type: "value", name: tr("vol réalisée (points)", "realised vol (points)"), nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax" },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v, ccy) } },
      series: [
        { type: "line", name: tr("Swap de variance", "Variance swap"), showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 }, data: pr.realized_vol.map((v, i) => [v, pr.variance_swap[i]]) },
        { type: "line", name: tr("Swap de vol", "Vol swap"), showSymbol: false, color: p.series[1], lineStyle: { width: 2, type: "dashed" }, data: pr.realized_vol.map((v, i) => [v, pr.volatility_swap[i]]) },
      ],
    };
  }, [d, ccy]);

  if (swap.error || term.error) return <NotAvailable error={swap.error ?? term.error} />;
  return (
    <div className="split">
      <div className="sticky">
        <Card title={tr("Contrat", "Contract")}>
          <div className="form">
            <SelectField label={tr("Maturité", "Maturity")} value={req.maturity_days} onChange={(maturity_days) => set({ maturity_days, elapsed_days: Math.min(req.elapsed_days, maturity_days - 1) })}
              options={[30, 61, 91, 182, 273, 365, 547].map((v) => ({ value: v, label: v < 365 ? tr(`${Math.round(v / 30.4)} mois`, `${Math.round(v / 30.4)} months`) : tr(`${num(v / 365, 1)} an${v >= 730 ? "s" : ""}`, `${num(v / 365, 1)} year${v >= 730 ? "s" : ""}`) }))} />
            <NumberField label={tr("Notionnel vega", "Vega notional")} value={req.vega_notional} suffix={ccySymbol(ccy)} min={1} digits={0}
              hint={tr("Gain par point de vol réalisée au-dessus du strike (près du strike)", "Gain per point of realised vol above the strike (near the strike)")} onChange={(vega_notional) => set({ vega_notional })} />
            <NumberField label={tr("Strike du contrat", "Contract strike")} value={req.strike_vol ?? 0} suffix="%" scale={100} min={0} digits={2}
              hint={tr("0 = strike juste du jour", "0 = today's fair strike")} onChange={(v) => set({ strike_vol: v > 0 ? v : null })} />
            <NumberField label={tr("Jours déjà écoulés", "Days already elapsed")} value={req.elapsed_days} suffix={tr("j", "d")} min={0} max={req.maturity_days - 1} digits={0}
              hint={tr("Swap en cours : la variance réalisée vient de l'historique", "Seasoned swap: the realised variance comes from history")} onChange={(elapsed_days) => set({ elapsed_days })} />
            <SelectField label={tr("Trajectoires Monte Carlo", "Monte Carlo paths")} value={req.n_paths} onChange={(n_paths) => set({ n_paths })}
              options={[5_000, 20_000, 50_000].map((v) => ({ value: v, label: num(v, 0) }))} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <Explainer>
          {tr(<>
            Un swap de variance paie N<sub>var</sub> (σ²<sub>réalisée</sub> − K<sub>var</sub>). La variance réalisée est celle d'un contrat log
            couvert en delta, et ce contrat se réplique par une bande d'options hors de la monnaie pondérées en 1/K² : le strike juste
            ne dépend que du smile du jour, sans modèle. Comme les puts bas sont chers (skew), √K<sub>var</sub> dépasse la vol ATM.
          </>, <>
            A variance swap pays N<sub>var</sub> (σ²<sub>realised</sub> − K<sub>var</sub>). The realised variance is that of a delta-hedged
            log contract, and that contract is replicated by a strip of out-of-the-money options weighted in 1/K²: the fair strike
            depends only on today's smile, with no model. Since low-strike puts are expensive (skew), √K<sub>var</sub> exceeds the ATM vol.
          </>)}
        </Explainer>
        <div className="grid cols-4">
          <Stat label={tr("Strike juste √K_var", "Fair strike √K_var")} value={pct(d?.fair_vol, 2)} foot={d ? tr(`Vol ATM ${pct(d.atm_vol, 2)} · prime de skew +${num((d.fair_vol - d.atm_vol) * 100, 2)} pts`, `ATM vol ${pct(d.atm_vol, 2)} · skew premium +${num((d.fair_vol - d.atm_vol) * 100, 2)} pts`) : undefined} busy={busy} />
          <Stat label={tr("Part des puts", "Share of puts")} value={pct(d?.put_share, 1)} foot={tr("Contribution des strikes sous le forward", "Contribution of strikes below the forward")} busy={busy} />
          <Stat label={tr("Swap de vol (Heston, MC)", "Vol swap (Heston, MC)")} value={pct(heston?.vol_swap, 2)} foot={heston ? tr(`Convexité ${num((heston.convexity ?? 0) * 100, 2)} pts sous √K_var`, `Convexity ${num((heston.convexity ?? 0) * 100, 2)} pts below √K_var`) : undefined} busy={busy} />
          <Stat label={tr("Strikes cotés (formule du VIX)", "Listed strikes (VIX formula)")} value={pct(d?.listed?.listed_vol, 2)}
            foot={d?.listed ? tr(`${d.listed.n_strikes} strikes, échéance ${d.listed.days} j ; surface ${pct(d.listed.surface_vol, 2)}`, `${d.listed.n_strikes} strikes, expiry ${d.listed.days} d; surface ${pct(d.listed.surface_vol, 2)}`) : "—"} busy={busy} />
        </div>
        <div className="grid cols-4">
          <Stat label={tr("Notionnel variance", "Variance notional")} value={d ? num(d.contract.variance_notional, 1) : "—"} foot={tr("N_vega / (2 K) par point² de variance", "N_vega / (2 K) per variance point²")} busy={busy} />
          <Stat label={tr("Valeur du contrat", "Contract value")} value={money(d?.contract.value, ccy)} foot={d ? `Strike ${pct(d.contract.strike_vol, 2)}` : undefined} busy={busy} />
          <Stat label={tr("Vega (1 pt de vol implicite)", "Vega (1 implied vol pt)")} value={money(d?.contract.vega, ccy)} foot={tr("Sur la durée restante", "Over the remaining life")} busy={busy} />
          <Stat label={tr("Vol réalisée depuis le départ", "Realised vol since inception")} value={d && d.contract.elapsed_days > 0 ? pct(d.contract.realized_vol_so_far, 2) : "—"}
            foot={d && d.contract.elapsed_days > 0 ? tr(`${d.contract.elapsed_days} jours d'historique`, `${d.contract.elapsed_days} days of history`) : tr("Contrat qui démarre aujourd'hui", "Contract starting today")} busy={busy} />
        </div>
        <Card title={tr("Structure par terme : strike juste, vol ATM et Heston", "Term structure: fair strike, ATM vol and Heston")}>
          {term.data ? <EChart option={termOption} height={320} ariaLabel={tr("Strike juste des swaps de variance par échéance", "Fair variance swap strike by expiry")} /> : <Skeleton height={280} />}
        </Card>
        <div className="grid cols-2">
          <Card title={tr("Réplication : d'où vient la variance", "Replication: where the variance comes from")}>
            {d ? <EChart option={densityOption} height={320} ariaLabel={tr("Contribution de chaque strike au strike de variance", "Contribution of each strike to the variance strike")} /> : <Skeleton height={280} />}
          </Card>
          <Card title={d?.listed ? tr(`Strikes cotés : échéance ${d.listed.expiry}`, `Listed strikes: expiry ${d.listed.expiry}`) : tr("Strikes cotés", "Listed strikes")}>
            {d?.listed ? <EChart option={listedOption} height={320} ariaLabel={tr("Contribution de chaque strike coté", "Contribution of each listed strike")} /> : <Skeleton height={280} />}
          </Card>
        </div>
        <InfoBox>
          {tr("Avec les seuls strikes cotés (formule du VIX), la bande s'arrête là où les cotations disparaissent : les ailes manquent et la variance est un peu sous-estimée par rapport à la surface SVI, qui extrapole les ailes.",
            "With listed strikes only (VIX formula), the strip stops where quotes disappear: the wings are missing and the variance is slightly underestimated compared with the SVI surface, which extrapolates the wings.")}
        </InfoBox>
        <Card title={tr("Strike juste selon le modèle", "Fair strike by model")} flush>
          {d ? (
            <div className={`table-wrap${busy ? " busy" : ""}`}>
              <table className="data">
                <thead><tr><th>{tr("Modèle", "Model")}</th><th>{tr("Swap de variance √E[V]", "Variance swap √E[V]")}</th><th>{tr("Swap de vol E[√V]", "Vol swap E[√V]")}</th><th>{tr("Convexité", "Convexity")}</th><th>{tr("Écart-type vol réalisée", "Realised vol std. dev.")}</th><th>{tr("Remarque", "Note")}</th></tr></thead>
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
          <Card title={tr("Heston : distribution de la vol réalisée", "Heston: distribution of realised vol")}>
            {d ? <EChart option={distOption} height={300} ariaLabel={tr("Distribution de la vol réalisée sous Heston", "Distribution of realised vol under Heston")} /> : <Skeleton height={260} />}
            {d && <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
              {tr(`Approximation de convexité √E[V] − Var(V) / (8 E[V]^3/2) : ${pct(d.heston.convexity_approx_vol, 2)} (vol de la variance σ = ${num(d.heston.sigma, 2)}).`,
                `Convexity approximation √E[V] − Var(V) / (8 E[V]^3/2): ${pct(d.heston.convexity_approx_vol, 2)} (vol of variance σ = ${num(d.heston.sigma, 2)}).`)}
            </div>}
          </Card>
          <Card title={tr("Payoff selon la vol réalisée", "Payoff by realised vol")}>
            {d ? <EChart option={payoffOption} height={300} ariaLabel={tr("Payoff du swap de variance et du swap de vol", "Payoff of the variance swap and the vol swap")} /> : <Skeleton height={260} />}
          </Card>
        </div>
        <InfoBox>
          {tr(<>
            Le payoff du swap de variance est convexe en vol réalisée : l'acheteur gagne davantage sur une forte hausse de vol qu'il ne
            perd sur une baisse. Cette convexité a un prix : le strike d'un swap de vol, linéaire, est sous √K<sub>var</sub>, d'autant
            plus que la vol de la variance est forte. Contrairement au swap de variance, le swap de vol ne se réplique pas sans modèle.
          </>, <>
            The variance swap payoff is convex in realised vol: the buyer gains more on a large rise in vol than they
            lose on a fall. That convexity has a price: the strike of a vol swap, which is linear, sits below √K<sub>var</sub>, all the
            more so when the vol of variance is high. Unlike the variance swap, the vol swap cannot be replicated without a model.
          </>)}
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
      yAxis: { type: "value", name: tr("vol (points)", "vol (points)") },
      dataZoom: [{ type: "inside" }],
      series: [
        { type: "line", name: tr("VIX (implicite 30 j)", "VIX (30-day implied)"), showSymbol: false, color: p.series[1], lineStyle: { width: 1.5 }, data: a.implied },
        { type: "line", name: tr("Vol réalisée de SPY sur les 21 jours suivants", "SPY realised vol over the next 21 days"), showSymbol: false, color: p.series[0], lineStyle: { width: 1.5 }, data: a.realized_next },
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
      yAxis: { type: "value", name: tr("P&L / notionnel vega", "P&L / vega notional") },
      series: [{ type: "bar", name: tr("Vente d'un swap de variance 1 mois", "Short 1-month variance swap"), data: m.map((x) => ({ value: x.pnl,
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
        { type: "line", name: tr("VIX officiel (CBOE, options S&P 500)", "Official VIX (CBOE, S&P 500 options)"), color: p.series[1], symbolSize: 6, lineStyle: { width: 2 }, data: r.map((x) => x.vix) },
        { type: "line", name: tr("Recalculé par Argus (options SPY en base)", "Recomputed by Argus (stored SPY options)"), color: p.series[0], symbolSize: 6, lineStyle: { width: 2, type: "dashed" }, data: r.map((x) => x.argus) },
      ],
    };
  }, [vix.data]);

  return (
    <div className="grid">
      <ErrorBox error={vrp.error} />
      <Explainer>
        {tr(<>
          Le VIX est le strike juste d'un swap de variance à 30 jours sur le S&P 500 (en points de vol). On le compare à la vol que
          SPY réalise ensuite sur 21 jours de bourse : l'écart est la <b>prime de risque de variance</b>, ce que l'acheteur de variance
          paie pour se protéger des hausses de volatilité.
        </>, <>
          The VIX is the fair strike of a 30-day variance swap on the S&P 500 (in vol points). We compare it with the vol that
          SPY then realises over 21 trading days: the gap is the <b>variance risk premium</b>, what the variance buyer
          pays for protection against rises in volatility.
        </>)}
      </Explainer>
      <div className="grid cols-4">
        <Stat label={tr("VIX moyen", "Mean VIX")} value={s ? num(s.mean_implied, 1) : "—"} foot={s ? tr(`Vol réalisée ensuite : ${num(s.mean_realized, 1)}`, `Realised vol afterwards: ${num(s.mean_realized, 1)}`) : undefined} />
        <Stat label={tr("Prime moyenne", "Mean premium")} value={s ? `+${num(s.mean_premium_vol_pts, 2)} pts` : "—"} foot={s ? tr(`Implicite > réalisée ${pct(s.share_implied_above, 0)} des jours`, `Implied > realised on ${pct(s.share_implied_above, 0)} of days`) : undefined} />
        <Stat label={tr("Vente mensuelle de variance", "Monthly variance selling")} value={s?.monthly_hit_rate != null ? pct(s.monthly_hit_rate, 0) : "—"} foot={tr("Part des mois gagnants", "Share of winning months")} />
        <Stat label={tr("Gain moyen / pire mois", "Mean gain / worst month")} value={s?.monthly_mean_pnl != null ? `${num(s.monthly_mean_pnl, 2)} / ${num(s.monthly_worst_pnl, 1)}` : "—"}
          foot={tr("En multiple du notionnel vega", "As a multiple of the vega notional")} />
      </div>
      <Card title={tr("VIX contre la vol réalisée qui a suivi", "VIX against the realised vol that followed")}>
        {vrp.data ? <EChart option={seriesOption} height={360} ariaLabel={tr("VIX et vol réalisée suivante de SPY", "VIX and the following SPY realised vol")} /> : <Skeleton height={300} />}
      </Card>
      <Card title={tr("P&L de la vente d'un swap de variance à 1 mois, chaque mois", "P&L of selling a 1-month variance swap, every month")}>
        {vrp.data ? <EChart option={monthlyOption} height={300} ariaLabel={tr("P&L mensuel de la vente de variance", "Monthly P&L of selling variance")} /> : <Skeleton height={260} />}
      </Card>
      <InfoBox>
        {tr("Vendre de la variance gagne presque tous les mois une petite prime, mais perd beaucoup lors des chocs de volatilité : le profil est celui d'une assurance vendue. C'est le payoff convexe du swap de variance qui crée ces pertes extrêmes.",
          "Selling variance earns a small premium almost every month, but loses a lot in volatility shocks: the profile is that of a sold insurance policy. The convex payoff of the variance swap is what creates these extreme losses.")}
      </InfoBox>
      <Card title={tr("Validation : le VIX recalculé à partir de nos chaînes d'options", "Validation: the VIX recomputed from our option chains")}>
        <Explainer>
          {tr(<>
            La formule officielle du CBOE (bande d'options OTM pondérées par ΔK/K², deux échéances interpolées à 30 jours) appliquée
            aux chaînes SPY stockées chaque jour. Écart médian avec le VIX officiel :{" "}
            <b>{vix.data?.summary.median_abs_gap != null ? `${num(vix.data.summary.median_abs_gap, 2)} point` : "…"}</b>{" "}
            sur {vix.data?.summary.n ?? "…"} jours (SPY contre S&P 500, heure du snapshot contre clôture, options américaines).
          </>, <>
            The official CBOE formula (strip of OTM options weighted by ΔK/K², two expiries interpolated to 30 days) applied
            to the SPY chains stored every day. Median gap with the official VIX:{" "}
            <b>{vix.data?.summary.median_abs_gap != null ? `${num(vix.data.summary.median_abs_gap, 2)} point` : "…"}</b>{" "}
            over {vix.data?.summary.n ?? "…"} days (SPY against the S&P 500, snapshot time against the close, American options).
          </>)}
        </Explainer>
        {vix.error ? <ErrorBox error={vix.error} /> : vix.data ? <EChart option={vixOption} height={300} ariaLabel={tr("VIX officiel et VIX recalculé", "Official and recomputed VIX")} /> : <Skeleton height={260} />}
      </Card>
    </div>
  );
}
