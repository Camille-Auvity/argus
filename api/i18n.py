"""English output of the API.

The engine and the routers write their user-facing text in French. When the interface asks for English (header
`X-Lang: en`), the JSON response is translated on the way out: whole strings first (EXACT), then templates with
variable parts (TEMPLATES, full-match regexes). Keeping the translation at the edge means no cached computation has
to know the language, and the French source stays the single place where the wording lives.
"""

from __future__ import annotations

import json
import re

from starlette.types import ASGIApp, Message, Receive, Scope, Send

EXACT: dict[str, str] = {
    # ---- positions: demo book labels and books
    "Actions US": "US equities", "Couvertures": "Hedges", "Structurés": "Structured", "Taux": "Rates", "Crédit": "Credit",
    "Change": "FX", "Volatilité": "Volatility", "Principal": "Main",
    "Ligne cœur": "Core holding", "Protection indice": "Index protection", "Ligne semi-conducteurs": "Semiconductor holding",
    "Vente de call couvert": "Covered call sale", "Digitale call (paye 100 $)": "Digital call (pays $100)",
    "Asiatique vendu (moyenne mensuelle)": "Short Asian (monthly average)", "Cliquet 2 ans": "2-year cliquet",
    "Phoenix 5 ans": "5-year Phoenix", "Treasury 10 ans": "10-year Treasury",
    "Protection CDS 5 ans TotalEnergies": "5-year CDS protection on TotalEnergies",
    "Vente de protection high yield": "High-yield protection sale",
    "Cap 5 ans USD (protection hausse des taux)": "5-year USD cap (protection against rising rates)",
    "Call EUR/USD 6 mois": "6-month EUR/USD call", "Vente de variance SPY 3 mois": "3-month SPY variance sale",
    "Vente future CAC 40": "Short CAC 40 future", "Émetteur": "Issuer", "Luxe": "Luxury", "OAT 5 ans": "5-year OAT",
    "Put américain": "American put", "Put down-and-in vendu": "Short down-and-in put",
    "surface ATM": "ATM surface", "vol réalisée 1 an": "1-year realised vol",
    # ---- models and methods
    "Black-Scholes (vol ATM)": "Black-Scholes (ATM vol)", "Volatilité locale": "Local volatility",
    "BS formule fermée (BGK)": "BS closed form (BGK)", "Black-Scholes (vol du strike)": "Black-Scholes (strike vol)",
    "BS + pente du smile": "BS + smile slope", "Heston (formule de Lewis)": "Heston (Lewis formula)",
    "Monte Carlo (échantillonnage préférentiel)": "Monte Carlo (importance sampling)",
    "Sans bornes globales (formule fermée)": "No global bounds (closed form)",
    "Réplication sur le smile (SVI)": "Replication on the smile (SVI)", "sans modèle : seul le smile du jour": "model-free: today's smile only",
    "vol constante : swap de vol = swap de variance": "constant vol: vol swap = variance swap",
    "Heston (formule fermée)": "Heston (closed form)", "E[∫v dt]/T ; swap de vol par Monte Carlo": "E[∫v dt]/T; vol swap by Monte Carlo",
    "Heston (MC, rendements quotidiens)": "Heston (MC, daily returns)", "variance réalisée échantillonnée": "sampled realised variance",
    "Volatilité locale (MC)": "Local volatility (MC)", "doit retrouver la réplication": "should recover the replication",
    "Arbre 2000 pas": "2,000-step tree",
    "vol implicite ATM 1 an (surface SVI)": "1-year ATM implied vol (SVI surface)", "volatilité réalisée 1 an": "1-year realised volatility",
    "h (spot)": "h (spot)", "h (vol)": "h (vol)", "dt (années)": "dt (years)", "h (taux, shift parallèle)": "h (rate, parallel shift)",
    # ---- research
    "Marché (Mkt-RF)": "Market (Mkt-RF)", "Taille (SMB)": "Size (SMB)", "Valeur (HML)": "Value (HML)",
    "Rentabilité (RMW)": "Profitability (RMW)", "Investissement (CMA)": "Investment (CMA)",
    "Krach de 1929": "1929 crash", "Krach de 1987": "1987 crash", "Bulle internet": "Dot-com bubble",
    "Crise financière": "Financial crisis", "Krach du momentum 2009": "2009 momentum crash",
    # ---- allocation backtest
    "équipondéré, aucune estimation": "equal weights, no estimation",
    "Moyenne-variance (moyennes empiriques, shorts)": "Mean-variance (sample means, shorts)",
    "Moyenne-variance long-only (shrinkage)": "Mean-variance long-only (shrinkage)",
    "James-Stein + Ledoit-Wolf, poids plafonnés": "James-Stein + Ledoit-Wolf, capped weights",
    "Moyenne-variance avec coûts": "Mean-variance with costs",
    # ---- explain: step labels, formulas and notes
    "Taux zéro à l'échéance": "Zero rate to expiry", "lu sur la courbe, composition continue": "read off the curve, continuous compounding",
    "fonction de répartition normale": "normal cumulative distribution", "= delta / e^{−qT}": "= delta / e^{−qT}",
    "probabilité risque-neutre de finir dans la monnaie": "risk-neutral probability of ending in the money",
    "Terme sous-jacent": "Underlying term", "Terme strike": "Strike term", "Prix": "Price",
    "terme sous-jacent − terme strike": "underlying term − strike term",
    "Pas de temps": "Time step", "Facteur de hausse": "Up factor", "Facteur de baisse": "Down factor",
    "Actualisation sur un pas": "One-step discount", "f : taux forward de la courbe sur le pas": "f: forward rate of the curve over the step",
    "Probabilité risque-neutre": "Risk-neutral probability",
    "fait croître le sous-jacent au taux sans risque en espérance": "makes the underlying grow at the risk-free rate in expectation",
    "Valeur d'un nœud": "Value of a node", "induction à rebours depuis les payoffs à l'échéance": "backward induction from the payoffs at expiry",
    "Trajectoires simulées": "Simulated paths", "N (paires antithétiques Z, −Z)": "N (antithetic pairs Z, −Z)",
    "Spot final simulé": "Simulated final spot", "Proportion dans la monnaie": "Share in the money",
    "Payoff moyen": "Mean payoff", "moyenne de max(φ(S_T − K), 0)": "mean of max(φ(S_T − K), 0)",
    "P(0,T) × payoff moyen": "P(0,T) × mean payoff", "Erreur standard": "Standard error",
    "écart-type des paires / √(N/2)": "standard deviation of the pairs / √(N/2)",
    "Intervalle de confiance à 95 %": "95% confidence interval", "prix ± 1,96 × erreur standard": "price ± 1.96 × standard error",
    "Dates d'exercice": "Exercise dates", "M dates équidistantes": "M equally spaced dates", "Trajectoires": "Paths",
    "Régression à chaque date": "Regression at each date",
    "E[cash-flow futur | S] ≈ β₀ + β₁x + β₂x² + β₃x³,  x = S/K": "E[future cash flow | S] ≈ β₀ + β₁x + β₂x² + β₃x³,  x = S/K",
    "dates où l'exercice est optimal pour au moins une trajectoire": "dates where exercise is optimal for at least one path",
    "Règle d'exercice": "Exercise rule", "exercer si payoff(S) > continuation estimée": "exercise if payoff(S) > estimated continuation",
    "Prix LSM": "LSM price", "moyenne des cash-flows actualisés de la stratégie optimale": "mean of the discounted cash flows of the optimal strategy",
    "σ / √N (paires antithétiques)": "σ / √N (antithetic pairs)", "Prix européen (Black-Scholes)": "European price (Black-Scholes)",
    "sans droit d'exercice anticipé": "without the early-exercise right", "Prime d'exercice anticipé": "Early-exercise premium",
    "LSM − européen": "LSM − European",
    # ---- errors
    "portefeuille vide": "empty portfolio", "ticker requis": "ticker required", "position introuvable": "position not found",
    "seule une position CDS a une courbe de spreads": "only a CDS position has a spread curve",
    "un spread positif par maturité": "one positive spread per maturity", "un spread par maturité": "one spread per maturity",
    "pas d'historique VIX / SPY en base — lancez le rafraîchissement des taux": "no VIX / SPY history stored — run the rates refresh",
    "aucune chaîne SPY en base": "no SPY option chain stored", "pas de courbe USD": "no USD curve",
    "Yahoo Finance ne diffuse pas de chaînes d'options pour ce marché": "Yahoo Finance does not publish option chains for this market",
    "aucune chaîne d'options en base": "no option chain stored",
    "pas de cours EUR/USD en base — lancez le rafraîchissement des taux": "no EUR/USD price stored — run the rates refresh",
    "strike trop éloigné : le smile Vanna-Volga n'y est pas défini": "strike too far: the Vanna-Volga smile is not defined there",
    "facteurs Fama-French absents de la base : lancez le rafraîchissement des taux": "Fama-French factors missing from the database: run the rates refresh",
    "historique SPY / VIX insuffisant — lancez le rafraîchissement": "not enough SPY / VIX history — run the refresh",
    "horizon 5-63 jours, moneyness 0,8-1,2": "horizon 5-63 days, moneyness 0.8-1.2",
    "theta dans [-3, 3], T dans [0,1 ; 5]": "theta in [-3, 3], T in [0.1, 5]",
    "horizon 7-730 jours, μ dans [-100 %, 100 %]": "horizon 7-730 days, μ in [-100%, 100%]",
    "série trop courte pour estimer le processus": "series too short to estimate the process",
    "historique des taux courts indisponible (lancer scripts/refresh.py --jobs rates --force)":
        "short-rate history unavailable (run scripts/refresh.py --jobs rates --force)",
    "données de Shiller indisponibles (lancer scripts/refresh.py --jobs rates --force)":
        "Shiller data unavailable (run scripts/refresh.py --jobs rates --force)",
    "aucune news notée pour ce titre": "no scored news for this ticker",
    "paramètres hors bornes : 0 ≤ ρ ≤ 0,999, −0,99 ≤ corrélation ≤ 0,99, 20 ≤ n ≤ 2000":
        "parameters out of range: 0 ≤ ρ ≤ 0.999, −0.99 ≤ correlation ≤ 0.99, 20 ≤ n ≤ 2000",
}

