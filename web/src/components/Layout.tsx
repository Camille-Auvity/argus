import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity, ArrowLeftRight, BarChart3, BookOpen, Shapes, ShieldAlert, Briefcase, Clock, FlaskConical, Landmark, Layers, LayoutDashboard, LineChart, Moon, Newspaper, RefreshCw, Sigma, Sun,
} from "lucide-react";
import type { ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { api } from "../api/client";
import { STATIC_MODE } from "../engine/bridge";
import { ccySymbol, num, relativeTime } from "../lib/format";
import { useStatus, useTicker, useTickers } from "../lib/hooks";
import { useTheme } from "../lib/theme";
import { Delta } from "./ui";

const NAV = [
  { section: "Marchés" },
  { to: "/", label: "Vue d'ensemble", icon: LayoutDashboard },
  { to: "/sentiment", label: "News & sentiment", icon: Newspaper },
  { section: "Portefeuille" },
  { to: "/portfolio", label: "Portefeuille & risques", icon: Briefcase },
  { section: "Pricing" },
  { to: "/options", label: "Options vanille", icon: Sigma },
  { to: "/methods", label: "Méthodes de pricing", icon: FlaskConical },
  { to: "/volatility", label: "Volatilité implicite", icon: Activity },
  { to: "/models", label: "Modèles de volatilité", icon: Layers },
  { to: "/exotics", label: "Options exotiques", icon: Shapes },
  { to: "/structured", label: "Produits structurés", icon: BarChart3 },
  { section: "Taux, change & crédit" },
  { to: "/rates", label: "Courbes & obligations", icon: Landmark },
  { to: "/rates-fx", label: "Options de taux & change", icon: ArrowLeftRight },
  { to: "/credit", label: "Crédit : CDS & Merton", icon: ShieldAlert },
  { section: "Référence" },
  { to: "/documentation", label: "Documentation", icon: BookOpen },
] as const;

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="shell">
      <Sidebar />
      <TopBar />
      <main className="main">{children}</main>
    </div>
  );
}

function Sidebar() {
  const { data: status } = useStatus();
  return (
    <nav className="sidebar" aria-label="Navigation principale">
      <div className="brand">
        <div className="brand-mark"><LineChart size={17} /></div>
        <div className="brand-text">
          <div className="brand-name">ARGUS</div>
          <div className="brand-sub">Quant Pricing Platform</div>
        </div>
      </div>
      {NAV.map((item, i) =>
        "section" in item ? (
          <div key={i} className="nav-section">{item.section}</div>
        ) : (
          <NavLink key={item.to} to={item.to} end={item.to === "/"} title={item.label}
            className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            <item.icon size={17} />
            <span className="label">{item.label}</span>
          </NavLink>
        ),
      )}
      <div className="sidebar-footer">
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Clock size={12} /> Données {relativeTime(status?.last_refresh)}
        </span>
        <span>Sentiment : {status?.sentiment_model ?? "—"}</span>
        {STATIC_MODE ? (
          <>
            <span>Version en ligne : le moteur tourne dans votre navigateur</span>
            <a href="https://github.com/Camille-Auvity/argus" target="_blank" rel="noreferrer">Code source sur GitHub ↗</a>
          </>
        ) : (
          <a href="/docs" target="_blank" rel="noreferrer">Documentation de l'API ↗</a>
        )}
      </div>
    </nav>
  );
}

function TopBar() {
  const { ticker, setTicker, snapshot } = useTicker();
  const { data: tickers } = useTickers();
  const { data: status } = useStatus();
  const { mode, toggle } = useTheme();
  const qc = useQueryClient();
  const refresh = useMutation({
    mutationFn: () => api.refresh(ticker),
    onSuccess: () => qc.invalidateQueries(),
  });

  const us = tickers?.filter((t) => t.market === "US") ?? [];
  const eu = tickers?.filter((t) => t.market === "EU") ?? [];

  return (
    <header className="topbar">
      <div className="ticker-select">
        <span className="badge accent">{snapshot?.market ?? "—"}</span>
        <select value={ticker} onChange={(e) => setTicker(e.target.value)} aria-label="Sous-jacent">
          {!tickers && <option value={ticker}>{ticker}</option>}
          {[["États-Unis", us], ["Europe", eu]].map(([label, list]) => (
            <optgroup key={label as string} label={label as string}>
              {(list as typeof us).map((t) => (
                <option key={t.ticker} value={t.ticker}>{t.ticker} — {t.name}</option>
              ))}
            </optgroup>
          ))}
        </select>
      </div>
      {snapshot?.last != null && (
        <div className="ticker-quote">
          <span className="px num">{num(snapshot.last)} {ccySymbol(snapshot.currency)}</span>
          <Delta value={snapshot.change_pct} pct />
        </div>
      )}
      <div className="spacer" />
      {status &&
        Object.entries(status.markets).map(([name, m]) => {
          const open = status.open_markets.includes(name);
          return (
            <span key={name} className="market-chip" title={`${m.open}–${m.close} (${m.tz})`}>
              <span className={`dot${open ? " open" : ""}`} />
              {name} {open ? "ouvert" : "fermé"}
            </span>
          );
        })}
      {STATIC_MODE ? (
        <span className="market-chip" title="Les données sont mises à jour automatiquement par GitHub Actions">
          <Clock size={13} /> Données {relativeTime(status?.last_refresh)}
        </span>
      ) : (
        <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}
          title={`Télécharger maintenant les données de ${ticker}`}>
          <RefreshCw size={14} className={refresh.isPending ? "spin" : ""} />
          <span className="label">{refresh.isPending ? "Mise à jour…" : "Actualiser"}</span>
        </button>
      )}
      <button className="btn icon ghost" onClick={toggle} aria-label="Changer de thème"
        title={mode === "dark" ? "Thème clair" : "Thème sombre"}>
        {mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
      </button>
    </header>
  );
}
