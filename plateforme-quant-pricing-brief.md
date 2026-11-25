# Plateforme Quant Pricing — Brief pour Claude Code

Oct 11, 2026 · @Cam

## Objectif et vision

Construire une plateforme quant locale, en Python, qui pricerait des instruments financiers (options vanille puis américaines, puis obligations/futures, puis produits structurés comme une autocall ou une barrière), afficherait ces prix et leurs grecques dans un dashboard interactif, et superposerait une couche de sentiment de marché basée sur l'analyse de news par IA.

Le projet sert deux buts : un objectif CV (démontrer la capacité à construire une plateforme complète — pricing, risk, data — plutôt qu'un script isolé, pour un poste de quant researcher ou quant trader en banque), et un objectif personnel (avoir un outil de suivi de marché et d'aide à la décision utilisable au quotidien).

Philosophie de construction : une seule plateforme qui s'empile en couches successives, pas trois projets séparés. Chaque étape doit rester utilisable seule, mais s'enrichir de la précédente sans réécriture.

## Architecture technique en couches

Quatre couches, strictement découplées :

1. **Moteur de calcul (librairie Python pure)** : classes d'instruments financiers (options, obligations, futures, produits structurés) et classes de pricers (Black-Scholes, arbre binomial, Monte Carlo, etc.). Ne connaît rien de l'affichage ni du stockage. C'est la couche qui a le plus de valeur CV et qui doit être testée unitairement.
2. **Couche de données** : récupère prix de marché, taux, et news à intervalles réguliers (Alpha Vantage, yfinance, API de news) et les stocke plutôt que de tout recalculer à chaque rafraîchissement. Une base SQLite locale suffit pour démarrer en solo — pas besoin de PostgreSQL tout de suite.
3. **Interface / dashboard** : Streamlit est recommandé pour commencer — Python pur, pas de JavaScript, dashboard interactif rapide à produire. Point d'attention : Streamlit recharge tout le script à chaque interaction, donc il faut mettre en cache les appels API et les calculs lourds dès le départ.
4. **Orchestration / rafraîchissement automatique** : un scheduler simple (cron ou GitHub Actions) qui rafraîchit les données à intervalle fixe (par exemple toutes les 15 minutes pendant les heures de marché).

L'hébergement en ligne (pour un accès au-delà du poste local) est explicitement reporté à plus tard — non bloquant pour l'architecture.

## Feuille de route par étapes

Le moteur de pricing est construit avant le dashboard : tant que les besoins en données de chaque produit ne sont pas connus, le schéma de données ne peut pas être bien dessiné. L'ordre ci-dessous est celui à suivre, chaque étape restant fonctionnelle avant de passer à la suivante.

1. **Option vanille européenne** pricée par trois méthodes : Black-Scholes fermé, arbre binomial, Monte Carlo. Calcul des grecques (delta, gamma, vega, theta, rho) par formule fermée pour Black-Scholes, par différences finies pour les deux autres. Valide toute la mécanique de base.
2. **Option américaine**, qui force à gérer l'exercice anticipé via l'arbre binomial ou Longstaff-Schwartz en Monte Carlo.
3. **Courbe de taux** : construction d'une courbe de discount factors par bootstrap, avec interpolation (linéaire sur les taux zéro, ou log-linéaire sur les discount factors), puis pricing d'obligations et de futures à partir de cette courbe. Cette étape est positionnée ici car les produits structurés de l'étape suivante en ont besoin pour l'actualisation.
4. **Produit structuré** (autocall ou option à barrière), qui utilise à la fois le moteur d'options et la courbe de taux.
5. **Dashboard** : affichage en direct des prix, grecques, smile de volatilité implicite, courbes de taux.
6. **Couche sentiment IA** : extraction de news par API, scoring de sentiment par un LLM (par titre, par action, ou par secteur), affiché dans le dashboard en complément des prix.

## Structure des classes du moteur de pricing

Deux familles de classes, séparées :

**Instruments** : une classe abstraite de base (`Option` ou `Instrument`) qui porte uniquement les paramètres de marché et de contrat — spot, strike, maturité, taux sans risque, volatilité, type call/put. Elle ne sait pas se pricer elle-même, elle est un conteneur de données pur.

**Pricers** : une famille de classes séparée (`BlackScholesPricer`, `BinomialTreePricer`, `MonteCarloPricer`) qui reçoivent un objet instrument en entrée et exposent la même interface — une méthode `price`, et des méthodes `delta`, `gamma`, `vega`, `theta`, `rho`. Cette séparation entre l'instrument et la méthode de pricing permet de pricer le même instrument par plusieurs méthodes sans dupliquer aucune donnée.

Pour les grecques : `BlackScholesPricer` code les formules fermées directement ; les pricers numériques (arbre, Monte Carlo) codent une méthode générique de différences finies au niveau d'une classe parente commune, pour éviter de la réécrire plusieurs fois.

Pour la courbe de taux (étape 3 de la feuille de route) : un objet `RateCurve` séparé, que l'instrument ou le pricer interroge au lieu d'avoir un taux constant codé en dur — prépare l'étape obligations/futures sans restructuration.

Points à trancher dès le départ pour éviter une réécriture : convention de calendrier et de comptage des jours pour la maturité (années, jours ouvrés, conventions de taux) — un détail souvent négligé qui cause des écarts de prix difficiles à déboguer plus tard.

## Stack technique recommandée

| Couche | Outil | Raison |
| --- | --- | --- |
| Moteur de calcul | Python pur (numpy, scipy) | Portable, testable, aucune dépendance à l'affichage |
| Stockage | SQLite | Suffisant en solo, zéro configuration serveur |
| Données de marché | Alpha Vantage / yfinance | Prix, taux, options déjà accessibles |
| News / sentiment | API de news + modèle de langage (Anthropic API) | Déjà utilisé sur un projet existant, réutilisable ici |
| Dashboard | Streamlit | Python pur, pas de JavaScript, itération rapide en solo |
| Orchestration | cron ou GitHub Actions | Rafraîchissement automatique sans serveur dédié |

L'hébergement en ligne est une question à traiter plus tard, une fois la plateforme fonctionnelle en local.

## Points d'attention et pièges à éviter

- Ne jamais mélanger instrument et méthode de pricing dans une même classe : la séparation est ce qui permet de pricer un même produit par trois méthodes sans dupliquer de code.
- Mettre en cache les appels API et les calculs lourds dès la première version du dashboard Streamlit, pas après coup — sinon l'interface devient vite inutilisable.
- Fixer tôt les conventions de calendrier et de day count : un écart de prix causé par une mauvaise convention de maturité est difficile à déboguer après coup.
- Stocker les données récupérées (prix, taux, news) plutôt que de tout recalculer à chaque interaction — la base SQLite locale suffit au départ.
- Ne pas construire la base de données avant d'avoir fini le moteur de pricing : les besoins en données ne sont connus qu'une fois les produits à pricer définis.
- Reporter la question de l'hébergement en ligne à une fois la plateforme fonctionnelle en local.
