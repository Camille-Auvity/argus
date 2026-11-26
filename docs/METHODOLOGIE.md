# Documentation technique de QPLAT

Ce document décrit comment chaque nombre affiché par la plateforme est calculé : conventions, modèles, algorithmes, paramètres numériques et sources de données. Chaque section renvoie au fichier du code qui l'implémente.

---

## 1. Architecture

La plateforme est organisée en quatre couches, chacune ignorant le fonctionnement des autres :

| Couche | Dossier | Rôle |
|---|---|---|
| Moteur de calcul | `qplat/core`, `qplat/curves`, `qplat/instruments`, `qplat/pricers`, `qplat/models`, `qplat/credit`, `qplat/fx`, `qplat/allocation`, `qplat/research`, `qplat/theory`, `qplat/risk`, `qplat/analytics` | Conventions, courbes de taux, instruments, méthodes de pricing. Python pur (numpy, scipy). |
| Données | `qplat/data` | Téléchargement des marchés, bilans, taux et news ; stockage SQLite ; scoring du sentiment par Claude. |
| Interface | `api/` (FastAPI), `web/` (React) | L'API expose le moteur et la base ; l'interface web l'appelle. |
| Orchestration | `scripts/refresh.py`, crontab | Rafraîchissement automatique pendant les heures de marché. |

**Version en ligne.** Sur GitHub Pages, la même application FastAPI s'exécute dans le navigateur du visiteur grâce à Pyodide (Python compilé en WebAssembly), sur une copie allégée de la base republiée chaque heure par GitHub Actions. Tous les calculs décrits dans ce document sont donc faits sur la machine du visiteur, avec le même code.

**Séparation instrument / pricer.** Un instrument (`EuropeanOption`, `BarrierOption`, `Autocallable`, `FixedRateBond`…) est un conteneur de données immuable : il ne sait pas se pricer. Un pricer reçoit l'instrument et expose la même interface : `price`, `delta`, `gamma`, `vega`, `theta`, `rho`, `greeks()`. Le même objet peut ainsi être pricé par plusieurs méthodes sans duplication.

---

## 2. Conventions

*Fichier : `qplat/core/conventions.py`*

### 2.1 Temps

Toutes les durées manipulées par le moteur sont des **fractions d'année ACT/365 Fixed** mesurées depuis la date de valorisation :

$$
\tau(d_1, d_2) = \frac{d_2 - d_1}{365} \quad \text{(en jours calendaires)}
$$

Les autres conventions ne servent qu'à convertir les données de marché à l'entrée :

