# Documentation technique de QPLAT

Ce document décrit comment chaque nombre affiché par la plateforme est calculé : conventions, modèles, algorithmes, paramètres numériques et sources de données. Chaque section renvoie au fichier du code qui l'implémente.

---

## 1. Architecture

La plateforme est organisée en quatre couches, chacune ignorant le fonctionnement des autres :

| Couche | Dossier | Rôle |
|---|---|---|
| Moteur de calcul | `qplat/core`, `qplat/curves`, `qplat/instruments`, `qplat/pricers`, `qplat/models`, `qplat/risk`, `qplat/analytics` | Conventions, courbes de taux, instruments, méthodes de pricing. Python pur (numpy, scipy). |
| Données | `qplat/data` | Téléchargement des marchés, taux et news ; stockage SQLite ; scoring du sentiment par Claude. |
| Interface | `api/` (FastAPI), `web/` (React) | L'API expose le moteur et la base ; l'interface web l'appelle. |
| Orchestration | `scripts/refresh.py`, crontab | Rafraîchissement automatique pendant les heures de marché. |

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

### 7.3 Longstaff-Schwartz (exercice américain)

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

## 11. Smile de volatilité implicite

*Fichiers : `qplat/analytics/smile.py`, `qplat/data/market.py`*

1. **Sélection des échéances** : pour chaque horizon cible (7, 14, 30, 60, 90, 180, 270, 365 et 545 jours), on retient l'échéance cotée la plus proche.
2. **Temps jusqu'à l'échéance** : mesuré à la seconde, depuis l'heure du snapshot jusqu'à 16h00 (New York) le jour d'expiration, divisé par 365 jours.
3. **Prix retenu** : le mid $(bid + ask)/2$ s'il existe une cotation des deux côtés, sinon le dernier prix traité.
4. **Filtres** : options hors de la monnaie uniquement (puts sous le spot, calls au-dessus), moneyness $K/S \in [0{,}7\,;\,1{,}3]$, plus de 2 jours avant l'échéance.
5. **Inversion** : volatilité implicite par Brent (section 5.4), avec le taux zéro $z(T)$ de la courbe et le dividende du sous-jacent.
6. **Structure par terme ATM** : pour chaque échéance, la volatilité implicite du strike le plus proche de la monnaie.

---

## 12. Modèle de Heston (volatilité stochastique)

*Fichiers : `qplat/models/heston.py`, `qplat/models/market_models.py`*

### 12.1 Dynamique

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

### 12.2 Fonction caractéristique

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

### 12.3 Prix européen : formule de Lewis

$$
C(K) = S e^{-qT} - \frac{\sqrt{SK}\, e^{-(r+q)T/2}}{\pi} \int_0^{\infty} \mathrm{Re}\!\left[e^{iux}\, \varphi_T\!\left(u - \tfrac{i}{2}\right)\right] \frac{du}{u^2 + 1/4}, \qquad x = \ln\frac{S}{K} + (r-q)T
$$

L'intégrale est calculée par quadrature de Gauss-Legendre (400 nœuds) sur $[0, U]$, avec $U = \sqrt{80 / (v_{min} T)}$ borné entre 100 et 3000. L'intégrande décroît comme $e^{-vTu^2/2}$. La fonction caractéristique ne dépend que de $T$ : elle est évaluée une seule fois par échéance pour tous les strikes. Les puts s'obtiennent par parité call-put.

**Vérifications** : avec une vol de vol quasi nulle et $v_0 = \theta$, le prix redonne Black-Scholes à $10^{-5}$ près. Il concorde aussi avec la simulation Monte Carlo de Heston.

### 12.4 Calibration

Points utilisés : la partie liquide du smile, soit les échéances de 14 jours ou plus, la zone $|\ln(K/S)| \le \max(0{,}08\,;\,0{,}35\sqrt{T})$, et au plus 25 options par échéance.

On minimise par moindres carrés bornés (Trust Region Reflective) les erreurs de prix normalisées par le vega Black-Scholes, qui sont au premier ordre des erreurs de volatilité implicite :

$$
\min_{v_0,\kappa,\theta,\sigma,\rho} \sum_j \left(\frac{V^{Heston}_j - V^{marché}_j}{\nu^{BS}_j}\right)^2
$$

