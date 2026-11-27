# qplat — Plateforme quant de pricing

Plateforme locale en Python, couvrant les marchés US et européens. Elle price des options vanille et américaines, des obligations, des futures, des options à barrière, des digitales, des asiatiques, des cliquets et des autocalls. Elle affiche prix, grecques, smile de volatilité et courbe de taux dans une application web (FastAPI + React), et y ajoute un sentiment de marché calculé par Claude à partir des news.

## Démarrage

Prérequis : Python 3.11+ et Node.js (`brew install node`).

```bash
pip install -r requirements.txt
```

```bash
cp .env.example .env
```

Renseigner `ANTHROPIC_API_KEY` dans `.env` (nécessaire uniquement pour le scoring de sentiment).

```bash
python scripts/refresh.py --force
```

```bash
python run.py
```

`run.py` installe et construit l'interface web si besoin, puis sert toute la plateforme sur http://localhost:8000. La documentation interactive de l'API est sur http://localhost:8000/docs. Pour développer avec rechargement à chaud (API sur :8000, interface sur :5173) :

```bash
python run.py --dev
```

```bash
python -m pytest
```

## Version en ligne (GitHub Pages)

Le site public fonctionne **sans serveur** : l'application FastAPI et tout le moteur Python tournent dans le navigateur du visiteur grâce à [Pyodide](https://pyodide.org), c'est-à-dire Python compilé en WebAssembly.

