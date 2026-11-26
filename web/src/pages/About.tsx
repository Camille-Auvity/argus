import { Link } from "react-router-dom";
import { ReplicatedResults } from "../components/ReplicatedResults";
import { STATIC_MODE } from "../engine/bridge";
import { tr } from "../lib/i18n";

/** About Argus: what it is, what it covers, how it runs, why the numbers can be trusted. Facts only. */

type Pair = [string, string];
const t = (p: Pair) => tr(p[0], p[1]);

const AREAS: { title: Pair; text: Pair; links: { to: string; label: Pair }[] }[] = [
  {
    title: ["Pricing", "Pricing"],
    text: ["Options vanille et américaines (Black-Scholes, arbre binomial, Monte Carlo, Longstaff-Schwartz), barrières, digitales, asiatiques, cliquets, autocalls, avec les grecques partout.",
      "Vanilla and American options (Black-Scholes, binomial tree, Monte Carlo, Longstaff-Schwartz), barriers, digitals, Asians, cliquets, autocalls, with Greeks everywhere."],
    links: [{ to: "/options", label: ["Options vanille", "Vanilla options"] }, { to: "/methods", label: ["Méthodes", "Methods"] },
      { to: "/exotics", label: ["Exotiques", "Exotics"] }, { to: "/structured", label: ["Structurés", "Structured"] }],
  },
  {
    title: ["Volatilité", "Volatility"],
    text: ["Smile implicite calculé sur les chaînes d'options, surfaces SVI, vol locale de Dupire, Heston calibré, swaps de variance et VIX recalculé.",
      "Implied smile computed from option chains, SVI surfaces, Dupire local vol, calibrated Heston, variance swaps and a recomputed VIX."],
    links: [{ to: "/volatility", label: ["Vol implicite", "Implied vol"] }, { to: "/models", label: ["Modèles", "Models"] },
      { to: "/variance", label: ["Variance", "Variance"] }],
  },
  {
    title: ["Taux, change et crédit", "Rates, FX and credit"],
    text: ["Courbes zéro-coupon USD et EUR, obligations et futures, caps et floors (Black-76, Bachelier), options de change avec smile Vanna-Volga, CDS et modèle de Merton.",
      "USD and EUR zero-coupon curves, bonds and futures, caps and floors (Black-76, Bachelier), FX options with a Vanna-Volga smile, CDS and the Merton model."],
    links: [{ to: "/rates", label: ["Courbes", "Curves"] }, { to: "/rates-fx", label: ["Taux et change", "Rates and FX"] },
      { to: "/credit", label: ["Crédit", "Credit"] }],
  },
  {
    title: ["Portefeuille et allocation", "Portfolio and allocation"],
    text: ["Un livre de positions de tous ces produits : VaR et expected shortfall, stress tests, P&L explain ; allocation moyenne-variance avec estimateurs robustes et backtest contre 1/N.",
      "A book holding all of these products: VaR and expected shortfall, stress tests, P&L explain; mean-variance allocation with robust estimators and a backtest against 1/N."],
    links: [{ to: "/portfolio", label: ["Portefeuille", "Portfolio"] }, { to: "/allocation", label: ["Allocation", "Allocation"] }],
  },
  {
    title: ["Recherche et théorie", "Research and theory"],
    text: ["Portefeuilles à volatilité pilotée (Moreira et Muir) sur les facteurs Fama-French depuis 1926, et des laboratoires de finance en temps continu : réplication, couverture delta, calcul stochastique, Girsanov, probabilités P et Q.",
      "Volatility-managed portfolios (Moreira and Muir) on the Fama-French factors since 1926, and continuous-time finance labs: replication, delta hedging, stochastic calculus, Girsanov, P and Q measures."],
    links: [{ to: "/research", label: ["Recherche", "Research"] }, { to: "/theory", label: ["Théorie appliquée", "Applied theory"] }],
  },
];

const STACK: { name: string; role: Pair }[] = [
  { name: "qplat", role: ["Moteur Python (numpy, scipy, pandas) : instruments, pricers, modèles, risque, données.", "Python engine (numpy, scipy, pandas): instruments, pricers, models, risk, data."] },
  { name: "FastAPI", role: ["API qui expose le moteur à l'interface.", "API exposing the engine to the interface."] },
  { name: "React", role: ["Interface (TypeScript, Vite, ECharts) avec une page d'explication par sujet.", "Interface (TypeScript, Vite, ECharts) with an explainer page per topic."] },
  { name: "Pyodide", role: ["Sur la version en ligne, tout le moteur Python tourne dans le navigateur, en WebAssembly : aucun serveur.", "On the online version, the whole Python engine runs in the browser, in WebAssembly: no server."] },
];

