import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ratesFxApi, type CapRequest, type FXMarketResponse, type FXRequest } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { money, num, pct } from "../lib/format";
import { useDebounced } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

export const RATES_FX_PAGES = [
  { path: "caps", label: "Caps & floors" },
  { path: "fx", label: "Options de change EUR/USD" },
] as const;

export default function RatesFx() {
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Options de taux et de change</h1>
          <div className="page-sub">
            Caps et floors sur les courbes USD et EUR (Black-76 ou Bachelier), options EUR/USD (Garman-Kohlhagen)
            avec un smile construit à partir des cotations ATM, risk reversal et butterfly.
          </div>
        </div>
      </div>
      <nav className="tabs subnav" aria-label="Options de taux et de change">
        {RATES_FX_PAGES.map((m) => (
          <NavLink key={m.path} to={`/rates-fx/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

function Explainer({ children }: { children: ReactNode }) {
  return <p className="explainer" style={{ margin: 0 }}>{children}</p>;
}

/** Exact zero for numerical noise (cap - floor at the money, swap at its par rate). */
const clean = (x: number | null | undefined) => (x != null && Math.abs(x) < 0.005 ? 0 : x);
const bp = (x: number | null | undefined, digits = 1) => (x == null || !Number.isFinite(x) ? "—" : `${num(x * 1e4, digits)} bp`);

// ----------------------------------------------------------------------------- caps & floors

export function CapsPage() {
  const [atm, setAtm] = useState(true);
  const [req, setReq] = useState<CapRequest>({
    currency: "USD", maturity: 5, frequency: 4, strike: null, kind: "cap", model: "bachelier", vol: 0.01, notional: 10_000_000,
    market_price: null,
  });
  const set = (patch: Partial<CapRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req);
  const { data, error, isFetching } = useQuery({ queryKey: ["cap", debounced], queryFn: () => ratesFxApi.cap(debounced), placeholderData: keepPreviousData });
  const g = data?.greeks;
  const ccy = req.currency;
  const normal = req.model === "bachelier";

  const switchModel = (model: CapRequest["model"]) => {
    // keep a comparable vol: normal vol ~ lognormal vol x forward
    const fwd = data?.atm_strike ?? 0.04;
    set({ model, vol: model === "bachelier" ? Math.max(0.0005, req.vol * Math.max(fwd, 0.005)) : Math.max(0.01, req.vol / Math.max(fwd, 0.005)) });
  };

  const capletOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34, right: 64 },
    tooltip: { trigger: "axis" },
    xAxis: { type: "category", name: "fixing (ans)", nameLocation: "middle", nameGap: 26, data: data?.caplets.map((c) => num(c.start, 2)) ?? [] },
    yAxis: [
      { type: "value", name: "valeur", axisLabel: { formatter: (v: number) => money(v, ccy) } },
      { type: "value", name: "taux", axisLabel: { formatter: (v: number) => pct(v, 1) }, splitLine: { show: false } },
    ],
    series: [
      { type: "bar", name: `Valeur du ${req.kind === "cap" ? "caplet" : "floorlet"}`, color: p.series[0], itemStyle: { borderRadius: [3, 3, 0, 0] },
        tooltip: { valueFormatter: (v: number) => money(v, ccy) }, data: data?.caplets.map((c) => c.price) ?? [] },
      { type: "line", name: "Taux forward", yAxisIndex: 1, color: p.series[1], symbolSize: 5, lineStyle: { width: 2 },
        tooltip: { valueFormatter: (v: number) => pct(v, 3) }, data: data?.caplets.map((c) => c.forward) ?? [] },
      { type: "line", name: "Strike", yAxisIndex: 1, color: p.muted, showSymbol: false, lineStyle: { width: 1.5, type: "dashed" },
        tooltip: { valueFormatter: (v: number) => pct(v, 3) }, data: data?.caplets.map(() => data.strike) ?? [] },
    ],
  }), [data, ccy, req.kind]);

  const profileOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => money(v, ccy) },
    xAxis: { type: "value", name: "strike", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax", axisLabel: { formatter: (v: number) => pct(v, 1) } },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v, ccy) } },
    series: [
      { type: "line", name: "Cap", showSymbol: false, color: p.series[0], lineStyle: { width: 2 }, data: data?.profile.strike.map((k, i) => [k, data.profile.cap[i]]) ?? [],
        markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dashed", width: 1 },
          label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: data ? [{ xAxis: data.atm_strike, name: "ATM" }, { xAxis: data.strike, name: "K" }] : [] } },
      { type: "line", name: "Floor", showSymbol: false, color: p.series[1], lineStyle: { width: 2 }, data: data?.profile.strike.map((k, i) => [k, data.profile.floor[i]]) ?? [] },
    ],
  }), [data, ccy]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Paramètres">
          <div className="form">
            <Segmented value={req.kind} onChange={(kind) => set({ kind })} options={[{ value: "cap", label: "Cap" }, { value: "floor", label: "Floor" }]} />
            <div className="form-row">
              <Segmented label="Courbe" value={req.currency} onChange={(currency) => set({ currency })} options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }]} />
              <SelectField label="Fréquence" value={req.frequency} onChange={(frequency) => set({ frequency })}
                options={[{ value: 12, label: "Mensuelle" }, { value: 4, label: "Trimestrielle" }, { value: 2, label: "Semestrielle" }, { value: 1, label: "Annuelle" }]} />
            </div>
            <div className="form-row">
              <NumberField label="Maturité" value={req.maturity} suffix="ans" min={0.5} max={30} digits={2} onChange={(maturity) => set({ maturity })} />
              <SelectField label="Strike" value={atm ? "atm" : "fixed"} onChange={(v) => { setAtm(v === "atm"); set({ strike: v === "atm" ? null : data?.atm_strike ?? 0.04 }); }}
                options={[{ value: "atm", label: "ATM (taux swap)" }, { value: "fixed", label: "Fixé" }]} />
            </div>
            {!atm && <NumberField label="Niveau du strike" value={req.strike ?? 0.04} suffix="%" scale={100} digits={3} onChange={(strike) => set({ strike })} />}
            <div className="form-sep" />
            <div className="form-group-title">Volatilité</div>
            <Segmented value={req.model} onChange={switchModel}
              options={[{ value: "bachelier", label: "Bachelier" }, { value: "black", label: "Black-76" }]} />
            {normal
              ? <NumberField label="Vol normale" value={req.vol} suffix="bp" scale={1e4} min={0.0001} digits={1} hint="Points de base par an" onChange={(vol) => set({ vol })} />
              : <NumberField label="Vol log-normale" value={req.vol} suffix="%" scale={100} min={0.01} digits={1} onChange={(vol) => set({ vol })} />}
            <NumberField label="Nominal" value={req.notional} suffix={ccy === "EUR" ? "€" : "$"} min={1} digits={0} onChange={(notional) => set({ notional })} />
            <NumberField label="Prix de marché (optionnel)" value={req.market_price ?? 0} suffix={ccy === "EUR" ? "€" : "$"} min={0} digits={0}
              hint="Pour retrouver la vol plate implicite" onChange={(v) => set({ market_price: v > 0 ? v : null })} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <Explainer>
          Un {req.kind} est une série de {req.kind === "cap" ? "caplets" : "floorlets"} : à chaque période, une option sur le taux forward
          L<sub>i</sub> fixé en début de période et payé en fin, valorisée en Black-76 (taux log-normal) ou en Bachelier (taux normal,
          utilisable avec des taux nuls ou négatifs). La première période, déjà fixée, est exclue. Les forwards viennent de la
          courbe {ccy === "USD" ? "Treasury" : "BCE"} stockée en base.
        </Explainer>
        <div className="grid cols-4">
          <Stat label="Prime" value={money(data?.price, ccy)} foot={data ? `${num(data.price_pct * 100, 3)} % du nominal` : undefined} busy={isFetching} />
          <Stat label="Prime en running" value={data ? `${num(data.running_bp, 1)} bp / an` : "—"} foot="Prime / annuité des caplets" busy={isFetching} />
          <Stat label="Strike" value={pct(data?.strike, 3)} foot={data ? `ATM (taux swap forward) ${pct(data.atm_strike, 3)}` : undefined} busy={isFetching} />
          <Stat label={`Parité ${req.kind} − ${data?.parity.other_kind ?? ""}`} value={data ? money(clean(req.kind === "cap" ? data.price - data.parity.other_price : data.parity.other_price - data.price), ccy) : "—"}
            foot={data ? `= swap payeur ${money(clean(data.parity.swap_value), ccy)}` : undefined} busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label="DV01 (+1 bp de taux)" value={money(g?.dv01, ccy)} foot={req.kind === "cap" ? "Le cap gagne quand les taux montent" : "Le floor gagne quand les taux baissent"} busy={isFetching} />
          <Stat label="Gamma (1 bp)" value={money(g?.gamma_1bp, ccy)} foot="V(+1 bp) − 2V + V(−1 bp)" busy={isFetching} />
          <Stat label={normal ? "Vega (1 bp de vol normale)" : "Vega (1 % de vol)"} value={money(g?.vega, ccy)} busy={isFetching} />
          <Stat label="Theta (1 jour)" value={money(g?.theta, ccy)} foot={data?.implied_vol != null ? `Vol implicite du prix de marché : ${normal ? bp(data.implied_vol) : pct(data.implied_vol, 2)}` : undefined} busy={isFetching} />
        </div>
        <Card title="Caplets : valeur, forward et strike">
          {data ? <EChart option={capletOption} height={360} ariaLabel="Valeur de chaque caplet et taux forward" /> : <Skeleton height={300} />}
        </Card>
        <div className="grid cols-2">
          <Card title="Prix selon le strike (même vol)">
            {data ? <EChart option={profileOption} height={320} ariaLabel="Prix du cap et du floor selon le strike" /> : <Skeleton height={260} />}
          </Card>
          <Card title="Détail des caplets" flush>
            {data ? (
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
                <table className="data">
                  <thead><tr><th>Période</th><th>Forward</th><th>DF</th><th>Valeur</th><th>Delta 1 bp</th><th>Vega</th></tr></thead>
                  <tbody>
                    {data.caplets.map((c) => (
                      <tr key={c.start}>
                        <td className="strong">{num(c.start, 2)} → {num(c.end, 2)}</td><td>{pct(c.forward, 3)}</td><td>{num(c.discount, 4)}</td>
                        <td className="strong">{money(c.price, ccy)}</td><td>{money(c.delta * 1e-4, ccy)}</td>
                        <td>{money(c.vega * (normal ? 1e-4 : 0.01), ccy)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <div className="card-body"><Skeleton height={200} /></div>}
          </Card>
        </div>
        <InfoBox>
          Il n'existe pas de cotation gratuite des vols de caps : la vol est saisie (par défaut 100 bp en normal, un ordre de grandeur
          réaliste pour le dollar). Les courbes sont des courbes d'État (Treasury, BCE), une approximation des courbes swap
          SOFR / €STR utilisées par le marché.
        </InfoBox>
      </div>
    </div>
  );
}

// ----------------------------------------------------------------------------- FX

export function FxPage() {
  const market = useQuery({ queryKey: ["fx-market"], queryFn: ratesFxApi.fxMarket, retry: false });
  if (market.isLoading) return <Skeleton height={300} />;
  if (market.error) return <ErrorBox error={market.error} />;
  return market.data ? <FxDesk market={market.data} /> : null;
}

function FxDesk({ market }: { market: FXMarketResponse }) {
  const rv1y = market.realized_vol["1A"] ?? 0.075;
  const [req, setReq] = useState<FXRequest>({
    expiry: 0.5, atm: Math.round(Math.max(rv1y, 0.03) * 1000) / 1000, rr25: 0.003, bf25: 0.0025, convention: null,
    option_type: "call", strike_mode: "delta", strike: null, delta: 0.25, notional: 10_000_000, spot: null,
  });
  const set = (patch: Partial<FXRequest>) => setReq((r) => ({ ...r, ...patch }));
  const debounced = useDebounced(req, 400);
  const { data, error, isFetching } = useQuery({ queryKey: ["fx", debounced], queryFn: () => ratesFxApi.fx(debounced), placeholderData: keepPreviousData });
  const o = data?.option;
  const g = o?.greeks;
  const pillars = data ? Object.entries(data.smile.pillars) : [];

  const smileOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const c = data.smile.curve;
    return {
      legend: { top: 0 },
      grid: { top: 70, right: 24 },
      tooltip: { trigger: "axis" },
      xAxis: { type: "value", name: "strike", nameLocation: "middle", nameGap: 26, min: "dataMin", max: "dataMax", axisLabel: { formatter: (v: number) => num(v, 3) } },
      yAxis: [
        { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 1) } },
        { type: "value", splitLine: { show: false }, axisLabel: { show: false } },
      ],
      series: [
        { type: "line", name: "Vanna-Volga", showSymbol: false, color: p.series[0], lineStyle: { width: 2.5 },
          tooltip: { valueFormatter: (v: number) => pct(v, 2) }, data: c.strike.map((k, i) => [k, c.vol[i]]) },
        { type: "line", name: "Approximation 1er ordre (Lagrange en ln K)", showSymbol: false, color: p.series[2], lineStyle: { width: 1.5, type: "dashed" },
          tooltip: { valueFormatter: (v: number) => pct(v, 2) }, data: c.strike.map((k, i) => [k, c.vol_first_order[i]]) },
        { type: "scatter", name: "Piliers 25Δ put / ATM / 25Δ call", symbolSize: 11, color: p.series[1], itemStyle: { borderColor: p.surface, borderWidth: 2 },
          tooltip: { valueFormatter: (v: number) => pct(v, 2) }, data: pillars.map(([, v]) => [v.strike, v.vol]) },
        { type: "line", name: "Densité risque-neutre", yAxisIndex: 1, showSymbol: false, color: p.muted, lineStyle: { width: 1 },
          areaStyle: { opacity: 0.08 }, tooltip: { valueFormatter: (v: number) => num(v, 2) }, data: c.strike.map((k, i) => [k, c.density[i]]),
          markLine: { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dashed", width: 1 },
            label: { color: p.muted, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
            data: [{ xAxis: data.market.spot, name: "spot" }, { xAxis: data.market.forward, name: "forward" }, ...(o ? [{ xAxis: o.strike, name: "K" }] : [])] } },
      ],
    };
  }, [data, o, pillars]);

  const historyOption = useCallback((p: ChartPalette) => ({
    grid: { top: 12, left: 48 },
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v, 4) },
    xAxis: { type: "category", show: false, data: market.history.map((_, i) => i) },
    yAxis: { type: "value", scale: true },
    series: [{ type: "line", showSymbol: false, color: p.series[0], lineStyle: { width: 1.5 }, data: market.history }],
  }), [market]);

  return (
    <div className="split">
      <div className="sticky">
        <Card title="Cotations du smile">
          <div className="form">
            <NumberField label="Échéance" value={req.expiry * 12} suffix="mois" min={0.25} max={60} digits={1} onChange={(v) => set({ expiry: v / 12 })} />
            <NumberField label="Vol ATM (straddle delta-neutre)" value={req.atm} suffix="%" scale={100} min={0.001} digits={2}
              hint={`Vol réalisée : 1M ${pct(market.realized_vol["1M"], 1)} · 3M ${pct(market.realized_vol["3M"], 1)} · 1A ${pct(market.realized_vol["1A"], 1)}`}
              onChange={(atm) => set({ atm })} />
            <div className="form-row">
              <NumberField label="Risk reversal 25Δ" value={req.rr25} suffix="%" scale={100} digits={2} hint="σ(25Δ call) − σ(25Δ put)" onChange={(rr25) => set({ rr25 })} />
              <NumberField label="Butterfly 25Δ (marché)" value={req.bf25} suffix="%" scale={100} digits={2} hint="Strangle de marché (broker fly)" onChange={(bf25) => set({ bf25 })} />
            </div>
            <div className="form-sep" />
            <div className="form-group-title">Option (nominal en EUR)</div>
            <Segmented value={req.option_type} onChange={(option_type) => set({ option_type })}
              options={[{ value: "call", label: "Call EUR / put USD" }, { value: "put", label: "Put EUR / call USD" }]} />
            <SelectField label="Strike" value={req.strike_mode} onChange={(strike_mode) => set({ strike_mode, strike: strike_mode === "strike" ? (o?.strike ?? market.spot) : null })}
              options={[{ value: "delta", label: "Par delta" }, { value: "atm", label: "ATM delta-neutre" }, { value: "strike", label: "Niveau fixé" }]} />
            {req.strike_mode === "delta" && <NumberField label="Delta" value={req.delta} suffix="Δ" scale={100} min={0.01} max={0.99} digits={0} onChange={(delta) => set({ delta })} />}
            {req.strike_mode === "strike" && <NumberField label="Strike" value={req.strike ?? market.spot} min={0.0001} digits={4} onChange={(strike) => set({ strike })} />}
            <NumberField label="Nominal" value={req.notional} suffix="€" min={1} digits={0} onChange={(notional) => set({ notional })} />
          </div>
        </Card>
      </div>
      <div className="grid">
        <ErrorBox error={error} />
        <div className="grid cols-4">
          <Stat label={`EUR/USD au ${market.asof}`} value={num(market.spot, 4)} foot={data ? `Forward ${num(data.market.forward, 4)} (${num((data.market.forward - data.market.spot) * 1e4, 1)} pts)` : undefined} />
          <Stat label="Taux USD / EUR" value={data ? `${pct(data.market.rd, 2)} / ${pct(data.market.rf, 2)}` : "—"} foot="Domestique / étranger, zéro-coupon à l'échéance" busy={isFetching} />
          <Stat label="Butterfly de smile" value={data ? pct(data.smile.bf25_smile, 3) : "—"} foot={data ? `Marché ${pct(data.smile.bf25_market, 3)} : différent (Clark)` : undefined} busy={isFetching} />
          <Stat label="Convention de delta" value={data?.market.convention === "spot" ? "Delta spot" : "Delta forward"} foot="Spot jusqu'à 1 an, forward au-delà" busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label="Prime" value={money(g?.price_usd, "USD")} foot={g ? `${num(g.price_pips, 1)} pips · ${pct(g.price_pct_eur, 3)} du nominal` : undefined} busy={isFetching} />
          <Stat label="Strike et vol" value={o ? `${num(o.strike, 4)} · ${pct(o.vol, 2)}` : "—"} foot={o ? `Delta ${num(o.delta * 100, 1)} · vol ATM ${pct(o.atm_vol, 2)}` : undefined} busy={isFetching} />
          <Stat label="Effet du smile" value={money(o?.smile_effect_usd, "USD")} foot="Prime au smile − prime à la vol ATM" busy={isFetching} />
          <Stat label="Delta spot" value={money(g?.delta_spot_eur, "EUR")} foot={g ? `Forward ${money(g.delta_forward_eur, "EUR")} · ajusté prime ${money(g.delta_pa_eur, "EUR")}` : undefined} busy={isFetching} />
        </div>
        <div className="grid cols-4">
          <Stat label="Gamma (spot +1 %)" value={money(g?.gamma_eur_1pct, "EUR")} foot="Variation du delta en EUR" busy={isFetching} />
          <Stat label="Vega (1 % de vol)" value={money(g?.vega_usd, "USD")} foot={g ? `Vanna ${money(g.vanna_usd, "USD")} · volga ${money(g.volga_usd, "USD")}` : undefined} busy={isFetching} />
          <Stat label="Theta (1 jour)" value={money(g?.theta_usd, "USD")} busy={isFetching} />
          <Stat label="Rho USD / EUR (1 %)" value={g ? `${money(g.rho_usd, "USD")} / ${money(g.rho_eur, "USD")}` : "—"} foot="Deux courbes : domestique et étrangère" busy={isFetching} />
        </div>
        <Card title="Smile de volatilité et densité risque-neutre">
          {data ? <EChart option={smileOption} height={400} ariaLabel="Smile EUR/USD et densité risque-neutre" /> : <Skeleton height={320} />}
        </Card>
        <Explainer>
          Le marché des changes cote le smile en delta. La vol ATM est celle du straddle delta-neutre. Le risk reversal mesure
          l'asymétrie (σ<sub>25Δ call</sub> − σ<sub>25Δ put</sub>). Le butterfly est coté comme un strangle « de marché » : une seule vol,
          σ<sub>ATM</sub> + BF, price le strangle dont les strikes sont les 25 deltas à cette vol. On cherche le butterfly de smile qui
          reprice ce strangle exactement, puis on interpole par Vanna-Volga : le prix Black-Scholes à la vol ATM, corrigé par les trois
          options piliers pondérées pour couvrir vega, vanna et volga au strike.
        </Explainer>
        <div className="grid cols-2">
          <Card title="Piliers du smile" flush>
            {data ? (
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Pilier</th><th>Strike</th><th>Vol</th><th>Delta</th></tr></thead>
                  <tbody>
                    {pillars.map(([name, v]) => (
                      <tr key={name}><td className="strong">{name}</td><td>{num(v.strike, 4)}</td><td>{pct(v.vol, 3)}</td><td>{num(v.delta * 100, 1)}</td></tr>
                    ))}
                    <tr>
                      <td className="strong">Strangle de marché</td>
                      <td>{num(data.smile.market_strangle.put_strike, 4)} / {num(data.smile.market_strangle.call_strike, 4)}</td>
                      <td>{pct(data.smile.market_strangle.vol, 3)}</td><td className="muted">±25 à cette vol</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            ) : <div className="card-body"><Skeleton height={160} /></div>}
          </Card>
          <Card title="EUR/USD — 1 an">
            <EChart option={historyOption} height={220} ariaLabel="Historique EUR/USD sur un an" />
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Échéance</th><th>Taux USD</th><th>Taux EUR</th><th>Forward</th><th>Points</th></tr></thead>
                <tbody>
                  {market.tenors.map((t) => (
                    <tr key={t.tenor}><td className="strong">{t.tenor}</td><td>{pct(t.rd, 2)}</td><td>{pct(t.rf, 2)}</td><td>{num(t.forward, 4)}</td><td>{num(t.points, 1)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
        <InfoBox>
          Les cotations de vol FX ne sont pas diffusées gratuitement : la vol ATM part de la vol réalisée sur un an et le risk reversal
          et le butterfly sont à saisir. Les points forward viennent des courbes d'État USD et EUR (parité des taux couverte), sans la
          base cross-currency.
        </InfoBox>
      </div>
    </div>
  );
}
