import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2, Wand2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ApiError, portfolioApi, type PositionIn, type PositionKind, type PositionRow } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, Delta, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { money, num, pct, signedMoney } from "../lib/format";
import { CDS_PRESETS, CDS_TENORS } from "../lib/credit";
import { useTickers } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { tr } from "../lib/i18n";

const KIND_PAIRS: Record<PositionKind, [string, string]> = {
  equity: ["Action", "Equity"], option: ["Option", "Option"], barrier: ["Barrière", "Barrier"], digital: ["Digitale", "Digital"],
  asian: ["Asiatique", "Asian"], cliquet: ["Cliquet", "Cliquet"], autocall: ["Autocall", "Autocall"], bond: ["Obligation", "Bond"],
  future: ["Future", "Future"], cds: ["CDS", "CDS"], capfloor: ["Cap / floor", "Cap / floor"], fxoption: ["Option de change", "FX option"],
  varswap: ["Swap de variance", "Variance swap"],
};
const KIND_LABEL = new Proxy({} as Record<PositionKind, string>, { get: (_, k: string) => KIND_PAIRS[k as PositionKind] && tr(...KIND_PAIRS[k as PositionKind]) });

export const PORTFOLIO_PAGES = [
  { path: "positions", label: ["Positions & expositions", "Positions & exposures"] },
  { path: "risques", label: ["Stress tests, VaR & P&L", "Stress tests, VaR & P&L"] },
] as const;