| Convention | Fraction d'année |
|---|---|
| ACT/365F | $\dfrac{\text{jours}}{365}$ |
| ACT/360 | $\dfrac{\text{jours}}{360}$ |
| 30/360 (US) | $\dfrac{360(Y_2-Y_1) + 30(M_2-M_1) + (D_2-D_1)}{360}$, avec $D_1 \leftarrow \min(D_1,30)$ et $D_2 \leftarrow 30$ si $D_1 = 30$ et $D_2 = 31$ |
| ACT/ACT ISDA | somme, année par année, de $\dfrac{\text{jours dans l'année}}{365 \text{ ou } 366}$ |

### 2.2 Taux

Tous les taux internes sont **composés en continu** sur l'axe ACT/365F. Les conversions utilisées :

$$
r_c = \frac{\ln(1 + R\,\tau)}{\tau} \quad \text{(taux simple } R \text{ sur une période } \tau)
$$

$$
r_c = m \ln\!\left(1 + \frac{R_m}{m}\right) \quad \text{(taux composé } m \text{ fois par an)}
$$

### 2.3 Unités des grecques

Le moteur calcule des dérivées brutes :

| Grecque | Définition | Unité moteur | Unité affichée |
|---|---|---|---|
| Delta $\Delta$ | $\partial V / \partial S$ | — | — |
| Gamma $\Gamma$ | $\partial^2 V / \partial S^2$ | — | — |
| Vega $\nu$ | $\partial V / \partial \sigma$ | pour 1,00 de vol | pour 1 % ($\nu/100$) |
| Theta $\Theta$ | $\partial V / \partial t$ (le temps passe) | par an | par jour ($\Theta/365$) |
| Rho $\rho$ | $\partial V / \partial r$ (shift parallèle de la courbe) | pour 1,00 de taux | pour 1 % ($\rho/100$) |

---

## 3. Courbes de taux

*Fichiers : `qplat/curves/rate_curve.py`, `qplat/curves/bootstrap.py`, `qplat/data/market.py`*

### 3.1 Grandeurs

Une courbe est définie par ses facteurs d'actualisation $P(0,t)$. On en déduit :

$$
z(t) = -\frac{\ln P(0,t)}{t} \qquad \text{(taux zéro-coupon continu)}
$$

$$
f(t_1, t_2) = \frac{1}{t_2 - t_1} \ln\frac{P(0,t_1)}{P(0,t_2)} \qquad \text{(taux forward continu)}
$$

Le **shift parallèle** de $h$ (utilisé pour le rho et la DV01) multiplie chaque facteur d'actualisation :

$$
P^{(h)}(0,t) = P(0,t)\, e^{-h t} \quad \Longleftrightarrow \quad z^{(h)}(t) = z(t) + h
$$

Un taux constant $r$ est traité comme une courbe plate : $P(0,t) = e^{-rt}$.

### 3.2 Interpolation entre les piliers

Les piliers sont des couples $(t_k, P_k)$. Deux méthodes sont disponibles :

- **Linéaire sur les taux zéro** : $z(t)$ est interpolé linéairement entre les piliers, et extrapolé à plat au-delà. Simple, mais les forwards qui en résultent sont en dents de scie (visible sur la page « Courbes »).
- **Log-linéaire sur les facteurs d'actualisation** (méthode par défaut) : $\ln P$ est interpolé linéairement, avec le point d'ancrage $(0, 0)$. Les forwards sont alors **constants par morceaux** :

$$
f(t) = \frac{\ln P_{k} - \ln P_{k+1}}{t_{k+1} - t_k} \quad \text{pour } t \in [t_k, t_{k+1}]
$$

Au-delà du dernier pilier, le dernier forward est prolongé.

### 3.3 Bootstrap

Les quotes sont triées par maturité et résolues une par une : pour chaque quote, on cherche le facteur $P(T_k)$ qui la fait repricer exactement, compte tenu des piliers déjà fixés et de l'interpolation choisie pour les dates intermédiaires. La résolution utilise la méthode de Brent sur $P(T_k) \in [10^{-6}, 2]$ avec une tolérance de $10^{-14}$.

**Dépôt** (taux simple $R$, maturité $T$) :

$$
P(T) = \frac{1}{1 + R \cdot \tau_{acc}}, \qquad \tau_{acc} = T \times \text{base}
$$

avec base $= 365/360$ pour un dépôt monétaire ACT/360.

**Taux de swap ou rendement d'une obligation au pair** (coupon $c$, fréquence $m$, dates $t_1 < \dots < t_n = T$ construites à rebours depuis $T$, $\tau_i = t_i - t_{i-1}$) :

$$
c \sum_{i=1}^{n} \tau_i\, P(t_i) + P(t_n) = 1
$$

C'est la condition pour qu'une obligation de coupon $c$ vaille exactement 100 %.

### 3.4 Courbe USD (Treasury)

Les données sont les *par yields* « constant maturity » de la Réserve fédérale, publiés par FRED : 1M, 3M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y, 20Y, 30Y. Si FRED est indisponible, la plateforme se rabat sur yfinance (^IRX, ^FVX, ^TNX, ^TYX).

- Maturités ≤ 6 mois (bills) : traitées comme des dépôts à taux simple sur ACT/365F (base = 1).
- Maturités ≥ 1 an : obligations au pair à coupon semestriel ($m = 2$).

### 3.5 Courbe EUR (BCE)

La BCE publie la courbe des emprunts d'État notés AAA de la zone euro, ajustée par le modèle de Svensson :

$$
z(t) = \beta_0 + \beta_1 \frac{1 - e^{-t/\tau_1}}{t/\tau_1} + \beta_2 \left(\frac{1 - e^{-t/\tau_1}}{t/\tau_1} - e^{-t/\tau_1}\right) + \beta_3 \left(\frac{1 - e^{-t/\tau_2}}{t/\tau_2} - e^{-t/\tau_2}\right)
$$

La plateforme télécharge directement les taux zéro continus (3M à 30Y) et les utilise comme piliers sans bootstrap : $P(0,t_k) = e^{-z_k t_k}$.

---

## 4. Obligations et futures

*Fichiers : `qplat/instruments/fixed_income.py`, `qplat/pricers/rates.py`*

### 4.1 Obligation à taux fixe

Nominal $N$, coupon annuel $c$, fréquence $m$, maturité $T$. Les dates de coupon sont construites à rebours depuis la maturité, avec un pas de $1/m$ :

$$
CF_i = \frac{N c}{m} \quad (i < n), \qquad CF_n = \frac{N c}{m} + N
$$

**Prix plein (dirty)** actualisé sur la courbe :

$$
P_{dirty} = \sum_{i} CF_i \, P(0, t_i)
$$

**Coupon couru**, avec $t_{next}$ la date du prochain coupon :

$$
AI = N c \left(\frac{1}{m} - t_{next}\right)
$$

**Prix pied de coupon (clean)** : $P_{clean} = P_{dirty} - AI$.

**Rendement actuariel** $y$, composé $m$ fois par an, solution par Brent sur $[-0{,}5\,;\,2]$ de :

$$
\sum_i CF_i \left(1 + \frac{y}{m}\right)^{-m t_i} = P_{dirty}
$$

**Durations et convexité** (avec $PV_i = CF_i (1 + y/m)^{-m t_i}$) :

$$
D_{Mac} = \frac{\sum_i t_i\, PV_i}{P_{dirty}}, \qquad D_{mod} = \frac{D_{Mac}}{1 + y/m}, \qquad C = \frac{\sum_i PV_i\, t_i (t_i + 1/m)}{P_{dirty}\,(1 + y/m)^2}
$$

**DV01**, variation de prix pour une baisse de 1 point de base de toute la courbe (différence centrée) :

$$
DV01 = \frac{P_{dirty}(\text{courbe} - 1\,bp) - P_{dirty}(\text{courbe} + 1\,bp)}{2}
$$

### 4.2 Future sur action ou indice

Avec des taux déterministes, le prix d'un future est égal à celui d'un forward. Par portage (*cost of carry*) :

$$
F = \frac{S\, e^{-qT}}{P(0,T)}
$$

### 4.3 Future obligataire (un seul livrable)

On porte l'obligation jusqu'à la livraison $T_d$ : on l'achète au prix plein, on encaisse les coupons versés avant la livraison, et on livre.

$$
F_{dirty} = \frac{P_{dirty}(0) - \sum_{t_i \le T_d} CF_i\, P(0,t_i)}{P(0,T_d)}, \qquad F = \frac{F_{dirty} - AI(T_d)}{CF}
$$

où $CF$ est le facteur de conversion. Simplifications : un seul titre livrable (pas d'option *cheapest-to-deliver*), pas d'option de calendrier, pas d'ajustement de convexité entre future et forward.

---

## 5. Modèle de Black-Scholes-Merton

*Fichier : `qplat/pricers/black_scholes.py`*

### 5.1 Dynamique

Sous la probabilité risque-neutre $\mathbb{Q}$, le sous-jacent suit un mouvement brownien géométrique dont la dérive est le taux forward de la courbe moins le rendement du dividende :

$$
\frac{dS_t}{S_t} = \big(f(t) - q\big)\,dt + \sigma\, dW_t
$$

Ce qui donne, pour une échéance $T$ :

$$
S_T = \frac{S_0\, e^{-qT}}{P(0,T)} \exp\!\left(-\tfrac{1}{2}\sigma^2 T + \sigma \sqrt{T}\, Z\right), \qquad Z \sim \mathcal{N}(0,1)
$$

$\ln S_T$ est donc gaussien et $\mathbb{E}^{\mathbb{Q}}[S_T]$ est égal au forward. Pour un payoff européen, la courbe n'intervient qu'au travers du taux zéro à l'échéance $r = z(T)$.

### 5.2 Formule de prix

Avec $\varphi = +1$ pour un call et $\varphi = -1$ pour un put :

$$
d_1 = \frac{\ln(S/K) + (r - q + \tfrac{1}{2}\sigma^2)\,T}{\sigma\sqrt{T}}, \qquad d_2 = d_1 - \sigma\sqrt{T}
$$

$$
V = \varphi \left[ S e^{-qT} N(\varphi d_1) - K e^{-rT} N(\varphi d_2) \right]
$$

$N$ est la fonction de répartition de la loi normale centrée réduite et $n$ sa densité. $N(\varphi d_2)$ est la probabilité risque-neutre de finir dans la monnaie.

**Parité call-put** : $C - P = S e^{-qT} - K e^{-rT}$.

### 5.3 Grecques en formule fermée

$$
\Delta = \varphi\, e^{-qT} N(\varphi d_1) \qquad\qquad \Gamma = \frac{e^{-qT}\, n(d_1)}{S \sigma \sqrt{T}}
$$

$$
\nu = S e^{-qT} n(d_1) \sqrt{T} \qquad\qquad \rho = \varphi\, K T e^{-rT} N(\varphi d_2)
$$

$$
\Theta = -\frac{S e^{-qT} n(d_1)\, \sigma}{2\sqrt{T}} - \varphi\, r K e^{-rT} N(\varphi d_2) + \varphi\, q S e^{-qT} N(\varphi d_1)
$$

Le theta suppose que le taux zéro reste constant quand le temps passe.

### 5.4 Volatilité implicite

*Fichier : `qplat/pricers/black_scholes.py` (`implied_volatility`)*

On cherche $\sigma_{imp}$ telle que $V_{BS}(\sigma_{imp}) = V_{marché}$, par la méthode de Brent sur $[10^{-4}\,;\,5]$ avec une tolérance de $10^{-10}$. Le prix doit d'abord respecter les bornes de non-arbitrage, sinon la fonction renvoie NaN :

$$
\max\!\big(\varphi(S e^{-qT} - K e^{-rT}),\, 0\big) < V < \begin{cases} S e^{-qT} & \text{call} \\ K e^{-rT} & \text{put} \end{cases}
$$

---

## 6. Arbre binomial de Cox-Ross-Rubinstein

*Fichier : `qplat/pricers/binomial.py` — défaut : 500 pas*

### 6.1 Construction

On découpe $[0, T]$ en $N$ pas de $\Delta t = T/N$ :

$$
u = e^{\sigma \sqrt{\Delta t}}, \qquad d = \frac{1}{u}, \qquad S_{i,j} = S_0\, u^{\,i - 2j} \quad (j = 0, \dots, i)
$$

Sur chaque pas, le facteur d'actualisation et la probabilité risque-neutre sont tirés de la courbe :

$$
P_i = \frac{P(0, t_{i+1})}{P(0, t_i)}, \qquad p_i = \frac{e^{-q\Delta t}/P_i - d}{u - d}
$$

Ce choix de $p_i$ garantit $\mathbb{E}[S_{i+1} \mid S_i] = S_i\, e^{-q\Delta t}/P_i$, c'est-à-dire une croissance au taux forward. Si $p_i \notin\, ]0,1[$, l'arbre est rejeté pour arbitrage.

### 6.2 Induction à rebours

À l'échéance, $V_{N,j} = \text{payoff}(S_{N,j})$. Puis pour $i = N-1, \dots, 0$ :

$$
C_{i,j} = P_i \left[ p_i\, V_{i+1,j} + (1 - p_i)\, V_{i+1,j+1} \right]
$$

$$
V_{i,j} = \begin{cases} C_{i,j} & \text{exercice européen} \\ \max\!\big(C_{i,j},\, \text{payoff}(S_{i,j})\big) & \text{exercice américain} \end{cases}
$$

Le prix est $V_{0,0}$. Pour une américaine, un nœud est marqué « exercice optimal » quand $\text{payoff}(S_{i,j}) > C_{i,j}$.

### 6.3 Frontière d'exercice et convergence

Pour un put américain, la **frontière d'exercice** à la date $t_i$ est le plus haut spot où l'exercice est optimal (pour un call, le plus bas). On ne garde que les pas pairs, car les nœuds CRR alternent entre deux grilles de prix, ce qui ferait zigzaguer la frontière.

Le prix CRR converge vers Black-Scholes à la vitesse $O(1/N)$, avec une oscillation selon la parité de $N$ (visible sur le graphique de convergence).

Les grecques de l'arbre sont calculées par différences finies (section 9).

---

## 7. Monte Carlo

*Fichiers : `qplat/pricers/paths.py`, `qplat/pricers/monte_carlo.py` — défaut : 100 000 trajectoires, graine 42*

### 7.1 Simulation exacte

Entre deux dates $t_{k-1}$ et $t_k$ (pas $\Delta_k$), la simulation est exacte (pas d'erreur de discrétisation) :

$$
S_{t_k} = S_{t_{k-1}} \exp\!\left( \ln\frac{P(0,t_{k-1})}{P(0,t_k)} - q\Delta_k - \tfrac{1}{2}\sigma^2 \Delta_k + \sigma\sqrt{\Delta_k}\, Z_k \right)
$$

Pour une option européenne, une seule étape (de $0$ à $T$) suffit.

### 7.2 Estimateur et intervalle de confiance

$$
\hat V = P(0,T)\, \frac{1}{M} \sum_{m=1}^{M} \text{payoff}\big(S_T^{(m)}\big)
$$

**Variables antithétiques.** Les tirages sont faits par paires $(Z, -Z)$. L'erreur standard est calculée sur les $M/2$ moyennes de paires $\bar Y_k = \tfrac{1}{2}\big(Y(Z_k) + Y(-Z_k)\big)$ :

$$
SE = \frac{\text{écart-type}(\bar Y)}{\sqrt{M/2}}, \qquad IC_{95\%} = \hat V \pm 1{,}96 \cdot SE
$$

L'erreur décroît en $1/\sqrt{M}$ : diviser l'erreur par deux coûte quatre fois plus de trajectoires.

**Nombres aléatoires communs.** Chaque appel utilise la même graine. Les prix « bumpés » qui servent aux grecques partagent donc les mêmes $Z$, et le bruit s'annule dans la différence.

### 7.3 Échantillonnage préférentiel (Girsanov)

Option `importance` des pricers Monte Carlo (vanilles européennes et exotiques, trajectoires Black-Scholes). Le mouvement brownien est simulé avec une dérive $\theta$ : chaque incrément $\sqrt{\Delta t}\,z$ devient $\sqrt{\Delta t}\,(z + \theta\sqrt{\Delta t})$. Chaque trajectoire est ensuite repondérée par la dérivée de Radon-Nikodym :

$$
\frac{dP}{dQ} = \exp\left(-\theta W_T + \tfrac12 \theta^2 T\right), \qquad \mathbb E_P[\text{payoff}] = \mathbb E_Q\left[\text{payoff} \cdot \frac{dP}{dQ}\right]
$$

Avec `importance="auto"`, $\theta^* = \left(\ln(K/F) + \tfrac12\sigma^2 T\right)/(\sigma T)$ place la médiane de $S_T$ au strike. L'estimateur reste sans biais. Pour une option très hors de la monnaie, la variance est divisée par plusieurs centaines ou milliers : environ 1 600 pour un call à 150 % du spot à 6 mois. Pour une option à la monnaie, il n'y a presque rien à gagner (section 19.5).

### 7.4 Longstaff-Schwartz (exercice américain)

Défaut : 50 dates d'exercice, régression polynomiale de degré 3 sur $x = S/K$.

1. Simuler les trajectoires aux dates $t_1, \dots, t_M$ ; initialiser $CF = \text{payoff}(S_{t_M})$.
2. Pour $k = M-1, \dots, 1$ :
   - actualiser les cash-flows d'un pas : $CF \leftarrow CF \cdot P(0,t_{k+1})/P(0,t_k)$ ;
   - parmi les trajectoires **dans la monnaie** en $t_k$, régresser $CF$ sur $(1, x, x^2, x^3)$ pour obtenir la continuation estimée $\hat C(x)$ ;
   - pour ces trajectoires, si $\text{payoff}(S_{t_k}) > \hat C(x)$, exercer : $CF \leftarrow \text{payoff}(S_{t_k})$.
3. Prix $= P(0, t_1) \cdot \overline{CF}$, ou la valeur d'exercice immédiat si elle est supérieure.

Utiliser les mêmes trajectoires pour la régression et la valorisation crée un léger biais. La frontière d'exercice estimée est approximative, mais le prix reste précis : se tromper de décision près de la frontière, là où exercer et continuer valent presque autant, ne coûte presque rien.

---

## 8. Options à barrière

*Fichier : `qplat/pricers/barrier.py`*

### 8.1 Définitions

Une barrière $H$ active (*in*) ou désactive (*out*) une option vanille de strike $K$ si le sous-jacent la touche (*down* : par le bas, *up* : par le haut). Le **rebate** $R$ est payé au moment de la touche pour une *out*, ou à l'échéance pour une *in* jamais activée.

**Parité in/out** : $V_{in} + V_{out} = V_{vanille}$ (sans rebate).

### 8.2 Formule fermée de Reiner-Rubinstein (observation continue)

Avec $b = r - q$, $\varphi = \pm 1$ (call/put) et $\eta = +1$ (down) ou $-1$ (up) :

$$
\mu = \frac{b - \sigma^2/2}{\sigma^2}, \qquad \lambda = \sqrt{\mu^2 + \frac{2r}{\sigma^2}}
$$

$$
x_1 = \frac{\ln(S/K)}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T, \qquad x_2 = \frac{\ln(S/H)}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T
$$

$$
y_1 = \frac{\ln(H^2/(SK))}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T, \qquad y_2 = \frac{\ln(H/S)}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T, \qquad z = \frac{\ln(H/S)}{\sigma\sqrt T} + \lambda\sigma\sqrt T
$$

Les six briques :

$$
A = \varphi S e^{(b-r)T} N(\varphi x_1) - \varphi K e^{-rT} N(\varphi x_1 - \varphi\sigma\sqrt T)
$$

$$
B = \varphi S e^{(b-r)T} N(\varphi x_2) - \varphi K e^{-rT} N(\varphi x_2 - \varphi\sigma\sqrt T)
$$

$$
C = \varphi S e^{(b-r)T} (H/S)^{2(\mu+1)} N(\eta y_1) - \varphi K e^{-rT} (H/S)^{2\mu} N(\eta y_1 - \eta\sigma\sqrt T)
$$

$$
D = \varphi S e^{(b-r)T} (H/S)^{2(\mu+1)} N(\eta y_2) - \varphi K e^{-rT} (H/S)^{2\mu} N(\eta y_2 - \eta\sigma\sqrt T)
$$

$$
E = R e^{-rT} \left[ N(\eta x_2 - \eta\sigma\sqrt T) - (H/S)^{2\mu} N(\eta y_2 - \eta\sigma\sqrt T) \right]
$$

$$
F = R \left[ (H/S)^{\mu+\lambda} N(\eta z) + (H/S)^{\mu-\lambda} N(\eta z - 2\eta\lambda\sigma\sqrt T) \right]
$$

Combinaisons selon le type :

| Type | $K > H$ | $K < H$ |
|---|---|---|
| Down-and-in call | $C + E$ | $A - B + D + E$ |
| Up-and-in call | $A + E$ | $B - C + D + E$ |
| Down-and-in put | $B - C + D + E$ | $A + E$ |
| Up-and-in put | $A - B + D + E$ | $C + E$ |
| Down-and-out call | $A - C + F$ | $B - D + F$ |
| Up-and-out call | $F$ | $A - B + C - D + F$ |
| Down-and-out put | $A - B + C - D + F$ | $F$ |
| Up-and-out put | $B - D + F$ | $A - C + F$ |

Si la barrière est déjà franchie, une *in* vaut la vanille de Black-Scholes et une *out* vaut le rebate. Avec une courbe, $r = z(T)$.

### 8.3 Observation discrète : correction de Broadie-Glasserman-Kou

Une barrière observée $m$ fois par an est approchée par une barrière continue décalée en s'éloignant du spot :

$$
H' = H\, e^{\pm \beta \sigma \sqrt{\Delta t}}, \qquad \Delta t = \frac{1}{m}, \qquad \beta = -\frac{\zeta(1/2)}{\sqrt{2\pi}} \approx 0{,}5826
$$

(signe $+$ pour une barrière up, $-$ pour une barrière down).

### 8.4 Monte Carlo

- **Observation discrète** : on simule exactement aux dates d'observation et on teste la barrière à chaque date. Le rebate d'une *out* est actualisé depuis la date de touche.
- **Observation continue** (252 pas par an) : entre deux points simulés du même côté de la barrière, la probabilité que le pont brownien l'ait touchée vaut

$$
p_k = \exp\!\left( -\frac{2 \ln(H/S_k)\, \ln(H/S_{k+1})}{\sigma^2 \Delta t} \right)
$$

On en déduit la valeur *out* = $P(0,T) \cdot \mathbb{E}\big[\text{payoff} \cdot \prod_k (1 - p_k)\big]$, puis la valeur *in* = vanille − *out*.

---

## 9. Grecques par différences finies

*Fichier : `qplat/pricers/base.py` (`FiniteDifferencePricer`)*

Toutes les méthodes numériques (arbre, Monte Carlo, barrière, autocall) héritent d'une seule implémentation par bump-and-reprice :

| Grecque | Formule | Bump |
|---|---|---|
| Delta | $\dfrac{V(S+h) - V(S-h)}{2h}$ | $h = 1\,\% \times S$ |
| Gamma | $\dfrac{V(S+h) - 2V(S) + V(S-h)}{h^2}$ | $h = 1\,\% \times S$ |
| Vega | $\dfrac{V(\sigma+h) - V(\sigma-h)}{2h}$ | $h = \min(0{,}01,\ \sigma/2)$ |
| Theta | $\dfrac{V(t+\delta) - V(t)}{\delta}$ | $\delta = \min(1/365,\ T/2)$ ; toutes les dates sont raccourcies de $\delta$ |
| Rho | $\dfrac{V(r+h) - V(r-h)}{2h}$ | $h = 1$ bp, shift parallèle de la courbe |

Pour un autocall, le niveau initial (strike de référence) reste figé pendant le bump de spot : c'est le sous-jacent qui bouge, pas les barrières.

---

## 10. Autocall Phoenix / Athena

*Fichiers : `qplat/instruments/structured.py`, `qplat/pricers/autocall.py` — défaut : 100 000 trajectoires*

### 10.1 Paramètres

Nominal $N$, dates d'observation $t_1 < \dots < t_n$, niveau initial $S_{init}$, coupon $c$ par période, barrières (en % de $S_{init}$) : autocall $B_{ac}$, coupon $B_c$, protection $B_p$, effet mémoire.

### 10.2 Payoff sur une trajectoire

Performance à chaque date : $\pi_k = S_{t_k} / S_{init}$. Tant que le produit est vivant, à chaque date $t_k$ :

1. **Coupon** : si $\pi_k \ge B_c$, versement de $c N (1 + m_k)$, où $m_k$ est le nombre de coupons manqués depuis le dernier paiement (0 sans effet mémoire). Sinon $m_{k+1} = m_k + 1$.
2. **Remboursement anticipé** ($k < n$) : si $\pi_k \ge B_{ac}$, versement de $N$ et fin du produit.
3. **Échéance** ($k = n$) : versement de $N$ si $\pi_n \ge B_p$, sinon de $N \pi_n$ (perte en capital).

La valeur est l'espérance de la somme des flux actualisés $\sum_k \text{flux}_k\, P(0, t_k)$. Comme le payoff ne dépend que des dates d'observation, la simulation exacte à ces seules dates suffit.

Une **Athena** correspond au cas $B_c = B_{ac}$.

### 10.3 Indicateurs

- Probabilité de remboursement à chaque date, probabilité de payer un coupon à chaque date.
- Probabilité de perte : $\mathbb{Q}(\text{vivant à } t_n \text{ et } \pi_n < B_p)$.
- Durée de vie espérée : $\mathbb{E}[\text{date de remboursement}]$.
- **Coupon au pair** : la valeur de $c$ qui donne un prix de 100 %, trouvée par Brent sur $[0\,;\,0{,}5]$. Les nombres aléatoires étant communs, le prix est une fonction lisse de $c$.

**Lecture des grecques.** Le porteur est en général vendeur de volatilité ($\nu < 0$), car il a vendu un put down-and-in implicite. Le delta peut être négatif quand les coupons sont élevés par rapport aux taux : une hausse du sous-jacent accélère un rappel défavorable au porteur.

---

## 11. Options digitales, asiatiques et cliquets

*Fichiers : `qplat/instruments/exotics.py`, `qplat/pricers/exotics.py`*

Les trois produits exposent la même interface Monte Carlo : des dates d'observation et un payoff calculé sur les spots simulés à ces dates. Un seul moteur (`MonteCarloExoticPricer`) les price donc sous Black-Scholes, Heston ou volatilité locale. Comme partout, les grecques sont obtenues par différences finies (section 9), avec des nombres aléatoires communs pour le Monte Carlo.

### 11.1 Digitales

Une digitale **cash-or-nothing** paie un montant $Q$ si l'option finit dans la monnaie ; une **asset-or-nothing** paie $S_T$. Avec $d_{1,2}$ de Black-Scholes :

$$
\text{CoN}_{call} = Q\, e^{-rT} N(d_2), \qquad \text{CoN}_{put} = Q\, e^{-rT} N(-d_2)
$$

$$
\text{AoN}_{call} = S e^{-qT} N(d_1), \qquad \text{AoN}_{put} = S e^{-qT} N(-d_1)
$$

**Relations vérifiées par les tests** : $\text{CoN}_{call} + \text{CoN}_{put} = Q e^{-rT}$, et une vanille se décompose en $C = \text{AoN}_{call} - K \cdot \text{CoN}_{call}/Q$.

**Réplication par call spread.** Une digitale cash est la dérivée du prix du call par rapport au strike :

$$
\text{CoN}_{call} = -Q\, \frac{\partial C}{\partial K} = \lim_{w \to 0} \frac{Q}{w} \left[ C(K - w/2) - C(K + w/2) \right]
$$

L'interface affiche la convergence du call spread vers la digitale quand sa largeur $w$ diminue.

**Grecques.** Le delta $Q e^{-rT} n(d_2) / (S\sigma\sqrt T)$ devient un pic autour de $K$ près de l'échéance, et le gamma change de signe en $K$. Le vega, $-Q e^{-rT} n(d_2)\, d_1 / \sigma$, est négatif quand le call est dans la monnaie : plus de volatilité éloigne la probabilité de finir au-dessus du strike de 1.

**Correction de smile.** Avec un smile $\sigma(K)$, le prix du call est $C(K) = C_{BS}(K, \sigma(K))$. En dérivant :

$$
\text{CoN}_{call} = Q \left[ D_{BS}(\sigma(K)) - \mathcal{V}_{BS}(K)\, \frac{\partial \sigma}{\partial K} \right]
$$

Avec un skew négatif ($\partial\sigma/\partial K < 0$), le call digital est plus cher que le prix Black-Scholes. Le calcul est fait par différence centrée de $C(K)$ sur la surface SVI. Sous Heston, la digitale est la même différence appliquée aux prix de la formule de Lewis.

### 11.2 Options asiatiques

Payoff $(\varphi(A - K))^+$ payé au dernier fixing, où $A$ est la moyenne arithmétique ou géométrique de $S$ sur $n$ fixings équirépartis $t_1 < \dots < t_n$.

**Moyenne géométrique : formule fermée exacte.** Avec $g_i = \int_0^{t_i} (f(s) - q)\,ds = -\ln P(0, t_i) - q t_i$, $\ln G = \frac1n \sum_i \ln S_{t_i}$ est gaussien :

$$
m = \ln S + \frac1n \sum_i \left( g_i - \tfrac12 \sigma^2 t_i \right), \qquad v = \frac{\sigma^2}{n^2} \sum_{i,j} \min(t_i, t_j)
$$

$$
V_{geo} = P(0, t_n) \cdot \varphi \left[ e^{m + v/2} N(\varphi d_1) - K N(\varphi d_2) \right], \qquad d_1 = \frac{m - \ln K + v}{\sqrt v}, \quad d_2 = d_1 - \sqrt v
$$

Avec un seul fixing, on retrouve Black-Scholes. Quand $n \to \infty$, on retrouve la formule continue de Kemna-Vorst (vol $\sigma/\sqrt3$).

**Moyenne arithmétique : approximation de Lévy (1992).** La somme de log-normales n'est pas log-normale. On l'approche par une log-normale de mêmes deux premiers moments. Avec $F_i = S e^{g_i}$ :

$$
M_1 = \frac1n \sum_i F_i, \qquad M_2 = \frac{1}{n^2} \sum_{i,j} F_i F_j\, e^{\sigma^2 \min(t_i, t_j)}
$$

$$
V_{Lévy} = P(0, t_n) \cdot \text{Black}\left(M_1, K, \ \Sigma^2 = \ln(M_2 / M_1^2)\right)
$$

L'approximation surévalue légèrement le prix quand la volatilité est forte (queue droite trop épaisse).

**Monte Carlo avec variable de contrôle.** L'asiatique géométrique $Y$, calculé sur les mêmes trajectoires que l'arithmétique $X$, a un prix exact $\mathbb{E}[Y]$ et lui est très corrélé :

$$
\hat V = \overline{X} - \beta \left( \overline{Y} - \mathbb{E}[Y] \right), \qquad \beta = \frac{\text{Cov}(X, Y)}{\text{Var}(Y)}
$$

La variance est divisée par $1/(1 - \rho_{XY}^2)$, typiquement plusieurs centaines pour un call ATM : à précision égale, il faut des centaines de fois moins de trajectoires. Les paires antithétiques sont moyennées avant l'estimation de $\beta$.

**Grecques.** Le delta d'un call asiatique est plus faible que celui de la vanille, et le vega aussi : la moyenne a une volatilité effective réduite (environ $\sigma/\sqrt3$ en continu).

### 11.3 Cliquets

Dates de reset $t_0 = 0 < t_1 < \dots < t_n$, rendements de période $R_i = S_{t_i} / S_{t_{i-1}} - 1$, floor et cap locaux $f, c$, floor et cap globaux $F, C$ (chacun optionnel) :

$$
\text{payoff} = N \cdot \min\left( \max\left( \sum_{i=1}^n \min(\max(R_i, f), c),\ F \right),\ C \right) \quad \text{payé en } t_n
$$

**Sans bornes globales : formule fermée.** Sous Black-Scholes, $1 + R_i$ est log-normal de moyenne $\Phi_i = \frac{P(0,t_{i-1})}{P(0,t_i)} e^{-q(t_i - t_{i-1})}$ et de variance $\sigma^2 (t_i - t_{i-1})$, indépendamment du niveau de $S$. Chaque période est un call spread à départ différé :

$$
\mathbb{E}[\min(\max(R_i, f), c)] = f + C_{Bl}(\Phi_i, 1 + f) - C_{Bl}(\Phi_i, 1 + c)
$$

($C_{Bl}$ : call de Black non actualisé), d'où $V = N\, P(0, t_n) \sum_i \mathbb{E}[\cdot]$. Le floor global est une option sur la somme : il faut le Monte Carlo.

**Grecques.** Le payoff ne dépend que de rendements : **delta et gamma sont nuls** sous Black-Scholes, et le moteur les retrouve exactement (zéro numérique). Le vega est souvent **négatif** : avec des caps locaux, plus de volatilité fait perdre plus de performance sur les périodes cappées qu'elle n'en fait gagner. Le graphique du prix en fonction de la volatilité montre ce profil, parfois non monotone (le floor global, lui, est long vol).

**Risque de modèle.** Le prix ne dépend que des **volatilités forward** et du smile forward. La volatilité locale, calibrée sur les vanilles d'aujourd'hui, produit un skew forward qui s'aplatit. Heston conserve un skew forward proche du skew actuel. Les deux modèles reproduisent les mêmes vanilles mais donnent des prix de cliquet différents : c'est l'exemple classique du risque de modèle (onglet *Modèles de volatilité → Digitale, asiatique, cliquet*).

---

## 12. Swaps de variance et de volatilité

*Fichiers : `qplat/pricers/variance.py`, `api/routers/variance.py`*

### 12.1 Le contrat

Un swap de variance paie à l'échéance $N_{var}\,(\sigma_R^2 - K_{var})$, où $\sigma_R^2$ est la variance réalisée des rendements logarithmiques quotidiens, annualisée et sans retrait de la moyenne (convention de marché) :

$$
\sigma_R^2 = \frac{252}{n} \sum_{i=1}^{n} \ln^2\!\frac{S_i}{S_{i-1}}
$$

Les vols sont cotées en points (100 σ). Le notionnel variance se déduit du notionnel vega : $N_{var} = N_{vega} / (2 K_{vol})$. Près du strike, un point de vol réalisée au-dessus de $K_{vol}$ rapporte donc environ $N_{vega}$.

Le swap de **volatilité** paie $N_{vega}(\sigma_R - K_{vol})$ : c'est un payoff linéaire en vol, alors que le swap de variance est convexe.

### 12.2 Strike juste par réplication statique

Pour une trajectoire continue, le lemme d'Itô appliqué à $\ln S$ donne

$$
\int_0^T \sigma_t^2\, dt = 2 \int_0^T \frac{dS_t}{S_t} - 2 \ln\frac{S_T}{S_0}
$$

La variance réalisée est donc un contrat log, couvert en delta par la position dynamique $2/S_t$. Le contrat log se décompose en une bande d'options hors de la monnaie pondérées en $1/K^2$ (Carr et Madan ; Demeterfi, Derman, Kamal et Zou, 1999). Avec $F$ le forward et $P(0,T)$ le facteur d'actualisation :

$$
K_{var} = \frac{2}{T\, P(0,T)} \left[ \int_0^F \frac{\text{Put}(K)}{K^2}\, dK + \int_F^\infty \frac{\text{Call}(K)}{K^2}\, dK \right]
$$

Le strike juste ne dépend que du **smile du jour** : aucun modèle n'intervient, à condition que les trajectoires soient continues.

**Mise en œuvre.** L'intégrale est calculée en log-moneyness $k = \ln(K/F)$, puisque $dK/K^2 = e^{-k}\,dk/F$. Elle porte sur ±10 écarts-types ATM (4 001 points), avec les prix de Black issus de la surface SVI (section 15). La page affiche la contribution de chaque strike : les puts portent l'essentiel de la variance (77 % sur SPY), ce qui place $\sqrt{K_{var}}$ nettement au-dessus de la vol ATM.

**Validation par Heston.** Sous Heston, la variance réalisée espérée a une formule fermée :

$$
\mathbb{E}\left[ \frac{1}{T}\int_0^T v_t\, dt \right] = \theta + (v_0 - \theta)\, \frac{1 - e^{-\kappa T}}{\kappa T}
$$

En répliquant le smile produit par Heston, on retrouve cette valeur à $10^{-4}$ près en relatif (test automatique).

### 12.3 Strikes cotés : la formule du VIX

Le CBOE applique la même formule aux strikes cotés :

$$
\sigma^2 = \frac{2}{T} \sum_i \frac{\Delta K_i}{K_i^2}\, e^{rT}\, Q(K_i) - \frac{1}{T}\left( \frac{F}{K_0} - 1 \right)^2
$$

- $Q(K_i)$ est le milieu de fourchette de l'option hors de la monnaie (moyenne du call et du put en $K_0$).
- $K_0$ est le premier strike sous le forward.
- La bande s'arrête après deux bids nuls consécutifs.
- Le forward est tiré de la parité call-put : la plateforme prend la médiane des forwards implicites à ±10 % du spot, plus robuste aux cotations aberrantes des strikes lointains que la règle du strike minimisant $|C - P|$.

Le VIX interpole ensuite linéairement en temps les variances totales des deux échéances qui encadrent 30 jours, puis annualise.

**Validation.** Cette formule est appliquée chaque jour aux chaînes SPY stockées, et comparée au VIX officiel (`^VIX`, téléchargé avec les taux). L'écart médian est d'environ 0,4 point. Les écarts restants s'expliquent par :
- SPY au lieu de l'indice S&P 500 ;
- l'heure du snapshot, comparée à la clôture du VIX ;
- des options américaines au lieu d'européennes.

La bande cotée s'arrête où les cotations disparaissent. Elle sous-estime donc un peu la variance par rapport à la surface SVI, qui extrapole les ailes.

### 12.4 Swap de volatilité et convexité

$\sqrt{\cdot}$ est concave, donc par l'inégalité de Jensen $\mathbb{E}[\sigma_R] = \mathbb{E}\left[\sqrt{\sigma_R^2}\right] \le \sqrt{\mathbb{E}[\sigma_R^2]} = \sqrt{K_{var}}$. L'écart, ou **convexité**, dépend de la variance de la variance réalisée : il faut donc un modèle.

La page compare plusieurs approches :
- **Black-Scholes** (vol constante) : la convexité est presque nulle ; il ne reste que le bruit d'échantillonnage quotidien.
- **Heston** : on simule la variance intégrée $\frac1T\int v\,dt$ par un schéma d'Euler à troncature complète ; on calcule aussi la variance réalisée de trajectoires quotidiennes.
- **Volatilité locale** : variance réalisée des trajectoires simulées. Elle doit retrouver la réplication, puisqu'elle reprice toutes les vanilles.

L'approximation au second ordre $\mathbb{E}[\sqrt V] \approx \sqrt{\mathbb{E}V} - \text{Var}(V)/(8\,\mathbb{E}[V]^{3/2})$ est affichée pour comparaison. Elle se dégrade quand la vol de la variance est forte.

### 12.5 Valeur et risques d'un swap en cours de vie

À la date $t$, la variance totale espérée combine la partie réalisée (lue dans l'historique) et la partie implicite restante :

$$
\mathbb{E}[\sigma_R^2] = \frac{t}{T}\, \sigma^2_{R}(0,t) + \frac{T-t}{T}\, K_{var}(t,T), \qquad V_t = P(t,T)\, N_{var} \left( \mathbb{E}[\sigma_R^2] - K_{vol}^2 \right)
$$

Le **vega**, pour un point de vol implicite sur la durée restante, vaut $P(t,T)\, N_{var}\, \frac{T-t}{T}\, 2\sigma_{impl}$ ; à la monnaie et au départ, il est égal à $N_{vega}$. Le profil de payoff (variance contre vol) illustre la convexité.

### 12.6 Prime de risque de variance

Le VIX de la date $t$ est comparé à la vol réalisée de SPY sur les 21 séances suivantes, c'est-à-dire ce que paie un swap de variance à un mois conclu en $t$. L'historique couvre 2 ans.

On affiche :
- la part des jours où l'implicite dépasse le réalisé ;
- la prime moyenne en points de vol ;
- le P&L d'une vente mensuelle de swap de variance, de notionnel vega 1 : $(K^2 - \sigma_R^2)/(2K)$.

Le profil est celui d'une assurance vendue : une petite prime gagnée presque tous les mois, et de grosses pertes lors des chocs de volatilité (Carr et Wu, 2009).

---

## 13. Smile de volatilité implicite

*Fichiers : `qplat/analytics/smile.py`, `qplat/data/market.py`*

1. **Sélection des échéances** : pour chaque horizon cible (7, 14, 30, 60, 90, 180, 270, 365 et 545 jours), on retient l'échéance cotée la plus proche.
2. **Temps jusqu'à l'échéance** : mesuré à la seconde, depuis l'heure du snapshot jusqu'à 16h00 (New York) le jour d'expiration, divisé par 365 jours.
3. **Prix retenu** : le mid $(bid + ask)/2$ s'il existe une cotation des deux côtés, sinon le dernier prix traité.
4. **Filtres** : options hors de la monnaie uniquement (puts sous le spot, calls au-dessus), moneyness $K/S \in [0{,}7\,;\,1{,}3]$, plus de 2 jours avant l'échéance.
5. **Inversion** : volatilité implicite par Brent (section 5.4), avec le taux zéro $z(T)$ de la courbe et le dividende du sous-jacent.
6. **Structure par terme ATM** : pour chaque échéance, la volatilité implicite du strike le plus proche de la monnaie.

---

## 14. Modèle de Heston (volatilité stochastique)

*Fichiers : `qplat/models/heston.py`, `qplat/models/market_models.py`*

### 14.1 Dynamique

$$
\frac{dS_t}{S_t} = \big(f(t) - q\big)\,dt + \sqrt{v_t}\, dW^1_t, \qquad dv_t = \kappa(\theta - v_t)\,dt + \sigma\sqrt{v_t}\, dW^2_t, \qquad d\langle W^1, W^2\rangle_t = \rho\, dt
$$

| Paramètre | Rôle |
|---|---|
| $v_0$ | variance initiale ($\sqrt{v_0}$ = vol courte) |
| $\theta$ | variance de long terme |
| $\kappa$ | vitesse de retour à la moyenne (demi-vie $\ln 2 / \kappa$) : pente de la structure par terme |
| $\sigma$ | volatilité de la variance : convexité du smile |
| $\rho$ | corrélation spot / variance : $\rho < 0$ crée le skew baissier |

La **condition de Feller** $2\kappa\theta > \sigma^2$ garantit que la variance ne touche jamais zéro. Elle est souvent violée par les calibrations sur actions.

### 14.2 Fonction caractéristique

On note $X_T = \ln(S_T/S_0) - (r - q)T$. Sous la forme « little Heston trap » (Albrecher et al., 2007), qui évite les discontinuités du logarithme complexe :

$$
a = \kappa - \rho\sigma i u, \qquad d = \sqrt{a^2 + \sigma^2 (iu + u^2)}, \qquad g = \frac{a - d}{a + d}
$$

$$
C(u) = \frac{\kappa\theta}{\sigma^2}\left[(a - d)T - 2\ln\frac{1 - g e^{-dT}}{1 - g}\right], \qquad D(u) = \frac{a - d}{\sigma^2}\cdot\frac{1 - e^{-dT}}{1 - g e^{-dT}}
$$

$$
\varphi_T(u) = \mathbb{E}\big[e^{iuX_T}\big] = \exp\big(C(u) + D(u)\, v_0\big)
$$

### 14.3 Prix européen : formule de Lewis

$$
C(K) = S e^{-qT} - \frac{\sqrt{SK}\, e^{-(r+q)T/2}}{\pi} \int_0^{\infty} \mathrm{Re}\!\left[e^{iux}\, \varphi_T\!\left(u - \tfrac{i}{2}\right)\right] \frac{du}{u^2 + 1/4}, \qquad x = \ln\frac{S}{K} + (r-q)T
$$

L'intégrale est calculée par quadrature de Gauss-Legendre (400 nœuds) sur $[0, U]$, avec $U = \sqrt{80 / (v_{min} T)}$ borné entre 100 et 3000. L'intégrande décroît comme $e^{-vTu^2/2}$. La fonction caractéristique ne dépend que de $T$ : elle est évaluée une seule fois par échéance pour tous les strikes. Les puts s'obtiennent par parité call-put.

**Vérifications** : avec une vol de vol quasi nulle et $v_0 = \theta$, le prix redonne Black-Scholes à $10^{-5}$ près. Il concorde aussi avec la simulation Monte Carlo de Heston.

### 14.4 Calibration

Points utilisés : la partie liquide du smile, soit les échéances de 14 jours ou plus, la zone $|\ln(K/S)| \le \max(0{,}08\,;\,0{,}35\sqrt{T})$, et au plus 25 options par échéance.

On minimise par moindres carrés bornés (Trust Region Reflective) les erreurs de prix normalisées par le vega Black-Scholes, qui sont au premier ordre des erreurs de volatilité implicite :

$$
\min_{v_0,\kappa,\theta,\sigma,\rho} \sum_j \left(\frac{V^{Heston}_j - V^{marché}_j}{\nu^{BS}_j}\right)^2
$$

Bornes : $v_0, \theta \in [10^{-4}, 1{,}5]$, $\kappa \in [0{,}05, 15]$, $\sigma \in [0{,}01, 3]$, $\rho \in [-0{,}99, 0{,}99]$. Point de départ : $v_0$ et $\theta$ tirés des vols implicites de la plus courte et de la plus longue échéance, $\kappa = 2$, $\sigma = 0{,}6$, $\rho = -0{,}6$.

La qualité affichée (RMSE et erreur maximale) est l'écart **exact** de volatilité implicite après inversion des prix du modèle. Sur des données synthétiques, la calibration retrouve les paramètres à $10^{-3}$ près en relatif.

### 14.5 Simulation (exotiques sous Heston)

Schéma d'Euler à troncature complète sur $(\ln S, v)$, avec 252 pas par an et des variables antithétiques. On note $v^+ = \max(v, 0)$ :

$$
\ln S_{t+\Delta} = \ln S_t + \ln\frac{P(0,t)}{P(0,t+\Delta)} - q\Delta - \tfrac{1}{2}v_t^+\Delta + \sqrt{v_t^+ \Delta}\, Z_1
$$

$$
v_{t+\Delta} = v_t + \kappa(\theta - v_t^+)\Delta + \sigma\sqrt{v_t^+\Delta}\left(\rho Z_1 + \sqrt{1-\rho^2}\, Z_2\right)
$$

---

## 15. Surface de volatilité SVI et volatilité locale de Dupire

*Fichier : `qplat/models/svi.py`*

### 15.1 SVI par échéance

On note $k = \ln(K/F_T)$ la log-moneyness par rapport au forward, et $w(k) = \sigma_{imp}^2(k)\,T$ la variance implicite totale. La paramétrisation SVI « raw » de Gatheral :

$$
w(k) = a + b\left(\rho\,(k - m) + \sqrt{(k-m)^2 + s^2}\right)
$$

Chaque échéance (au moins 7 jours, au moins 6 points, $|k| \le 0{,}5$) est ajustée par moindres carrés sur $w$. Des pénalités assurent l'absence d'arbitrage sur la grille $k \in [-0{,}5\,;\,0{,}5]$ :

- **Positivité** : $a + b\,s\sqrt{1 - \rho^2} \ge 0$.
- **Papillon** (densité risque-neutre positive), avec la fonction de Durrleman :

$$
g(k) = \left(1 - \frac{k\, w'}{2w}\right)^2 - \frac{w'^2}{4}\left(\frac{1}{w} + \frac{1}{4}\right) + \frac{w''}{2} \ \ge 0
$$

- **Calendrier** : $w_{T_{i+1}}(k) \ge w_{T_i}(k)$. Les échéances sont ajustées par maturité croissante, chacune contrainte à rester au-dessus de la précédente.

### 15.2 Interpolation entre échéances

La variance totale est interpolée linéairement en $T$ à $k$ fixé, ce qui préserve l'absence d'arbitrage calendaire. Avant la première échéance et après la dernière, la volatilité implicite est prolongée à plat.

### 15.3 Volatilité locale de Dupire

La volatilité locale est l'unique fonction $\sigma_{loc}(S, t)$ telle que $dS/S = (r - q)\,dt + \sigma_{loc}\,dW$ reproduise tous les prix européens. Exprimée en variance totale (Gatheral, *The Volatility Surface*, éq. 1.10) :

$$
\sigma_{loc}^2(k, T) = \frac{\partial w / \partial T}{g(k, T)}
$$

$w'$ et $w''$ sont analytiques en SVI, et $\partial w/\partial T$ vient de l'interpolation entre échéances. Là où $g \le 0$ ou $\partial w / \partial T \le 0$ (arbitrage), la volatilité locale n'est pas définie et vaut NaN.

### 15.4 Simulation sous volatilité locale

On précalcule $\sigma_{loc}$ sur une grille de 60 maturités × 81 moneyness ($k \in [-1, 1]$), interpolée bilinéairement. Les trous d'arbitrage sont comblés par la volatilité implicite, et les valeurs bornées entre 1 % et 300 %. Schéma d'Euler sur $\ln S$ avec 252 pas par an :

$$
\ln S_{t+\Delta} = \ln S_t + \ln\frac{P(0,t)}{P(0,t+\Delta)} - q\Delta - \tfrac{1}{2}\sigma_{loc}^2\Delta + \sigma_{loc}\sqrt{\Delta}\, Z, \qquad \sigma_{loc} = \sigma_{loc}\!\left(\ln\frac{S_t}{F_t},\, t\right)
$$

**Vérification** : une surface plate redonne une volatilité locale plate, et le Monte Carlo sous volatilité locale reprice les vanilles du marché à environ 1 % près.

### 15.5 Exotiques : comparaison des modèles

Le même produit (barrière en observation quotidienne, autocall) est pricé sous trois hypothèses :
- **Black-Scholes**, avec la vol implicite ATM de la surface à la maturité du produit ;
- **Heston** calibré ;
- **volatilité locale**.

Les trois modèles s'accordent sur les vanilles ATM. L'écart de prix entre eux mesure donc le **risque de modèle** dû au smile et à la dynamique de la volatilité. Un autocall avec protection basse est en général surévalué par une vol plate, qui ignore le skew baissier.

La même comparaison existe pour la digitale (avec en plus le prix « BS + pente du smile » et la formule de Lewis sous Heston), l'asiatique et le cliquet (section 11).

---

## 16. Portefeuille et gestion des risques

*Fichiers : `qplat/risk/portfolio.py`, `api/routers/portfolio.py`*

### 16.1 Positions et valorisation

Types de positions : actions, options européennes ou américaines, barrières, digitales, asiatiques, cliquets, autocalls, obligations, futures sur indices, CDS, caps et floors, options de change EUR/USD, swaps de variance. Les maturités sont saisies en dates et converties en ACT/365F à la date de valorisation.

Chaque position est valorisée avec le pricer adapté :

| Type | Pricer |
|---|---|
| Option européenne | Black-Scholes |
| Option américaine | arbre CRR à 200 pas |
| Barrière | formule fermée (BGK si l'observation est discrète) |
| Digitale | formule fermée de Black-Scholes |
| Asiatique | Monte Carlo avec variable de contrôle (arithmétique), formule fermée (géométrique), 20 000 trajectoires |
| Cliquet | Monte Carlo, 20 000 trajectoires |
| Autocall | Monte Carlo, 20 000 trajectoires |
| Obligation | actualisation sur la courbe |
| Future | portage, avec une valeur égale à $(F - F_{entrée})$ × nominal |
| Cap / floor | caplets en Black-76 ou Bachelier sur la courbe de la devise (section 21.1) ; strike ATM figé à l'ajout ; quantité = nominal |
| Swap de variance | variance réalisée depuis le départ (historique) + strike juste de la durée restante répliqué sur la surface SVI (section 12.5) ; quantité = notionnel vega |
| Option de change | Garman-Kohlhagen à la vol du smile de la position (ATM, RR et BF saisis) au strike ; sous-jacent EUR/USD ; quantité = nominal en EUR |
| CDS | bootstrap de la courbe de spreads de la position, puis jambes ISDA (section 20) ; quantité = nominal, positive pour un acheteur de protection |

**Données de marché** : dernier cours, dividende, courbe de la devise. La volatilité est la vol ATM de la surface SVI à la maturité de la position quand le sous-jacent a des options cotées, sinon la vol réalisée sur un an.

**Produits en cours de vie.** Une asiatique ou un cliquet commencé avant la date de valorisation a déjà des fixings observés. Ils sont lus dans l'historique des cours en base : dernier cours de clôture à la date du fixing ou avant. Si l'historique manque, c'est le spot actuel qui est utilisé.
- **Asiatique** : les fixings passés entrent dans la moyenne. La formule géométrique, l'approximation de Lévy et le Monte Carlo moyennent sur les $n$ fixings du contrat, dont $n_{passés}$ sont déjà connus.
- **Cliquet** : les périodes terminées sont accumulées (somme des rendements bornés localement). La période en cours a un niveau de référence figé, le cours au dernier reset ; au départ, c'est le niveau initial fixé à l'ajout de la position. Dès qu'il est lancé, le cliquet a donc un delta non nul, alors qu'il en a un nul avant son départ.
- Une fois tous les fixings connus, la valeur est le payoff, sans plus aucune sensibilité.

Pour le theta, un fixing qui tombe pendant le décalage d'un jour est fixé au spot du jour.

**Caps déjà lancés.** L'échéancier est construit sur les dates du contrat. Les caplets dont le paiement est passé sont ignorés. Le caplet de la période en cours a déjà été fixé, mais les fixings SOFR / Euribor ne sont pas stockés : il est valorisé à sa valeur intrinsèque, avec un fixing approché par le taux de la courbe jusqu'à sa date de paiement.

**Options de change.** Le sous-jacent EUR/USD est un sous-jacent comme un autre. Il a son delta cash (exposition en euros), entre dans la VaR historique avec ses propres rendements, et subit les chocs de spot des stress tests. Le choc de vol des stress tests translate la vol ATM du smile coté de la position. Le rho additionne les sensibilités aux taux USD et EUR, puisque les chocs de taux translatent les deux courbes. Le vega des caps est exprimé pour 1 % de vol log-normale ou 1 bp de vol normale, selon le modèle.

**Swaps de variance.**
- **Strike** : par défaut, le strike juste du jour pour toute la période, figé à l'ajout.
- **Delta** : nul.
- **Gamma** : chaque rendement quotidien $r$ ajoute $10^4 r^2 / T$ points de variance. Le P&L d'un mouvement de 1 % vaut donc $N_{var}/T$ (actualisé), un terme exactement quadratique qui entre dans la VaR historique comme un gamma.
- **Vega** : pour un point de vol implicite sur la durée restante. Le choc de vol des stress tests translate la vol implicite restante ; le choc de spot ne réévalue pas le swap (surface figée), son effet de variance réalisée passe par le gamma.
- **Theta** : la perte d'une journée sans mouvement. La variance implicite de cette journée n'est pas réalisée : l'acheteur de variance paie ce portage.

Les montants sont convertis en **euros**, avec le dernier taux EUR/USD stocké en base. Les positions sont enregistrées dans la table SQLite `positions` (conditions du contrat en JSON, prix d'entrée par unité).

### 16.2 Sensibilités agrégées

Pour une position de quantité $Q$ et de multiplicateur $M$, avec $fx$ le taux de change vers l'euro :

$$
\Delta_{cash} = \Delta\, S\, Q M \cdot fx, \qquad \Gamma_{1\%} = \tfrac{1}{2}\, \Gamma\, (0{,}01\, S)^2\, Q M \cdot fx
$$

$\Gamma_{1\%}$ est le P&L du terme de gamma pour un mouvement de 1 % du sous-jacent. Le vega est donné pour 1 point de vol, le theta par jour, le rho pour 1 % de taux, et la DV01 pour les obligations et les CDS. Les agrégats sont présentés par sous-jacent, par book et par type d'instrument.

**Positions CDS.**
- **CS01** : variation pour +1 bp sur toute la courbe de spreads.
- **Jump-to-default** : P&L si l'émetteur fait défaut immédiatement, $\pm N(1-R) - V$.
- **Theta** : portage de la prime sur un jour.
- **Rho** : IR01 × 100.

Ces mesures sont agrégées, avec en plus le pire défaut isolé et le nominal net de protection. Une position CDS garde sa courbe de spreads dans ses paramètres. On la met à jour depuis la liste des positions. Le prix d'entrée est conservé, si bien que l'effet de l'écartement ou du resserrement des spreads apparaît dans le P&L.

### 16.3 Stress tests

Chaque scénario est une **revalorisation complète** du book :

- **Grille actions × volatilité** : chocs relatifs sur tous les sous-jacents de −20 % à +20 %, croisés avec des chocs absolus de vol de −5 à +10 points.
- **Chocs de taux** : translations parallèles de ±50 et ±100 points de base, appliquées à toutes les courbes. Pour les CDS, les spreads cotés sont conservés et la courbe de défaut est re-bootstrapée.
- **Chocs de spreads de crédit** : translations de −25, +25, +50, +100 et +200 bp de toutes les courbes CDS, avec revalorisation complète.

La VaR historique ne porte que sur les sous-jacents actions. Il n'existe pas d'historique public de spreads CDS : le risque de crédit est donc mesuré par les chocs de spreads et le jump-to-default.

### 16.4 Value at Risk et Expected Shortfall (1 jour)

**VaR historique.** On rejoue les rendements journaliers réels, sur les dates communes à tous les sous-jacents du book (environ 2 ans). Le P&L de chaque scénario $s$ est approché à l'ordre 2 (delta-gamma) :

$$
\text{P\&L}_s = \sum_{i} \left[\Delta_{cash,i}\, r_{i,s} + \tfrac{1}{2}\,\Gamma_i S_i^2\, r_{i,s}^2\right]
$$

$$
\text{VaR}_\alpha = -\,\text{quantile}_{1-\alpha}(\text{P\&L}), \qquad \text{ES}_\alpha = -\,\mathbb{E}\big[\text{P\&L} \mid \text{P\&L} \le -\text{VaR}_\alpha\big]
$$

**VaR paramétrique (delta-normale).** Avec $\Sigma$ la matrice de covariance des rendements sur le même historique :

$$
\text{VaR}_\alpha = z_\alpha \sqrt{\Delta_{cash}^\top\, \Sigma\, \Delta_{cash}}, \qquad z_{95\%} = 1{,}645, \quad z_{99\%} = 2{,}326
$$

La VaR couvre le risque actions. Les risques de taux et de volatilité sont mesurés par les stress tests.

### 16.5 Explication du P&L

On compare la revalorisation complète à la clôture précédente et au dernier cours, en décomposant pour chaque position :

$$
\text{P\&L} = \underbrace{\Delta_{cash}\, r}_{\text{delta}} + \underbrace{\Gamma_{1\%}\left(\frac{r}{1\%}\right)^2}_{\text{gamma}} + \underbrace{\Theta \cdot \text{jours}}_{\text{theta}} + \text{résiduel}
$$

Un résiduel faible valide les sensibilités. Un résiduel important signale des effets d'ordre supérieur ou un saut de marché.

**Simplifications** : l'état « coupons manqués » des autocalls déjà en vie n'est pas suivi ; la volatilité et les taux sont supposés inchangés dans l'explication du P&L.

---

## 17. Allocation de portefeuille

*Fichiers : `qplat/allocation/estimation.py`, `qplat/allocation/optimize.py`, `qplat/allocation/backtest.py`, `api/routers/allocation.py`*

### 17.1 Données

L'univers est celui de la plateforme : actions, ETF et indices, avec environ 2 ans de clôtures quotidiennes. Les rendements sont calculés en **euros**. Un actif en dollars vu par un investisseur européen vaut $P_{EUR} = P_{USD} / \text{EURUSD}$ : son rendement inclut le risque de change. Seules les dates où tous les actifs cotent sont gardées. Tout est annualisé avec 252 jours.

### 17.2 Estimation et erreur d'estimation

**Covariance de Ledoit et Wolf (2004).** La covariance empirique $S$ est rétrécie vers une cible $F = m I$, où $m$ est la variance moyenne. L'intensité est estimée sur les données :

$$
\hat\Sigma = \delta^* F + (1 - \delta^*) S, \qquad \delta^* = \min\left(1, \frac{\hat b^2}{\hat d^2}\right), \quad \hat d^2 = \frac{\|S - F\|^2}{p}, \quad \hat b^2 = \frac{1}{n^2 p}\sum_t \|x_t x_t' - S\|^2
$$

La matrice obtenue est toujours définie positive, et $\delta^*$ diminue quand le nombre d'observations augmente.

**Rendements espérés de James et Stein (Jorion, 1986).** Les moyennes sont rétrécies vers la moyenne commune $\bar\mu$ :

$$
\hat\mu_{JS} = w\, \bar\mu \mathbf{1} + (1 - w)\, \hat\mu, \qquad w = \min\left(1, \frac{p - 2}{n\,(\hat\mu - \bar\mu\mathbf 1)' \hat\Sigma^{-1} (\hat\mu - \bar\mu \mathbf 1)}\right)
$$

Sur 2 ans de données, $w = 1$ : les écarts entre rendements moyens ne sont pas statistiquement distinguables. C'est la raison principale des mauvaises performances de la moyenne-variance « naïve » (Michaud, 1989).

### 17.3 Problème d'optimisation

$$
\max_w \; \mu' w - \frac{\gamma}{2} w' \Sigma w - \lambda_1 \|w\|_1 - \lambda_2 \|w\|_2^2 - \frac{c}{h}\, \|w - w_0\|_1
$$

$$
\text{s.c.} \quad \mathbf 1' w = 1, \qquad -s_{max} \le w_i \le w_{max}
$$

- **γ** : aversion au risque.
- **$\lambda_1$, $\lambda_2$** : pénalités elastic-net (LASSO et ridge).
- **$c$** : coût proportionnel. Il est amorti sur la durée de détention $h$ (en années) pour être comparable à un rendement annuel.
- **$w_0$** : le portefeuille actuel (1/N par défaut).

Les termes non dérivables sont rendus lisses en dédoublant les variables : $w = u - v$ et $w - w_0 = b - s$, avec $u, v, b, s \ge 0$. On obtient un programme quadratique résolu par SLSQP, avec gradients exacts. Les variables inutiles sont supprimées : $v$ en long-only, $(b, s)$ sans coûts.

**Résultats fermés utilisés comme tests**, sans autre contrainte que le budget :

$$
w_{GMV} = \frac{\Sigma^{-1}\mathbf 1}{\mathbf 1'\Sigma^{-1}\mathbf 1}, \qquad w^* = w_{GMV} + \frac{1}{\gamma}\left( \Sigma^{-1}\mu - \frac{\mathbf 1'\Sigma^{-1}\mu}{\mathbf 1'\Sigma^{-1}\mathbf 1}\Sigma^{-1}\mathbf 1 \right), \qquad \sigma^2(\bar\mu) = \frac{a\bar\mu^2 - 2b\bar\mu + c}{ac - b^2}
$$

avec $a = \mathbf 1'\Sigma^{-1}\mathbf 1$, $b = \mathbf 1'\Sigma^{-1}\mu$, $c = \mu'\Sigma^{-1}\mu$.

**Frontière efficiente.** On cherche la variance minimale pour une grille de rendements cibles, du portefeuille de variance minimale au rendement maximal atteignable. La page superpose trois frontières :
- la frontière sans contrainte (formule fermée) ;
- la frontière avec ventes à découvert bornées ;
- la frontière long-only.

**Portefeuille tangent** (Sharpe maximal) : on prend le meilleur point de la grille, puis on affine par une recherche par section dorée sur le rendement cible.

**Contributions au risque** : $RC_i = w_i (\Sigma w)_i / w'\Sigma w$, qui somment à 1. **Nombre effectif d'actifs** : $1/\sum w_i^2$.

### 17.4 LASSO et elastic-net

En long-only, $\|w\|_1 = \mathbf 1' w = 1$ est constant : la pénalité L1 ne change rien. La contrainte de non-vente à découvert agit alors elle-même comme une régularisation (Jagannathan et Ma, 2003). Avec des ventes à découvert, la pénalité L1 réduit l'exposition brute et met des poids exactement à zéro (Brodie et al., 2009).

L'onglet LASSO trace le chemin de régularisation du portefeuille de variance minimale :
- la covariance est estimée sur les 60 % premiers jours ;
- la volatilité est mesurée sur les 40 % suivants ;
- on suit, selon $\lambda_1$, le nombre d'actifs, l'exposition brute et les volatilités dans et hors échantillon.

C'est l'arbitrage biais-variance : la vol dans l'échantillon augmente avec $\lambda_1$, tandis que la vol hors échantillon baisse d'abord, puis remonte.

### 17.5 Backtest hors échantillon

Le backtest est *walk-forward*. À chaque rebalancement $t$ (tous les 21 jours par défaut), la règle ne voit que les rendements des $W$ jours qui précèdent $t$, strictement ; un test vérifie l'absence de *look-ahead*. Les poids dérivent ensuite avec les prix. Les coûts $c \sum_i |w_i^{new} - w_i^{drift}|$ sont prélevés à chaque rebalancement.

Les stratégies comparées sont :
- **1/N** ;
- **minimum variance long-only** (Ledoit-Wolf, poids plafonnés) ;
- **moyenne-variance** avec moyennes empiriques et ventes à découvert ;
- **moyenne-variance long-only** avec shrinkage ;
- **minimum variance elastic-net** avec shorts ;
- **moyenne-variance pénalisée par les coûts**.

On mesure le rendement annualisé, la volatilité, le Sharpe (taux EUR 3 mois), le drawdown maximal, la rotation et les coûts cumulés.

Le résultat reproduit celui de DeMiguel, Garlappi et Uppal (2009) :
- le 1/N est difficile à battre ;
- la moyenne-variance aux moyennes empiriques avec shorts accumule une rotation énorme et une volatilité élevée ;
- le minimum variance donne la volatilité la plus faible ;
- les contraintes, le shrinkage et la pénalisation des coûts réduisent l'erreur d'estimation et la rotation.

Avec 2 ans d'historique, l'échantillon reste court : les écarts sont indicatifs.

---

## 18. Recherche : portefeuilles volatility-managed

*Fichiers : `qplat/research/vol_managed.py`, `api/routers/research.py`*

### 18.1 Données

Les facteurs quotidiens de la bibliothèque de Kenneth French sont téléchargés une fois par semaine dans la table `factor_returns` :
- marché (Mkt-RF), taille (SMB) et valeur (HML), depuis juillet 1926 ;
- momentum, depuis novembre 1926 ;
- rentabilité (RMW) et investissement (CMA), depuis juillet 1963 ;
- taux sans risque.

Les rendements mensuels sont obtenus en composant les rendements quotidiens. La variance réalisée d'un mois est la somme des carrés des écarts des rendements quotidiens à leur moyenne du mois :

$$
RV_t = \sum_{d \in t} \left( f_d - \bar f_t \right)^2
$$

### 18.2 La stratégie (Moreira et Muir, 2017)

$$
f^\sigma_{t+1} = \frac{c}{RV_t}\, f_{t+1}
$$

L'exposition au mois $t+1$ est inversement proportionnelle à la variance réalisée du mois $t$. Deux versions sont proposées :
- **Comme dans l'article**, $c$ est choisi sur tout l'échantillon pour que $f^\sigma$ ait la même volatilité que $f$.
- **En temps réel**, $c_t$ n'utilise que le passé : rapport des écarts-types de $f$ et de $f/RV$ sur une fenêtre croissante, après 10 ans d'historique.

Deux options de robustesse s'ajoutent :
- un plafond de levier ;
- des coûts proportionnels à la variation d'exposition, $|w_t - w_{t-1}|$.

### 18.3 Le test

$$
f^\sigma_{t+1} = \alpha + \beta f_{t+1} + \varepsilon_{t+1}
$$

Les écarts-types sont de Newey et West (6 retards, noyau de Bartlett). L'**appraisal ratio** $\alpha / \sigma_\varepsilon$ (annualisé) mesure le gain de Sharpe obtenu en combinant $f$ et $f^\sigma$ :

$$
SR_{new}^2 = SR_{f}^2 + \left(\frac{\alpha}{\sigma_\varepsilon}\right)^2
$$

Un alpha positif signifie que la stratégie élargit la frontière moyenne-variance. Comme robustesse, on calcule aussi l'alpha contre les trois facteurs Fama-French.

**Réplication.** Sur 1926-2015 (l'échantillon de l'article), le facteur marché donne α = 4,9 % par an, β = 0,60 et un appraisal ratio de 0,33, comme le Tableau I de Moreira et Muir. L'effet est fort sur le marché, le momentum et la rentabilité, faible ou nul sur la taille et l'investissement.

### 18.4 Pourquoi ça marche

On classe les mois en quintiles de variance réalisée du mois précédent. Du quintile le plus calme au plus agité :
- la volatilité du mois suivant augmente fortement, car la volatilité est persistante ;
- le rendement moyen n'augmente pas en proportion.

Le rapport moyenne / variance, qui fixe l'exposition optimale $w^* = \mu / (\gamma \sigma^2)$ d'un investisseur moyenne-variance, baisse donc avec la volatilité passée. Réduire l'exposition après un mois agité suit cette règle. La stratégie évite aussi une partie des krachs, qui arrivent dans des périodes déjà volatiles : 1929-1932, 2008, et le krach du momentum de 2009.

### 18.5 Limites

- **Constante en temps réel.** L'alpha baisse nettement quand $c$ est estimé sans regarder le futur (Cederburg, O'Doherty, Wang et Yan, 2020).
- **Levier.** L'exposition dépasse 10 fois le facteur après des mois très calmes. La plafonner réduit l'alpha.
- **Implémentation.** Le marché est négociable (futures), mais les facteurs long-short sont des portefeuilles théoriques, sans coûts de transaction ni contraintes de vente à découvert.
- **Stabilité dans le temps.** L'alpha varie beaucoup d'une décennie à l'autre (graphique par décennie).

---

## 19. Théorie appliquée : réplication, couverture, calcul stochastique, P et Q

*Fichiers : `qplat/theory/replication.py`, `qplat/theory/hedging.py`, `qplat/theory/stochastic.py`, `qplat/theory/measures.py`, `api/routers/theory.py` — cours de finance en temps continu, lectures 2 et 3*

### 19.1 Réplication dans l'arbre binomial

À chaque période, l'action passe de $S$ à $uS$ ou $dS$, et le compte en banque est multiplié par le taux brut $R$. À chaque nœud, l'option est répliquée par $\Delta$ actions et $B$ en banque :

$$
\Delta = \frac{V_u - V_d}{S_u - S_d}, \qquad B = \frac{V_u - \Delta S_u}{R}, \qquad V = \Delta S + B = \frac{\pi V_u + (1-\pi) V_d}{R}, \qquad \pi = \frac{R - d}{u - d}
$$

La probabilité risque-neutre $\pi$ existe et vaut entre 0 et 1 si et seulement si $d < R < u$. Sinon, l'arbre est refusé, car il existe un arbitrage. Sous $\pi$, $\mathbb E_Q[S_1/S_0] = R$ : l'action rapporte le taux sans risque.

**Vérifications** sur l'exemple du cours ($S_0 = 100$, $u = 1{,}2$, $d = 0{,}8$, $R = 1{,}05$, put $K = 110$, tous testés) :
- **Une période** : $P_0 = 10{,}714$, $\Delta = -0{,}75$, $B = 85{,}714$.
- **Deux périodes** : $P_0 = 11{,}820$ ; aux nœuds intermédiaires, $(\Delta, B) = (-0{,}2917 ; 40)$ et $(-1 ; 104{,}762)$.
- **Probabilités des chemins** : $Q(S_2 = 96) = 2 \times 0{,}625 \times 0{,}375 = 0{,}46875$, et la valorisation directe $\sum Q \times \text{payoff} / R^N$ redonne le prix de l'induction.
- **Autofinancement** : le portefeuille posé au nœud parent vaut, à chaque nœud enfant, exactement l'option. La page l'affiche pour chaque nœud.
- **Convergence** : avec $u = e^{\sigma\sqrt{\Delta t}}$ et $d = 1/u$, l'arbre converge vers Black-Scholes.

**Market maker.** Le teneur de marché vend à l'ask, garde la marge (ask − prix) et rebalance le long d'un chemin choisi. Chaque achat ou vente d'actions est financé par le compte en banque, et la couverture paie exactement le client à l'échéance, quel que soit le chemin.

### 19.2 Couverture dynamique en delta

On vend une option au prix de Black-Scholes avec la vol implicite $\sigma_i$, puis on la couvre $N$ fois. Le sous-jacent suit un mouvement brownien géométrique sous la probabilité réelle : drift $\mu$ et vol réalisée $\sigma_r$, en simulation exacte. Le cash rapporte $r$ et les actions détenues touchent le dividende.

- **Indépendance du drift.** Avec $\sigma_r = \sigma_i$, le P&L moyen est nul quel que soit $\mu$, à l'erreur de discrétisation près. Le prix est le coût de la réplication ; Girsanov change le drift, pas la volatilité.
- **Erreur de couverture.** Elle décroît en $1/\sqrt N$, car la variation quadratique $(dS)^2 = \sigma^2 S^2 dt$ devient déterministe. Approximation de Derman et Kamal :

$$
\text{sd}(\text{P\&L}) \approx \sqrt{\pi/4}\; \mathcal V\, \sigma / \sqrt N
$$

où $\mathcal V$ est le vega. L'écart avec la simulation est inférieur à 10 % (test automatique).

- **Gamma contre theta.** Sur un pas, la position vendue et couverte gagne

$$
\tfrac12\, \Gamma S^2 \left( \sigma_i^2\, dt - \left(\tfrac{dS}{S}\right)^2 \right)
$$

Si $\sigma_r \ne \sigma_i$ :
- couverte avec le delta à la vol implicite, la position a un P&L qui dépend du chemin, de moyenne $\approx \tfrac12 \int \Gamma S^2 (\sigma_i^2 - \sigma_r^2)\, dt$ ;
- couverte avec le delta à la vol réalisée, elle verrouille $BS(\sigma_i) - BS(\sigma_r)$, avec moins de dispersion (Carr, 2005 ; Ahmad et Wilmott, 2005).

### 19.3 Sur données réelles

Chaque mois, on vend un call SPY à la monnaie à 21 jours. Son prix est fixé au VIX du jour (vol implicite à 30 jours du S&P 500). On le couvre ensuite chaque jour avec les vrais cours de clôture, au taux USD et avec le dividende de SPY. Le P&L mensuel :
- est corrélé à 0,99 avec la prévision gamma-theta ;
- gagne la plupart des mois, parce que la vol réalisée est en général sous le VIX ;
- perd lors des mois agités.

C'est la prime de risque de variance de la section 12.6, pondérée par le gamma.

### 19.4 Calcul stochastique, vérifié numériquement

Les exercices de la lecture 3 sont recalculés sur des milliers de trajectoires browniennes simulées exactement : $\Delta B = \sqrt{\Delta t}\, Z$.

- **Scaling.** $B_t \sim N(0, t)$ : les trajectoires restent dans la bande $\pm 1{,}96\sqrt t$ avec une probabilité de 95 %.
- **Variation totale.** $\mathbb E\left[\sum |\Delta B_i|\right] = N \sqrt{T/N}\, \mathbb E|Z| = \sqrt{2NT/\pi} \to \infty$. Les trajectoires n'ont pas de longueur finie, donc l'intégrale de Riemann-Stieltjes ne s'applique pas.
- **Variation quadratique.** $\sum (\Delta B_i)^2 \to T$, de variance $2T^2/N \to 0$ : c'est la règle $(dB)^2 = dt$.
- **Point d'évaluation.** La somme au point gauche $L_N = \sum B_{t_i} \Delta B_i$ tend vers $\tfrac12 B_T^2 - \tfrac12 T$ (d'espérance nulle : l'intégrale d'Itô est une martingale). La somme au point droit $R_N$ tend vers $\tfrac12 B_T^2 + \tfrac12 T$ (d'espérance $T$), car $R_N - L_N = \sum (\Delta B_i)^2$. Le lemme d'Itô le retrouve : $d(B^2) = 2B\,dB + dt$.
- **Martingales.** $B_t$, $B_t^2 - t$ et $e^{\lambda B_t - \lambda^2 t/2}$ ont une espérance constante. $B_t^2$ et $e^{\lambda B_t}$ dérivent, avec $\mathbb E[e^{\lambda B_t}] = e^{\lambda^2 t/2}$ (la transformée de Laplace de l'exercice 3).

### 19.5 Girsanov et échantillonnage préférentiel

Avec $Y = dQ/dP = \exp(\theta B_T - \tfrac12\theta^2 T)$, on a $\mathbb E_P[Y] = 1$ et, sous $Q$, $B_T \sim N(\theta T, T)$ : la densité est la densité sous $P$ multipliée par $Y$. Les trajectoires possibles ne changent pas, seuls leurs poids changent ; la dérive bouge, pas la volatilité. La page vérifie $\mathbb E_P[Y] \approx 1$ et $\mathbb E_P[Y B_T] = \theta T$.

**Application.** On lit le théorème dans l'autre sens : on simule sous une mesure où l'événement rare devient typique, puis on corrige par $dP/dQ$ (section 7.3). La page compare le Monte Carlo simple et l'échantillonnage préférentiel sur un call, un put ou une digitale très hors de la monnaie :
- le prix exact, la réduction de variance et la convergence ;
- l'erreur standard en fonction de $\theta$. Elle est minimale près de $\theta^*$ et remonte au-delà, quand quelques poids deviennent énormes.

### 19.6 Monde réel P et risque-neutre Q sur un vrai titre

**Deux lognormales, une seule vol.** Sous $P$, $\ln S_T \sim N\big(\ln S_0 + (\mu - q - \tfrac12\sigma^2)T,\ \sigma^2 T\big)$ ; sous $Q$, $\mu$ est remplacé par $r$. Girsanov change la dérive de $\lambda = (\mu - r)/\sigma$, le prix de marché du risque, et laisse $\sigma$ inchangée : les deux lois utilisent la vol implicite à la monnaie de la maturité. Pour une lognormale, $\text{mode} = e^{m - s^2} < \text{médiane} = e^{m} < \text{moyenne} = e^{m + s^2/2}$, avec $m$ et $s^2$ la moyenne et la variance de $\ln S_T$. Sous $Q$, la moyenne est le forward $S_0 e^{(r-q)T}$.

**Le $Q$ du marché (Breeden-Litzenberger, 1978).** Avec $C(K) = D\,\mathbb E_Q[(S_T - K)^+]$ :
$$Q(S_T \le K) = 1 + \frac{1}{D}\frac{\partial C}{\partial K}, \qquad q(K) = \frac{1}{D}\frac{\partial^2 C}{\partial K^2}.$$
Les prix de calls viennent de la surface SVI (section 15) sur une grille uniforme de 2 001 strikes, de $F e^{-12\sigma\sqrt T}$ à $F e^{6\sigma\sqrt T}$, et les dérivées sont prises par différences finies centrées. Contrôles affichés : masse de la densité, $\mathbb E_Q[S_T]$ contre le forward (écart de l'ordre de 0,01 % sur SPY), masse négative (arbitrage papillon), masse hors de la grille. Le skew épaissit la queue gauche : à vol ATM égale, $Q(S_T < 0{,}8\,S_0)$ à 3 mois est d'environ 6 % pour SPY, contre 1,5 % pour la lognormale. Pour garder la moyenne au forward, la médiane et le mode remontent au-dessus du spot.

**Le rendement espéré $\mu$.** Trois sources possibles :
- CAPM : $\mu = r + \beta \cdot \text{prime}$, avec $\beta$ estimé contre SPY sur l'historique et la prime de marché égale à la moyenne arithmétique du facteur marché de Fama-French depuis 1926 (environ 7,8 % par an) ;
- historique du titre : $\hat\mu = 252\,\overline{\Delta \ln S} + \tfrac12\hat\sigma^2 + q$, d'erreur standard $\hat\sigma/\sqrt{\text{années}}$, soit environ 12 points pour SPY sur deux ans. C'est la raison du CAPM par défaut ;
- une valeur libre.

La page superpose aussi la loi empirique : les rendements historiques sur l'horizon, en fenêtres qui se chevauchent et donc très corrélées.

**Éventail et noyau de prix.** Les quantiles à 5, 50 et 95 % sont tracés selon l'horizon sous $P$, sous $Q$ lognormale et sous le $Q$ du marché. Le rapport $q/p$ est la densité des prix d'état au facteur d'actualisation près. Pour deux lognormales, il vaut $\exp(-\lambda W_T - \tfrac12\lambda^2 T)$, décroissant en $S_T$ quand $\mu > r$. Avec le smile, il est beaucoup plus pentu à gauche, et sa forme non monotone autour du spot est le *pricing kernel puzzle* (Jackwerth, 2000).

**Tests.** Sur un smile plat, Breeden-Litzenberger redonne la lognormale (densité à $10^{-5}$ près, fonction de répartition à $10^{-5}$ près, moyenne égale au forward). Sont aussi testés : l'ordre mode < médiane < moyenne et les formules fermées, un décalage de tous les quantiles de $e^{(\mu - r)T}$ entre $P$ et $Q$, la queue gauche plus épaisse sous un skew avec la moyenne inchangée, la décroissance du noyau quand $\mu > r$, et l'erreur standard de $\hat\mu$ sur 40 ans simulés.

---

## 20. Crédit : CDS et modèle de Merton

*Fichiers : `qplat/credit/cds.py`, `qplat/credit/merton.py`, `api/routers/credit.py`*

### 20.1 Courbe de défaut

Le défaut est le premier saut d'un processus de Poisson d'intensité $\lambda(t)$, constante par morceaux entre des piliers $T_1 < \dots < T_n$ (et constante au-delà du dernier) :

$$
Q(t) = \mathbb{P}(\tau > t) = \exp\left( -\int_0^t \lambda(s)\, ds \right)
$$

**Triangle du crédit** : avec une intensité constante, $s \approx \lambda (1 - R)$.

### 20.2 Les deux jambes d'un CDS

Prime $c$ payée trimestriellement (base ACT/360, échéancier construit à rebours depuis la maturité), recouvrement $R$, courbe d'actualisation $P(0,t)$ :

$$
\text{Protection} = (1 - R) \int_0^T P(0,t)\, dF(t), \qquad F = 1 - Q
$$

$$
\text{RPV01} = \sum_k \alpha_k\, P(0,t_k)\, Q(t_k) \;+\; \underbrace{\int_0^T \alpha(t)\, P(0,t)\, dF(t)}_{\text{prime courue payée au défaut}}
$$

Les intégrales sont calculées sur une grille hebdomadaire qui inclut toutes les dates de paiement et les piliers. Sur chaque sous-intervalle, $\lambda$ et le taux forward $f$ sont constants, et la formule de l'ISDA Standard Model est exacte :

$$
\int_a^b \lambda\, P(t) Q(t)\, dt = \frac{\lambda}{\lambda + f} \left[ P(a)Q(a) - P(b)Q(b) \right]
$$

**Spread au pair** : $s = \text{Protection} / \text{RPV01}$.

**Upfront.** Depuis le Big Bang de 2009, un CDS se traite avec un coupon standard (100 bp pour l'investment grade, 500 bp pour le high yield). La différence se règle à la signature : $U = \text{Protection} - c \cdot \text{RPV01}$, positif si l'acheteur de protection paie.

### 20.3 Bootstrap

On part des spreads au pair cotés pour $T_1 < \dots < T_n$. On résout séquentiellement $\lambda_j$ (Brent) sur le segment $(T_{j-1}, T_j]$ pour que le CDS de maturité $T_j$ reprice son spread, les segments précédents étant déjà fixés. Chaque spread coté est repricé à $10^{-12}$ près. Une courbe trop inversée exigerait une intensité négative : elle est rejetée.

Il n'existe pas de source gratuite de spreads CDS. La plateforme propose donc des courbes types (A, BBB, BB, B, stressée), une saisie libre, et la courbe implicite du modèle de Merton (section 20.6).

### 20.4 Risques d'une position

Valeur pour l'acheteur de protection : $N(\text{Protection} - c \cdot \text{RPV01})$ ; pour le vendeur, l'opposé.

| Mesure | Définition |
|---|---|
| CS01 | variation de valeur pour +1 bp sur tous les spreads cotés, courbe re-bootstrapée ($\approx N \cdot \text{RPV01} \cdot 10^{-4}$) |
| IR01 | +1 bp sur la courbe de taux, spreads cotés inchangés (re-bootstrap) |
| Recouvrement +1 % | spreads cotés inchangés : un recouvrement plus haut implique une intensité plus forte |
| Jump-to-default | $\pm N(1 - R) - V$ : P&L si l'émetteur fait défaut immédiatement |
| Portage 1 jour | $\mp N c / 360$ |

### 20.5 Modèle de Merton (1974)

La valeur des actifs $V$ suit un mouvement brownien géométrique de volatilité $\sigma_V$. La dette est un zéro-coupon de nominal $D$ à l'horizon $T$, et le défaut a lieu si $V_T < D$. L'action est donc un call sur les actifs :

$$
E = V N(d_1) - D e^{-rT} N(d_2), \qquad d_{1,2} = \frac{\ln(V/D) + (r \pm \sigma_V^2/2) T}{\sigma_V \sqrt T}
$$

$$
\sigma_E E = N(d_1)\, \sigma_V V \qquad \text{(lemme d'Itô)}
$$

**Calibration.** $E$ (cours × nombre d'actions) et $\sigma_E$ (vol implicite ATM 1 an de la surface SVI quand elle existe, sinon vol réalisée 1 an) sont observés. On résout ces deux équations en $(V, \sigma_V)$ par moindres carrés, en variables logarithmiques normalisées par $E$, avec une tolérance de $10^{-14}$.

**Point de défaut.** Le bilan annuel est téléchargé chaque semaine (Yahoo Finance) et converti dans la devise de cotation si besoin. Par défaut, on prend la convention KMV : $D$ = dette court terme + ½ dette long terme. La dette totale ou une valeur libre sont aussi possibles.

**Sorties :**

$$
\text{DD} = d_2, \qquad \text{PD}^{\mathbb Q} = N(-d_2), \qquad B = V - E = D e^{-rT} - \text{Put}(V, D)
$$

$$
s = -\frac1T \ln\frac{B}{D e^{-rT}}, \qquad R_{impl} = \frac{\mathbb{E}^{\mathbb Q}[V_T \mid V_T < D]}{D} = \frac{V e^{rT} N(-d_1)}{D\, N(-d_2)}
$$

**Structure par terme.** Avec $V$ et $\sigma_V$ fixés, on recalcule la probabilité de défaut et le spread pour une dette de maturité $T$ variable.

**Sensibilités.**
- Spread en fonction de la vol action.
- Spread en fonction du cours de l'action, à dette inchangée : c'est le lien actions / crédit, base de l'arbitrage de structure du capital.
- Variation du spread pour une baisse de 1 % de l'action.

### 20.6 Du structurel au CDS

La survie de Merton $Q(T) = N(d_2(T))$ est échantillonnée chaque trimestre. On en tire une intensité constante par morceaux, puis les spreads CDS au pair avec un recouvrement de marché (en général 40 %, distinct du recouvrement implicite du modèle). Cette courbe peut être envoyée au pricer CDS.

**Vol implicite du crédit.** Si l'on saisit un CDS 5 ans observé, on cherche par Brent la vol action $\sigma_E$ pour laquelle Merton redonne ce spread.

**Limite connue.** Pour une grande entreprise peu endettée, Merton donne des spreads quasi nuls, surtout à court terme. Le processus des actifs est continu : une firme à 9 écarts-types de son point de défaut ne peut pas l'atteindre en un an. Les spreads observés sont bien plus élevés : c'est le *credit spread puzzle*. Les extensions classiques ajoutent :
- une barrière franchissable à tout moment (Black-Cox) ;
- un point de défaut incertain (CreditGrades) ;
- des sauts dans la valeur des actifs.

---

## 21. Options de taux et de change

*Fichiers : `qplat/pricers/capfloor.py`, `qplat/fx/options.py`, `qplat/fx/smile.py`, `api/routers/caps_fx.py`*

### 21.1 Caps et floors

Un cap de maturité $T$ et de fréquence $f$ est une série de caplets sur les périodes $(t_{i-1}, t_i]$, avec $t_i = i/f$. La première période, déjà fixée aujourd'hui, est exclue. Le taux forward simple est lu sur la courbe :

$$
F_i = \frac{1}{\tau_i} \left( \frac{P(0, t_{i-1})}{P(0, t_i)} - 1 \right), \qquad \tau_i = t_i - t_{i-1}
$$

Le caplet $i$ est une option sur $L_i$, fixé en $t_{i-1}$ et payé en $t_i$.

**Black-76** (taux log-normal) :

$$
\text{Caplet}_i = N \tau_i P(0,t_i) \left[ F_i N(d_1) - K N(d_2) \right], \qquad d_{1,2} = \frac{\ln(F_i/K) \pm \sigma^2 t_{i-1}/2}{\sigma \sqrt{t_{i-1}}}
$$

**Bachelier** (taux normal, utilisable avec des taux nuls ou négatifs ; vol en points de base) :

$$
\text{Caplet}_i = N \tau_i P(0,t_i) \left[ (F_i - K) N(d) + \sigma_n \sqrt{t_{i-1}}\, n(d) \right], \qquad d = \frac{F_i - K}{\sigma_n \sqrt{t_{i-1}}}
$$

Les floorlets sont les puts correspondants.

**Parité** : cap − floor = swap payeur $= \sum_i N \tau_i P(0,t_i)(F_i - K)$. Le strike **ATM** est le taux swap forward des mêmes périodes, $S = \dfrac{P(0,t_1) - P(0,t_n)}{\sum_i \tau_i P(0,t_i)}$ ; à ce strike, cap et floor valent la même chose.

**Prime en running** : prime divisée par l'annuité $\sum_i N \tau_i P(0,t_i)$.

**Vol plate implicite** : la vol unique qui reprice le cap entier, obtenue par Brent. C'est la cotation usuelle du marché.

**Grecques** :
- **DV01** : variation pour une translation de +1 bp de la courbe, vol inchangée ; le **gamma** est la différence seconde sur ±1 bp.
- **Vega** : pour 1 % de vol log-normale ou 1 bp de vol normale.
- **Theta** : toutes les dates rapprochées d'un jour.

Le tableau des caplets donne pour chacun la contribution, le delta pour 1 bp de forward et le vega.

**Limites.**
- Les vols de caps ne sont pas diffusées gratuitement : elles sont saisies.
- Les forwards sont tirés des courbes d'État (Treasury, BCE), pas des courbes swap SOFR / €STR.

### 21.2 Options de change : Garman-Kohlhagen

Le sous-jacent est le prix d'une unité de devise **étrangère** en devise **domestique** (EUR/USD : étranger EUR, domestique USD). Le taux étranger joue le rôle d'un dividende :

$$
V = \varphi \left[ S e^{-r_f T} N(\varphi d_1) - K e^{-r_d T} N(\varphi d_2) \right], \qquad F = S e^{(r_d - r_f) T}
$$

$r_d$ et $r_f$ sont les taux zéro-coupon USD et EUR à l'échéance. Les points forward $(F - S) \times 10^4$ découlent de la parité des taux couverte, sans base cross-currency.

**Grecques** (formules fermées, vérifiées par différences finies) :
- **Delta** : delta spot $\varphi e^{-r_f T} N(\varphi d_1)$, delta forward $\varphi N(\varphi d_1)$, et delta ajusté de la prime, égal au delta spot moins $V/S$.
- **Gamma, vega, vanna et volga**, ces deux dernières étant les sensibilités croisées qui pilotent le smile.
- **Theta**.
- **Deux rhos** : domestique $\varphi K T e^{-r_d T} N(\varphi d_2)$ et étranger $-\varphi S T e^{-r_f T} N(\varphi d_1)$.

### 21.3 Le smile FX coté en delta

Pour chaque échéance, le marché des changes cote trois nombres.
- **ATM** : la vol du straddle delta-neutre, de strike $K_{ATM} = F e^{\sigma_{ATM}^2 T / 2}$ (les deltas du call et du put s'annulent).
- **Risk reversal 25Δ** : $RR = \sigma_{25C} - \sigma_{25P}$, l'asymétrie du smile.
- **Butterfly 25Δ de marché** (*broker fly*) : une seule vol $\sigma_{ATM} + BF_{mkt}$ price le strangle dont les strikes sont les 25 deltas à cette vol.

**Strike d'un delta** (delta spot, non ajusté de la prime) :

$$
K = F \exp\left( -\varphi N^{-1}\!\left(\varphi\, \Delta\, e^{r_f T}\right) \sigma \sqrt T + \tfrac12 \sigma^2 T \right)
$$

Au-delà d'un an, on prend le delta forward, sans le facteur $e^{r_f T}$.

**Butterfly de smile** (Clark, 2011). Le butterfly de marché n'est pas la moyenne $(\sigma_{25C} + \sigma_{25P})/2 - \sigma_{ATM}$ du smile. On cherche par Brent le butterfly de smile $BF_s$ tel que :
- les piliers sont $\sigma_{25C/P} = \sigma_{ATM} + BF_s \pm RR/2$, à leurs propres strikes 25 delta ;
- le smile qu'ils définissent reprice exactement le strangle de marché.

### 21.4 Interpolation Vanna-Volga

Avec les trois piliers $K_1 < K_2 = K_{ATM} < K_3$ (Castagna et Mercurio, 2007), le prix d'un call de strike $K$ est le prix Black-Scholes à la vol ATM, corrigé par le surcoût de marché des trois options piliers :

$$
C(K) = C_{BS}(K, \sigma_{ATM}) + \sum_{i=1}^{3} x_i(K) \left[ C_{BS}(K_i, \sigma_i) - C_{BS}(K_i, \sigma_{ATM}) \right]
$$

Les poids $x_i(K)$ résolvent le système $3 \times 3$ qui égalise le vega, la vanna et la volga du portefeuille de piliers à ceux de l'option en $K$. La vol affichée est la vol implicite de ce prix. L'approximation au premier ordre est une interpolation de Lagrange des trois vols en $\ln K$ ; elle est tracée en comparaison et s'en écarte dans les ailes.

**Densité risque-neutre** : $q(K) = e^{r_d T} \partial^2 C / \partial K^2$, par différences finies sur les prix Vanna-Volga. Une densité négative signalerait un arbitrage papillon.

**Option pricée sur le smile.** Pour un strike donné par un delta, le strike et la vol dépendent l'un de l'autre : on itère jusqu'au point fixe. L'**effet du smile** est la différence entre la prime à la vol du smile et la prime à la vol ATM.

**Limite.** Les cotations ATM, RR et BF ne sont pas diffusées gratuitement. La vol ATM part de la vol réalisée sur un an d'EUR/USD ; le risk reversal et le butterfly sont saisis.

---

## 22. Données et orchestration

*Fichiers : `qplat/data/*.py`, `scripts/refresh.py`*

### 22.1 Sources

| Donnée | Source | Fréquence |
|---|---|---|
| Cours de clôture (2 ans) et dernier cours | yfinance | chaque passage |
| Nom, secteur, devise, dividende ($q$ = rendement sur 12 mois glissants) | yfinance | chaque passage |
| Chaînes d'options (US) | yfinance | chaque passage |
| Bilan : nombre d'actions, dettes court et long terme, devise des comptes (modèle de Merton) | yfinance | une fois par semaine |
| Taux USD | FRED (CSV public), repli yfinance | chaque passage |
| Taux EUR | API de données de la BCE | chaque passage |
| Taux de change EUR/USD (conversion du portefeuille en euros) | yfinance (EURUSD=X) | chaque passage |
| VIX (vol implicite 30 jours du S&P 500, swaps de variance) | yfinance (^VIX) | chaque passage |
| Facteurs Fama-French quotidiens depuis 1926 (marché, SMB, HML, RMW, CMA, momentum, taux sans risque) | bibliothèque de Kenneth French | une fois par semaine |
| News | flux RSS Yahoo Finance (édition FR pour l'Europe), Alpha Vantage en option | chaque passage |

### 22.2 Volatilité réalisée

Volatilité par défaut des pricers et vol 1 mois de la vue d'ensemble :

$$
\sigma_{réalisée} = \sqrt{252} \times \text{écart-type}\big(\ln(S_t / S_{t-1})\big)
$$

sur les 252 derniers rendements journaliers (1 an) ou les 21 derniers (1 mois).

### 22.3 Rafraîchissement

Une tâche cron s'exécute toutes les 15 minutes en semaine. Le script ne rafraîchit que les sous-jacents dont le marché est ouvert :

| Marché | Fuseau | Ouverture |
|---|---|---|
| US | New York | 9h30 – 16h00 |
| EU | Paris | 9h00 – 17h30 |

Chaque tâche est journalisée dans la table `refresh_log`. Une erreur sur un sous-jacent n'interrompt pas les autres.

Pour la version en ligne, GitHub Actions exécute la même tâche toutes les heures en semaine (de 7h à 21h UTC), puis republie le site.

Le scoring du sentiment ne porte que sur les news de moins de 7 jours, au plus 100 par passage. Ainsi, une interruption, comme un crédit épuisé, ne se transforme jamais en grosse facture de rattrapage.

---

## 23. Sentiment des news par IA

*Fichier : `qplat/data/sentiment.py` — modèle `claude-opus-5-5`, effort `low`*

### 23.1 Scoring

Les titres non encore notés sont envoyés à Claude par paquets de 25, regroupés par sous-jacent. La consigne demande, pour chaque titre, l'impact probable sur le cours du sous-jacent dans les prochaines séances, vu par un actionnaire. Les titres sont traités comme des données, jamais comme des instructions. La réponse est contrainte par un schéma JSON :

| Champ | Contenu |
|---|---|
| `score` | nombre dans $[-1\,;\,1]$, borné côté serveur |
| `label` | very_negative, negative, neutral, positive ou very_positive |
| `rationale` | une phrase de justification |

### 23.2 Agrégation

Le sentiment d'un sous-jacent est une moyenne pondérée par la récence, avec une demi-vie de 3 jours. Pour un article d'âge $a$ jours et de score $s$ :

$$
w = 0{,}5^{\,a/3}, \qquad \text{Sentiment} = \frac{\sum w_i\, s_i}{\sum w_i}
$$

Le sentiment d'un secteur est la moyenne des sentiments de ses sous-jacents, pondérée par leur nombre d'articles.

---

## 24. Validation

*Dossier : `tests/` — 225 tests*

| Référence | Vérification |
|---|---|
| Hull, exemple 15.6 | call 4,7594 et put 0,8086 (S = 42, K = 40, r = 10 %, σ = 20 %, T = 0,5) |
| Relations d'arbitrage | parité call-put ; parité in/out des barrières ; obligation au pair égale à 100 |
| Grecques | formules fermées comparées aux différences finies |
| Convergence | arbre et Monte Carlo vers Black-Scholes, y compris avec une courbe non plate |
| Longstaff-Schwartz (2001) | put américain S = 36, K = 40, r = 6 %, σ = 20 %, T = 1 : environ 4,48 par l'arbre et par LSM |
| Haug, table 4-13 | les 24 valeurs de barrières retrouvées à $10^{-4}$ près |
| Digitales | valeurs de Haug (cash et asset-or-nothing), parités, limite du call spread, delta et vega en formule fermée, Monte Carlo |
| Asiatiques | un fixing = européenne ; limite de Kemna-Vorst ; géométrique fermée vs Monte Carlo ; variable de contrôle (réduction > 50) ; Lévy à 1 % du Monte Carlo |
| Cliquets | formule fermée vs Monte Carlo ; somme des rendements forward ; delta nul ; floor global ; payoff recalculé à la main |
| Bootstrap | chaque quote repricée à $10^{-10}$ près |
| Autocall | cas dégénérés (zéro-coupon, forward prépayé, rappel certain) |
| Arbre | un nœud recalculé à la main redonne la valeur du moteur |
| Heston | limite Black-Scholes, parité, Monte Carlo, paramètres retrouvés par la calibration |
| SVI / Dupire | ajustement retrouvé, vol locale d'une surface plate, détection d'arbitrage calendaire, Monte Carlo sous vol locale |
| Risques | swap de variance en portefeuille (valeur nulle au strike juste, vega et gamma au départ, variance réalisée d'un swap en cours de vie, choc de vol) ; cap et option de change en portefeuille (cohérence avec les pricers, caplet en cours à sa valeur intrinsèque, choc de vol sur le smile FX) ; CDS en portefeuille (cohérence avec le moteur crédit, symétrie acheteur/vendeur, choc de spreads ≈ CS01, mise à jour des spreads) ; digitale, asiatique et cliquet en portefeuille, fixings passés lus dans l'historique ; valorisation en euros, cohérence Black-Scholes, stress linéaire exact, VaR historique et paramétrique, explication du P&L |
| Calcul stochastique et Girsanov | variation totale ≈ √(2N/π), variation quadratique → T avec un écart-type √(2/N), sommes d'Itô et au point droit (espérances 0 et T), martingales et non-martingales, Girsanov (E_P[Y] = 1, moyenne θT), échantillonnage préférentiel sans biais avec une variance divisée par plus de 100 hors de la monnaie, grecques Monte Carlo avec échantillonnage préférentiel |
| Théorie appliquée | exemple du cours (put 10,714 puis 11,820, Δ et B de chaque nœud, Q(S₂ = 96) = 0,46875), autofinancement à chaque nœud, absence d'arbitrage d < R < u, market maker couvert sur tous les chemins, convergence de l'arbre vers Black-Scholes, erreur de couverture en 1/√N (Derman-Kamal), indépendance du drift, P&L à vol réalisée ≠ implicite, backtest synthétique |
| Monde réel P et risque-neutre Q | Breeden-Litzenberger sur smile plat = lognormale (densité et répartition à 1e-5, moyenne = forward), mode < médiane < moyenne, quantiles décalés de e^{(μ−r)T}, skew : queue gauche plus épaisse à forward inchangé, noyau de prix décroissant si μ > r, erreur standard de μ̂ en σ/√années |
| Recherche (Moreira-Muir) | rendement mensuel composé et variance réalisée, MCO Newey-West, même volatilité par construction, variance constante → stratégie = facteur, alpha positif sous régimes de volatilité et nul sans, version temps réel sans look-ahead, plafond de levier et coûts |
| Allocation | minimum variance et moyenne-variance sans contrainte égaux aux formules fermées, frontière contrainte au-dessus de la frontière de Markowitz, tangence de Sharpe maximal (y compris la formule Σ⁻¹(μ − r)), long-only et plafonds respectés, LASSO inactif en long-only et actif avec shorts, coûts qui réduisent puis gèlent la rotation, Ledoit-Wolf défini positif et moins rétréci avec plus de données, conversion en euros, backtest sans look-ahead |
| Swaps de variance | variance réalisée (convention sans moyenne), smile plat → σ², réplication du smile de Heston = variance espérée de Heston, convexité du swap de vol (Jensen et approximation), formule du VIX sur une chaîne Black-Scholes, troncature de la bande, interpolation à 30 jours, valeur d'un swap en cours de vie et vega |
| Caps / floors | caplet = Black-76, parité cap − floor = swap, cap = floor au strike ATM, Black ≈ Bachelier près de la monnaie, rejet de Black avec des taux négatifs, vol plate implicite |
| Options de change | Garman-Kohlhagen = Black-Scholes avec dividende étranger, parité, grecques par différences finies, aller-retour delta ↔ strike, straddle delta-neutre, Vanna-Volga reprice les piliers, smile plat, strangle de marché repricé, densité positive |
| CDS | survie d'une courbe par morceaux, jambe de protection en formule fermée, triangle du crédit, bootstrap exact, rejet d'une courbe inversée, CDS au pair de valeur nulle, CS01 ≈ RPV01 × nominal × 1 bp, jump-to-default |
| Merton | aller-retour de la calibration, dette = sans risque − put (Black-Scholes), monotonie en levier et en vol, courbe de survie, vol implicite d'un spread |
| API | routes testées sur une base de test synthétique, dont une chaîne d'options générée par Heston |

---

## 25. Limites et extensions possibles

- **Volatilité** : Heston et volatilité locale sont calibrés séparément. Un modèle à volatilité locale-stochastique (LSV) combinerait les deux.
- **Calendrier** : pas de jours fériés (NYSE, Euronext) ; échéancier obligataire régulier calculé à rebours.
- **Future obligataire** : sans option *cheapest-to-deliver* ni ajustement de convexité.
- **Options européennes** : Yahoo ne diffuse pas de chaînes d'options pour l'Europe, donc pas de smile EUR.
- **Taux** : déterministes. Un modèle de taux court (Hull-White) permettrait de pricer des produits sensibles aux taux.

---

## 26. Références

- Black, F. & Scholes, M. (1973). *The Pricing of Options and Corporate Liabilities*. Journal of Political Economy.
- Merton, R. (1973). *Theory of Rational Option Pricing*. Bell Journal of Economics.
- Merton, R. (1974). *On the Pricing of Corporate Debt: The Risk Structure of Interest Rates*. Journal of Finance.
- ISDA (2009). *ISDA CDS Standard Model* (conventions du « Big Bang » des CDS).
- Glasserman, P. (2003). *Monte Carlo Methods in Financial Engineering*. Springer (chapitre 4.6, échantillonnage préférentiel).
- Derman, E. & Kamal, M. (1999). *When You Cannot Hedge Continuously: The Corrections of Black-Scholes*. Risk.
- Carr, P. (2005). *FAQ's in Option Pricing Theory*. Journal of Derivatives.
- Ahmad, R. & Wilmott, P. (2005). *Which Free Lunch Would You Like Today, Sir? Delta Hedging, Volatility Arbitrage and Optimal Portfolios*. Wilmott Magazine.
- Moreira, A. & Muir, T. (2017). *Volatility-Managed Portfolios*. Journal of Finance.
- Cederburg, S., O'Doherty, M., Wang, F. & Yan, X. (2020). *On the Performance of Volatility-Managed Portfolios*. Journal of Financial Economics.
- Fama, E. & French, K. (1993, 2015). *Common Risk Factors in the Returns on Stocks and Bonds* ; *A Five-Factor Asset Pricing Model*. Journal of Financial Economics.
- Newey, W. & West, K. (1987). *A Simple, Positive Semi-Definite, Heteroskedasticity and Autocorrelation Consistent Covariance Matrix*. Econometrica.
- Markowitz, H. (1952). *Portfolio Selection*. Journal of Finance.
- Michaud, R. (1989). *The Markowitz Optimization Enigma: Is Optimized Optimal?* Financial Analysts Journal.
- Jorion, P. (1986). *Bayes-Stein Estimation for Portfolio Analysis*. Journal of Financial and Quantitative Analysis.
- Jagannathan, R. & Ma, T. (2003). *Risk Reduction in Large Portfolios: Why Imposing the Wrong Constraints Helps*. Journal of Finance.
- Ledoit, O. & Wolf, M. (2004). *A Well-Conditioned Estimator for Large-Dimensional Covariance Matrices*. Journal of Multivariate Analysis.
- DeMiguel, V., Garlappi, L. & Uppal, R. (2009). *Optimal Versus Naive Diversification: How Inefficient Is the 1/N Portfolio Strategy?* Review of Financial Studies.
- Brodie, J., Daubechies, I., De Mol, C., Giannone, D. & Loris, I. (2009). *Sparse and Stable Markowitz Portfolios*. PNAS.
- Demeterfi, K., Derman, E., Kamal, M. & Zou, J. (1999). *More Than You Ever Wanted to Know About Volatility Swaps*. Goldman Sachs Quantitative Strategies.
- Carr, P. & Madan, D. (1998). *Towards a Theory of Volatility Trading*. Volatility, Risk Publications.
- Carr, P. & Wu, L. (2009). *Variance Risk Premiums*. Review of Financial Studies.
- CBOE (2019). *VIX White Paper: Cboe Volatility Index*.
- Black, F. (1976). *The Pricing of Commodity Contracts*. Journal of Financial Economics.
- Bachelier, L. (1900). *Théorie de la spéculation*. Annales scientifiques de l'École normale supérieure.
- Garman, M. & Kohlhagen, S. (1983). *Foreign Currency Option Values*. Journal of International Money and Finance.
- Castagna, A. & Mercurio, F. (2007). *The Vanna-Volga Method for Implied Volatilities*. Risk.
- Clark, I. (2011). *Foreign Exchange Option Pricing: A Practitioner's Guide*. Wiley.
- O'Kane, D. (2008). *Modelling Single-name and Multi-name Credit Derivatives*. Wiley.
- Cox, J., Ross, S. & Rubinstein, M. (1979). *Option Pricing: A Simplified Approach*. Journal of Financial Economics.
- Reiner, E. & Rubinstein, M. (1991). *Breaking Down the Barriers*. Risk.
- Broadie, M., Glasserman, P. & Kou, S. (1997). *A Continuity Correction for Discrete Barrier Options*. Mathematical Finance.
- Longstaff, F. & Schwartz, E. (2001). *Valuing American Options by Simulation: A Simple Least-Squares Approach*. Review of Financial Studies.
- Svensson, L. (1994). *Estimating and Interpreting Forward Interest Rates*. NBER Working Paper.
- Lewis, A. (2001). *A Simple Option Formula for General Jump-Diffusion and Other Exponential Lévy Processes*.
- Heston, S. (1993). *A Closed-Form Solution for Options with Stochastic Volatility*. Review of Financial Studies.
- Albrecher, H., Mayer, P., Schoutens, W. & Tistaert, J. (2007). *The Little Heston Trap*. Wilmott Magazine.
- Dupire, B. (1994). *Pricing with a Smile*. Risk.
- Gatheral, J. (2006). *The Volatility Surface*. Wiley.
- Gatheral, J. & Jacquier, A. (2014). *Arbitrage-free SVI Volatility Surfaces*. Quantitative Finance.
- Glasserman, P. (2003). *Monte Carlo Methods in Financial Engineering*. Springer.
- Haug, E. G. (2007). *The Complete Guide to Option Pricing Formulas*. McGraw-Hill.
- Hull, J. (2022). *Options, Futures, and Other Derivatives*. Pearson.
