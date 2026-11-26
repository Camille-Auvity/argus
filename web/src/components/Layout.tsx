import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Activity, ArrowLeftRight, Info, AudioWaveform, GraduationCap, Microscope, PieChart, BarChart3, BookOpen, Shapes, ShieldAlert, Briefcase, Clock, FlaskConical, Landmark, Layers, LayoutDashboard, LineChart, Moon, Newspaper, RefreshCw, Sigma, Sun,
} from "lucide-react";
import { useEffect, useRef, type KeyboardEvent, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { api } from "../api/client";
import { STATIC_MODE } from "../engine/bridge";
import { ccySymbol, num, relativeTime } from "../lib/format";
import { useStatus, useTicker, useTickers } from "../lib/hooks";
import { DESIGNS, useTheme, type Design } from "../lib/theme";
import { LANGS, tr, useLang } from "../lib/i18n";

/** [français, English] pair → text of the current language */
const pick = (p: readonly [string, string]) => tr(p[0], p[1]);
import { Delta } from "./ui";

const NAV = [
  { section: ["Marchés", "Markets"], group: "marches" },
  { to: "/", label: ["Vue d'ensemble", "Overview"], icon: LayoutDashboard },
  { to: "/sentiment", label: ["News & sentiment", "News & sentiment"], icon: Newspaper },
  { section: ["Portefeuille", "Portfolio"], group: "portefeuille" },
  { to: "/portfolio", label: ["Portefeuille & risques", "Portfolio & risk"], icon: Briefcase },
  { to: "/allocation", label: ["Allocation de portefeuille", "Portfolio allocation"], icon: PieChart },
  { section: ["Pricing", "Pricing"], group: "pricing" },
  { to: "/options", label: ["Options vanille", "Vanilla options"], icon: Sigma },
  { to: "/methods", label: ["Méthodes de pricing", "Pricing methods"], icon: FlaskConical },
  { to: "/volatility", label: ["Volatilité implicite", "Implied volatility"], icon: Activity },
  { to: "/models", label: ["Modèles de volatilité", "Volatility models"], icon: Layers },
  { to: "/exotics", label: ["Options exotiques", "Exotic options"], icon: Shapes },
  { to: "/variance", label: ["Swaps de variance", "Variance swaps"], icon: AudioWaveform },
  { to: "/structured", label: ["Produits structurés", "Structured products"], icon: BarChart3 },
  { section: ["Taux, change & crédit", "Rates, FX & credit"], group: "taux" },
  { to: "/rates", label: ["Courbes & obligations", "Curves & bonds"], icon: Landmark },
  { to: "/rates-fx", label: ["Options de taux & change", "Rate & FX options"], icon: ArrowLeftRight },
  { to: "/credit", label: ["Crédit : CDS & Merton", "Credit: CDS & Merton"], icon: ShieldAlert },
  { section: ["Recherche", "Research"], group: "recherche" },
  { to: "/research", label: ["Volatility-managed (Moreira-Muir)", "Volatility-managed (Moreira-Muir)"], icon: Microscope },
  { to: "/theory", label: ["Théorie appliquée", "Applied theory"], icon: GraduationCap },
  { section: ["Référence", "Reference"], group: "reference" },
  { to: "/about", label: ["Présentation", "About"], icon: Info },
  { to: "/documentation", label: ["Documentation", "Documentation"], icon: BookOpen },
] as const;

/** Navigation group of the current route (drives per-section colour in some designs). */
function routeGroup(pathname: string): string {
  let group = "";
  let best = { group: "marches", len: 0 };
  for (const item of NAV) {
    if ("section" in item) group = item.group;
    else if ((item.to === "/" ? pathname === "/" : pathname.startsWith(item.to)) && item.to.length > best.len) {
      best = { group, len: item.to.length };
    }
  }
  return best.group;
}

export function Layout({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  return (
    <div className="shell">
      <Sidebar />
      <TopBar />
      <main className="main" data-group={routeGroup(pathname)}>{children}</main>
      <DesignMenu />
    </div>
  );
}

function Sidebar() {
  const { data: status } = useStatus();
  const { togglePicker } = useTheme();
  // easter egg: three quick clicks on the logo reveal (or hide) the design picker
  const clicks = useRef<number[]>([]);
  const onLogo = () => {
    const now = Date.now();
    clicks.current = [...clicks.current.filter((t) => now - t < 900), now];
    if (clicks.current.length >= 3) {
      clicks.current = [];
      togglePicker();
    }
  };
  let group = "";
  return (
    <nav className="sidebar" aria-label="Navigation principale">
      <div className="brand">
        <div className="brand-mark" onClick={onLogo}><LineChart size={17} /></div>
        <div className="brand-text">
          <div className="brand-name">ARGUS</div>
          <div className="brand-sub">{tr("Plateforme quant de pricing", "Quant Pricing Platform")}</div>
        </div>
      </div>
      {NAV.map((item, i) => {
        if ("section" in item) {
          group = item.group;
          return <div key={i} className="nav-section" data-group={item.group}>{pick(item.section)}</div>;
        }
        return (
          <NavLink key={item.to} to={item.to} end={item.to === "/"} title={pick(item.label)} data-group={group}
            className={({ isActive }) => `nav-link${isActive ? " active" : ""}`}>
            <item.icon size={17} />
            <span className="label">{pick(item.label)}</span>
          </NavLink>
        );
      })}
      <div className="sidebar-footer">
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Clock size={12} /> {tr("Données", "Data")} {relativeTime(status?.last_refresh)}
        </span>
        <span>{tr("Sentiment :", "Sentiment:")} {status?.sentiment_model ?? "—"}</span>
        {STATIC_MODE ? (
          <>
            <span>{tr("Version en ligne : le moteur tourne dans votre navigateur", "Online version: the engine runs in your browser")}</span>
            <a href="https://github.com/Camille-Auvity/argus" target="_blank" rel="noreferrer">{tr("Code source sur GitHub ↗", "Source code on GitHub ↗")}</a>
          </>
        ) : (
          <a href="/docs" target="_blank" rel="noreferrer">{tr("Documentation de l'API ↗", "API documentation ↗")}</a>
        )}
      </div>
    </nav>
  );
}

function TopBar() {
  const { ticker, setTicker, snapshot } = useTicker();
  const { data: tickers } = useTickers();
  const { data: status } = useStatus();
  const { mode, toggle, design } = useTheme();
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
        <select value={ticker} onChange={(e) => setTicker(e.target.value)} aria-label={tr("Sous-jacent", "Underlying")}>
          {!tickers && <option value={ticker}>{ticker}</option>}
          {[[tr("États-Unis", "United States"), us], ["Europe", eu]].map(([label, list]) => (
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
              {name} {open ? tr("ouvert", "open") : tr("fermé", "closed")}
            </span>
          );
        })}
      {STATIC_MODE ? (
        <span className="market-chip" title={tr("Les données sont mises à jour automatiquement par GitHub Actions", "Data are refreshed automatically by GitHub Actions")}>
          <Clock size={13} /> {tr("Données", "Data")} {relativeTime(status?.last_refresh)}
        </span>
      ) : (
        <button className="btn" onClick={() => refresh.mutate()} disabled={refresh.isPending}
          title={tr(`Télécharger maintenant les données de ${ticker}`, `Download ${ticker} data now`)}>
          <RefreshCw size={14} className={refresh.isPending ? "spin" : ""} />
          <span className="label">{refresh.isPending ? tr("Mise à jour…", "Updating…") : tr("Actualiser", "Refresh")}</span>
        </button>
      )}
      {design === "classic" && (
        <button className="btn icon ghost" onClick={toggle} aria-label={tr("Changer de thème", "Switch theme")}
          title={mode === "dark" ? tr("Thème clair", "Light theme") : tr("Thème sombre", "Dark theme")}>
          {mode === "dark" ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      )}
    </header>
  );
}

/** Swatches of each design (ground, ink, accent) shown in the secret menu. */
const SWATCHES: Record<Design, [string, string, string]> = {
  classic: ["#0d0d0d", "#ffffff", "#3987e5"],
  eyes: ["#0e3b43", "#e8efec", "#c99a2e"],
  metro: ["#0f1a3a", "#f4f1e8", "#e5484d"],
  billets: ["#f1f3f5", "#2f5da8", "#d9812b"],
  paper: ["#fcfcfa", "#16181d", "#7a1f2b"],
};

/** The easter-egg design menu: opens next to the logo, closes on pick, Escape or outside click. */
function DesignMenu() {
  const { design, setDesign, pickerOpen, closePicker } = useTheme();
  const { lang, setLang } = useLang();
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!pickerOpen) return;
    ref.current?.querySelector<HTMLButtonElement>("button[aria-checked='true']")?.focus();
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node) && !(e.target as HTMLElement).closest(".brand-mark")) closePicker();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [pickerOpen, closePicker]);

  if (!pickerOpen) return null;

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape") closePicker();
    else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
    }
  };

  return (
    <div ref={ref} className="design-menu" role="menu" aria-label={tr("Design et langue", "Design and language")} onKeyDown={onKey}>
      <div className="menu-label" role="presentation">{tr("Design", "Design")}</div>
      {DESIGNS.map((d) => (
        <button key={d.value} type="button" role="menuitemradio" aria-checked={d.value === design}
          onClick={() => { setDesign(d.value); closePicker(); }}>
          <span className="swatch" aria-hidden="true">
            {SWATCHES[d.value].map((c) => <i key={c} style={{ background: c }} />)}
          </span>
          {pick(d.label)}
        </button>
      ))}
      <div className="menu-label" role="presentation">{tr("Langue", "Language")}</div>
      {LANGS.map((l) => (
        <button key={l.value} type="button" role="menuitemradio" aria-checked={l.value === lang} lang={l.value}
          onClick={() => { closePicker(); setLang(l.value); }}>
          <span className="lang-code" aria-hidden="true">{l.value.toUpperCase()}</span>
          {l.label}
        </button>
      ))}
    </div>
  );
}