export default function Portfolio() {
  const qc = useQueryClient();
  const demo = useMutation({ mutationFn: portfolioApi.demo, onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio"] }) });
  const clear = useMutation({ mutationFn: portfolioApi.clear, onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio"] }) });
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Portefeuille & risques", "Portfolio & risk")}</h1>
          <div className="page-sub">{tr("Book multi-actifs valorisé aux dernières données de marché, en euros. Chaque scénario de stress est une revalorisation complète.", "Multi-asset book valued at the latest market data, in euros. Every stress scenario is a full revaluation.")}</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => demo.mutate()} disabled={demo.isPending}>
            <Wand2 size={14} /> {demo.isPending ? tr("Chargement…", "Loading…") : tr("Charger le book de démonstration", "Load the demo book")}
          </button>
          <button className="btn ghost" onClick={() => { if (window.confirm(tr("Supprimer toutes les positions ?", "Delete all positions?"))) clear.mutate(); }}>
            <Trash2 size={14} /> {tr("Vider", "Clear")}
          </button>
        </div>
      </div>
      <ErrorBox error={demo.error ?? clear.error} />
      <nav className="tabs subnav" aria-label={tr("Portefeuille", "Portfolio")}>
        {PORTFOLIO_PAGES.map((m) => (
          <NavLink key={m.path} to={`/portfolio/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{tr(m.label[0], m.label[1])}</NavLink>
        ))}
      </nav>
      <Outlet />
    </>
  );
}

function usePortfolio() {
  return useQuery({ queryKey: ["portfolio", "book"], queryFn: portfolioApi.get, refetchInterval: 120_000 });
}

function Empty() {
  return (
    <div className="card empty">
      {tr("Aucune position. Chargez le book de démonstration ou ajoutez une position.", "No positions. Load the demo book or add a position.")}
    </div>
  );
}

// ----------------------------------------------------------------------------- positions

export function PositionsPage() {
  const { data, error, isLoading } = usePortfolio();
  const [adding, setAdding] = useState(false);
  const qc = useQueryClient();
  const remove = useMutation({ mutationFn: portfolioApi.remove, onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio"] }) });
  const t = data?.totals;

  const exposureOption = useCallback((metric: "delta_cash" | "vega") => (p: ChartPalette) => {
    const rows = (data?.by_underlying ?? []).filter((r) => Math.abs(r[metric]) > 1e-6).sort((a, b) => a[metric] - b[metric]);
    return {
      grid: { left: 8, right: 70, top: 8, bottom: 8, containLabel: true },
      tooltip: { trigger: "item", formatter: (it: { name: string; value: number }) => `${it.name}<br/><b>${signedMoney(it.value)}</b>` },
      xAxis: { type: "value", axisLabel: { formatter: (v: number) => money(v) } },
      yAxis: { type: "category", data: rows.map((r) => r.key), axisLine: { show: false } },
      series: [{
        type: "bar", barMaxWidth: 18,
        data: rows.map((r) => ({ value: r[metric], itemStyle: { color: r[metric] >= 0 ? p.diverging[2] : p.diverging[0],
          borderRadius: r[metric] >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] } })),
        label: { show: true, position: "right", color: p.textSecondary, formatter: (it: { value: number }) => signedMoney(it.value) },
      }],
    };
  }, [data]);

  return (
    <div className="grid">
      <ErrorBox error={error ?? remove.error} />
      {isLoading && <Skeleton height={300} />}
      {data && !data.positions.length && <Empty />}
      {t && (
        <div className="grid cols-4">
          <Stat label={tr("Valeur du book", "Book value")} value={money(t.market_value)} foot={<>P&L <Delta value={t.pnl} digits={0} /> €</>} />
          <Stat label="Delta cash" value={signedMoney(t.delta_cash)} foot={tr("exposition actions équivalente", "equivalent equity exposure")} />
          <Stat label={tr("Vega (1 pt de vol)", "Vega (1 vol pt)")} value={signedMoney(t.vega)} foot={tr(`Gamma 1 % : ${signedMoney(t.gamma_cash)}`, `Gamma 1%: ${signedMoney(t.gamma_cash)}`)} />
          <Stat label={tr("Theta (1 jour)", "Theta (1 day)")} value={signedMoney(t.theta)} foot={tr(`Rho 1 % : ${signedMoney(t.rho)} · DV01 ${money(t.dv01)}`, `Rho 1%: ${signedMoney(t.rho)} · DV01 ${money(t.dv01)}`)} />
        </div>
      )}
      {t && data?.positions.some((p) => p.kind === "cds") && (
        <div className="grid cols-4">
          <Stat label={tr("CS01 (+1 bp de spread)", "CS01 (+1 bp spread)")} value={signedMoney(t.cs01)} foot={tr("Tous les CDS, courbes re-bootstrapées", "All CDS, curves re-bootstrapped")} />
          <Stat label={tr("Jump-to-default total", "Total jump-to-default")} value={signedMoney(t.jtd)} foot={tr("Si tous les émetteurs faisaient défaut", "If every issuer defaulted")} />
          <Stat label={tr("Pire défaut isolé", "Worst single default")} value={signedMoney(Math.min(0, ...data.positions.filter((p) => p.kind === "cds").map((p) => p.jtd ?? 0)))}
            foot={tr("Position CDS la plus exposée", "Most exposed CDS position")} />
          <Stat label={tr("Notionnel CDS net", "Net CDS notional")} value={signedMoney(data.positions.filter((p) => p.kind === "cds").reduce((a, p) => a + p.quantity, 0))}
            foot={tr("> 0 : acheteur net de protection (devise des contrats)", "> 0: net protection buyer (contract currency)")} />
        </div>
      )}
      <Card title={`Positions (${data?.positions.length ?? 0})`} flush actions={
        <button className="btn primary" onClick={() => setAdding((a) => !a)}><Plus size={14} /> {tr("Ajouter une position", "Add a position")}</button>
      }>
        {adding && <div className="card-body" style={{ borderBottom: "1px solid var(--border)" }}><AddPosition onDone={() => setAdding(false)} /></div>}
        {data && data.positions.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Position</th><th>Book</th><th>{tr("Quantité", "Quantity")}</th><th>{tr("Prix unitaire", "Unit price")}</th><th>{tr("Valeur (€)", "Value (€)")}</th><th>P&L (€)</th>
                  <th>Delta cash</th><th>Vega 1 pt</th><th>{tr("Theta 1 j", "Theta 1 d")}</th><th />
                </tr>
              </thead>
              <tbody>
                {data.positions.map((p) => <PositionLine key={p.id} p={p} onDelete={() => remove.mutate(p.id)} />)}
              </tbody>
            </table>
          </div>
        )}
        {data?.vol_source && Object.keys(data.vol_source).length > 0 && (
          <div className="card-body muted" style={{ fontSize: 12 }}>
            {tr("Volatilité utilisée :", "Volatility used:")} {Object.entries(data.vol_source).map(([k, v]) => `${k} (${v})`).join(" · ")}.
            {data.eurusd ? ` EUR/USD ${num(data.eurusd, 4)}.` : ""}
          </div>
        )}
      </Card>
      {data && data.by_underlying.length > 0 && (
        <>
          <div className="grid cols-2">
            <Card title={tr("Delta cash par sous-jacent", "Delta cash by underlying")}>
              <EChart option={exposureOption("delta_cash")} height={Math.max(260, data.by_underlying.length * 34)} ariaLabel={tr("Delta cash par sous-jacent", "Delta cash by underlying")} />
            </Card>
            <Card title={tr("Vega par sous-jacent (pour 1 point de vol)", "Vega by underlying (per vol point)")}>
              <EChart option={exposureOption("vega")} height={Math.max(260, data.by_underlying.length * 34)} ariaLabel={tr("Vega par sous-jacent", "Vega by underlying")} />
            </Card>
          </div>
          <div className="grid cols-2">
            <ExposureTable title={tr("Par book", "By book")} rows={data.by_book} />
            <ExposureTable title={tr("Par type d'instrument", "By instrument type")} rows={data.by_kind.map((r) => ({ ...r, key: KIND_LABEL[r.key as PositionKind] ?? r.key }))} />
          </div>
        </>
      )}
    </div>
  );
}

function SpreadEditor({ p, onClose }: { p: PositionRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [spreads, setSpreads] = useState<number[]>((p.params.spreads_bp as number[]) ?? []);
  const save = useMutation({
    mutationFn: () => portfolioApi.updateSpreads(p.id, spreads),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["portfolio"] }); onClose(); },
  });
  return (
    <tr>
      <td colSpan={10} style={{ textAlign: "left" }}>
        <div className="form">
          <div className="toolbar-grid">
            {CDS_TENORS.map((t, i) => (
              <NumberField key={t} label={tr(`${t} an${t > 1 ? "s" : ""}`, `${t} year${t > 1 ? "s" : ""}`)} value={spreads[i]} suffix="bp" min={0.01} digits={1}
                onChange={(v) => setSpreads((s) => s.map((x, j) => (j === i ? v : x)))} />
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <button className="btn primary" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? tr("Revalorisation…", "Revaluing…") : tr("Mettre à jour les spreads", "Update the spreads")}</button>
            <button className="btn ghost" onClick={onClose}>{tr("Annuler", "Cancel")}</button>
            <span className="muted" style={{ fontSize: 12 }}>{tr("Le prix d'entrée est conservé : l'effet du mouvement de spread apparaît dans le P&L.", "The entry price is kept: the effect of the spread move shows up in the P&L.")}</span>
          </div>
          <ErrorBox error={save.error} />
        </div>
      </td>
    </tr>
  );
}

function PositionLine({ p, onDelete }: { p: PositionRow; onDelete: () => void }) {
  const [editing, setEditing] = useState(false);
  const cds = p.kind === "cds";
  return (
    <>
    <tr>
      <td style={{ textAlign: "left", whiteSpace: "normal", minWidth: 260 }}>
        <span className="badge" style={{ marginRight: 6 }}>{KIND_LABEL[p.kind]}</span>
        <span className="strong">{p.label || p.description}</span>
        {p.label && <div className="muted" style={{ fontSize: 11.5 }}>{p.description}</div>}
        {p.error && <div className="down" style={{ fontSize: 11.5 }}>{p.error}</div>}
      </td>
      <td className="muted">{p.book}</td>
      <td>{num(p.quantity, 0)}{p.params.multiplier ? <span className="muted"> ×{String(p.params.multiplier)}</span> : null}</td>
      <td>{cds || p.kind === "capfloor" ? <>{num(p.unit_price != null ? p.unit_price * 100 : null, 3)} <span className="muted">{tr("% nom.", "% notional")}</span></>
        : p.kind === "fxoption" ? <>{num(p.unit_price != null ? p.unit_price * 1e4 : null, 1)} <span className="muted">pips</span></>
        : p.kind === "varswap" ? <>{num(p.unit_price, 3)} <span className="muted">× vega</span></>
        : <>{num(p.unit_price, 2)} <span className="muted">{p.currency}</span></>}</td>
      <td className="strong">{money(p.market_value_base)}</td>
      <td><Delta value={p.pnl_base} digits={0} /></td>
      <td>{cds ? <span title="CS01">{signedMoney(p.cs01)} <span className="muted">CS01</span></span> : signedMoney(p.delta_cash)}</td>
      <td>{cds ? <span title="Jump-to-default">{signedMoney(p.jtd)} <span className="muted">JTD</span></span> : signedMoney(p.vega)}</td>
      <td>{signedMoney(p.theta)}</td>
      <td style={{ whiteSpace: "nowrap" }}>
        {cds && <button className="btn icon ghost" onClick={() => setEditing((e) => !e)} aria-label={tr("Modifier les spreads", "Edit the spreads")} title={tr("Mettre à jour la courbe de spreads", "Update the spread curve")}><Pencil size={14} /></button>}
        <button className="btn icon ghost" onClick={onDelete} aria-label={tr("Supprimer la position", "Delete the position")} title={tr("Supprimer", "Delete")}><Trash2 size={14} /></button>
      </td>
    </tr>
    {editing && <SpreadEditor p={p} onClose={() => setEditing(false)} />}
    </>
  );
}

function ExposureTable({ title, rows }: { title: string; rows: { key: string; market_value: number; pnl: number; delta_cash: number; vega: number; n: number }[] }) {
  return (
    <Card title={title} flush>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{title.replace(/^(Par|By) /, "")}</th><th>Positions</th><th>{tr("Valeur", "Value")}</th><th>P&L</th><th>Delta cash</th><th>Vega</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td className="strong">{r.key}</td><td className="muted">{r.n}</td><td>{money(r.market_value)}</td>
                <td><Delta value={r.pnl} digits={0} /></td><td>{signedMoney(r.delta_cash)}</td><td>{signedMoney(r.vega)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------------------- add position form

function inMonths(m: number): string {
  const d = new Date();
  d.setMonth(d.getMonth() + m);
  return d.toISOString().slice(0, 10);
}

function DateField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="input-wrap"><input type="date" value={value} onChange={(e) => onChange(e.target.value)} /></span>
    </label>
  );
}

function TextField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="input-wrap"><input value={value} onChange={(e) => onChange(e.target.value)} /></span>
    </label>
  );
}

function AddPosition({ onDone }: { onDone: () => void }) {
  const { data: tickers } = useTickers();
  const qc = useQueryClient();
  const [kind, setKind] = useState<PositionKind>("option");
  const [ticker, setTicker] = useState("SPY");
  const [quantity, setQuantity] = useState(1);
  const [book, setBook] = useState("Principal");
  const [label, setLabel] = useState("");
  const [prm, setPrm] = useState<Record<string, unknown>>({
    strike: 100, expiry: inMonths(3), option_type: "call", exercise: "european", multiplier: 100, barrier: 80,
    barrier_type: "down-and-in", monitoring_per_year: 252, maturity_years: 3, frequency: 4, coupon_rate: 0.02,
    autocall_barrier: 1, coupon_barrier: 0.7, protection_barrier: 0.6, memory: true, currency: "EUR",
    maturity: inMonths(60), bond_coupon: 0.03, bond_frequency: 1,
    digital_kind: "cash-or-nothing", cash: 100, n_fixings: 12, averaging: "arithmetic", cliquet_years: 2,
    local_floor: -0.05, local_cap: 0.05, global_floor: 0,
    reference: "", cds_currency: "EUR", cds_maturity: inMonths(60), coupon_bp: 100, recovery: 0.4, cds_preset: "bbb",
    spreads_bp: CDS_PRESETS.bbb.spreads,
    cf_kind: "cap", cf_currency: "USD", cf_maturity: inMonths(60), cf_frequency: 4, cf_atm: true, cf_strike: 0.04,
    cf_model: "bachelier", cf_vol: 0.01,
    fx_type: "call", fx_expiry: inMonths(6), fx_strike: 1.12, fx_atm: 0.07, fx_rr: 0.003, fx_bf: 0.0025,
    vs_maturity: inMonths(3), vs_fair: true, vs_strike: 0.2,
  });
  const set = (k: string) => (v: unknown) => setPrm((p) => ({ ...p, [k]: v }));
  const spot = tickers?.find((t) => t.ticker === ticker)?.last;

  const add = useMutation({
    mutationFn: () => {
      const pick = (...keys: string[]) => Object.fromEntries(keys.map((k) => [k, prm[k]]));
      const params: Record<string, Record<string, unknown>> = {
        equity: {},
        option: pick("strike", "expiry", "option_type", "exercise", "multiplier"),
        barrier: { ...pick("strike", "expiry", "option_type", "barrier", "barrier_type", "multiplier"),
          monitoring_per_year: prm.monitoring_per_year === 0 ? null : prm.monitoring_per_year },
        digital: pick("strike", "expiry", "option_type", "digital_kind", "cash", "multiplier"),
        asian: pick("strike", "expiry", "option_type", "n_fixings", "averaging", "multiplier"),
        cliquet: { maturity_years: prm.cliquet_years, frequency: prm.frequency, local_floor: prm.local_floor,
          local_cap: prm.local_cap, global_floor: prm.global_floor },
        autocall: pick("maturity_years", "frequency", "coupon_rate", "autocall_barrier", "coupon_barrier", "protection_barrier", "memory"),
        bond: { currency: prm.currency, maturity: prm.maturity, coupon_rate: prm.bond_coupon, frequency: prm.bond_frequency },
        future: pick("expiry", "multiplier"),
        capfloor: { currency: prm.cf_currency, cf_kind: prm.cf_kind, maturity: prm.cf_maturity, frequency: prm.cf_frequency,
          strike: prm.cf_atm ? null : prm.cf_strike, model: prm.cf_model, vol: prm.cf_vol },
        fxoption: { expiry: prm.fx_expiry, strike: prm.fx_strike, option_type: prm.fx_type, atm: prm.fx_atm,
          rr25: prm.fx_rr, bf25: prm.fx_bf },
        varswap: { maturity: prm.vs_maturity, strike_vol: prm.vs_fair ? null : prm.vs_strike },
        cds: { reference: prm.reference || tr("Émetteur", "Issuer"), currency: prm.cds_currency, maturity: prm.cds_maturity,
          coupon_bp: prm.coupon_bp, recovery: prm.recovery, spreads_bp: prm.spreads_bp },
      };
      const noTicker = kind === "bond" || kind === "cds" || kind === "capfloor" || kind === "fxoption";
      const body: PositionIn = { kind, quantity, ticker: noTicker ? null : ticker, params: params[kind], book, label };
      return portfolioApi.add(body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["portfolio"] });
      onDone();
    },
  });

  const optionFields = (
    <>
      <NumberField label={`Strike${spot ? ` (spot ${num(spot, 2)})` : ""}`} value={prm.strike as number} min={0.01} digits={2} onChange={set("strike")} />
      <DateField label={tr("Échéance", "Expiry")} value={prm.expiry as string} onChange={set("expiry")} />
      <Segmented label="Type" value={prm.option_type as string} onChange={set("option_type")} options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
      <NumberField label={tr("Multiplicateur", "Multiplier")} value={prm.multiplier as number} min={1} digits={0} onChange={set("multiplier")} />
    </>
  );

  let fields: ReactNode = null;
  if (kind === "option") {
    fields = <>{optionFields}<Segmented label={tr("Exercice", "Exercise")} value={prm.exercise as string} onChange={set("exercise")} options={[{ value: "european", label: tr("Européen", "European") }, { value: "american", label: tr("Américain", "American") }]} /></>;
  } else if (kind === "barrier") {
    fields = (
      <>
        {optionFields}
        <NumberField label={tr("Barrière", "Barrier")} value={prm.barrier as number} min={0.01} digits={2} onChange={set("barrier")} />
        <SelectField label={tr("Type de barrière", "Barrier type")} value={prm.barrier_type as string} onChange={set("barrier_type")}
          options={["down-and-out", "down-and-in", "up-and-out", "up-and-in"].map((v) => ({ value: v, label: v }))} />
        <SelectField label={tr("Observation", "Monitoring")} value={prm.monitoring_per_year as number} onChange={set("monitoring_per_year")}
          options={[{ value: 0, label: tr("Continue", "Continuous") }, { value: 252, label: tr("Quotidienne", "Daily") }, { value: 52, label: tr("Hebdomadaire", "Weekly") }]} />
      </>
    );
  } else if (kind === "digital") {
    fields = (
      <>
        {optionFields}
        <Segmented label="Payoff" value={prm.digital_kind as string} onChange={set("digital_kind")}
          options={[{ value: "cash-or-nothing", label: "Cash" }, { value: "asset-or-nothing", label: "Asset" }]} />
        {prm.digital_kind === "cash-or-nothing" && <NumberField label={tr("Montant payé", "Amount paid")} value={prm.cash as number} min={0.01} digits={2} onChange={set("cash")} />}
      </>
    );
  } else if (kind === "asian") {
    fields = (
      <>
        {optionFields}
        <SelectField label={tr("Fixings (d'aujourd'hui à l'échéance)", "Fixings (from today to expiry)")} value={prm.n_fixings as number} onChange={set("n_fixings")}
          options={[4, 12, 52].map((v) => ({ value: v, label: String(v) }))} />
        <Segmented label={tr("Moyenne", "Average")} value={prm.averaging as string} onChange={set("averaging")}
          options={[{ value: "arithmetic", label: tr("Arithmétique", "Arithmetic") }, { value: "geometric", label: tr("Géométrique", "Geometric") }]} />
      </>
    );
  } else if (kind === "cliquet") {
    fields = (
      <>
        <NumberField label={tr("Maturité", "Maturity")} value={prm.cliquet_years as number} suffix={tr("ans", "years")} min={0.25} max={10} digits={2} onChange={set("cliquet_years")} />
        <SelectField label="Resets" value={prm.frequency as number} onChange={set("frequency")}
          options={[{ value: 12, label: tr("Mensuels", "Monthly") }, { value: 4, label: tr("Trimestriels", "Quarterly") }, { value: 1, label: tr("Annuels", "Annual") }]} />
        <NumberField label={tr("Floor local", "Local floor")} value={prm.local_floor as number} suffix="%" scale={100} min={-1} digits={1} onChange={set("local_floor")} />
        <NumberField label={tr("Cap local", "Local cap")} value={prm.local_cap as number} suffix="%" scale={100} min={-1} digits={1} onChange={set("local_cap")} />
        <NumberField label={tr("Floor global", "Global floor")} value={prm.global_floor as number} suffix="%" scale={100} digits={1} onChange={set("global_floor")} />
      </>
    );
  } else if (kind === "autocall") {
    fields = (
      <>
        <NumberField label={tr("Maturité", "Maturity")} value={prm.maturity_years as number} suffix={tr("ans", "years")} min={0.5} max={10} digits={1} onChange={set("maturity_years")} />
        <SelectField label={tr("Observations", "Observations")} value={prm.frequency as number} onChange={set("frequency")}
          options={[{ value: 12, label: tr("Mensuelles", "Monthly") }, { value: 4, label: tr("Trimestrielles", "Quarterly") }, { value: 1, label: tr("Annuelles", "Annual") }]} />
        <NumberField label={tr("Coupon / période", "Coupon / period")} value={prm.coupon_rate as number} suffix="%" scale={100} digits={2} onChange={set("coupon_rate")} />
        <NumberField label={tr("Barrière autocall", "Autocall barrier")} value={prm.autocall_barrier as number} suffix="%" scale={100} digits={0} onChange={set("autocall_barrier")} />
        <NumberField label={tr("Barrière coupon", "Coupon barrier")} value={prm.coupon_barrier as number} suffix="%" scale={100} digits={0} onChange={set("coupon_barrier")} />
        <NumberField label="Protection" value={prm.protection_barrier as number} suffix="%" scale={100} digits={0} onChange={set("protection_barrier")} />
        <Check label={tr("Effet mémoire", "Memory effect")} checked={prm.memory as boolean} onChange={set("memory")} />
      </>
    );
  } else if (kind === "bond") {
    fields = (
      <>
        <Segmented label={tr("Devise", "Currency")} value={prm.currency as string} onChange={set("currency")} options={[{ value: "EUR", label: "EUR" }, { value: "USD", label: "USD" }]} />
        <DateField label={tr("Maturité", "Maturity")} value={prm.maturity as string} onChange={set("maturity")} />
        <NumberField label="Coupon" value={prm.bond_coupon as number} suffix="%" scale={100} digits={3} onChange={set("bond_coupon")} />
        <SelectField label={tr("Fréquence", "Frequency")} value={prm.bond_frequency as number} onChange={set("bond_frequency")}
          options={[{ value: 1, label: tr("Annuel", "Annual") }, { value: 2, label: tr("Semestriel", "Semi-annual") }]} />
      </>
    );
  } else if (kind === "capfloor") {
    const normal = prm.cf_model === "bachelier";
    fields = (
      <>
        <Segmented label="Type" value={prm.cf_kind as string} onChange={set("cf_kind")} options={[{ value: "cap", label: "Cap" }, { value: "floor", label: "Floor" }]} />
        <Segmented label={tr("Courbe", "Curve")} value={prm.cf_currency as string} onChange={set("cf_currency")} options={[{ value: "USD", label: "USD" }, { value: "EUR", label: "EUR" }]} />
        <DateField label={tr("Maturité", "Maturity")} value={prm.cf_maturity as string} onChange={set("cf_maturity")} />
        <SelectField label={tr("Fréquence", "Frequency")} value={prm.cf_frequency as number} onChange={set("cf_frequency")}
          options={[{ value: 12, label: tr("Mensuelle", "Monthly") }, { value: 4, label: tr("Trimestrielle", "Quarterly") }, { value: 2, label: tr("Semestrielle", "Semi-annual") }, { value: 1, label: tr("Annuelle", "Annual") }]} />
        <SelectField label="Strike" value={prm.cf_atm ? "atm" : "fixed"} onChange={(v: string) => set("cf_atm")(v === "atm")}
          options={[{ value: "atm", label: tr("ATM (fixé à l'ajout)", "ATM (set when added)") }, { value: "fixed", label: tr("Niveau fixé", "Fixed level") }]} />
        {!prm.cf_atm && <NumberField label={tr("Niveau du strike", "Strike level")} value={prm.cf_strike as number} suffix="%" scale={100} digits={3} onChange={set("cf_strike")} />}
        <Segmented label={tr("Modèle", "Model")} value={prm.cf_model as string} onChange={(v: string) => setPrm((q) => ({ ...q, cf_model: v, cf_vol: v === "bachelier" ? 0.01 : 0.25 }))}
          options={[{ value: "bachelier", label: "Normal" }, { value: "black", label: "Log-normal" }]} />
        {normal
          ? <NumberField label={tr("Vol normale", "Normal vol")} value={prm.cf_vol as number} suffix="bp" scale={1e4} min={0.0001} digits={1} onChange={set("cf_vol")} />
          : <NumberField label={tr("Vol log-normale", "Lognormal vol")} value={prm.cf_vol as number} suffix="%" scale={100} min={0.01} digits={1} onChange={set("cf_vol")} />}
      </>
    );
  } else if (kind === "fxoption") {
    fields = (
      <>
        <Segmented label="Type" value={prm.fx_type as string} onChange={set("fx_type")}
          options={[{ value: "call", label: "Call EUR" }, { value: "put", label: "Put EUR" }]} />
        <DateField label={tr("Échéance", "Expiry")} value={prm.fx_expiry as string} onChange={set("fx_expiry")} />
        <NumberField label="Strike EUR/USD" value={prm.fx_strike as number} min={0.0001} digits={4} onChange={set("fx_strike")} />
        <NumberField label="Vol ATM" value={prm.fx_atm as number} suffix="%" scale={100} min={0.001} digits={2} onChange={set("fx_atm")} />
        <NumberField label="Risk reversal 25Δ" value={prm.fx_rr as number} suffix="%" scale={100} digits={2} onChange={set("fx_rr")} />
        <NumberField label="Butterfly 25Δ" value={prm.fx_bf as number} suffix="%" scale={100} digits={2} onChange={set("fx_bf")} />
      </>
    );
  } else if (kind === "varswap") {
    fields = (
      <>
        <DateField label={tr("Échéance", "Expiry")} value={prm.vs_maturity as string} onChange={set("vs_maturity")} />
        <SelectField label="Strike" value={prm.vs_fair ? "fair" : "fixed"} onChange={(v: string) => set("vs_fair")(v === "fair")}
          options={[{ value: "fair", label: tr("Strike juste du jour", "Today's fair strike") }, { value: "fixed", label: tr("Niveau fixé", "Fixed level") }]} />
        {!prm.vs_fair && <NumberField label="Strike (vol)" value={prm.vs_strike as number} suffix="%" scale={100} min={0.01} digits={2} onChange={set("vs_strike")} />}
      </>
    );
  } else if (kind === "cds") {
    const spreads = prm.spreads_bp as number[];
    fields = (
      <>
        <TextField label={tr("Entité de référence", "Reference entity")} value={prm.reference as string} onChange={set("reference")} />
        <Segmented label={tr("Devise", "Currency")} value={prm.cds_currency as string} onChange={set("cds_currency")} options={[{ value: "EUR", label: "EUR" }, { value: "USD", label: "USD" }]} />
        <DateField label={tr("Maturité", "Maturity")} value={prm.cds_maturity as string} onChange={set("cds_maturity")} />
        <SelectField label={tr("Coupon standard", "Standard coupon")} value={prm.coupon_bp as number} onChange={set("coupon_bp")}
          options={[{ value: 100, label: "100 bp" }, { value: 500, label: "500 bp" }, { value: 25, label: "25 bp" }, { value: 1000, label: tr("1 000 bp", "1,000 bp") }]} />
        <NumberField label={tr("Recouvrement", "Recovery")} value={prm.recovery as number} suffix="%" scale={100} min={0} max={0.95} digits={0} onChange={set("recovery")} />
        <SelectField label={tr("Courbe de spreads", "Spread curve")} value={prm.cds_preset as string} onChange={(k: string) => setPrm((q) => ({
          ...q, cds_preset: k, ...(CDS_PRESETS[k] ? { spreads_bp: CDS_PRESETS[k].spreads, recovery: CDS_PRESETS[k].recovery } : {}) }))}
          options={[...Object.entries(CDS_PRESETS).map(([value, c]) => ({ value, label: c.label })), { value: "custom", label: tr("Personnalisée", "Custom") }]} />
        {CDS_TENORS.map((t, i) => (
          <NumberField key={t} label={tr(`Spread ${t} an${t > 1 ? "s" : ""}`, `${t}-year spread`)} value={spreads[i]} suffix="bp" min={0.01} digits={1}
            onChange={(v) => setPrm((q) => ({ ...q, cds_preset: "custom", spreads_bp: (q.spreads_bp as number[]).map((x, j) => (j === i ? v : x)) }))} />
        ))}
      </>
    );
  } else if (kind === "future") {
    fields = (
      <>
        <DateField label={tr("Échéance", "Expiry")} value={prm.expiry as string} onChange={set("expiry")} />
        <NumberField label={tr("Multiplicateur", "Multiplier")} value={prm.multiplier as number} min={1} digits={0} onChange={set("multiplier")} />
      </>
    );
  }

  return (
    <div className="form">
      <div style={{ maxWidth: 320 }}>
        <SelectField label={tr("Type d'instrument", "Instrument type")} value={kind} onChange={(k: PositionKind) => {
        // a CDS quantity is a notional: switch between unit counts and notionals with sensible defaults
        // notional-quoted kinds get a sensible default size when the type changes
        const defaults: Partial<Record<PositionKind, number>> = { cds: 10_000_000, capfloor: 10_000_000, fxoption: 10_000_000, varswap: 100_000 };
        if (defaults[k] !== defaults[kind]) setQuantity(defaults[k] ?? 1);
        setKind(k);
      }} options={(Object.keys(KIND_PAIRS) as PositionKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      </div>
      <div className="toolbar-grid">
        {!["bond", "cds", "capfloor", "fxoption"].includes(kind) && (
          <SelectField label={tr("Sous-jacent", "Underlying")} value={ticker} onChange={setTicker}
            options={(tickers ?? []).map((t) => ({ value: t.ticker, label: `${t.ticker} — ${t.name}` }))} />
        )}
        <NumberField label={kind === "autocall" || kind === "cliquet" ? tr("Nombre de notes (nominal 100)", "Number of notes (100 notional)") : kind === "bond" ? tr("Nombre de titres (nominal 100)", "Number of bonds (100 notional)")
          : kind === "cds" ? tr("Nominal (> 0 achat de protection, < 0 vente)", "Notional (> 0 buy protection, < 0 sell)")
          : kind === "capfloor" ? tr("Nominal (négatif = vente)", "Notional (negative = sell)") : kind === "fxoption" ? tr("Nominal en EUR (négatif = vente)", "EUR notional (negative = sell)")
          : kind === "varswap" ? tr("Notionnel vega (> 0 achat de variance)", "Vega notional (> 0 buy variance)") : tr("Quantité (négatif = vente)", "Quantity (negative = sell)")}
          value={quantity} digits={2} onChange={setQuantity} />
        {fields}
        <TextField label="Book" value={book} onChange={setBook} />
        <TextField label={tr("Libellé (optionnel)", "Label (optional)")} value={label} onChange={setLabel} />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn primary" onClick={() => add.mutate()} disabled={add.isPending}>{add.isPending ? tr("Valorisation…", "Valuing…") : tr("Ajouter au book", "Add to the book")}</button>
        <button className="btn ghost" onClick={onDone}>{tr("Annuler", "Cancel")}</button>
        <span className="muted" style={{ fontSize: 12 }}>{tr("Le prix d'entrée est le prix modèle actuel : le P&L part de zéro.", "The entry price is the current model price: the P&L starts at zero.")}</span>
      </div>
      <ErrorBox error={add.error} />
    </div>
  );
}

// ----------------------------------------------------------------------------- risk

export function RiskPage() {
  const book = usePortfolio();
  const { data, error, isLoading } = useQuery({
    queryKey: ["portfolio", "risk", book.data?.positions.map((p) => [p.id, p.quantity])],
    queryFn: portfolioApi.risk, enabled: !!book.data?.positions.length, retry: false,
  });

  const stressOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const s = data.stress;
    const cells: [number, number, number][] = [];
    s.pnl.forEach((row, vi) => row.forEach((v, si) => cells.push([si, vi, v])));
    const m = Math.max(...cells.map((c) => Math.abs(c[2])), 1);
    return {
      grid: { left: 8, right: 16, top: 10, bottom: 50, containLabel: true },
      tooltip: { trigger: "item", formatter: (it: { value: [number, number, number] }) =>
        `Spot ${pct(s.spot_shocks[it.value[0]], 0)} · vol ${s.vol_shocks[it.value[1]] >= 0 ? "+" : ""}${num(s.vol_shocks[it.value[1]] * 100, 0)} pts<br/>P&L <b>${signedMoney(it.value[2])}</b>` },
      xAxis: { type: "category", data: s.spot_shocks.map((x) => `${x > 0 ? "+" : ""}${pct(x, 0)}`), name: tr("choc sur les actions", "equity shock"), nameLocation: "middle", nameGap: 28, splitLine: { show: false } },
      yAxis: { type: "category", data: s.vol_shocks.map((x) => `${x >= 0 ? "+" : ""}${num(x * 100, 0)} pts`), name: "vol", splitLine: { show: false } },
      visualMap: { show: false, min: -m, max: m, inRange: { color: [p.diverging[0], p.diverging[1], p.diverging[2]] } },
      series: [{ type: "heatmap", data: cells, label: { show: true, color: p.text, fontSize: 11, formatter: (it: { value: number[] }) => signedMoney(it.value[2]) },
        itemStyle: { borderColor: p.surface, borderWidth: 2 } }],
    };
  }, [data]);

  const histOption = useCallback((p: ChartPalette) => {
    const h = data?.var.histogram;
    if (!h || !data) return {};
    const total = h.counts.reduce((a, b) => a + b, 0);
    const v = data.var;
    return {
      tooltip: { trigger: "axis", valueFormatter: (x: number) => pct(x, 1) },
      xAxis: { type: "value", scale: true, axisLabel: { formatter: (x: number) => money(x) } },
      yAxis: { type: "value", axisLabel: { formatter: (x: number) => pct(x, 0) } },
      series: [{
        type: "line", step: "middle", name: tr("Fréquence", "Frequency"), showSymbol: false, color: p.series[0], areaStyle: { opacity: 0.3 },
        data: h.counts.map((c, i) => [(h.edges[i] + h.edges[i + 1]) / 2, c / total]),
        markLine: { symbol: "none", silent: true, label: { color: p.textSecondary, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: [
            { xAxis: -(v.var_95 ?? 0), name: tr("VaR 95 %", "95% VaR"), lineStyle: { color: p.series[1], type: "dashed" } },
            { xAxis: -(v.var_99 ?? 0), name: tr("VaR 99 %", "99% VaR"), lineStyle: { color: p.critical, type: "dashed" } },
          ] },
      }],
    };
  }, [data]);

  const explainOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const t = data.pnl_explain.totals;
    const actualLabel = tr("P&L réel", "Actual P&L");
    const items = [["Delta", t.delta], ["Gamma", t.gamma], ["Theta", t.theta], [tr("Résiduel", "Residual"), t.residual], [actualLabel, t.actual]] as const;
    return {
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: { trigger: "item", formatter: (it: { name: string; value: number }) => `${it.name}<br/><b>${signedMoney(it.value)}</b>` },
      xAxis: { type: "category", data: items.map((i) => i[0]), axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { formatter: (x: number) => money(x) } },
      series: [{
        type: "bar", barMaxWidth: 48,
        data: items.map(([name, v]) => ({ value: v, itemStyle: { color: name === actualLabel ? p.text : v >= 0 ? p.diverging[2] : p.diverging[0], borderRadius: v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
        label: { show: true, position: "top", color: p.textSecondary, formatter: (it: { value: number }) => signedMoney(it.value) },
      }],
    };
  }, [data]);

  if (book.data && !book.data.positions.length) return <Empty />;
  const v = data?.var;
  return (
    <div className="grid">
      <ErrorBox error={error instanceof ApiError && error.status === 404 ? null : error} />
      {(isLoading || book.isLoading) && <Skeleton height={400} />}
      {data && v && (
        <>
          <div className="grid cols-4">
            <Stat label={tr("VaR 99 % (1 jour, historique)", "99% VaR (1 day, historical)")} value={money(v.var_99)} foot={tr(`ES 99 % : ${money(v.es_99)}`, `99% ES: ${money(v.es_99)}`)} />
            <Stat label={tr("VaR 95 % (1 jour, historique)", "95% VaR (1 day, historical)")} value={money(v.var_95)} foot={tr(`ES 95 % : ${money(v.es_95)}`, `95% ES: ${money(v.es_95)}`)} />
            <Stat label={tr("VaR 99 % paramétrique", "Parametric 99% VaR")} value={money(v.parametric_var_99)} foot={tr("delta-normale, même historique", "delta-normal, same history")} />
            <Stat label={tr("Scénarios historiques", "Historical scenarios")} value={num(v.n_scenarios, 0)} foot={tr(`${data.history_days} jours communs à tous les sous-jacents`, `${data.history_days} days common to every underlying`)} />
          </div>
          <Card title={tr("Stress test : P&L par choc actions × choc de volatilité (revalorisation complète)", "Stress test: P&L by equity shock × volatility shock (full revaluation)")}>
            <EChart option={stressOption} height={360} ariaLabel={tr("Matrice de stress actions et volatilité", "Equity and volatility stress matrix")} />
          </Card>
          <div className="grid cols-2">
            <Card title={tr("Distribution du P&L journalier (scénarios historiques)", "Daily P&L distribution (historical scenarios)")}>
              <EChart option={histOption} height={320} ariaLabel={tr("Distribution historique du P&L", "Historical P&L distribution")} />
              {v.worst_scenarios && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  {tr("Pires jours :", "Worst days:")} {v.worst_scenarios.map((w) => `${w.date} (${signedMoney(w.pnl)})`).join(" · ")}
                </div>
              )}
            </Card>
            <Card title={tr("Chocs de taux parallèles", "Parallel rate shocks")} flush>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>{tr("Choc", "Shock")}</th><th>P&L</th></tr></thead>
                  <tbody>
                    {data.stress.rate_shocks.map((r) => (
                      <tr key={r.shift}><td className="strong">{r.shift > 0 ? "+" : ""}{num(r.shift * 1e4, 0)} bp</td><td><Delta value={r.pnl} digits={0} /> €</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-body">
                <InfoBox>
                  {tr("La VaR historique rejoue les variations journalières réelles des sous-jacents (approximation delta-gamma). Les risques de taux et de volatilité sont mesurés par les stress tests, en revalorisation complète.",
                    "Historical VaR replays the actual daily moves of the underlyings (delta-gamma approximation). Rate and volatility risks are measured by the stress tests, with full revaluation.")}
                </InfoBox>
              </div>
            </Card>
          </div>
          {data.stress.spread_shocks.length > 0 && (
            <Card title={tr("Chocs de spreads de crédit (positions CDS, courbes re-bootstrapées)", "Credit spread shocks (CDS positions, curves re-bootstrapped)")} flush>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr>{data.stress.spread_shocks.map((r) => <th key={r.shift}>{r.shift > 0 ? "+" : ""}{num(r.shift * 1e4, 0)} bp</th>)}</tr></thead>
                  <tbody><tr>{data.stress.spread_shocks.map((r) => <td key={r.shift}><Delta value={r.pnl} digits={0} /> €</td>)}</tr></tbody>
                </table>
              </div>
            </Card>
          )}
          <div className="grid cols-2">
            <Card title={tr("Explication du P&L depuis la clôture précédente", "P&L explain since the previous close")}>
              <EChart option={explainOption} height={300} ariaLabel={tr("Décomposition du P&L du jour", "Breakdown of today's P&L")} />
            </Card>
            <Card title={tr("P&L par position", "P&L by position")} flush>
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
                <table className="data">
                  <thead><tr><th>Position</th><th>{tr("Var. spot", "Spot move")}</th><th>{tr("Réel", "Actual")}</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>{tr("Résiduel", "Residual")}</th></tr></thead>
                  <tbody>
                    {data.pnl_explain.rows.map((r) => (
                      <tr key={r.id}>
                        <td style={{ textAlign: "left", whiteSpace: "normal", minWidth: 200 }}>{r.description}</td>
                        <td>{pct(r.return, 2)}</td><td className="strong">{signedMoney(r.actual)}</td><td>{signedMoney(r.delta)}</td>
                        <td>{signedMoney(r.gamma)}</td><td>{signedMoney(r.theta)}</td><td className="muted">{signedMoney(r.residual)}</td>
                      </tr>
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
