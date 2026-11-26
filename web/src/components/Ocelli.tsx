import type { TickerSnapshot } from "../api/client";
import { ccySymbol, num, pct, signed } from "../lib/format";
import { useTicker } from "../lib/hooks";
import { Delta } from "./ui";

/** "Les cent yeux": the market under watch. Each underlying is an ocellus (the eye of a peacock feather):
 *  outer radius on one fixed ramp of 1-month realised vol, iris colour and strength from the day's move. */

const VOL_CAP = 1.25;
const radius = (vol: number | null | undefined) => 12 + 28 * Math.sqrt(Math.min(Math.max(vol ?? 0, 0), VOL_CAP) / VOL_CAP);

function Eye({ t, selected, onSelect }: { t: TickerSnapshot; selected: boolean; onSelect: () => void }) {
  const R = radius(t.realized_vol_1m);
  const move = t.change_pct ?? 0;
  const strength = Math.min(Math.abs(move) / 0.03, 1);
  const iris = move >= 0 ? "var(--good)" : "var(--critical)";
  return (
    <button type="button" className={`eye${selected ? " selected" : ""}`} onClick={onSelect}
      aria-pressed={selected} title={`${t.ticker} — ${t.name}`}
      aria-label={`${t.ticker}, ${signed(move, 2, true)}, vol réalisée 1 mois ${pct(t.realized_vol_1m, 1)}`}>
      <svg viewBox="-44 -44 88 88" width="88" height="88" aria-hidden="true">
        {selected && <circle r={R + 4} className="eye-select" />}
        <circle r={R} fill="var(--gold)" />
        <circle r={R * 0.8} fill="#0e7c86" />
        <circle r={R * 0.62} fill="var(--surface-1)" />
        <circle r={R * 0.62} fill={iris} opacity={0.35 + 0.65 * strength} />
        <circle r={R * 0.3} className="pupil" />
        <circle cx={-R * 0.12} cy={-R * 0.14} r={Math.max(R * 0.07, 1.4)} fill="#ffffff" opacity={0.85} />
      </svg>
      <span className="eye-sym">{t.ticker}</span>
      <span className={`eye-move num ${move >= 0 ? "up" : "down"}`}>{signed(move, 2, true)}</span>
    </button>
  );
}

export function SurveillanceMap({ tickers }: { tickers: TickerSnapshot[] }) {
  const { ticker, setTicker } = useTicker();
  const groups: [string, TickerSnapshot[]][] = [
    ["États-Unis", tickers.filter((t) => t.market === "US")],
    ["Europe", tickers.filter((t) => t.market === "EU")],
  ];
  const ups = tickers.filter((t) => (t.change_pct ?? 0) >= 0).length;
  return (
    <section className="card surveillance">
      <header className="card-head">
        <h2 className="card-title">Les cent yeux — {tickers.length} sous-jacents sous surveillance</h2>
        <span className="muted num">{ups} en hausse · {tickers.length - ups} en baisse</span>
      </header>
      <div className="surveillance-body">
        <div className="ocelli-wrap">
          {groups.filter(([, l]) => l.length).map(([label, list]) => (
            <div key={label} className="ocelli-group">
              <h3 className="ocelli-label">{label}</h3>
              <div className="ocelli">
                {list.map((t) => <Eye key={t.ticker} t={t} selected={t.ticker === ticker} onSelect={() => setTicker(t.ticker)} />)}
              </div>
            </div>
          ))}
          <p className="ocelli-legend">
            <span><i className="lg-ring" /> Taille de l'œil : vol réalisée sur 1 mois</span>
            <span><i className="lg-up" /> Iris vert : hausse du jour</span>
            <span><i className="lg-down" /> Iris rouge : baisse</span>
            <span>Intensité : ampleur du mouvement (pleine à 3 %)</span>
          </p>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Sous-jacent</th><th>Dernier</th><th>Jour</th><th>Vol 1M</th></tr></thead>
            <tbody>
              {groups.flatMap(([, l]) => l).map((t) => (
                <tr key={t.ticker} className={t.ticker === ticker ? "selected" : ""} onClick={() => setTicker(t.ticker)}>
                  <td className="strong"><div className="name-cell"><span>{t.ticker}</span><span className="muted">{t.name}</span></div></td>
                  <td className="num">{num(t.last)} <span className="muted">{ccySymbol(t.currency)}</span></td>
                  <td><Delta value={t.change_pct} pct /></td>
                  <td className="num">{pct(t.realized_vol_1m, 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
