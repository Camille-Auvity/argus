import { AlertTriangle, ArrowDownRight, ArrowUpRight, Info } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { signed } from "../lib/format";

export function Card({ title, actions, children, flush, className = "" }: {
  title?: ReactNode; actions?: ReactNode; children: ReactNode; flush?: boolean; className?: string;
}) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title ? <h2 className="card-title">{title}</h2> : <span />}
          {actions}
        </header>
      )}
      <div className={`card-body${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}

export function Stat({ label, value, foot, busy }: { label: string; value: ReactNode; foot?: ReactNode; busy?: boolean }) {
  return (
    <div className={`card stat${busy ? " busy" : ""}`}>
      <div className="stat-label">{label}</div>
      <div className="stat-value num">{value}</div>
      {foot !== undefined && <div className="stat-foot num">{foot}</div>}
    </div>
  );
}

/** Numeric input that keeps its own text while typing and reports only valid numbers. */
export function NumberField({ label, value, onChange, suffix, step = 1, min, max, scale = 1, digits = 4, hint }: {
  label: string; value: number; onChange: (v: number) => void; suffix?: string; step?: number; min?: number;
  max?: number; scale?: number; digits?: number; hint?: string;
}) {
  const display = (v: number) => String(Number((v * scale).toFixed(digits)));
  const [text, setText] = useState(display(value));
  useEffect(() => {
    if (Number(text.replace(",", ".")) / scale !== value) setText(display(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {hint && <span title={hint}>ⓘ</span>}
      </span>
      <span className="input-wrap">
        <input
          inputMode="decimal"
          value={text}
          step={step}
          onChange={(e) => {
            setText(e.target.value);
            const v = Number(e.target.value.replace(",", "."));
            if (e.target.value.trim() !== "" && Number.isFinite(v)) {
              const raw = v / scale;
              if ((min === undefined || raw >= min) && (max === undefined || raw <= max)) onChange(raw);
            }
          }}
          onBlur={() => setText(display(value))}
        />
        {suffix && <span className="input-suffix">{suffix}</span>}
      </span>
    </label>
  );
}

export function SelectField<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <span className="input-wrap">
        <select
          value={String(value)}
          onChange={(e) => {
            const opt = options.find((o) => String(o.value) === e.target.value);
            if (opt) onChange(opt.value);
          }}
        >
          {options.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
          ))}
        </select>
        <span className="input-suffix">▾</span>
      </span>
    </label>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label?: string;
}) {
  const control = (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={String(o.value)} type="button" role="radio" aria-checked={o.value === value}
          className={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
  if (!label) return control;
  return (
    <div className="field">
      <span className="field-label">{label}</span>
      {control}
    </div>
  );
}

export function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function ErrorBox({ error }: { error: unknown }) {
  if (!error) return null;
  const msg = error instanceof Error ? error.message : String(error);
  return (
    <div className="error-box" role="alert">
      <AlertTriangle size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
      {msg}
    </div>
  );
}

export function InfoBox({ children }: { children: ReactNode }) {
  return (
    <div className="info-box">
      <Info size={15} style={{ flex: "none", marginTop: 1 }} />
      <div>{children}</div>
    </div>
  );
}

export function Skeleton({ height = 16, width = "100%" }: { height?: number; width?: number | string }) {
  return <div className="skeleton" style={{ height, width }} />;
}

/** Signed change: arrow + sign carry the direction, colour only reinforces it. */
export function Delta({ value, pct, digits = 2 }: { value: number | null; pct?: boolean; digits?: number }) {
  if (value === null || !Number.isFinite(value)) return <span className="muted">—</span>;
  const up = value > 0;
  const down = value < 0;
  const Icon = up ? ArrowUpRight : ArrowDownRight;
  return (
    <span className={`num ${up ? "up" : down ? "down" : "muted"}`} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
      {(up || down) && <Icon size={13} aria-hidden />}
      {signed(value, digits, pct)}
    </span>
  );
}

export function Sparkline({ data, width = 120, height = 32, color }: {
  data: number[]; width?: number; height?: number; color: string;
}) {
  if (data.length < 2) return <svg width={width} height={height} />;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * width},${height - 2 - ((v - min) / span) * (height - 4)}`);
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: "block" }}>
      <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
    </svg>
  );
}

/** Sentiment score in [-1, 1] as a centred bar; the signed number is always shown next to it. */
export function ScoreBar({ score, palette }: { score: number | null; palette: [string, string, string] }) {
  if (score === null) return <span className="badge">non scoré</span>;
  const width = Math.min(Math.abs(score), 1) * 50;
  return (
    <div>
      <span className="num" style={{ fontWeight: 600 }}>
        {signed(score, 2)}
      </span>
      <div className="score-bar">
        <span className="mid" />
        <span className="fill" style={{
          left: score >= 0 ? "50%" : `${50 - width}%`, width: `${width}%`,
          background: score >= 0 ? palette[2] : palette[0],
        }} />
      </div>
    </div>
  );
}