Bornes : $v_0, \theta \in [10^{-4}, 1{,}5]$, $\kappa \in [0{,}05, 15]$, $\sigma \in [0{,}01, 3]$, $\rho \in [-0{,}99, 0{,}99]$. Point de départ : $v_0$ et $\theta$ tirés des vols implicites de la plus courte et de la plus longue échéance, $\kappa = 2$, $\sigma = 0{,}6$, $\rho = -0{,}6$.

La qualité affichée (RMSE et erreur maximale) est l'écart **exact** de volatilité implicite après inversion des prix du modèle. Sur des données synthétiques, la calibration retrouve les paramètres à $10^{-3}$ près en relatif.

### 12.5 Simulation (exotiques sous Heston)

Schéma d'Euler à troncature complète sur $(\ln S, v)$, avec 252 pas par an et des variables antithétiques. On note $v^+ = \max(v, 0)$ :

$$
\ln S_{t+\Delta} = \ln S_t + \ln\frac{P(0,t)}{P(0,t+\Delta)} - q\Delta - \tfrac{1}{2}v_t^+\Delta + \sqrt{v_t^+ \Delta}\, Z_1
$$

$$
v_{t+\Delta} = v_t + \kappa(\theta - v_t^+)\Delta + \sigma\sqrt{v_t^+\Delta}\left(\rho Z_1 + \sqrt{1-\rho^2}\, Z_2\right)
$$

---

## 13. Surface de volatilité SVI et volatilité locale de Dupire

*Fichier : `qplat/models/svi.py`*

### 13.1 SVI par échéance

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

### 13.2 Interpolation entre échéances

La variance totale est interpolée linéairement en $T$ à $k$ fixé, ce qui préserve l'absence d'arbitrage calendaire. Avant la première échéance et après la dernière, la volatilité implicite est prolongée à plat.

### 13.3 Volatilité locale de Dupire

La volatilité locale est l'unique fonction $\sigma_{loc}(S, t)$ telle que $dS/S = (r - q)\,dt + \sigma_{loc}\,dW$ reproduise tous les prix européens. Exprimée en variance totale (Gatheral, *The Volatility Surface*, éq. 1.10) :

$$
\sigma_{loc}^2(k, T) = \frac{\partial w / \partial T}{g(k, T)}
$$

$w'$ et $w''$ sont analytiques en SVI, et $\partial w/\partial T$ vient de l'interpolation entre échéances. Là où $g \le 0$ ou $\partial w / \partial T \le 0$ (arbitrage), la volatilité locale n'est pas définie et vaut NaN.

### 13.4 Simulation sous volatilité locale

On précalcule $\sigma_{loc}$ sur une grille de 60 maturités × 81 moneyness ($k \in [-1, 1]$), interpolée bilinéairement. Les trous d'arbitrage sont comblés par la volatilité implicite, et les valeurs bornées entre 1 % et 300 %. Schéma d'Euler sur $\ln S$ avec 252 pas par an :

$$
\ln S_{t+\Delta} = \ln S_t + \ln\frac{P(0,t)}{P(0,t+\Delta)} - q\Delta - \tfrac{1}{2}\sigma_{loc}^2\Delta + \sigma_{loc}\sqrt{\Delta}\, Z, \qquad \sigma_{loc} = \sigma_{loc}\!\left(\ln\frac{S_t}{F_t},\, t\right)
$$

**Vérification** : une surface plate redonne une volatilité locale plate, et le Monte Carlo sous volatilité locale reprice les vanilles du marché à environ 1 % près.

### 13.5 Exotiques : comparaison des modèles

Le même produit (barrière en observation quotidienne, autocall) est pricé sous trois hypothèses :
- **Black-Scholes**, avec la vol implicite ATM de la surface à la maturité du produit ;
- **Heston** calibré ;
- **volatilité locale**.

Les trois modèles s'accordent sur les vanilles ATM. L'écart de prix entre eux mesure donc le **risque de modèle** dû au smile et à la dynamique de la volatilité. Un autocall avec protection basse est en général surévalué par une vol plate, qui ignore le skew baissier.

---

## 14. Portefeuille et gestion des risques

*Fichiers : `qplat/risk/portfolio.py`, `api/routers/portfolio.py`*

