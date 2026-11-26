import { Check, LineChart, Loader2, TriangleAlert } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { startEngine, STATIC_MODE, subscribeEngine, type EngineState } from "../engine/bridge";
import { tr } from "../lib/i18n";

const STEPS: [string, string][] = [
  ["Chargement de Python (WebAssembly)", "Loading Python (WebAssembly)"],
  ["Bibliothèques scientifiques : numpy, scipy, pandas", "Scientific libraries: numpy, scipy, pandas"],
  ["Serveur d'API (FastAPI)", "API server (FastAPI)"],
  ["Moteur de pricing et données de marché", "Pricing engine and market data"],
  ["Démarrage de l'application", "Starting the application"],
];

/** Static build only: shows the engine boot sequence until Python is ready in the browser. */
export function EngineGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<EngineState | null>(null);

  useEffect(() => {
    if (!STATIC_MODE) return;
    const unsubscribe = subscribeEngine(setState);
    startEngine().catch(() => undefined);
    return unsubscribe;
  }, []);

  if (!STATIC_MODE || state?.status === "ready") return <>{children}</>;

  const done = state?.status === "loading" ? state.progress.done : 0;
  return (
    <div className="boot">
      <div className="boot-card card">
        <div className="brand" style={{ padding: 0, marginBottom: 18 }}>
          <div className="brand-mark"><LineChart size={17} /></div>
          <div>
            <div className="brand-name">ARGUS</div>
            <div className="brand-sub">{tr("Plateforme quant de pricing et de risque", "Quant pricing and risk platform")}</div>
          </div>
        </div>
        {state?.status === "error" ? (
          <div className="error-box" role="alert">
            <TriangleAlert size={14} style={{ verticalAlign: -2, marginRight: 6 }} />
            {tr("Le moteur n'a pas pu démarrer :", "The engine could not start:")} {state.message}
            <div style={{ marginTop: 10 }}><button className="btn" onClick={() => window.location.reload()}>{tr("Réessayer", "Retry")}</button></div>
          </div>
        ) : (
          <>
            <p className="secondary" style={{ marginTop: 0 }}>
              {tr("Le moteur de calcul (Python, numpy, scipy) démarre directement dans votre navigateur : aucun serveur, tous les prix sont calculés sur votre machine.",
                "The computing engine (Python, numpy, scipy) starts right in your browser: no server, every price is computed on your machine.")}
            </p>
            <div className="boot-bar" aria-hidden><span style={{ width: `${(done / STEPS.length) * 100}%` }} /></div>
            <ol className="boot-steps">
              {STEPS.map((s, i) => (
                <li key={s[1]} className={i < done ? "done" : i === done ? "active" : ""}>
                  {i < done ? <Check size={14} /> : i === done ? <Loader2 size={14} className="spin" /> : <span className="dot" />}
                  {tr(s[0], s[1])}
                </li>
              ))}
            </ol>
            <p className="muted" style={{ fontSize: 12, marginBottom: 0 }}>
              {tr("Première visite : environ 25 Mo à télécharger (10 à 30 s). Les visites suivantes utilisent le cache du navigateur.",
                "First visit: about 25 MB to download (10 to 30 s). Later visits use the browser cache.")}
            </p>
          </>
        )}
      </div>
    </div>
  );
}
