import type { KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTicker } from "../lib/hooks";

/** "Plan de métro": Argus drawn as a transit network. Each page is a station; lines follow the engine's real
 *  dependencies (an option chain feeds the smile, the smile feeds the models, every pricer feeds the book). */

type Station = { id: string; to: string; label: string; x: number; y: number; anchor?: "start" | "middle" | "end";
  dy?: number; chains?: boolean; hub?: [number, number] };

const S: Record<string, Station> = {
  theory: { id: "theory", to: "/theory", label: "Théorie appliquée", x: 60, y: 60, dy: -16 },
  docs: { id: "docs", to: "/documentation", label: "Documentation", x: 60, y: 220, dy: 24 },
  methods: { id: "methods", to: "/methods", label: "Méthodes de pricing", x: 180, y: 140, dy: 28, anchor: "start" },
  options: { id: "options", to: "/options", label: "Options vanille", x: 300, y: 140, dy: -14, anchor: "start" },
  vol: { id: "vol", to: "/volatility", label: "Volatilité implicite", x: 420, y: 60, dy: -16, chains: true },
  models: { id: "models", to: "/models", label: "Modèles de volatilité", x: 560, y: 60, dy: -16, chains: true },
  variance: { id: "variance", to: "/variance", label: "Swaps de variance", x: 700, y: 60, dy: -16, chains: true },
  exotics: { id: "exotics", to: "/exotics", label: "Options exotiques", x: 440, y: 140, dy: 26 },
  structured: { id: "structured", to: "/structured", label: "Produits structurés", x: 570, y: 140, dy: 26 },
  portfolio: { id: "portfolio", to: "/portfolio", label: "Portefeuille & risques", x: 700, y: 140, dy: -18, hub: [700, 720] },
  rates: { id: "rates", to: "/rates", label: "Courbes & obligations", x: 360, y: 220, dy: 26 },
  ratesfx: { id: "ratesfx", to: "/rates-fx", label: "Options de taux & change", x: 500, y: 220, dy: -14 },
  credit: { id: "credit", to: "/credit", label: "Crédit : CDS & Merton", x: 640, y: 220, dy: 26 },
  news: { id: "news", to: "/sentiment", label: "News & sentiment", x: 840, y: 240, dy: 24 },
  overview: { id: "overview", to: "/", label: "Vue d'ensemble", x: 960, y: 240, dy: -16, anchor: "end" },
  allocation: { id: "allocation", to: "/allocation", label: "Allocation", x: 830, y: 140, dy: -14 },
  research: { id: "research", to: "/research", label: "Volatility-managed", x: 960, y: 140, dy: 26, anchor: "end" },
};

const LINES: { name: string; color: string; path: [number, number][] }[] = [
  { name: "Volatilité", color: "#4d8bf0", path: [[300, 140], [300, 100], [340, 60], [700, 60]] },
  { name: "Pricing", color: "#e5484d", path: [[180, 140], [700, 140]] },
  { name: "Taux & crédit", color: "#f2a541", path: [[360, 220], [660, 220], [700, 180], [700, 140]] },
  { name: "Marchés & risque", color: "#2ba84a", path: [[960, 240], [780, 240], [720, 180], [720, 140], [960, 140]] },
  { name: "Théorie", color: "#a78bfa", path: [[60, 60], [120, 60], [180, 120], [180, 160], [120, 220], [60, 220]] },
];

const STATION_LINE: Record<string, string> = {
  theory: "#a78bfa", docs: "#a78bfa", vol: "#4d8bf0", models: "#4d8bf0", variance: "#4d8bf0", exotics: "#e5484d",
  structured: "#e5484d", rates: "#f2a541", ratesfx: "#f2a541", credit: "#f2a541", news: "#2ba84a", overview: "#2ba84a",
  allocation: "#2ba84a", research: "#2ba84a",
};
const INTERCHANGES = new Set(["methods", "options", "portfolio"]);

export function TransitMap() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { ticker, snapshot } = useTicker();
  const noChains = snapshot?.market === "EU";

  const go = (to: string) => navigate(to);
  const onKey = (e: KeyboardEvent, to: string) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      go(to);
    }
  };

  return (
    <section className="card transit">
      <header className="card-head">
        <h2 className="card-title">Plan du réseau Argus</h2>
        <span className="muted">5 lignes · {Object.keys(S).length} stations · cliquez une station pour y aller</span>
      </header>
      <div className="transit-body">
        <svg viewBox="0 20 1000 260" className="transit-svg" role="group" aria-label="Plan des pages d'Argus">
          {LINES.map((l) => (
            <polyline key={l.name} points={l.path.map((p) => p.join(",")).join(" ")} fill="none" stroke={l.color}
              strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {Object.values(S).map((st) => {
            const here = st.to === "/" ? pathname === "/" : pathname.startsWith(st.to);
            const suspended = noChains && st.chains;
            const hub = INTERCHANGES.has(st.id);
            const anchor = st.anchor ?? "middle";
            return (
              <g key={st.id} className={`station${here ? " here" : ""}${suspended ? " suspended" : ""}`} role="link"
                tabIndex={0} aria-label={`${st.label}${suspended ? ` (suspendue pour ${ticker})` : ""}`}
                onClick={() => go(st.to)} onKeyDown={(e) => onKey(e, st.to)}>
                {st.hub ? (
                  <rect x={st.hub[0] - 10} y={st.y - 10} width={st.hub[1] - st.hub[0] + 20} height={20} rx={10} className="hub" />
                ) : hub ? (
                  <circle cx={st.x} cy={st.y} r={10} className="hub" />
                ) : (
                  <circle cx={st.x} cy={st.y} r={7} className="stop" stroke={STATION_LINE[st.id]} />
                )}
                {here && <circle cx={st.hub ? (st.hub[0] + st.hub[1]) / 2 : st.x} cy={st.y} r={16} className="here-ring" />}
                <text x={st.x} y={st.y + (st.dy ?? 24)} textAnchor={anchor} className="station-label">{st.label}</text>
              </g>
            );
          })}
        </svg>
        <div className="transit-legend">
          {LINES.map((l) => (
            <span key={l.name}><i style={{ background: l.color }} />{l.name}</span>
          ))}
          <span><i className="lg-hub" />Correspondance</span>
          {noChains && <span className="warn"><i className="lg-suspended" />Stations suspendues pour {ticker} : pas de chaîne d'options européenne (Yahoo)</span>}
        </div>
      </div>
    </section>
  );
}