_FREQ = {"annuel": "annual", "semestriel": "semi-annual", "trimestriel": "quarterly", "mensuel": "monthly"}
_SIDE = {"achat": "buy", "vente": "sell"}


def _pct(s: str) -> str:
    """French number formatting inside a template ('2.00 %') to English ('2.00%')."""
    return s.replace(" %", "%")


# full-match templates: (regex, function of the match returning the English text)
TEMPLATES: list[tuple[re.Pattern, callable]] = [
    (re.compile(r"Action (\S+)"), lambda m: f"Equity {m[1]}"),
    (re.compile(r"début possible : (.+)"), lambda m: f"possible start: {m[1]}"),
    (re.compile(r"titre possible : (.+)"), lambda m: f"possible ticker: {m[1]}"),
    (re.compile(r"demi-vie possible : (.+)"), lambda m: f"possible half-life: {m[1]}"),
    (re.compile(r"(Call|Put) (européen|américain) (\S+) K=(\S+) éch\. (\S+)"),
     lambda m: f"{'European' if m[2] == 'européen' else 'American'} {m[1].lower()} {m[3]} K={m[4]} exp. {m[5]}"),
    (re.compile(r"(Call|Put) (\S+-and-\S+) (\S+) K=(\S+) H=(\S+) éch\. (\S+)"),
     lambda m: f"{m[1]} {m[2]} {m[3]} K={m[4]} H={m[5]} exp. {m[6]}"),
    (re.compile(r"Autocall (\S+) (\S+) ans, coupon (.+) / période, protection (.+)"),
     lambda m: f"Autocall {m[1]} {m[2]} years, coupon {_pct(m[3])} / period, protection {_pct(m[4])}"),
    (re.compile(r"Obligation (\S+) (.+) éch\. (\S+)"), lambda m: f"{m[1]} bond {_pct(m[2])} exp. {m[3]}"),
    (re.compile(r"Future (\S+) éch\. (\S+) (\(.+\))"), lambda m: f"Future {m[1]} exp. {m[2]} {m[3]}"),
    (re.compile(r"(Cap|Floor) (\S+) (.+?) éch\. (\S+) \((\w+), vol (.+)\)"),
     lambda m: f"{m[1]} {m[2]} {_pct(m[3])} exp. {m[4]} ({_FREQ.get(m[5], m[5])}, vol "
               f"{_pct(m[6]).replace(' bp normale', ' bp normal').replace(' log-normale', ' lognormal')})"),
    (re.compile(r"Swap de variance (\S+) \((achat|vente)\), strike (.+), éch\. (\S+)"),
     lambda m: f"Variance swap {m[1]} ({_SIDE[m[2]]}), strike {_pct(m[3])}, exp. {m[4]}"),
    (re.compile(r"((?:Call|Put) EUR / (?:put|call) USD) K=(\S+) éch\. (\S+)"), lambda m: f"{m[1]} K={m[2]} exp. {m[3]}"),
    (re.compile(r"CDS (.*) (achat|vente) de protection, coupon (\S+) bp, éch\. (\S+)"),
     lambda m: f"CDS {m[1]} protection {'purchase' if m[2] == 'achat' else 'sale'}, coupon {m[3]} bp, exp. {m[4]}"),
    (re.compile(r"Digitale (cash|asset) (call|put) (\S+) K=(\S+) éch\. (\S+)"),
     lambda m: f"Digital {m[1]} {m[2]} {m[3]} K={m[4]} exp. {m[5]}"),
    (re.compile(r"Asiatique (géométrique|arithmétique) (call|put) (\S+) K=(\S+), (\d+) fixings, éch\. (\S+)"),
     lambda m: f"{'Geometric' if m[1] == 'géométrique' else 'Arithmetic'} Asian {m[2]} {m[3]} K={m[4]}, {m[5]} fixings, exp. {m[6]}"),
    (re.compile(r"Cliquet (\S+) (\S+) ans \((.*)\)"),
     lambda m: f"Cliquet {m[1]} {m[2]} years ({_pct(m[3]).replace('floor local', 'local floor').replace('cap local', 'local cap').replace('floor global', 'global floor').replace('sans bornes', 'no bounds')})"),
    (re.compile(r"Crédit (.+)"), lambda m: f"Credit {m[1]}"),
    (re.compile(r"Taux (\S+)"), lambda m: f"Rates {m[1]}"),
    # allocation strategies
    (re.compile(r"covariance Ledoit-Wolf, poids ≤ (.+)"), lambda m: f"Ledoit-Wolf covariance, weights ≤ {m[1]}"),
    (re.compile(r"γ = (\S+), short ≤ (.+), estimateurs empiriques : le cas d'école de l'erreur d'estimation"),
     lambda m: f"γ = {m[1]}, short ≤ {m[2]}, sample estimators: the textbook case of estimation error"),
    (re.compile(r"comme le long-only shrinké, coût (.+) pénalisé dans l'optimisation"),
     lambda m: f"like the shrunk long-only, cost {m[1]} penalised in the optimisation"),
    # explain notes with numbers
    (re.compile(r"N = (\d+) pas affichés"), lambda m: f"N = {m[1]} steps shown"),
    (re.compile(r"V = P·\[p·V_haut \+ \(1−p\)·V_bas\]( puis max\(·, payoff\))?"),
     lambda m: "V = P·[p·V_up + (1−p)·V_down]" + (" then max(·, payoff)" if m[1] else "")),
    (re.compile(r"moyenne des S_T ; forward théorique (\S+)"), lambda m: f"mean of S_T; theoretical forward {m[1]}"),
    (re.compile(r"\[(\S+) ; (\S+)\]"), lambda m: f"[{m[1]}, {m[2]}]"),
    # errors with variable parts
    (re.compile(r"pas de cours en base pour (\S+)"), lambda m: f"no price stored for {m[1]}"),
    (re.compile(r"pas de cours pour (\S+)"), lambda m: f"no price for {m[1]}"),
    (re.compile(r"cours manquants : (.+) — lancez un rafraîchissement"), lambda m: f"missing prices: {m[1]} — run a refresh"),
    (re.compile(r"pas de courbe (\S+) en base — lancez le rafraîchissement des taux"), lambda m: f"no {m[1]} curve stored — run the rates refresh"),
    (re.compile(r"pas de courbe (\S+) en base"), lambda m: f"no {m[1]} curve stored"),
    (re.compile(r"pas assez d'historique pour estimer la volatilité de (\S+)"), lambda m: f"not enough history to estimate the volatility of {m[1]}"),
    (re.compile(r"pas de bilan pour (\S+) : (.+)"), lambda m: f"no balance sheet for {m[1]}: the Merton model applies to companies, not to indices or ETFs"),
    (re.compile(r"conversion (\S+) → (\S+) indisponible"), lambda m: f"{m[1]} → {m[2]} conversion unavailable"),
    (re.compile(r"(.+) n'est pas disponible dans la version en ligne : (.+)"),
     lambda m: f"{m[1]} is not available in the online version: data are refreshed automatically by GitHub Actions"),
]