const SOURCES: Pair[] = [
  ["Yahoo Finance : cours, chaînes d'options, fondamentaux, change, VIX", "Yahoo Finance: prices, option chains, fundamentals, FX, VIX"],
  ["FRED et Trésor américain : courbe de taux USD", "FRED and the US Treasury: USD rate curve"],
  ["Banque centrale européenne : courbe de taux EUR", "European Central Bank: EUR rate curve"],
  ["Bibliothèque de Kenneth French : facteurs quotidiens depuis 1926", "Kenneth French data library: daily factors since 1926"],
  ["Claude (Anthropic) : score de sentiment des news", "Claude (Anthropic): news sentiment score"],
];

export default function About() {
  return (
    <div className="about">
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Présentation d'Argus", "About Argus")}</h1>
          <div className="page-sub">{tr("Une plateforme quant de pricing, de risque et de recherche", "A quant pricing, risk and research platform")}</div>
        </div>
      </div>

      <section className="about-lead">
        <p>
          {tr("Argus price des produits dérivés, de taux et de crédit, mesure le risque d'un portefeuille et reproduit des résultats de recherche publiés, sur des données de marché réelles rafraîchies chaque heure. Chaque modèle est expliqué en français simple, documenté avec ses formules et testé contre une référence publiée.",
            "Argus prices derivatives, rates and credit products, measures the risk of a portfolio and reproduces published research results, on real market data refreshed every hour. Every model is explained in plain words, documented with its formulas and tested against a published reference.")}
        </p>
        <p className="secondary">
          {tr("Argus Panoptes, le géant aux cent yeux de la mythologie grecque, surveillait tout sans jamais dormir : la plateforme garde un œil sur chaque sous-jacent.",
            "Argus Panoptes, the hundred-eyed giant of Greek myth, watched everything and never slept: the platform keeps an eye on every underlying.")}
        </p>
      </section>

      <section className="about-section">
        <h2>{tr("Ce que couvre Argus", "What Argus covers")}</h2>
        <div className="about-areas">
          {AREAS.map((a) => (
            <article key={a.title[1]} className="about-area">
              <h3>{t(a.title)}</h3>
              <p>{t(a.text)}</p>
              <p className="about-links">
                {a.links.map((l, i) => (
                  <span key={l.to}>{i > 0 && " · "}<Link to={l.to}>{t(l.label)}</Link></span>
                ))}
              </p>
            </article>
          ))}
        </div>
      </section>

      <section className="about-section">
        <h2>{tr("Pourquoi faire confiance aux chiffres", "Why the numbers can be trusted")}</h2>
        <p className="about-prose">
          {tr("225 tests automatisés comparent la plateforme à des valeurs publiées : prix de référence, tableaux d'articles, formules fermées. La méthodologie complète, avec toutes les formules, tient en 26 sections.",
            "225 automated tests compare the platform with published values: reference prices, tables from papers, closed-form formulas. The full methodology, with every formula, runs to 26 sections.")}{" "}
          <Link to="/documentation">{tr("Lire la méthodologie →", "Read the methodology →")}</Link>
        </p>
        <ReplicatedResults />
      </section>

      <section className="about-section about-two">
        <div>
          <h2>{tr("Comment ça marche", "How it works")}</h2>
          <dl className="about-stack">
            {STACK.map((s) => (
              <div key={s.name}>
                <dt>{s.name}</dt>
                <dd>{t(s.role)}</dd>
              </div>
            ))}
          </dl>
        </div>
        <div>
          <h2>{tr("Données", "Data")}</h2>
          <ul className="about-sources">
            {SOURCES.map((s) => <li key={s[1]}>{t(s)}</li>)}
          </ul>
          <p className="muted about-note">
            {STATIC_MODE
              ? tr("Version en ligne : un workflow GitHub Actions rafraîchit les données toutes les heures en semaine et republie le site. Le premier chargement télécharge environ 25 Mo, mis en cache ensuite.",
                "Online version: a GitHub Actions workflow refreshes the data every hour on weekdays and republishes the site. The first load downloads about 25 MB, cached afterwards.")
              : tr("Version locale : les données se rafraîchissent à la demande avec le bouton Actualiser.",
                "Local version: data refresh on demand with the Refresh button.")}
          </p>
        </div>
      </section>

      <section className="about-section about-close">
        <p>
          {tr("Un projet personnel, dont le code est public :", "A personal project, with public source code:")}{" "}
          <a href="https://github.com/Camille-Auvity/argus" target="_blank" rel="noreferrer">github.com/Camille-Auvity/argus ↗</a>
        </p>
      </section>
    </div>
  );
}
