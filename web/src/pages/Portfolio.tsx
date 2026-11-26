import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2, Wand2 } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { ApiError, portfolioApi, type PositionIn, type PositionKind, type PositionRow } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Check, Delta, ErrorBox, InfoBox, NumberField, Segmented, SelectField, Skeleton, Stat } from "../components/ui";
import { money, num, pct, signedMoney } from "../lib/format";
import { useTickers } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";

const KIND_LABEL: Record<PositionKind, string> = {
  equity: "Action", option: "Option", barrier: "Barrière", digital: "Digitale", asian: "Asiatique", cliquet: "Cliquet",
  autocall: "Autocall", bond: "Obligation", future: "Future",
};

export const PORTFOLIO_PAGES = [
  { path: "positions", label: "Positions & expositions" },
  { path: "risques", label: "Stress tests, VaR & P&L" },
] as const;

export default function Portfolio() {
  const qc = useQueryClient();
  const demo = useMutation({ mutationFn: portfolioApi.demo, onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio"] }) });
  const clear = useMutation({ mutationFn: portfolioApi.clear, onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolio"] }) });
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Portefeuille & risques</h1>
          <div className="page-sub">Book multi-actifs valorisé aux dernières données de marché, en euros. Chaque scénario de stress est une revalorisation complète.</div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" onClick={() => demo.mutate()} disabled={demo.isPending}>
            <Wand2 size={14} /> {demo.isPending ? "Chargement…" : "Charger le book de démonstration"}
          </button>
          <button className="btn ghost" onClick={() => { if (window.confirm("Supprimer toutes les positions ?")) clear.mutate(); }}>
            <Trash2 size={14} /> Vider
          </button>
        </div>
      </div>
      <ErrorBox error={demo.error ?? clear.error} />
      <nav className="tabs subnav" aria-label="Portefeuille">
        {PORTFOLIO_PAGES.map((m) => (
          <NavLink key={m.path} to={`/portfolio/${m.path}`} className={({ isActive }) => (isActive ? "on" : "")}>{m.label}</NavLink>
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
      Aucune position. Chargez le book de démonstration ou ajoutez une position.
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
          <Stat label="Valeur du book" value={money(t.market_value)} foot={<>P&L <Delta value={t.pnl} digits={0} /> €</>} />
          <Stat label="Delta cash" value={signedMoney(t.delta_cash)} foot="exposition actions équivalente" />
          <Stat label="Vega (1 pt de vol)" value={signedMoney(t.vega)} foot={`Gamma 1 % : ${signedMoney(t.gamma_cash)}`} />
          <Stat label="Theta (1 jour)" value={signedMoney(t.theta)} foot={`Rho 1 % : ${signedMoney(t.rho)} · DV01 ${money(t.dv01)}`} />
        </div>
      )}
      <Card title={`Positions (${data?.positions.length ?? 0})`} flush actions={
        <button className="btn primary" onClick={() => setAdding((a) => !a)}><Plus size={14} /> Ajouter une position</button>
      }>
        {adding && <div className="card-body" style={{ borderBottom: "1px solid var(--border)" }}><AddPosition onDone={() => setAdding(false)} /></div>}
        {data && data.positions.length > 0 && (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Position</th><th>Book</th><th>Quantité</th><th>Prix unitaire</th><th>Valeur (€)</th><th>P&L (€)</th>
                  <th>Delta cash</th><th>Vega 1 pt</th><th>Theta 1 j</th><th />
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
            Volatilité utilisée : {Object.entries(data.vol_source).map(([k, v]) => `${k} (${v})`).join(" · ")}.
            {data.eurusd ? ` EUR/USD ${num(data.eurusd, 4)}.` : ""}
          </div>
        )}
      </Card>
      {data && data.by_underlying.length > 0 && (
        <>
          <div className="grid cols-2">
            <Card title="Delta cash par sous-jacent">
              <EChart option={exposureOption("delta_cash")} height={Math.max(260, data.by_underlying.length * 34)} ariaLabel="Delta cash par sous-jacent" />
            </Card>
            <Card title="Vega par sous-jacent (pour 1 point de vol)">
              <EChart option={exposureOption("vega")} height={Math.max(260, data.by_underlying.length * 34)} ariaLabel="Vega par sous-jacent" />
            </Card>
          </div>
          <div className="grid cols-2">
            <ExposureTable title="Par book" rows={data.by_book} />
            <ExposureTable title="Par type d'instrument" rows={data.by_kind.map((r) => ({ ...r, key: KIND_LABEL[r.key as PositionKind] ?? r.key }))} />
          </div>
        </>
      )}
    </div>
  );
}

function PositionLine({ p, onDelete }: { p: PositionRow; onDelete: () => void }) {
  return (
    <tr>
      <td style={{ textAlign: "left", whiteSpace: "normal", minWidth: 260 }}>
        <span className="badge" style={{ marginRight: 6 }}>{KIND_LABEL[p.kind]}</span>
        <span className="strong">{p.label || p.description}</span>
        {p.label && <div className="muted" style={{ fontSize: 11.5 }}>{p.description}</div>}
        {p.error && <div className="down" style={{ fontSize: 11.5 }}>{p.error}</div>}
      </td>
      <td className="muted">{p.book}</td>
      <td>{num(p.quantity, 0)}{p.params.multiplier ? <span className="muted"> ×{String(p.params.multiplier)}</span> : null}</td>
      <td>{num(p.unit_price, 2)} <span className="muted">{p.currency}</span></td>
      <td className="strong">{money(p.market_value_base)}</td>
      <td><Delta value={p.pnl_base} digits={0} /></td>
      <td>{signedMoney(p.delta_cash)}</td>
      <td>{signedMoney(p.vega)}</td>
      <td>{signedMoney(p.theta)}</td>
      <td><button className="btn icon ghost" onClick={onDelete} aria-label="Supprimer la position" title="Supprimer"><Trash2 size={14} /></button></td>
    </tr>
  );
}

function ExposureTable({ title, rows }: { title: string; rows: { key: string; market_value: number; pnl: number; delta_cash: number; vega: number; n: number }[] }) {
  return (
    <Card title={title} flush>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>{title.replace("Par ", "")}</th><th>Positions</th><th>Valeur</th><th>P&L</th><th>Delta cash</th><th>Vega</th></tr></thead>
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
      };
      const body: PositionIn = { kind, quantity, ticker: kind === "bond" ? null : ticker, params: params[kind], book, label };
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
      <DateField label="Échéance" value={prm.expiry as string} onChange={set("expiry")} />
      <Segmented label="Type" value={prm.option_type as string} onChange={set("option_type")} options={[{ value: "call", label: "Call" }, { value: "put", label: "Put" }]} />
      <NumberField label="Multiplicateur" value={prm.multiplier as number} min={1} digits={0} onChange={set("multiplier")} />
    </>
  );

  let fields: ReactNode = null;
  if (kind === "option") {
    fields = <>{optionFields}<Segmented label="Exercice" value={prm.exercise as string} onChange={set("exercise")} options={[{ value: "european", label: "Européen" }, { value: "american", label: "Américain" }]} /></>;
  } else if (kind === "barrier") {
    fields = (
      <>
        {optionFields}
        <NumberField label="Barrière" value={prm.barrier as number} min={0.01} digits={2} onChange={set("barrier")} />
        <SelectField label="Type de barrière" value={prm.barrier_type as string} onChange={set("barrier_type")}
          options={["down-and-out", "down-and-in", "up-and-out", "up-and-in"].map((v) => ({ value: v, label: v }))} />
        <SelectField label="Observation" value={prm.monitoring_per_year as number} onChange={set("monitoring_per_year")}
          options={[{ value: 0, label: "Continue" }, { value: 252, label: "Quotidienne" }, { value: 52, label: "Hebdomadaire" }]} />
      </>
    );
  } else if (kind === "digital") {
    fields = (
      <>
        {optionFields}
        <Segmented label="Payoff" value={prm.digital_kind as string} onChange={set("digital_kind")}
          options={[{ value: "cash-or-nothing", label: "Cash" }, { value: "asset-or-nothing", label: "Asset" }]} />
        {prm.digital_kind === "cash-or-nothing" && <NumberField label="Montant payé" value={prm.cash as number} min={0.01} digits={2} onChange={set("cash")} />}
      </>
    );
  } else if (kind === "asian") {
    fields = (
      <>
        {optionFields}
        <SelectField label="Fixings (d'aujourd'hui à l'échéance)" value={prm.n_fixings as number} onChange={set("n_fixings")}
          options={[4, 12, 52].map((v) => ({ value: v, label: String(v) }))} />
        <Segmented label="Moyenne" value={prm.averaging as string} onChange={set("averaging")}
          options={[{ value: "arithmetic", label: "Arithmétique" }, { value: "geometric", label: "Géométrique" }]} />
      </>
    );
  } else if (kind === "cliquet") {
    fields = (
      <>
        <NumberField label="Maturité" value={prm.cliquet_years as number} suffix="ans" min={0.25} max={10} digits={2} onChange={set("cliquet_years")} />
        <SelectField label="Resets" value={prm.frequency as number} onChange={set("frequency")}
          options={[{ value: 12, label: "Mensuels" }, { value: 4, label: "Trimestriels" }, { value: 1, label: "Annuels" }]} />
        <NumberField label="Floor local" value={prm.local_floor as number} suffix="%" scale={100} min={-1} digits={1} onChange={set("local_floor")} />
        <NumberField label="Cap local" value={prm.local_cap as number} suffix="%" scale={100} min={-1} digits={1} onChange={set("local_cap")} />
        <NumberField label="Floor global" value={prm.global_floor as number} suffix="%" scale={100} digits={1} onChange={set("global_floor")} />
      </>
    );
  } else if (kind === "autocall") {
    fields = (
      <>
        <NumberField label="Maturité" value={prm.maturity_years as number} suffix="ans" min={0.5} max={10} digits={1} onChange={set("maturity_years")} />
        <SelectField label="Observations" value={prm.frequency as number} onChange={set("frequency")}
          options={[{ value: 12, label: "Mensuelles" }, { value: 4, label: "Trimestrielles" }, { value: 1, label: "Annuelles" }]} />
        <NumberField label="Coupon / période" value={prm.coupon_rate as number} suffix="%" scale={100} digits={2} onChange={set("coupon_rate")} />
        <NumberField label="Barrière autocall" value={prm.autocall_barrier as number} suffix="%" scale={100} digits={0} onChange={set("autocall_barrier")} />
        <NumberField label="Barrière coupon" value={prm.coupon_barrier as number} suffix="%" scale={100} digits={0} onChange={set("coupon_barrier")} />
        <NumberField label="Protection" value={prm.protection_barrier as number} suffix="%" scale={100} digits={0} onChange={set("protection_barrier")} />
        <Check label="Effet mémoire" checked={prm.memory as boolean} onChange={set("memory")} />
      </>
    );
  } else if (kind === "bond") {
    fields = (
      <>
        <Segmented label="Devise" value={prm.currency as string} onChange={set("currency")} options={[{ value: "EUR", label: "EUR" }, { value: "USD", label: "USD" }]} />
        <DateField label="Maturité" value={prm.maturity as string} onChange={set("maturity")} />
        <NumberField label="Coupon" value={prm.bond_coupon as number} suffix="%" scale={100} digits={3} onChange={set("bond_coupon")} />
        <SelectField label="Fréquence" value={prm.bond_frequency as number} onChange={set("bond_frequency")}
          options={[{ value: 1, label: "Annuel" }, { value: 2, label: "Semestriel" }]} />
      </>
    );
  } else if (kind === "future") {
    fields = (
      <>
        <DateField label="Échéance" value={prm.expiry as string} onChange={set("expiry")} />
        <NumberField label="Multiplicateur" value={prm.multiplier as number} min={1} digits={0} onChange={set("multiplier")} />
      </>
    );
  }

  return (
    <div className="form">
      <Segmented value={kind} onChange={setKind} options={(Object.keys(KIND_LABEL) as PositionKind[]).map((k) => ({ value: k, label: KIND_LABEL[k] }))} />
      <div className="toolbar-grid">
        {kind !== "bond" && (
          <SelectField label="Sous-jacent" value={ticker} onChange={setTicker}
            options={(tickers ?? []).map((t) => ({ value: t.ticker, label: `${t.ticker} — ${t.name}` }))} />
        )}
        <NumberField label={kind === "autocall" || kind === "cliquet" ? "Nombre de notes (nominal 100)" : kind === "bond" ? "Nombre de titres (nominal 100)" : "Quantité (négatif = vente)"}
          value={quantity} digits={2} onChange={setQuantity} />
        {fields}
        <TextField label="Book" value={book} onChange={setBook} />
        <TextField label="Libellé (optionnel)" value={label} onChange={setLabel} />
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button className="btn primary" onClick={() => add.mutate()} disabled={add.isPending}>{add.isPending ? "Valorisation…" : "Ajouter au book"}</button>
        <button className="btn ghost" onClick={onDone}>Annuler</button>
        <span className="muted" style={{ fontSize: 12 }}>Le prix d'entrée est le prix modèle actuel : le P&L part de zéro.</span>
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
      xAxis: { type: "category", data: s.spot_shocks.map((x) => `${x > 0 ? "+" : ""}${num(x * 100, 0)} %`), name: "choc sur les actions", nameLocation: "middle", nameGap: 28, splitLine: { show: false } },
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
        type: "line", step: "middle", name: "Fréquence", showSymbol: false, color: p.series[0], areaStyle: { opacity: 0.3 },
        data: h.counts.map((c, i) => [(h.edges[i] + h.edges[i + 1]) / 2, c / total]),
        markLine: { symbol: "none", silent: true, label: { color: p.textSecondary, fontSize: 10, formatter: "{b}", position: "insideEndTop" },
          data: [
            { xAxis: -(v.var_95 ?? 0), name: "VaR 95 %", lineStyle: { color: p.series[1], type: "dashed" } },
            { xAxis: -(v.var_99 ?? 0), name: "VaR 99 %", lineStyle: { color: p.critical, type: "dashed" } },
          ] },
      }],
    };
  }, [data]);

  const explainOption = useCallback((p: ChartPalette) => {
    if (!data) return {};
    const t = data.pnl_explain.totals;
    const items = [["Delta", t.delta], ["Gamma", t.gamma], ["Theta", t.theta], ["Résiduel", t.residual], ["P&L réel", t.actual]] as const;
    return {
      grid: { left: 8, right: 16, top: 24, bottom: 8, containLabel: true },
      tooltip: { trigger: "item", formatter: (it: { name: string; value: number }) => `${it.name}<br/><b>${signedMoney(it.value)}</b>` },
      xAxis: { type: "category", data: items.map((i) => i[0]), axisTick: { show: false } },
      yAxis: { type: "value", axisLabel: { formatter: (x: number) => money(x) } },
      series: [{
        type: "bar", barMaxWidth: 48,
        data: items.map(([name, v]) => ({ value: v, itemStyle: { color: name === "P&L réel" ? p.text : v >= 0 ? p.diverging[2] : p.diverging[0], borderRadius: v >= 0 ? [4, 4, 0, 0] : [0, 0, 4, 4] } })),
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
            <Stat label="VaR 99 % (1 jour, historique)" value={money(v.var_99)} foot={`ES 99 % : ${money(v.es_99)}`} />
            <Stat label="VaR 95 % (1 jour, historique)" value={money(v.var_95)} foot={`ES 95 % : ${money(v.es_95)}`} />
            <Stat label="VaR 99 % paramétrique" value={money(v.parametric_var_99)} foot="delta-normale, même historique" />
            <Stat label="Scénarios historiques" value={num(v.n_scenarios, 0)} foot={`${data.history_days} jours communs à tous les sous-jacents`} />
          </div>
          <Card title="Stress test : P&L par choc actions × choc de volatilité (revalorisation complète)">
            <EChart option={stressOption} height={360} ariaLabel="Matrice de stress actions et volatilité" />
          </Card>
          <div className="grid cols-2">
            <Card title="Distribution du P&L journalier (scénarios historiques)">
              <EChart option={histOption} height={320} ariaLabel="Distribution historique du P&L" />
              {v.worst_scenarios && (
                <div className="muted" style={{ fontSize: 12, marginTop: 6 }}>
                  Pires jours : {v.worst_scenarios.map((w) => `${w.date} (${signedMoney(w.pnl)})`).join(" · ")}
                </div>
              )}
            </Card>
            <Card title="Chocs de taux parallèles" flush>
              <div className="table-wrap">
                <table className="data">
                  <thead><tr><th>Choc</th><th>P&L</th></tr></thead>
                  <tbody>
                    {data.stress.rate_shocks.map((r) => (
                      <tr key={r.shift}><td className="strong">{r.shift > 0 ? "+" : ""}{num(r.shift * 1e4, 0)} bp</td><td><Delta value={r.pnl} digits={0} /> €</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="card-body">
                <InfoBox>
                  La VaR historique rejoue les variations journalières réelles des sous-jacents (approximation delta-gamma).
                  Les risques de taux et de volatilité sont mesurés par les stress tests, en revalorisation complète.
                </InfoBox>
              </div>
            </Card>
          </div>
          <div className="grid cols-2">
            <Card title="Explication du P&L depuis la clôture précédente">
              <EChart option={explainOption} height={300} ariaLabel="Décomposition du P&L du jour" />
            </Card>
            <Card title="P&L par position" flush>
              <div className="table-wrap" style={{ maxHeight: 340, overflowY: "auto" }}>
                <table className="data">
                  <thead><tr><th>Position</th><th>Var. spot</th><th>Réel</th><th>Delta</th><th>Gamma</th><th>Theta</th><th>Résiduel</th></tr></thead>
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