def translate_text(s: str) -> str:
    if s in EXACT:
        return EXACT[s]
    for rx, fn in TEMPLATES:
        m = rx.fullmatch(s)
        if m:
            return fn(m)
    return s


def translate(obj):
    """Translate every string value of a decoded JSON document (keys are left alone: the interface reads them)."""
    if isinstance(obj, str):
        return translate_text(obj)
    if isinstance(obj, list):
        return [translate(x) for x in obj]
    if isinstance(obj, dict):
        return {k: translate(v) for k, v in obj.items()}
    return obj


def wants_english(scope: Scope) -> bool:
    """Header `X-Lang: en` (server mode) or query parameter `_lang=en` (static build, where the in-browser bridge
    forwards only the path)."""
    for k, v in scope.get("headers") or []:
        if k == b"x-lang":
            return v.strip().lower().startswith(b"en")
    return b"_lang=en" in (scope.get("query_string") or b"")


class TranslateMiddleware:
    """Pure ASGI middleware: buffers JSON responses of English requests and translates them."""

    def __init__(self, app: ASGIApp):
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or not wants_english(scope) or not scope.get("path", "").startswith("/api/"):
            await self.app(scope, receive, send)
            return
        start: dict | None = None
        chunks: list[bytes] = []

        async def capture(message: Message) -> None:
            nonlocal start
            if message["type"] == "http.response.start":
                start = message
                return
            if message["type"] == "http.response.body":
                chunks.append(message.get("body", b""))
                if message.get("more_body"):
                    return
                body = b"".join(chunks)
                headers = list(start["headers"]) if start else []
                is_json = any(k == b"content-type" and b"json" in v for k, v in headers)
                if is_json and body:
                    try:
                        body = json.dumps(translate(json.loads(body)), ensure_ascii=False).encode()
                    except (ValueError, TypeError):
                        pass
                headers = [(k, v) for k, v in headers if k != b"content-length"] + [(b"content-length", str(len(body)).encode())]
                await send({**(start or {"type": "http.response.start", "status": 200}), "headers": headers})
                await send({"type": "http.response.body", "body": body})
                return
            await send(message)

        await self.app(scope, receive, capture)
