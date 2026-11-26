import { useMemo } from "react";
import type { TickerSnapshot } from "../api/client";
import { ccySymbol, num, pct } from "../lib/format";
import { Delta } from "./ui";

/** "Série de billets": the selected underlying printed as a banknote face value. The background is a guilloché
 *  rosette (epitrochoid-like curves r(θ) = R + a·sin(kθ + φ)), the fine-line engraving of security printing. */

function rosette(cx: number, cy: number, R: number, a: number, k: number, phase: number, steps = 360): string {
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * 2 * Math.PI;
    const r = R + a * Math.sin(k * t + phase);
    pts.push(`${(cx + r * Math.cos(t)).toFixed(1)},${(cy + r * Math.sin(t)).toFixed(1)}`);
  }
  return `M${pts.join("L")}Z`;
}

function Guilloche() {
  const paths = useMemo(() => {
    const out: string[] = [];
    for (let i = 0; i < 22; i++) out.push(rosette(760, 120, 40 + i * 7, 9 + (i % 4), 18, i * 0.35));
    for (let i = 0; i < 9; i++) out.push(rosette(120, 210, 18 + i * 6, 5, 12, i * 0.5));
    return out;
  }, []);
  return (
    <svg className="guilloche" viewBox="0 0 1000 260" preserveAspectRatio="xMaxYMid slice" aria-hidden="true">
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

export function FaceValue({ snapshot }: { snapshot?: TickerSnapshot }) {
  if (!snapshot || snapshot.last == null) return null;
  const ccy = ccySymbol(snapshot.currency);
  return (
    <section className="card face-value" aria-label={`${snapshot.ticker}, ${num(snapshot.last)} ${ccy}`}>
      <Guilloche />
      <span className="fv-corner tl">{snapshot.ticker}</span>
      <span className="fv-corner br num">{num(snapshot.last, 0)}</span>
      <div className="fv-body">
        <div className="fv-name">{snapshot.name}</div>
        <div className="fv-value num">{num(snapshot.last)}<span className="fv-ccy">{ccy}</span></div>
        <div className="fv-meta">
          <span>Jour <Delta value={snapshot.change_pct} pct /></span>
          <span>Vol réalisée 1M <b className="num">{pct(snapshot.realized_vol_1m, 1)}</b></span>
          <span>Marché <b>{snapshot.market === "EU" ? "Europe" : "États-Unis"}</b></span>
        </div>
      </div>
    </section>
  );
}