### 14.1 Positions et valorisation

Types de positions : actions, options européennes ou américaines, barrières, autocalls, obligations, futures sur indices. Les maturités sont saisies en dates et converties en ACT/365F à la date de valorisation.

Chaque position est valorisée avec le pricer adapté :

| Type | Pricer |
|---|---|
| Option européenne | Black-Scholes |
| Option américaine | arbre CRR à 200 pas |
| Barrière | formule fermée (BGK si l'observation est discrète) |
| Autocall | Monte Carlo, 20 000 trajectoires |
| Obligation | actualisation sur la courbe |
| Future | portage, avec une valeur égale à $(F - F_{entrée})$ × nominal |

**Données de marché** : dernier cours, dividende, courbe de la devise. La volatilité est la vol ATM de la surface SVI à la maturité de la position quand le sous-jacent a des options cotées, sinon la vol réalisée sur un an.

Les montants sont convertis en **euros**, avec le dernier taux EUR/USD stocké en base. Les positions sont enregistrées dans la table SQLite `positions` (conditions du contrat en JSON, prix d'entrée par unité).

### 14.2 Sensibilités agrégées

Pour une position de quantité $Q$ et de multiplicateur $M$, avec $fx$ le taux de change vers l'euro :

$$
\Delta_{cash} = \Delta\, S\, Q M \cdot fx, \qquad \Gamma_{1\%} = \tfrac{1}{2}\, \Gamma\, (0{,}01\, S)^2\, Q M \cdot fx
$$

$\Gamma_{1\%}$ est le P&L du terme de gamma pour un mouvement de 1 % du sous-jacent. Le vega est donné pour 1 point de vol, le theta par jour, le rho pour 1 % de taux, et la DV01 pour les obligations. Les agrégats sont présentés par sous-jacent, par book et par type d'instrument.

### 14.3 Stress tests

Chaque scénario est une **revalorisation complète** du book :

- **Grille actions × volatilité** : chocs relatifs sur tous les sous-jacents de −20 % à +20 %, croisés avec des chocs absolus de vol de −5 à +10 points.
- **Chocs de taux** : translations parallèles de ±50 et ±100 points de base, appliquées à toutes les courbes.

### 14.4 Value at Risk et Expected Shortfall (1 jour)

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

### 14.5 Explication du P&L

On compare la revalorisation complète à la clôture précédente et au dernier cours, en décomposant pour chaque position :

$$
\text{P\&L} = \underbrace{\Delta_{cash}\, r}_{\text{delta}} + \underbrace{\Gamma_{1\%}\left(\frac{r}{1\%}\right)^2}_{\text{gamma}} + \underbrace{\Theta \cdot \text{jours}}_{\text{theta}} + \text{résiduel}
$$

Un résiduel faible valide les sensibilités. Un résiduel important signale des effets d'ordre supérieur ou un saut de marché.

**Simplifications** : l'état « coupons manqués » des autocalls déjà en vie n'est pas suivi ; la volatilité et les taux sont supposés inchangés dans l'explication du P&L.

---

## 15. Données et orchestration

*Fichiers : `qplat/data/*.py`, `scripts/refresh.py`*

### 15.1 Sources

| Donnée | Source | Fréquence |
|---|---|---|
| Cours de clôture (2 ans) et dernier cours | yfinance | chaque passage |
| Nom, secteur, devise, dividende ($q$ = rendement sur 12 mois glissants) | yfinance | chaque passage |
| Chaînes d'options (US) | yfinance | chaque passage |
| Taux USD | FRED (CSV public), repli yfinance | chaque passage |
| Taux EUR | API de données de la BCE | chaque passage |
| Taux de change EUR/USD (conversion du portefeuille en euros) | yfinance (EURUSD=X) | chaque passage |
| News | flux RSS Yahoo Finance (édition FR pour l'Europe), Alpha Vantage en option | chaque passage |

### 15.2 Volatilité réalisée

Volatilité par défaut des pricers et vol 1 mois de la vue d'ensemble :

$$
\sigma_{réalisée} = \sqrt{252} \times \text{écart-type}\big(\ln(S_t / S_{t-1})\big)
$$

sur les 252 derniers rendements journaliers (1 an) ou les 21 derniers (1 mois).

### 15.3 Rafraîchissement

Une tâche cron s'exécute toutes les 15 minutes en semaine. Le script ne rafraîchit que les sous-jacents dont le marché est ouvert :

| Marché | Fuseau | Ouverture |
|---|---|---|
| US | New York | 9h30 – 16h00 |
| EU | Paris | 9h00 – 17h30 |

Chaque tâche est journalisée dans la table `refresh_log`. Une erreur sur un sous-jacent n'interrompt pas les autres.

---

## 16. Sentiment des news par IA

*Fichier : `qplat/data/sentiment.py` — modèle `claude-opus-5-5`, effort `low`*

### 16.1 Scoring

Les titres non encore notés sont envoyés à Claude par paquets de 25, regroupés par sous-jacent. La consigne demande, pour chaque titre, l'impact probable sur le cours du sous-jacent dans les prochaines séances, vu par un actionnaire. Les titres sont traités comme des données, jamais comme des instructions. La réponse est contrainte par un schéma JSON :

| Champ | Contenu |
|---|---|
| `score` | nombre dans $[-1\,;\,1]$, borné côté serveur |
| `label` | very_negative, negative, neutral, positive ou very_positive |
| `rationale` | une phrase de justification |

### 16.2 Agrégation

Le sentiment d'un sous-jacent est une moyenne pondérée par la récence, avec une demi-vie de 3 jours. Pour un article d'âge $a$ jours et de score $s$ :

$$
w = 0{,}5^{\,a/3}, \qquad \text{Sentiment} = \frac{\sum w_i\, s_i}{\sum w_i}
$$

Le sentiment d'un secteur est la moyenne des sentiments de ses sous-jacents, pondérée par leur nombre d'articles.

---

## 17. Validation

*Dossier : `tests/` — 109 tests*

| Référence | Vérification |
|---|---|
| Hull, exemple 15.6 | call 4,7594 et put 0,8086 (S = 42, K = 40, r = 10 %, σ = 20 %, T = 0,5) |
| Relations d'arbitrage | parité call-put ; parité in/out des barrières ; obligation au pair égale à 100 |
| Grecques | formules fermées comparées aux différences finies |
| Convergence | arbre et Monte Carlo vers Black-Scholes, y compris avec une courbe non plate |
| Longstaff-Schwartz (2001) | put américain S = 36, K = 40, r = 6 %, σ = 20 %, T = 1 : environ 4,48 par l'arbre et par LSM |
| Haug, table 4-13 | les 24 valeurs de barrières retrouvées à $10^{-4}$ près |
| Bootstrap | chaque quote repricée à $10^{-10}$ près |
| Autocall | cas dégénérés (zéro-coupon, forward prépayé, rappel certain) |
| Arbre | un nœud recalculé à la main redonne la valeur du moteur |
| Heston | limite Black-Scholes, parité, Monte Carlo, paramètres retrouvés par la calibration |
| SVI / Dupire | ajustement retrouvé, vol locale d'une surface plate, détection d'arbitrage calendaire, Monte Carlo sous vol locale |
| Risques | valorisation en euros, cohérence Black-Scholes, stress linéaire exact, VaR historique et paramétrique, explication du P&L |
| API | routes testées sur une base de test synthétique, dont une chaîne d'options générée par Heston |

---

## 18. Limites et extensions possibles

- **Volatilité** : Heston et volatilité locale sont calibrés séparément. Un modèle à volatilité locale-stochastique (LSV) combinerait les deux.
- **Calendrier** : pas de jours fériés (NYSE, Euronext) ; échéancier obligataire régulier calculé à rebours.
- **Future obligataire** : sans option *cheapest-to-deliver* ni ajustement de convexité.
- **Options européennes** : Yahoo ne diffuse pas de chaînes d'options pour l'Europe, donc pas de smile EUR.
- **Taux** : déterministes. Un modèle de taux court (Hull-White) permettrait de pricer des produits sensibles aux taux.

---

## 19. Références

- Black, F. & Scholes, M. (1973). *The Pricing of Options and Corporate Liabilities*. Journal of Political Economy.
- Merton, R. (1973). *Theory of Rational Option Pricing*. Bell Journal of Economics.
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