| Élément | Rôle |
|---|---|
| `.github/workflows/pages.yml` | Chaque heure en semaine : récupère la base déjà publiée, rafraîchit marchés, taux et news, score le sentiment avec Claude (clé dans le secret `ANTHROPIC_API_KEY`), exporte, construit et déploie le site. |
| `scripts/export_static.py` | Copie allégée de la base (dernier snapshot d'options, 90 jours de news, aucune position personnelle) et archive du code Python, dans `web/public/engine/`. |
| `web/src/engine/` | Web worker qui charge Pyodide, numpy, scipy, pandas et FastAPI, puis sert les appels de l'interface. |
| `api/browser.py` | Passe chaque requête à l'application FastAPI sans réseau ni threads. |

**Différences avec la version locale** :
- les données sont mises à jour par le workflow, et non à la demande ;
- le scoring du sentiment se fait dans le workflow ;
- le portefeuille de chaque visiteur est enregistré dans son propre navigateur.

Le premier chargement télécharge environ 25 Mo, mis en cache ensuite.

Pour tester la version statique en local :

```bash
python scripts/export_static.py
```

```bash
cd web && npm run build:static
```

Le site est alors généré dans `web/dist/`, prévu pour être servi sous `/argus/`.

## Documentation

La documentation technique complète, avec toutes les formules, est dans [docs/METHODOLOGIE.md](docs/METHODOLOGIE.md). Elle couvre les conventions, les courbes et le bootstrap, les obligations et futures, Black-Scholes et ses grecques, l'arbre CRR, Monte Carlo et Longstaff-Schwartz, les barrières (Reiner-Rubinstein, BGK), les autocalls, les digitales, asiatiques et cliquets, le smile, les données et le sentiment. Le même fichier s'affiche dans la plateforme (menu « Documentation »), avec les formules mises en forme. Sa traduction anglaise, [docs/METHODOLOGY.md](docs/METHODOLOGY.md), s'affiche quand le site est en anglais.

**Langues.** Le site est en anglais par défaut ; le français se choisit dans le menu secret (trois clics sur le logo ou taper « argus ») ou avec `?lang=fr`. Les textes de l'interface sont écrits en paires inline `tr("français", "English")` (`web/src/lib/i18n.tsx`) ; les textes renvoyés par l'API restent en français dans le code et sont traduits à la sortie par un middleware (`api/i18n.py`), selon l'en-tête `X-Lang` ou le paramètre `_lang=en` de la version statique.

## Architecture : 4 couches découplées

```
qplat/
├── core/conventions.py   conventions de calendrier / day count / conversions de taux
├── curves/               RateCurve (Flat, Interpolated, Shifted) + bootstrap
├── instruments/          conteneurs de données purs (ne se pricent pas)
├── pricers/              méthodes de pricing, interface commune price + 5 grecques
├── models/               Heston (Lewis, calibration, MC), surface SVI sans arbitrage, volatilité locale de Dupire
├── risk/                 portefeuille : valorisation, grecques agrégées, stress tests, VaR, explication du P&L
├── analytics/            smile de volatilité implicite + explain.py (étapes intermédiaires de chaque méthode)
└── data/                 SQLite, fetchers marché/taux/news, sentiment Claude, jobs de refresh
api/                      backend FastAPI : routes REST /api/*, schémas pydantic, caches
web/                      frontend React + TypeScript (Vite, ECharts, TanStack Query, KaTeX)
docs/                     documentation technique (formules)
run.py                    lanceur (build du frontend + serveur)
scripts/refresh.py        point d'entrée du scheduler (cron)
tests/                    111 tests (moteur, modèles, risques, données, API)
```

1. **Moteur** (`instruments`, `pricers`, `curves`) : numpy/scipy uniquement. Aucune dépendance à l'affichage ni au stockage.
2. **Données** (`qplat/data`) : les fetchers écrivent dans SQLite ; l'API ne fait que lire (sauf les boutons « Actualiser » et « Scorer »).
3. **Interface** : une API FastAPI expose le moteur et la base ; un frontend React l'appelle.
   - **API** (`api/`) : chaque route valide ses entrées avec pydantic. Les résultats de pricing sont mis en cache sur le couple (requête, version de la courbe), et les courbes sur leurs quotes.
   - **Frontend** (`web/`) : TanStack Query met en cache les réponses et les formulaires recalculent automatiquement avec un délai (debounce). Les graphiques ECharts suivent le thème clair ou sombre, avec une palette validée pour le daltonisme.
4. **Orchestration** : `scripts/refresh.py` est lancé par cron. À chaque passage, il ne rafraîchit que les sous-jacents dont le marché est ouvert (US : 9h30-16h New York ; EU : 9h-17h30 Paris). `--force` lève ce filtre.

## Moteur de pricing

**Séparation instrument / pricer.** Un `EuropeanOption` porte le contrat et les paramètres de marché (spot, vol, taux, dividende). Les pricers (`BlackScholesPricer`, `BinomialTreePricer`, `MonteCarloPricer`…) le reçoivent et exposent tous `price`, `delta`, `gamma`, `vega`, `theta`, `rho`, `greeks()`. Le même objet se price donc par trois méthodes sans aucune duplication.

```python
from qplat.instruments import EuropeanOption, AmericanOption
from qplat.pricers import BlackScholesPricer, BinomialTreePricer, MonteCarloPricer

opt = EuropeanOption(spot=42, strike=40, expiry=0.5, rate=0.10, vol=0.20)
for pricer in (BlackScholesPricer(), BinomialTreePricer(), MonteCarloPricer()):
    print(pricer.name, pricer.greeks(opt).scaled())
```

**Grecques.** `BlackScholesPricer` utilise les formules fermées. Tous les pricers numériques héritent de `FiniteDifferencePricer`, qui implémente une seule fois les grecques par bump-and-reprice (différences centrées). Les pricers Monte Carlo réutilisent la même graine à chaque bump (common random numbers), sans quoi les grecques seraient inexploitables.

| Produit | Méthodes |
|---|---|
| Vanille européenne | Black-Scholes-Merton fermé, arbre CRR, Monte Carlo (antithétique) |
| Vanille américaine | arbre CRR avec exercice anticipé, Longstaff-Schwartz (régression polynomiale) |
| Courbe de taux | bootstrap dépôts + par swaps/par bonds, interpolation linéaire sur zéro ou log-linéaire sur DF |
| Obligations | prix plein/pied de coupon, couru, YTM, durations, convexité, DV01 |
| Futures | future action (cost of carry), future obligataire mono-livrable avec facteur de conversion |
| Barrière | Reiner-Rubinstein fermé (+ correction Broadie-Glasserman-Kou en observation discrète), Monte Carlo (pont brownien en continu) |
| Digitale | cash- et asset-or-nothing fermés, Monte Carlo, réplication par call spread, correction de smile |
| Asiatique | géométrique fermée exacte, approximation de Lévy (arithmétique), Monte Carlo avec la géométrique en variable de contrôle |
| Cliquet | floor/cap locaux et globaux : somme de call spreads forward en formule fermée, Monte Carlo avec floor global |
| Autocall Phoenix/Athena | Monte Carlo : coupon mémoire, probas de rappel, proba de perte, durée de vie espérée, coupon au pair |

**Courbe de taux.** Les instruments acceptent `rate=0.04` ou `rate=<RateCurve>`. Black-Scholes utilise le taux zéro à l'échéance. L'arbre et les Monte Carlo utilisent les forwards de la courbe pas à pas. Rho correspond à un shift parallèle de la courbe.

## Modèles de volatilité et gestion des risques

- **Heston** : pricer semi-analytique (formule de Lewis), calibré en environ 0,3 s sur la partie liquide du smile (erreur moyenne de l'ordre d'un point de vol sur SPY), et simulation pour les exotiques.
- **Surface SVI et Dupire** : une tranche SVI par échéance, avec des pénalités de non-arbitrage (papillon et calendrier), une surface implicite interpolée en variance totale, puis la volatilité locale de Gatheral-Dupire et sa simulation.
- **Exotiques comparés** : la même barrière, le même autocall, la même digitale, asiatique et cliquet pricés sous Black-Scholes, Heston et volatilité locale, pour mesurer le risque de modèle.
- **Swaps de variance et de volatilité** : strike juste par réplication statique sur la surface SVI (contribution de chaque strike), formule du VIX sur les strikes cotés et VIX recalculé contre le VIX officiel, comparaison Black-Scholes / Heston / volatilité locale, convexité du swap de vol, valeur et vega d'un swap en cours de vie, prime de risque de variance sur 2 ans.
- **Options de taux et de change** : caps et floors (Black-76 ou Bachelier) sur les courbes USD et EUR, avec parité, strike ATM, vol plate implicite, DV01, vega et détail des caplets ; options EUR/USD en Garman-Kohlhagen (deux rhos, deltas spot / forward / ajusté de la prime), smile construit sur ATM, risk reversal et butterfly 25Δ (butterfly de smile à la Clark, interpolation Vanna-Volga, densité risque-neutre).
- **Crédit** : bootstrap d'une courbe d'intensité de défaut à partir de spreads CDS (jambes façon ISDA), spread au pair, upfront, CS01, IR01, sensibilité au recouvrement, jump-to-default ; modèle de Merton calibré sur la capitalisation, la vol action et le bilan (distance au défaut, probabilité de défaut, spread, courbe CDS implicite, vol implicite d'un CDS de marché).
- **Théorie appliquée** (cours de finance en temps continu) : réplication sur l'arbre binomial (Δ, B et π à chaque nœud, autofinancement, scénario du market maker, exemple exact du cours) ; couverture dynamique en delta (erreur en 1/√N, indépendance du drift, gamma contre theta, vol réalisée vs implicite) et backtest d'un call SPY vendu au VIX couvert chaque jour ; calcul stochastique vérifié numériquement (variations totale et quadratique, sommes d'Itô, martingales) ; Girsanov et échantillonnage préférentiel, disponible comme option des pricers Monte Carlo ; loi de S_T sous la probabilité réelle P et sous la probabilité risque-neutre Q sur un vrai titre (μ par CAPM ou historique, densité risque-neutre du smile par Breeden-Litzenberger, mode, médiane, moyenne, éventail de quantiles, noyau de prix) ; taux court d'Ornstein-Uhlenbeck estimé par régression AR(1) sur les taux 3 mois depuis 1990 (USD) et 2004 (EUR), biais de petit échantillon de Kendall montré par Monte Carlo, courbe de Vasicek sous P et sous Q comparée à la courbe du marché (prime de terme).
- **Recherche — portefeuilles volatility-managed** : réplication de Moreira et Muir (2017) sur les facteurs Fama-French quotidiens depuis 1926 (alpha, appraisal ratio, Newey-West, quintiles de volatilité, décennies, crises), versions temps réel, levier plafonné et coûts.
- **Allocation** : moyenne-variance sous contraintes sur l'univers de la plateforme (rendements en euros), shrinkage Ledoit-Wolf et James-Stein, vente à découvert bornée, LASSO / elastic-net, coûts de transaction, frontières efficientes, contributions au risque, chemin de régularisation, backtest walk-forward contre 1/N.
- **Portefeuille** : book multi-actifs en euros (actions, options, barrières, digitales, asiatiques, cliquets, autocalls, obligations, futures, CDS, caps et floors, options EUR/USD, swaps de variance ; fixings passés lus dans l'historique) avec :
  - grecques agrégées ;
  - stress tests actions × vol, taux et spreads de crédit, en revalorisation complète ;
  - CS01 et jump-to-default des CDS ;
  - VaR et ES historiques (delta-gamma) et VaR paramétrique ;
  - explication du P&L du jour.

  Un book de démonstration se charge en un clic.

## Page « Méthodes de pricing »

Elle ouvre la boîte noire de chaque méthode. Les chiffres viennent des mêmes pricers que les prix affichés partout ailleurs : `BinomialTreePricer.lattice()`, `MonteCarloPricer.lsm_diagnostics()` et `FiniteDifferencePricer.greek_breakdown()` exposent leurs étapes intermédiaires au lieu de les recoder à côté.

| Onglet | Ce qui est montré |
|---|---|
| Black-Scholes | calcul de d₁, d₂, N(d₁), N(d₂) et des deux termes de la formule ; densité risque-neutre de S_T avec la zone dans la monnaie |
| Arbre binomial | arbre complet nœud par nœud (spot, valeur, nœuds d'exercice), u/d/p, convergence avec N, frontière d'exercice |
| Monte Carlo | trajectoires, distribution de S_T, convergence avec intervalle de confiance à 95 %, gain des variables antithétiques |
| Longstaff-Schwartz | régression à une date choisie (nuage de points, continuation estimée, valeur d'exercice), frontière LSM comparée à celle de l'arbre |
| Grecques | repricings bumpés derrière chaque différence finie, comparés à la formule fermée |

## Conventions (fixées une fois pour toutes)

- **Temps** : fractions d'année ACT/365F depuis la date de valorisation, partout dans le moteur.
- **Taux internes** : composition continue sur cet axe. Les conventions de marché (ACT/360, semestriel, 30/360) sont converties à la frontière, à la construction des quotes ou des instruments, jamais dans un pricer (`qplat/core/conventions.py`).
- **Unités des grecques** : dérivées brutes (vega et rho pour 1.00, theta par an). `Greeks.scaled()` donne les unités desk : vega/rho pour 1 %, theta par jour.

## Validation (tests)

- Black-Scholes : exemple de Hull (4,76 / 0,81), parité call-put, grecques fermées comparées aux différences finies.
- Convergence de l'arbre et du Monte Carlo vers Black-Scholes, y compris avec une courbe non plate.
- Put américain Longstaff-Schwartz (2001) : S=36, K=40 → 4,48 par l'arbre et par LSM.
- Barrières : les 24 valeurs de la table de Haug retrouvées à 1e-4, parité in/out, MC contre formule fermée.
- Digitales, asiatiques, cliquets : valeurs de Haug, parités, limite de Kemna-Vorst, variable de contrôle, formule fermée du cliquet contre Monte Carlo, delta nul du cliquet.
- Bootstrap : chaque quote est repricée à 1e-10, une obligation au pair price à 100.
- Autocall : cas dégénérés (zéro-coupon, forward prépayé, rappel certain), signes des grecques.
- Données : aller-retour SQLite, idempotence des news, pipeline de sentiment avec un client Claude simulé.

## Données

| Donnée | Source | Table |
|---|---|---|
| Spot (2 ans de clôtures + dernier cours), secteur, dividend yield | yfinance | `spot_prices`, `tickers` |
| Chaînes d'options (8 échéances) | yfinance | `option_quotes` |
| Par yields Treasury 1M → 30Y (USD) | CSV quotidien du Trésor américain, repli FRED puis yfinance | `rate_quotes` (`quote_type=par`, bootstrappés) |
| Taux 3 mois depuis 1990 (USD) et 2004 (EUR) | Trésor américain, BCE (une fois par semaine) | `short_rates` |
| Courbe zéro souverains AAA zone euro 3M → 30Y (EUR) | API de données BCE (sans clé) | `rate_quotes` (`quote_type=zero`, utilisés directement) |
| News | Yahoo Finance RSS, édition FR pour les titres européens (+ Alpha Vantage si clé) | `news` |
| Sentiment | Claude (`claude-opus-5-5`, effort `low`, sortie JSON contrainte) | `sentiment` |

Sous-jacents par défaut : SPY, QQQ, AAPL, MSFT, NVDA (US) et Euro Stoxx 50, CAC 40, LVMH, TotalEnergies, Airbus, Sanofi, ASML, SAP (EU). La liste se modifie via `QPLAT_TICKERS` ; le marché est déduit du suffixe Yahoo (`.PA`, `.DE`, `.AS`…). Chaque sous-jacent est pricé par défaut avec la courbe de sa devise.

Le smile n'utilise pas l'IV du fournisseur. Il est recalculé par le solveur interne (Brent) à partir des mids bid/ask OTM, avec le taux zéro de la courbe bootstrappée.

## Rafraîchissement automatique (cron)

Entrée installée dans la crontab (heure de Paris, toutes les 15 min en semaine de 8h à 22h45) :

```
*/15 8-22 * * 1-5 "/Users/camilleauvity/Desktop/Projet Quant/scripts/cron_refresh.sh"
```

`scripts/cron_refresh.sh` appelle `scripts/refresh.py` et écrit dans `logs/refresh.log`. Chaque job est aussi journalisé dans la table `refresh_log`, dont la date du dernier passage s'affiche dans la barre latérale de la plateforme. Le scoring de sentiment traite au plus 100 news par passage.

**Rétention des données** (appliquée automatiquement après chaque rafraîchissement des options) :
- chaînes d'options : tous les snapshots des 7 derniers jours, puis le dernier snapshot de chaque jour par sous-jacent ;
- journal des tâches : 90 jours.

Pour l'appliquer à la main et récupérer l'espace disque :

```bash
python scripts/maintenance.py --vacuum
```

## Simplifications assumées (pistes d'évolution)

- Volatilité plate par pricer : pas encore de surface de vol locale/stochastique calibrée sur le smile.
- Yahoo ne diffuse pas d'options européennes : le smile n'est disponible que pour les sous-jacents US.
- Pas de calendrier de jours fériés (ni NYSE ni Euronext) ; échéancier obligataire régulier calculé à rebours depuis la maturité.
- Future obligataire sans option de livraison (CTD) ni ajustement de convexité futures/forwards.
- Pas d'hébergement en ligne : la plateforme est conçue pour tourner en local.
