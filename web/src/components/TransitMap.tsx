import type { KeyboardEvent } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useTicker } from "../lib/hooks";
import { tr } from "../lib/i18n";

/** "Plan de métro": Argus drawn as a transit network. Each page is a station; lines follow the engine's real
 *  dependencies (an option chain feeds the smile, the smile feeds the models, every pricer feeds the book). */

type Station = { id: string; to: string; label: [string, string]; x: number; y: number; anchor?: "start" | "middle" | "end";
  dy?: number; dx?: number; chains?: boolean; hub?: [number, number] };

const S: Record<string, Station> = {
  theory: { id: "theory", to: "/theory", label: ["Théorie appliquée", "Applied theory"], x: 60, y: 60, dy: -16 },
  docs: { id: "docs", to: "/documentation", label: ["Documentation", "Documentation"], x: 60, y: 220, dy: 24 },
  methods: { id: "methods", to: "/methods", label: ["Méthodes de pricing", "Pricing methods"], x: 180, y: 140, dx: 14, dy: 34, anchor: "start" },
  options: { id: "options", to: "/options", label: ["Options vanille", "Vanilla options"], x: 300, y: 140, dx: 14, dy: -14, anchor: "start" },
  vol: { id: "vol", to: "/volatility", label: ["Volatilité implicite", "Implied volatility"], x: 420, y: 60, dy: -16, chains: true },
  models: { id: "models", to: "/models", label: ["Modèles de volatilité", "Volatility models"], x: 560, y: 60, dy: -16, chains: true },
  variance: { id: "variance", to: "/variance", label: ["Swaps de variance", "Variance swaps"], x: 700, y: 60, dy: -16, chains: true },
  exotics: { id: "exotics", to: "/exotics", label: ["Options exotiques", "Exotic options"], x: 440, y: 140, dy: 26 },
  structured: { id: "structured", to: "/structured", label: ["Produits structurés", "Structured products"], x: 570, y: 140, dy: 26 },
  portfolio: { id: "portfolio", to: "/portfolio", label: ["Portefeuille & risques", "Portfolio & risk"], x: 700, y: 140, dy: -18, hub: [700, 720] },
  rates: { id: "rates", to: "/rates", label: ["Courbes & obligations", "Curves & bonds"], x: 360, y: 220, dy: 26 },
  ratesfx: { id: "ratesfx", to: "/rates-fx", label: ["Options de taux & change", "Rate & FX options"], x: 500, y: 220, dy: -14 },
  credit: { id: "credit", to: "/credit", label: ["Crédit : CDS & Merton", "Credit: CDS & Merton"], x: 640, y: 220, dy: 26 },
  news: { id: "news", to: "/sentiment", label: ["News & sentiment", "News & sentiment"], x: 840, y: 240, dy: 24 },
  overview: { id: "overview", to: "/", label: ["Vue d'ensemble", "Overview"], x: 960, y: 240, dy: -26, anchor: "end" },
  allocation: { id: "allocation", to: "/allocation", label: ["Allocation", "Allocation"], x: 830, y: 140, dy: -14 },
  research: { id: "research", to: "/research", label: ["Volatility-managed", "Volatility-managed"], x: 960, y: 140, dy: 26, anchor: "end" },
};

const LINES: { name: [string, string]; color: string; path: [number, number][] }[] = [
  { name: ["Volatilité", "Volatility"] as [string, string], color: "#4d8bf0", path: [[300, 140], [300, 100], [340, 60], [700, 60]] },
  { name: ["Pricing", "Pricing"] as [string, string], color: "#e5484d", path: [[180, 140], [700, 140]] },
  { name: ["Taux & crédit", "Rates & credit"] as [string, string], color: "#f2a541", path: [[360, 220], [660, 220], [700, 180], [700, 140]] },
  { name: ["Marchés & risque", "Markets & risk"] as [string, string], color: "#2ba84a", path: [[960, 240], [780, 240], [720, 180], [720, 140], [960, 140]] },
  { name: ["Théorie", "Theory"] as [string, string], color: "#a78bfa", path: [[60, 60], [120, 60], [180, 120], [180, 160], [120, 220], [60, 220]] },
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
        <h2 className="card-title">{tr("Plan du réseau Argus", "Argus network map")}</h2>
        <span className="muted">{tr(`5 lignes · ${Object.keys(S).length} stations · cliquez une station pour y aller`, `5 lines · ${Object.keys(S).length} stations · click a station to go there`)}</span>
      </header>
      <div className="transit-body">
        <svg viewBox="0 20 1000 260" className="transit-svg" role="group" aria-label={tr("Plan des pages d'Argus", "Map of the Argus pages")}>
          {LINES.map((l) => (
            <polyline key={l.name[1]} points={l.path.map((p) => p.join(",")).join(" ")} fill="none" stroke={l.color}
              strokeWidth={7} strokeLinejoin="round" strokeLinecap="round" />
          ))}
          {Object.values(S).map((st) => {
            const here = st.to === "/" ? pathname === "/" : pathname.startsWith(st.to);
            const suspended = noChains && st.chains;
            const hub = INTERCHANGES.has(st.id);
            const anchor = st.anchor ?? "middle";
            return (
              <g key={st.id} className={`station${here ? " here" : ""}${suspended ? " suspended" : ""}`} role="link"
                tabIndex={0} aria-label={`${tr(st.label[0], st.label[1])}${suspended ? tr(` (suspendue pour ${ticker})`, ` (suspended for ${ticker})`) : ""}`}
                onClick={() => go(st.to)} onKeyDown={(e) => onKey(e, st.to)}>
                {st.hub ? (
                  <rect x={st.hub[0] - 10} y={st.y - 10} width={st.hub[1] - st.hub[0] + 20} height={20} rx={10} className="hub" />
                ) : hub ? (
                  <circle cx={st.x} cy={st.y} r={10} className="hub" />
                ) : (
                  <circle cx={st.x} cy={st.y} r={7} className="stop" stroke={STATION_LINE[st.id]} />
                )}
                {here && <circle cx={st.hub ? (st.hub[0] + st.hub[1]) / 2 : st.x} cy={st.y} r={16} className="here-ring" />}
                <text x={st.x + (st.dx ?? 0)} y={st.y + (st.dy ?? 24)} textAnchor={anchor} className="station-label">{tr(st.label[0], st.label[1])}</text>
              </g>
            );
          })}
        </svg>
        <div className="transit-legend">
          {LINES.map((l) => (
            <span key={l.name[1]}><i style={{ background: l.color }} />{tr(l.name[0], l.name[1])}</span>
          ))}
          <span><i className="lg-hub" />{tr("Correspondance", "Interchange")}</span>
          {noChains && <span className="warn"><i className="lg-suspended" />{tr(`Stations suspendues pour ${ticker} : pas de chaîne d'options européenne (Yahoo)`, `Stations suspended for ${ticker}: no European option chain (Yahoo)`)}</span>}
        </div>
      </div>
    </section>
  );
}
