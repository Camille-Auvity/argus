# QPLAT technical documentation

This document describes how every number shown by the platform is computed: conventions, models, algorithms, numerical parameters and data sources. Each section points to the code file that implements it. (English version of `docs/METHODOLOGIE.md`; the two are kept in step.)

---

## 1. Architecture

The platform is organised in four layers, each unaware of how the others work:

| Layer | Folder | Role |
|---|---|---|
| Computing engine | `qplat/core`, `qplat/curves`, `qplat/instruments`, `qplat/pricers`, `qplat/models`, `qplat/credit`, `qplat/fx`, `qplat/allocation`, `qplat/research`, `qplat/theory`, `qplat/risk`, `qplat/analytics` | Conventions, rate curves, instruments, pricing methods. Pure Python (numpy, scipy). |
| Data | `qplat/data` | Downloads markets, balance sheets, rates and news; SQLite storage; sentiment scoring by Claude. |
| Interface | `api/` (FastAPI), `web/` (React) | The API exposes the engine and the database; the web interface calls it. |
| Orchestration | `scripts/refresh.py`, crontab | Automatic refresh during market hours. |

**Online version.** On GitHub Pages, the same FastAPI application runs in the visitor's browser through Pyodide (Python compiled to WebAssembly), on a slimmed-down copy of the database republished every hour by GitHub Actions. Every calculation described in this document is therefore done on the visitor's machine, with the same code.

**Instrument / pricer separation.** An instrument (`EuropeanOption`, `BarrierOption`, `Autocallable`, `FixedRateBond`…) is an immutable data container: it does not know how to price itself. A pricer receives the instrument and exposes the same interface: `price`, `delta`, `gamma`, `vega`, `theta`, `rho`, `greeks()`. The same object can thus be priced by several methods without duplication.

---

## 2. Conventions

*File: `qplat/core/conventions.py`*

### 2.1 Time

Every duration handled by the engine is an **ACT/365 Fixed year fraction** measured from the valuation date:

$$
\tau(d_1, d_2) = \frac{d_2 - d_1}{365} \quad \text{(in calendar days)}
$$

The other conventions are used only to convert market data on the way in:

| Convention | Year fraction |
|---|---|
| ACT/365F | $\dfrac{\text{days}}{365}$ |
| ACT/360 | $\dfrac{\text{days}}{360}$ |
| 30/360 (US) | $\dfrac{360(Y_2-Y_1) + 30(M_2-M_1) + (D_2-D_1)}{360}$, with $D_1 \leftarrow \min(D_1,30)$ and $D_2 \leftarrow 30$ if $D_1 = 30$ and $D_2 = 31$ |
| ACT/ACT ISDA | sum, year by year, of $\dfrac{\text{days in the year}}{365 \text{ or } 366}$ |

### 2.2 Rates

All internal rates are **continuously compounded** on the ACT/365F axis. The conversions used:

$$
r_c = \frac{\ln(1 + R\,\tau)}{\tau} \quad \text{(simple rate } R \text{ over a period } \tau)
$$

$$
r_c = m \ln\!\left(1 + \frac{R_m}{m}\right) \quad \text{(rate compounded } m \text{ times a year)}
$$

### 2.3 Greek units

The engine computes raw derivatives:

| Greek | Definition | Engine unit | Displayed unit |
|---|---|---|---|
| Delta $\Delta$ | $\partial V / \partial S$ | — | — |
| Gamma $\Gamma$ | $\partial^2 V / \partial S^2$ | — | — |
| Vega $\nu$ | $\partial V / \partial \sigma$ | per 1.00 of vol | per 1% ($\nu/100$) |
| Theta $\Theta$ | $\partial V / \partial t$ (time passes) | per year | per day ($\Theta/365$) |
| Rho $\rho$ | $\partial V / \partial r$ (parallel shift of the curve) | per 1.00 of rate | per 1% ($\rho/100$) |

---

## 3. Rate curves

*Files: `qplat/curves/rate_curve.py`, `qplat/curves/bootstrap.py`, `qplat/data/market.py`*

### 3.1 Quantities

A curve is defined by its discount factors $P(0,t)$. From them:

$$
z(t) = -\frac{\ln P(0,t)}{t} \qquad \text{(continuous zero-coupon rate)}
$$

$$
f(t_1, t_2) = \frac{1}{t_2 - t_1} \ln\frac{P(0,t_1)}{P(0,t_2)} \qquad \text{(continuous forward rate)}
$$

A **parallel shift** of $h$ (used for rho and DV01) multiplies each discount factor:

$$
P^{(h)}(0,t) = P(0,t)\, e^{-h t} \quad \Longleftrightarrow \quad z^{(h)}(t) = z(t) + h
$$

A constant rate $r$ is treated as a flat curve: $P(0,t) = e^{-rt}$.

### 3.2 Interpolation between pillars

Pillars are pairs $(t_k, P_k)$. Two methods are available:

- **Linear on zero rates**: $z(t)$ is interpolated linearly between pillars and extrapolated flat beyond. Simple, but the resulting forwards are saw-toothed (visible on the "Curves" page).
- **Log-linear on discount factors** (default): $\ln P$ is interpolated linearly, with the anchor point $(0, 0)$. Forwards are then **piecewise constant**:

$$
f(t) = \frac{\ln P_{k} - \ln P_{k+1}}{t_{k+1} - t_k} \quad \text{for } t \in [t_k, t_{k+1}]
$$

Beyond the last pillar, the last forward is extended.

### 3.3 Bootstrap

Quotes are sorted by maturity and solved one at a time: for each quote we look for the factor $P(T_k)$ that reprices it exactly, given the pillars already set and the interpolation chosen for intermediate dates. The solver is Brent's method on $P(T_k) \in [10^{-6}, 2]$ with a tolerance of $10^{-14}$.

**Deposit** (simple rate $R$, maturity $T$):

$$
P(T) = \frac{1}{1 + R \cdot \tau_{acc}}, \qquad \tau_{acc} = T \times \text{basis}
$$

with basis $= 365/360$ for an ACT/360 money-market deposit.

**Swap rate or par bond yield** (coupon $c$, frequency $m$, dates $t_1 < \dots < t_n = T$ built backwards from $T$, $\tau_i = t_i - t_{i-1}$):

$$
c \sum_{i=1}^{n} \tau_i\, P(t_i) + P(t_n) = 1
$$

This is the condition for a bond with coupon $c$ to be worth exactly 100%.

### 3.4 USD curve (Treasury)

The data are the constant-maturity *par yields* published daily by the US Treasury (CSV file of the current year, the same series as FRED): 1M, 3M, 6M, 1Y, 2Y, 3Y, 5Y, 7Y, 10Y, 20Y, 30Y. If the Treasury is unavailable, the platform tries FRED, then yfinance (^IRX, ^FVX, ^TNX, ^TYX). A source more than 5 days behind another one is ignored, so the platform never stays stuck on a frozen curve.

- Maturities ≤ 6 months (bills): treated as simple-rate deposits on ACT/365F (basis = 1).
- Maturities ≥ 1 year: par bonds with a semi-annual coupon ($m = 2$).

### 3.5 EUR curve (ECB)

The ECB publishes the curve of AAA-rated euro-area government bonds, fitted with the Svensson model:

$$
z(t) = \beta_0 + \beta_1 \frac{1 - e^{-t/\tau_1}}{t/\tau_1} + \beta_2 \left(\frac{1 - e^{-t/\tau_1}}{t/\tau_1} - e^{-t/\tau_1}\right) + \beta_3 \left(\frac{1 - e^{-t/\tau_2}}{t/\tau_2} - e^{-t/\tau_2}\right)
$$

The platform downloads the continuous zero rates directly (3M to 30Y) and uses them as pillars without a bootstrap: $P(0,t_k) = e^{-z_k t_k}$.

---

## 4. Bonds and futures

*Files: `qplat/instruments/fixed_income.py`, `qplat/pricers/rates.py`*

### 4.1 Fixed-rate bond

Notional $N$, annual coupon $c$, frequency $m$, maturity $T$. Coupon dates are built backwards from maturity, with a step of $1/m$:

$$
CF_i = \frac{N c}{m} \quad (i < n), \qquad CF_n = \frac{N c}{m} + N
$$

**Dirty price** discounted on the curve:

$$
P_{dirty} = \sum_{i} CF_i \, P(0, t_i)
$$

**Accrued interest**, with $t_{next}$ the date of the next coupon:

$$
AI = N c \left(\frac{1}{m} - t_{next}\right)
$$

**Clean price**: $P_{clean} = P_{dirty} - AI$.

**Yield to maturity** $y$, compounded $m$ times a year, solved by Brent on $[-0.5,\,2]$ from:

$$
\sum_i CF_i \left(1 + \frac{y}{m}\right)^{-m t_i} = P_{dirty}
$$

**Durations and convexity** (with $PV_i = CF_i (1 + y/m)^{-m t_i}$):

$$
D_{Mac} = \frac{\sum_i t_i\, PV_i}{P_{dirty}}, \qquad D_{mod} = \frac{D_{Mac}}{1 + y/m}, \qquad C = \frac{\sum_i PV_i\, t_i (t_i + 1/m)}{P_{dirty}\,(1 + y/m)^2}
$$

**DV01**, the price change for a 1 basis point fall of the whole curve (central difference):

$$
DV01 = \frac{P_{dirty}(\text{curve} - 1\,bp) - P_{dirty}(\text{curve} + 1\,bp)}{2}
$$

### 4.2 Future on a stock or an index

With deterministic rates, the price of a future equals that of a forward. By cost of carry:

$$
F = \frac{S\, e^{-qT}}{P(0,T)}
$$

### 4.3 Bond future (single deliverable)

The bond is carried until delivery $T_d$: bought at the dirty price, the coupons paid before delivery are collected, then it is delivered.

$$
F_{dirty} = \frac{P_{dirty}(0) - \sum_{t_i \le T_d} CF_i\, P(0,t_i)}{P(0,T_d)}, \qquad F = \frac{F_{dirty} - AI(T_d)}{CF}
$$

where $CF$ is the conversion factor. Simplifications: a single deliverable bond (no *cheapest-to-deliver* option), no timing option, no convexity adjustment between future and forward.

---

## 5. Black-Scholes-Merton model

*File: `qplat/pricers/black_scholes.py`*

### 5.1 Dynamics

Under the risk-neutral probability $\mathbb{Q}$, the underlying follows a geometric Brownian motion whose drift is the forward rate of the curve minus the dividend yield:

$$
\frac{dS_t}{S_t} = \big(f(t) - q\big)\,dt + \sigma\, dW_t
$$

which gives, for an expiry $T$:

$$
S_T = \frac{S_0\, e^{-qT}}{P(0,T)} \exp\!\left(-\tfrac{1}{2}\sigma^2 T + \sigma \sqrt{T}\, Z\right), \qquad Z \sim \mathcal{N}(0,1)
$$

$\ln S_T$ is therefore Gaussian and $\mathbb{E}^{\mathbb{Q}}[S_T]$ equals the forward. For a European payoff, the curve enters only through the zero rate to expiry $r = z(T)$.

### 5.2 Price formula

With $\varphi = +1$ for a call and $\varphi = -1$ for a put:

$$
d_1 = \frac{\ln(S/K) + (r - q + \tfrac{1}{2}\sigma^2)\,T}{\sigma\sqrt{T}}, \qquad d_2 = d_1 - \sigma\sqrt{T}
$$

$$
V = \varphi \left[ S e^{-qT} N(\varphi d_1) - K e^{-rT} N(\varphi d_2) \right]
$$

$N$ is the standard normal cumulative distribution function and $n$ its density. $N(\varphi d_2)$ is the risk-neutral probability of ending in the money.

**Put-call parity**: $C - P = S e^{-qT} - K e^{-rT}$.

### 5.3 Closed-form Greeks

$$
\Delta = \varphi\, e^{-qT} N(\varphi d_1) \qquad\qquad \Gamma = \frac{e^{-qT}\, n(d_1)}{S \sigma \sqrt{T}}
$$

$$
\nu = S e^{-qT} n(d_1) \sqrt{T} \qquad\qquad \rho = \varphi\, K T e^{-rT} N(\varphi d_2)
$$

$$
\Theta = -\frac{S e^{-qT} n(d_1)\, \sigma}{2\sqrt{T}} - \varphi\, r K e^{-rT} N(\varphi d_2) + \varphi\, q S e^{-qT} N(\varphi d_1)
$$

Theta assumes the zero rate stays constant as time passes.

### 5.4 Implied volatility

*File: `qplat/pricers/black_scholes.py` (`implied_volatility`)*

We look for $\sigma_{imp}$ such that $V_{BS}(\sigma_{imp}) = V_{market}$, by Brent's method on $[10^{-4},\,5]$ with a tolerance of $10^{-10}$. The price must first satisfy the no-arbitrage bounds, otherwise the function returns NaN:

$$
\max\!\big(\varphi(S e^{-qT} - K e^{-rT}),\, 0\big) < V < \begin{cases} S e^{-qT} & \text{call} \\ K e^{-rT} & \text{put} \end{cases}
$$

---

## 6. Cox-Ross-Rubinstein binomial tree

*File: `qplat/pricers/binomial.py` — default: 500 steps*

### 6.1 Construction

$[0, T]$ is cut into $N$ steps of $\Delta t = T/N$:

$$
u = e^{\sigma \sqrt{\Delta t}}, \qquad d = \frac{1}{u}, \qquad S_{i,j} = S_0\, u^{\,i - 2j} \quad (j = 0, \dots, i)
$$

On each step, the discount factor and the risk-neutral probability come from the curve:

$$
P_i = \frac{P(0, t_{i+1})}{P(0, t_i)}, \qquad p_i = \frac{e^{-q\Delta t}/P_i - d}{u - d}
$$

This choice of $p_i$ guarantees $\mathbb{E}[S_{i+1} \mid S_i] = S_i\, e^{-q\Delta t}/P_i$, that is growth at the forward rate. If $p_i \notin\, ]0,1[$, the tree is rejected for arbitrage.

### 6.2 Backward induction

At expiry, $V_{N,j} = \text{payoff}(S_{N,j})$. Then for $i = N-1, \dots, 0$:

$$
C_{i,j} = P_i \left[ p_i\, V_{i+1,j} + (1 - p_i)\, V_{i+1,j+1} \right]
$$

$$
V_{i,j} = \begin{cases} C_{i,j} & \text{European exercise} \\ \max\!\big(C_{i,j},\, \text{payoff}(S_{i,j})\big) & \text{American exercise} \end{cases}
$$

The price is $V_{0,0}$. For an American option, a node is flagged "optimal exercise" when $\text{payoff}(S_{i,j}) > C_{i,j}$.

### 6.3 Exercise boundary and convergence

For an American put, the **exercise boundary** at date $t_i$ is the highest spot where exercise is optimal (for a call, the lowest). Only even steps are kept, because CRR nodes alternate between two price grids, which would make the boundary zigzag.

The CRR price converges to Black-Scholes at speed $O(1/N)$, with an oscillation depending on the parity of $N$ (visible on the convergence chart).

The tree's Greeks are computed by finite differences (section 9).

---

## 7. Monte Carlo

*Files: `qplat/pricers/paths.py`, `qplat/pricers/monte_carlo.py` — default: 100,000 paths, seed 42*

### 7.1 Exact simulation

Between two dates $t_{k-1}$ and $t_k$ (step $\Delta_k$), the simulation is exact (no discretisation error):

$$
S_{t_k} = S_{t_{k-1}} \exp\!\left( \ln\frac{P(0,t_{k-1})}{P(0,t_k)} - q\Delta_k - \tfrac{1}{2}\sigma^2 \Delta_k + \sigma\sqrt{\Delta_k}\, Z_k \right)
$$

For a European option, a single step (from $0$ to $T$) is enough.

### 7.2 Estimator and confidence interval

$$
\hat V = P(0,T)\, \frac{1}{M} \sum_{m=1}^{M} \text{payoff}\big(S_T^{(m)}\big)
$$

**Antithetic variables.** Draws come in pairs $(Z, -Z)$. The standard error is computed on the $M/2$ pair averages $\bar Y_k = \tfrac{1}{2}\big(Y(Z_k) + Y(-Z_k)\big)$:

$$
SE = \frac{\text{std}(\bar Y)}{\sqrt{M/2}}, \qquad CI_{95\%} = \hat V \pm 1.96 \cdot SE
$$

The error decays in $1/\sqrt{M}$: halving the error costs four times more paths.

**Common random numbers.** Every call uses the same seed. The "bumped" prices used for the Greeks therefore share the same $Z$, and the noise cancels in the difference.

### 7.3 Importance sampling (Girsanov)

`importance` option of the Monte Carlo pricers (European vanillas and exotics, Black-Scholes paths). The Brownian motion is simulated with a drift $\theta$: each increment $\sqrt{\Delta t}\,z$ becomes $\sqrt{\Delta t}\,(z + \theta\sqrt{\Delta t})$. Each path is then reweighted by the Radon-Nikodym derivative:

$$
\frac{dP}{dQ} = \exp\left(-\theta W_T + \tfrac12 \theta^2 T\right), \qquad \mathbb E_P[\text{payoff}] = \mathbb E_Q\left[\text{payoff} \cdot \frac{dP}{dQ}\right]
$$

With `importance="auto"`, $\theta^* = \left(\ln(K/F) + \tfrac12\sigma^2 T\right)/(\sigma T)$ puts the median of $S_T$ at the strike. The estimator stays unbiased. For a far out-of-the-money option, the variance is divided by several hundreds or thousands: about 1,600 for a call at 150% of spot with 6 months to expiry. For an at-the-money option there is almost nothing to gain (section 19.5).

### 7.4 Longstaff-Schwartz (American exercise)

Default: 50 exercise dates, degree-3 polynomial regression on $x = S/K$.

1. Simulate the paths at dates $t_1, \dots, t_M$; initialise $CF = \text{payoff}(S_{t_M})$.
2. For $k = M-1, \dots, 1$:
   - discount the cash flows by one step: $CF \leftarrow CF \cdot P(0,t_{k+1})/P(0,t_k)$;
   - among the paths **in the money** at $t_k$, regress $CF$ on $(1, x, x^2, x^3)$ to get the estimated continuation $\hat C(x)$;
   - for these paths, if $\text{payoff}(S_{t_k}) > \hat C(x)$, exercise: $CF \leftarrow \text{payoff}(S_{t_k})$.
3. Price $= P(0, t_1) \cdot \overline{CF}$, or the immediate exercise value if it is higher.

Using the same paths for the regression and the valuation creates a slight bias. The estimated exercise boundary is approximate, but the price stays accurate: a wrong decision near the boundary, where exercising and continuing are worth almost the same, costs almost nothing.

---

## 8. Barrier options

*File: `qplat/pricers/barrier.py`*

### 8.1 Definitions

A barrier $H$ activates (*in*) or deactivates (*out*) a vanilla option with strike $K$ if the underlying touches it (*down*: from above, *up*: from below). The **rebate** $R$ is paid at the touch for an *out*, or at expiry for an *in* that was never activated.

**In/out parity**: $V_{in} + V_{out} = V_{vanilla}$ (without rebate).

### 8.2 Reiner-Rubinstein closed form (continuous monitoring)

With $b = r - q$, $\varphi = \pm 1$ (call/put) and $\eta = +1$ (down) or $-1$ (up):

$$
\mu = \frac{b - \sigma^2/2}{\sigma^2}, \qquad \lambda = \sqrt{\mu^2 + \frac{2r}{\sigma^2}}
$$

$$
x_1 = \frac{\ln(S/K)}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T, \qquad x_2 = \frac{\ln(S/H)}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T
$$

$$
y_1 = \frac{\ln(H^2/(SK))}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T, \qquad y_2 = \frac{\ln(H/S)}{\sigma\sqrt T} + (1+\mu)\sigma\sqrt T, \qquad z = \frac{\ln(H/S)}{\sigma\sqrt T} + \lambda\sigma\sqrt T
$$

The six building blocks:

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

Combinations by type:

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

If the barrier has already been crossed, an *in* is worth the Black-Scholes vanilla and an *out* is worth the rebate. With a curve, $r = z(T)$.

### 8.3 Discrete monitoring: Broadie-Glasserman-Kou correction

A barrier monitored $m$ times a year is approximated by a continuous barrier shifted away from the spot:

$$
H' = H\, e^{\pm \beta \sigma \sqrt{\Delta t}}, \qquad \Delta t = \frac{1}{m}, \qquad \beta = -\frac{\zeta(1/2)}{\sqrt{2\pi}} \approx 0.5826
$$

($+$ for an up barrier, $-$ for a down barrier).

### 8.4 Monte Carlo

- **Discrete monitoring**: the paths are simulated exactly at the monitoring dates and the barrier is tested at each date. The rebate of an *out* is discounted from the touch date.
- **Continuous monitoring** (252 steps a year): between two simulated points on the same side of the barrier, the probability that the Brownian bridge touched it is

$$
p_k = \exp\!\left( -\frac{2 \ln(H/S_k)\, \ln(H/S_{k+1})}{\sigma^2 \Delta t} \right)
$$

From it, the *out* value $= P(0,T) \cdot \mathbb{E}\big[\text{payoff} \cdot \prod_k (1 - p_k)\big]$, then the *in* value $=$ vanilla − *out*.

---

## 9. Greeks by finite differences

*File: `qplat/pricers/base.py` (`FiniteDifferencePricer`)*

Every numerical method (tree, Monte Carlo, barrier, autocall) inherits a single bump-and-reprice implementation:

| Greek | Formula | Bump |
|---|---|---|
| Delta | $\dfrac{V(S+h) - V(S-h)}{2h}$ | $h = 1\% \times S$ |
| Gamma | $\dfrac{V(S+h) - 2V(S) + V(S-h)}{h^2}$ | $h = 1\% \times S$ |
| Vega | $\dfrac{V(\sigma+h) - V(\sigma-h)}{2h}$ | $h = \min(0.01,\ \sigma/2)$ |
| Theta | $\dfrac{V(t+\delta) - V(t)}{\delta}$ | $\delta = \min(1/365,\ T/2)$; every date is shortened by $\delta$ |
| Rho | $\dfrac{V(r+h) - V(r-h)}{2h}$ | $h = 1$ bp, parallel shift of the curve |

For an autocall, the initial level (reference strike) stays frozen during the spot bump: the underlying moves, not the barriers.

---

## 10. Phoenix / Athena autocall

*Files: `qplat/instruments/structured.py`, `qplat/pricers/autocall.py` — default: 100,000 paths*

### 10.1 Parameters

Notional $N$, observation dates $t_1 < \dots < t_n$, initial level $S_{init}$, coupon $c$ per period, barriers (in % of $S_{init}$): autocall $B_{ac}$, coupon $B_c$, protection $B_p$, memory effect.

### 10.2 Payoff along a path

Performance at each date: $\pi_k = S_{t_k} / S_{init}$. While the product is alive, at each date $t_k$:

1. **Coupon**: if $\pi_k \ge B_c$, payment of $c N (1 + m_k)$, where $m_k$ is the number of coupons missed since the last payment (0 without memory effect). Otherwise $m_{k+1} = m_k + 1$.
2. **Early redemption** ($k < n$): if $\pi_k \ge B_{ac}$, payment of $N$ and the product ends.
3. **Maturity** ($k = n$): payment of $N$ if $\pi_n \ge B_p$, otherwise of $N \pi_n$ (capital loss).

The value is the expectation of the sum of discounted flows $\sum_k \text{flow}_k\, P(0, t_k)$. Since the payoff depends only on the observation dates, exact simulation at those dates alone is enough.

An **Athena** is the case $B_c = B_{ac}$.

### 10.3 Indicators

- Probability of redemption at each date, probability of paying a coupon at each date.
- Loss probability: $\mathbb{Q}(\text{alive at } t_n \text{ and } \pi_n < B_p)$.
- Expected life: $\mathbb{E}[\text{redemption date}]$.
- **Par coupon**: the value of $c$ that gives a price of 100%, found by Brent on $[0,\,0.5]$. Since the random numbers are common, the price is a smooth function of $c$.

**Reading the Greeks.** The holder is usually short volatility ($\nu < 0$), because they have sold an implicit down-and-in put. Delta can be negative when coupons are high relative to rates: a rise in the underlying speeds up a call that is unfavourable to the holder.

---

## 11. Digital, Asian and cliquet options

*Files: `qplat/instruments/exotics.py`, `qplat/pricers/exotics.py`*

The three products expose the same Monte Carlo interface: observation dates and a payoff computed on the spots simulated at those dates. A single engine (`MonteCarloExoticPricer`) therefore prices them under Black-Scholes, Heston or local volatility. As everywhere, the Greeks come from finite differences (section 9), with common random numbers for Monte Carlo.

### 11.1 Digitals

A **cash-or-nothing** digital pays an amount $Q$ if the option ends in the money; an **asset-or-nothing** pays $S_T$. With the Black-Scholes $d_{1,2}$:

$$
\text{CoN}_{call} = Q\, e^{-rT} N(d_2), \qquad \text{CoN}_{put} = Q\, e^{-rT} N(-d_2)
$$

$$
\text{AoN}_{call} = S e^{-qT} N(d_1), \qquad \text{AoN}_{put} = S e^{-qT} N(-d_1)
$$

**Relations checked by the tests**: $\text{CoN}_{call} + \text{CoN}_{put} = Q e^{-rT}$, and a vanilla decomposes as $C = \text{AoN}_{call} - K \cdot \text{CoN}_{call}/Q$.

**Call-spread replication.** A cash digital is the derivative of the call price with respect to the strike:

$$
\text{CoN}_{call} = -Q\, \frac{\partial C}{\partial K} = \lim_{w \to 0} \frac{Q}{w} \left[ C(K - w/2) - C(K + w/2) \right]
$$

The interface shows the convergence of the call spread to the digital as its width $w$ shrinks.

**Greeks.** The delta $Q e^{-rT} n(d_2) / (S\sigma\sqrt T)$ becomes a spike around $K$ near expiry, and gamma changes sign at $K$. The vega, $-Q e^{-rT} n(d_2)\, d_1 / \sigma$, is negative when the call is in the money: more volatility pulls the probability of ending above the strike away from 1.

**Smile correction.** With a smile $\sigma(K)$, the call price is $C(K) = C_{BS}(K, \sigma(K))$. Differentiating:

$$
\text{CoN}_{call} = Q \left[ D_{BS}(\sigma(K)) - \mathcal{V}_{BS}(K)\, \frac{\partial \sigma}{\partial K} \right]
$$

With a negative skew ($\partial\sigma/\partial K < 0$), the digital call is more expensive than the Black-Scholes price. The computation is a central difference of $C(K)$ on the SVI surface. Under Heston, the digital is the same difference applied to the prices of the Lewis formula.

### 11.2 Asian options

Payoff $(\varphi(A - K))^+$ paid at the last fixing, where $A$ is the arithmetic or geometric average of $S$ over $n$ evenly spaced fixings $t_1 < \dots < t_n$.

**Geometric average: exact closed form.** With $g_i = \int_0^{t_i} (f(s) - q)\,ds = -\ln P(0, t_i) - q t_i$, $\ln G = \frac1n \sum_i \ln S_{t_i}$ is Gaussian:

$$
m = \ln S + \frac1n \sum_i \left( g_i - \tfrac12 \sigma^2 t_i \right), \qquad v = \frac{\sigma^2}{n^2} \sum_{i,j} \min(t_i, t_j)
$$

$$
V_{geo} = P(0, t_n) \cdot \varphi \left[ e^{m + v/2} N(\varphi d_1) - K N(\varphi d_2) \right], \qquad d_1 = \frac{m - \ln K + v}{\sqrt v}, \quad d_2 = d_1 - \sqrt v
$$

With a single fixing this is Black-Scholes. As $n \to \infty$, it becomes the continuous Kemna-Vorst formula (vol $\sigma/\sqrt3$).

**Arithmetic average: Lévy approximation (1992).** A sum of lognormals is not lognormal. It is approximated by a lognormal with the same first two moments. With $F_i = S e^{g_i}$:

$$
M_1 = \frac1n \sum_i F_i, \qquad M_2 = \frac{1}{n^2} \sum_{i,j} F_i F_j\, e^{\sigma^2 \min(t_i, t_j)}
$$

$$
V_{Lévy} = P(0, t_n) \cdot \text{Black}\left(M_1, K, \ \Sigma^2 = \ln(M_2 / M_1^2)\right)
$$

The approximation slightly overprices when volatility is high (right tail too fat).

**Monte Carlo with a control variate.** The geometric Asian $Y$, computed on the same paths as the arithmetic $X$, has an exact price $\mathbb{E}[Y]$ and is highly correlated with it:

$$
\hat V = \overline{X} - \beta \left( \overline{Y} - \mathbb{E}[Y] \right), \qquad \beta = \frac{\text{Cov}(X, Y)}{\text{Var}(Y)}
$$

The variance is divided by $1/(1 - \rho_{XY}^2)$, typically several hundreds for an ATM call: for the same accuracy, hundreds of times fewer paths are needed. Antithetic pairs are averaged before $\beta$ is estimated.

**Greeks.** The delta of an Asian call is lower than that of the vanilla, and so is the vega: the average has a reduced effective volatility (about $\sigma/\sqrt3$ in continuous time).

### 11.3 Cliquets

Reset dates $t_0 = 0 < t_1 < \dots < t_n$, period returns $R_i = S_{t_i} / S_{t_{i-1}} - 1$, local floor and cap $f, c$, global floor and cap $F, C$ (each optional):

$$
\text{payoff} = N \cdot \min\left( \max\left( \sum_{i=1}^n \min(\max(R_i, f), c),\ F \right),\ C \right) \quad \text{paid at } t_n
$$

**Without global bounds: closed form.** Under Black-Scholes, $1 + R_i$ is lognormal with mean $\Phi_i = \frac{P(0,t_{i-1})}{P(0,t_i)} e^{-q(t_i - t_{i-1})}$ and variance $\sigma^2 (t_i - t_{i-1})$, independently of the level of $S$. Each period is a forward-start call spread:

$$
\mathbb{E}[\min(\max(R_i, f), c)] = f + C_{Bl}(\Phi_i, 1 + f) - C_{Bl}(\Phi_i, 1 + c)
$$

($C_{Bl}$: undiscounted Black call), hence $V = N\, P(0, t_n) \sum_i \mathbb{E}[\cdot]$. The global floor is an option on the sum: Monte Carlo is needed.

**Greeks.** The payoff depends only on returns: **delta and gamma are zero** under Black-Scholes, and the engine recovers them exactly (numerical zero). Vega is often **negative**: with local caps, more volatility loses more performance on the capped periods than it gains. The chart of the price against volatility shows this profile, sometimes non-monotonic (the global floor itself is long vol).

**Model risk.** The price depends only on **forward volatilities** and the forward smile. Local volatility, calibrated on today's vanillas, produces a forward skew that flattens. Heston keeps a forward skew close to today's skew. The two models reproduce the same vanillas but give different cliquet prices: the classic example of model risk (*Volatility models → Digital, Asian, cliquet* tab).

---

## 12. Variance and volatility swaps

*Files: `qplat/pricers/variance.py`, `api/routers/variance.py`*

### 12.1 The contract

A variance swap pays at expiry $N_{var}\,(\sigma_R^2 - K_{var})$, where $\sigma_R^2$ is the realised variance of daily log returns, annualised and not demeaned (market convention):

$$
\sigma_R^2 = \frac{252}{n} \sum_{i=1}^{n} \ln^2\!\frac{S_i}{S_{i-1}}
$$

Vols are quoted in points (100 σ). The variance notional follows from the vega notional: $N_{var} = N_{vega} / (2 K_{vol})$. Near the strike, one point of realised vol above $K_{vol}$ therefore pays about $N_{vega}$.

The **volatility** swap pays $N_{vega}(\sigma_R - K_{vol})$: a payoff linear in vol, whereas the variance swap is convex.

### 12.2 Fair strike by static replication

For a continuous path, Itô's lemma applied to $\ln S$ gives

$$
\int_0^T \sigma_t^2\, dt = 2 \int_0^T \frac{dS_t}{S_t} - 2 \ln\frac{S_T}{S_0}
$$

The realised variance is therefore a log contract, delta-hedged by the dynamic position $2/S_t$. The log contract decomposes into a strip of out-of-the-money options weighted in $1/K^2$ (Carr and Madan; Demeterfi, Derman, Kamal and Zou, 1999). With $F$ the forward and $P(0,T)$ the discount factor:

$$
K_{var} = \frac{2}{T\, P(0,T)} \left[ \int_0^F \frac{\text{Put}(K)}{K^2}\, dK + \int_F^\infty \frac{\text{Call}(K)}{K^2}\, dK \right]
$$

The fair strike depends only on **today's smile**: no model is involved, provided the paths are continuous.

**Implementation.** The integral is computed in log-moneyness $k = \ln(K/F)$, since $dK/K^2 = e^{-k}\,dk/F$. It spans ±10 ATM standard deviations (4,001 points), with Black prices from the SVI surface (section 15). The page shows the contribution of each strike: puts carry most of the variance (77% on SPY), which puts $\sqrt{K_{var}}$ well above the ATM vol.

**Validation by Heston.** Under Heston, the expected realised variance has a closed form:

$$
\mathbb{E}\left[ \frac{1}{T}\int_0^T v_t\, dt \right] = \theta + (v_0 - \theta)\, \frac{1 - e^{-\kappa T}}{\kappa T}
$$

Replicating the smile produced by Heston recovers this value to within $10^{-4}$ in relative terms (automated test).

### 12.3 Listed strikes: the VIX formula

The CBOE applies the same formula to listed strikes:

$$
\sigma^2 = \frac{2}{T} \sum_i \frac{\Delta K_i}{K_i^2}\, e^{rT}\, Q(K_i) - \frac{1}{T}\left( \frac{F}{K_0} - 1 \right)^2
$$

- $Q(K_i)$ is the mid quote of the out-of-the-money option (average of the call and the put at $K_0$).
- $K_0$ is the first strike below the forward.
- The strip stops after two consecutive zero bids.
- The forward comes from put-call parity: the platform takes the median of the implied forwards within ±10% of spot, more robust to stale quotes on far strikes than the rule of the strike minimising $|C - P|$.

The VIX then interpolates linearly in time the total variances of the two expiries around 30 days, and annualises.

**Validation.** This formula is applied every day to the stored SPY chains and compared with the official VIX (`^VIX`, downloaded with the rates). The median gap is about 0.4 point. The remaining gaps come from:
- SPY instead of the S&P 500 index;
- the snapshot time, compared with the VIX close;
- American options instead of European ones.

The listed strip stops where quotes disappear. It therefore slightly underestimates the variance compared with the SVI surface, which extrapolates the wings.

### 12.4 Volatility swap and convexity

$\sqrt{\cdot}$ is concave, so by Jensen's inequality $\mathbb{E}[\sigma_R] = \mathbb{E}\left[\sqrt{\sigma_R^2}\right] \le \sqrt{\mathbb{E}[\sigma_R^2]} = \sqrt{K_{var}}$. The gap, or **convexity**, depends on the variance of the realised variance: a model is needed.

The page compares several approaches:
- **Black-Scholes** (constant vol): the convexity is almost zero; only daily sampling noise remains.
- **Heston**: the integrated variance $\frac1T\int v\,dt$ is simulated with a full-truncation Euler scheme; the realised variance of daily paths is computed as well.
- **Local volatility**: realised variance of the simulated paths. It must recover the replication, since it reprices every vanilla.

The second-order approximation $\mathbb{E}[\sqrt V] \approx \sqrt{\mathbb{E}V} - \text{Var}(V)/(8\,\mathbb{E}[V]^{3/2})$ is shown for comparison. It degrades when the vol of variance is high.

### 12.5 Value and risks of a seasoned swap

At date $t$, the expected total variance combines the realised part (read from history) and the remaining implied part:

$$
\mathbb{E}[\sigma_R^2] = \frac{t}{T}\, \sigma^2_{R}(0,t) + \frac{T-t}{T}\, K_{var}(t,T), \qquad V_t = P(t,T)\, N_{var} \left( \mathbb{E}[\sigma_R^2] - K_{vol}^2 \right)
$$

The **vega**, per point of implied vol over the remaining life, is $P(t,T)\, N_{var}\, \frac{T-t}{T}\, 2\sigma_{impl}$; at the money and at inception it equals $N_{vega}$. The payoff profile (variance against vol) illustrates the convexity.

### 12.6 Variance risk premium

The VIX of date $t$ is compared with the SPY realised vol over the following 21 sessions, that is what a one-month variance swap struck at $t$ pays. The history covers 2 years.

The page shows:
- the share of days where implied exceeds realised;
- the mean premium in vol points;
- the P&L of selling a monthly variance swap with vega notional 1: $(K^2 - \sigma_R^2)/(2K)$.

The profile is that of a sold insurance policy: a small premium earned almost every month, and large losses in volatility shocks (Carr and Wu, 2009).

---

## 13. Implied volatility smile

*Files: `qplat/analytics/smile.py`, `qplat/data/market.py`*

1. **Expiry selection**: for each target horizon (7, 14, 30, 60, 90, 180, 270, 365 and 545 days), the closest listed expiry is kept.
2. **Time to expiry**: measured to the second, from the snapshot time to 4:00 pm (New York) on expiration day, divided by 365 days.
3. **Price used**: the mid $(bid + ask)/2$ when there is a two-sided quote, otherwise the last traded price.
4. **Filters**: out-of-the-money options only (puts below spot, calls above), moneyness $K/S \in [0.7,\,1.3]$, more than 2 days before expiry.
5. **Inversion**: implied volatility by Brent (section 5.4), with the zero rate $z(T)$ of the curve and the underlying's dividend.
6. **ATM term structure**: for each expiry, the implied volatility of the strike closest to the money.

---

## 14. Heston model (stochastic volatility)

*Files: `qplat/models/heston.py`, `qplat/models/market_models.py`*

### 14.1 Dynamics

$$
\frac{dS_t}{S_t} = \big(f(t) - q\big)\,dt + \sqrt{v_t}\, dW^1_t, \qquad dv_t = \kappa(\theta - v_t)\,dt + \sigma\sqrt{v_t}\, dW^2_t, \qquad d\langle W^1, W^2\rangle_t = \rho\, dt
$$

| Parameter | Role |
|---|---|
| $v_0$ | initial variance ($\sqrt{v_0}$ = short vol) |
| $\theta$ | long-run variance |
| $\kappa$ | mean-reversion speed (half-life $\ln 2 / \kappa$): slope of the term structure |
| $\sigma$ | volatility of variance: smile convexity |
| $\rho$ | spot / variance correlation: $\rho < 0$ creates the downside skew |

The **Feller condition** $2\kappa\theta > \sigma^2$ guarantees that the variance never reaches zero. It is often violated by equity calibrations.

### 14.2 Characteristic function

Write $X_T = \ln(S_T/S_0) - (r - q)T$. In the "little Heston trap" form (Albrecher et al., 2007), which avoids the discontinuities of the complex logarithm:

$$
a = \kappa - \rho\sigma i u, \qquad d = \sqrt{a^2 + \sigma^2 (iu + u^2)}, \qquad g = \frac{a - d}{a + d}
$$

$$
C(u) = \frac{\kappa\theta}{\sigma^2}\left[(a - d)T - 2\ln\frac{1 - g e^{-dT}}{1 - g}\right], \qquad D(u) = \frac{a - d}{\sigma^2}\cdot\frac{1 - e^{-dT}}{1 - g e^{-dT}}
$$

$$
\varphi_T(u) = \mathbb{E}\big[e^{iuX_T}\big] = \exp\big(C(u) + D(u)\, v_0\big)
$$

### 14.3 European price: Lewis formula

$$
C(K) = S e^{-qT} - \frac{\sqrt{SK}\, e^{-(r+q)T/2}}{\pi} \int_0^{\infty} \mathrm{Re}\!\left[e^{iux}\, \varphi_T\!\left(u - \tfrac{i}{2}\right)\right] \frac{du}{u^2 + 1/4}, \qquad x = \ln\frac{S}{K} + (r-q)T
$$

The integral is computed by Gauss-Legendre quadrature (400 nodes) on $[0, U]$, with $U = \sqrt{80 / (v_{min} T)}$ bounded between 100 and 3000. The integrand decays like $e^{-vTu^2/2}$. The characteristic function depends only on $T$: it is evaluated once per expiry for all strikes. Puts follow from put-call parity.

**Checks**: with an almost zero vol of vol and $v_0 = \theta$, the price gives back Black-Scholes to within $10^{-5}$. It also agrees with Heston Monte Carlo simulation.

### 14.4 Calibration

Points used: the liquid part of the smile, that is expiries of 14 days or more, the region $|\ln(K/S)| \le \max(0.08,\,0.35\sqrt{T})$, and at most 25 options per expiry.

Bounded least squares (Trust Region Reflective) minimise the price errors normalised by the Black-Scholes vega, which are to first order implied volatility errors:

$$
\min_{v_0,\kappa,\theta,\sigma,\rho} \sum_j \left(\frac{V^{Heston}_j - V^{market}_j}{\nu^{BS}_j}\right)^2
$$

Bounds: $v_0, \theta \in [10^{-4}, 1.5]$, $\kappa \in [0.05, 15]$, $\sigma \in [0.01, 3]$, $\rho \in [-0.99, 0.99]$. Starting point: $v_0$ and $\theta$ from the implied vols of the shortest and longest expiries, $\kappa = 2$, $\sigma = 0.6$, $\rho = -0.6$.

The quality shown (RMSE and maximum error) is the **exact** implied volatility gap after inverting the model prices. On synthetic data, the calibration recovers the parameters to within $10^{-3}$ in relative terms.

### 14.5 Simulation (exotics under Heston)

Full-truncation Euler scheme on $(\ln S, v)$, with 252 steps a year and antithetic variables. Write $v^+ = \max(v, 0)$:

$$
\ln S_{t+\Delta} = \ln S_t + \ln\frac{P(0,t)}{P(0,t+\Delta)} - q\Delta - \tfrac{1}{2}v_t^+\Delta + \sqrt{v_t^+ \Delta}\, Z_1
$$

$$
v_{t+\Delta} = v_t + \kappa(\theta - v_t^+)\Delta + \sigma\sqrt{v_t^+\Delta}\left(\rho Z_1 + \sqrt{1-\rho^2}\, Z_2\right)
$$

---

## 15. SVI volatility surface and Dupire local volatility

*File: `qplat/models/svi.py`*

### 15.1 SVI per expiry

Write $k = \ln(K/F_T)$ for the log-moneyness against the forward and $w(k) = \sigma_{imp}^2(k)\,T$ for the total implied variance. Gatheral's "raw" SVI parametrisation:

$$
w(k) = a + b\left(\rho\,(k - m) + \sqrt{(k-m)^2 + s^2}\right)
$$

Each expiry (at least 7 days, at least 6 points, $|k| \le 0.5$) is fitted by least squares on $w$. Penalties enforce the absence of arbitrage on the grid $k \in [-0.5,\,0.5]$:

- **Positivity**: $a + b\,s\sqrt{1 - \rho^2} \ge 0$.
- **Butterfly** (positive risk-neutral density), with Durrleman's function:

$$
g(k) = \left(1 - \frac{k\, w'}{2w}\right)^2 - \frac{w'^2}{4}\left(\frac{1}{w} + \frac{1}{4}\right) + \frac{w''}{2} \ \ge 0
$$

- **Calendar**: $w_{T_{i+1}}(k) \ge w_{T_i}(k)$. Expiries are fitted by increasing maturity, each constrained to stay above the previous one.

### 15.2 Interpolation between expiries

The total variance is interpolated linearly in $T$ at fixed $k$, which preserves the absence of calendar arbitrage. Before the first expiry and after the last, the implied volatility is extended flat.

### 15.3 Dupire local volatility

Local volatility is the unique function $\sigma_{loc}(S, t)$ such that $dS/S = (r - q)\,dt + \sigma_{loc}\,dW$ reproduces every European price. In total variance (Gatheral, *The Volatility Surface*, eq. 1.10):

$$
\sigma_{loc}^2(k, T) = \frac{\partial w / \partial T}{g(k, T)}
$$

$w'$ and $w''$ are analytic in SVI, and $\partial w/\partial T$ comes from the interpolation between expiries. Where $g \le 0$ or $\partial w / \partial T \le 0$ (arbitrage), local volatility is undefined and is NaN.

### 15.4 Simulation under local volatility

$\sigma_{loc}$ is precomputed on a grid of 60 maturities × 81 moneyness points ($k \in [-1, 1]$), interpolated bilinearly. Arbitrage holes are filled with the implied volatility, and values are bounded between 1% and 300%. Euler scheme on $\ln S$ with 252 steps a year:

$$
\ln S_{t+\Delta} = \ln S_t + \ln\frac{P(0,t)}{P(0,t+\Delta)} - q\Delta - \tfrac{1}{2}\sigma_{loc}^2\Delta + \sigma_{loc}\sqrt{\Delta}\, Z, \qquad \sigma_{loc} = \sigma_{loc}\!\left(\ln\frac{S_t}{F_t},\, t\right)
$$

**Check**: a flat surface gives back a flat local volatility, and Monte Carlo under local volatility reprices market vanillas to within about 1%.

### 15.5 Exotics: model comparison

The same product (barrier with daily monitoring, autocall) is priced under three assumptions:
- **Black-Scholes**, with the surface's ATM implied vol at the product's maturity;
- calibrated **Heston**;
- **local volatility**.

The three models agree on ATM vanillas. The price gap between them therefore measures the **model risk** due to the smile and to the volatility dynamics. An autocall with a low protection is usually overpriced by a flat vol, which ignores the downside skew.

The same comparison exists for the digital (with, in addition, the "BS + smile slope" price and the Lewis formula under Heston), the Asian and the cliquet (section 11).

---

## 16. Portfolio and risk management

*Files: `qplat/risk/portfolio.py`, `api/routers/portfolio.py`*

### 16.1 Positions and valuation

Position types: equities, European or American options, barriers, digitals, Asians, cliquets, autocalls, bonds, index futures, CDS, caps and floors, EUR/USD FX options, variance swaps. Maturities are entered as dates and converted to ACT/365F at the valuation date.

Each position is valued with the appropriate pricer:

| Type | Pricer |
|---|---|
| European option | Black-Scholes |
| American option | 200-step CRR tree |
| Barrier | closed form (BGK if monitoring is discrete) |
| Digital | Black-Scholes closed form |
| Asian | Monte Carlo with control variate (arithmetic), closed form (geometric), 20,000 paths |
| Cliquet | Monte Carlo, 20,000 paths |
| Autocall | Monte Carlo, 20,000 paths |
| Bond | discounting on the curve |
| Future | cost of carry, with a value equal to $(F - F_{entry})$ × notional |
| Cap / floor | caplets in Black-76 or Bachelier on the currency's curve (section 21.1); ATM strike frozen when added; quantity = notional |
| Variance swap | realised variance since inception (history) + fair strike of the remaining life replicated on the SVI surface (section 12.5); quantity = vega notional |
| FX option | Garman-Kohlhagen at the position's smile vol (ATM, RR and BF entered) at the strike; underlying EUR/USD; quantity = EUR notional |
| CDS | bootstrap of the position's spread curve, then ISDA legs (section 20); quantity = notional, positive for a protection buyer |

**Market data**: last price, dividend, the currency's curve. The volatility is the SVI surface's ATM vol at the position's maturity when the underlying has listed options, otherwise the one-year realised vol.

**Seasoned products.** An Asian or a cliquet started before the valuation date already has observed fixings. They are read from the price history in the database: last close on or before the fixing date. If the history is missing, the current spot is used.
- **Asian**: past fixings enter the average. The geometric formula, the Lévy approximation and Monte Carlo average over the contract's $n$ fixings, of which $n_{past}$ are already known.
- **Cliquet**: completed periods are accrued (sum of locally bounded returns). The running period has a frozen reference level, the price at the last reset; at inception it is the initial level set when the position was added. Once started, the cliquet therefore has a non-zero delta, whereas it has a zero delta before it starts.
- Once every fixing is known, the value is the payoff, with no sensitivity left.

For theta, a fixing that falls during the one-day shift is fixed at today's spot.

**Seasoned caps.** The schedule is built on the contract dates. Caplets whose payment is past are ignored. The running period's caplet has already been fixed, but SOFR / Euribor fixings are not stored: it is valued at its intrinsic value, with the fixing approximated by the curve rate up to its payment date.

**FX options.** EUR/USD is an underlying like any other. It has its delta cash (exposure in euros), enters the historical VaR with its own returns, and takes the spot shocks of the stress tests. The vol shock of the stress tests shifts the ATM vol of the position's quoted smile. Rho adds up the sensitivities to the USD and EUR rates, since rate shocks shift both curves. The vega of caps is expressed per 1% of lognormal vol or 1 bp of normal vol, depending on the model.

**Variance swaps.**
- **Strike**: by default, today's fair strike for the whole period, frozen when added.
- **Delta**: zero.
- **Gamma**: each daily return $r$ adds $10^4 r^2 / T$ variance points. The P&L of a 1% move is therefore $N_{var}/T$ (discounted), an exactly quadratic term that enters the historical VaR as a gamma.
- **Vega**: per point of implied vol over the remaining life. The vol shock of the stress tests shifts the remaining implied vol; the spot shock does not revalue the swap (frozen surface), its realised variance effect goes through gamma.
- **Theta**: the loss of a day without any move. That day's implied variance is not realised: the variance buyer pays this carry.

Amounts are converted to **euros**, with the latest EUR/USD rate stored in the database. Positions are saved in the SQLite table `positions` (contract terms in JSON, entry price per unit).

### 16.2 Aggregated sensitivities

For a position of quantity $Q$ and multiplier $M$, with $fx$ the exchange rate to the euro:

$$
\Delta_{cash} = \Delta\, S\, Q M \cdot fx, \qquad \Gamma_{1\%} = \tfrac{1}{2}\, \Gamma\, (0.01\, S)^2\, Q M \cdot fx
$$

$\Gamma_{1\%}$ is the P&L of the gamma term for a 1% move of the underlying. Vega is given per vol point, theta per day, rho per 1% of rate, and DV01 for bonds and CDS. Aggregates are shown by underlying, by book and by instrument type.

**CDS positions.**
- **CS01**: change for +1 bp on the whole spread curve.
- **Jump-to-default**: P&L if the issuer defaults immediately, $\pm N(1-R) - V$.
- **Theta**: one-day carry of the premium.
- **Rho**: IR01 × 100.

These measures are aggregated, together with the worst single default and the net protection notional. A CDS position keeps its spread curve in its parameters. It is updated from the position list. The entry price is kept, so the effect of spreads widening or tightening shows up in the P&L.

### 16.3 Stress tests

Each scenario is a **full revaluation** of the book:

- **Equity × volatility grid**: relative shocks on every underlying from −20% to +20%, crossed with absolute vol shocks from −5 to +10 points.
- **Rate shocks**: parallel shifts of ±50 and ±100 basis points, applied to every curve. For CDS, quoted spreads are kept and the default curve is re-bootstrapped.
- **Credit spread shocks**: shifts of −25, +25, +50, +100 and +200 bp of every CDS curve, with full revaluation.

The historical VaR covers only the equity underlyings. There is no public history of CDS spreads: credit risk is therefore measured by the spread shocks and the jump-to-default.

### 16.4 Value at Risk and Expected Shortfall (1 day)

**Historical VaR.** The actual daily returns are replayed, on the dates common to every underlying of the book (about 2 years). The P&L of each scenario $s$ is approximated to second order (delta-gamma):

$$
\text{P\&L}_s = \sum_{i} \left[\Delta_{cash,i}\, r_{i,s} + \tfrac{1}{2}\,\Gamma_i S_i^2\, r_{i,s}^2\right]
$$

$$
\text{VaR}_\alpha = -\,\text{quantile}_{1-\alpha}(\text{P\&L}), \qquad \text{ES}_\alpha = -\,\mathbb{E}\big[\text{P\&L} \mid \text{P\&L} \le -\text{VaR}_\alpha\big]
$$

**Parametric VaR (delta-normal).** With $\Sigma$ the covariance matrix of returns on the same history:

$$
\text{VaR}_\alpha = z_\alpha \sqrt{\Delta_{cash}^\top\, \Sigma\, \Delta_{cash}}, \qquad z_{95\%} = 1.645, \quad z_{99\%} = 2.326
$$

The VaR covers equity risk. Rate and volatility risks are measured by the stress tests.

### 16.5 P&L explain

The full revaluation at the previous close is compared with the latest price, decomposed for each position:

$$
\text{P\&L} = \underbrace{\Delta_{cash}\, r}_{\text{delta}} + \underbrace{\Gamma_{1\%}\left(\frac{r}{1\%}\right)^2}_{\text{gamma}} + \underbrace{\Theta \cdot \text{days}}_{\text{theta}} + \text{residual}
$$

A small residual validates the sensitivities. A large residual signals higher-order effects or a market jump.

**Simplifications**: the "missed coupons" state of autocalls already alive is not tracked; volatility and rates are assumed unchanged in the P&L explain.

---

## 17. Portfolio allocation

*Files: `qplat/allocation/estimation.py`, `qplat/allocation/optimize.py`, `qplat/allocation/backtest.py`, `api/routers/allocation.py`*

### 17.1 Data

The universe is the platform's: stocks, ETFs and indices, with about 2 years of daily closes. Returns are computed in **euros**. A dollar asset seen by a European investor is worth $P_{EUR} = P_{USD} / \text{EURUSD}$: its return includes the currency risk. Only dates where every asset trades are kept. Everything is annualised with 252 days.

### 17.2 Estimation and estimation error

**Ledoit and Wolf (2004) covariance.** The sample covariance $S$ is shrunk towards a target $F = m I$, where $m$ is the average variance. The intensity is estimated from the data:

$$
\hat\Sigma = \delta^* F + (1 - \delta^*) S, \qquad \delta^* = \min\left(1, \frac{\hat b^2}{\hat d^2}\right), \quad \hat d^2 = \frac{\|S - F\|^2}{p}, \quad \hat b^2 = \frac{1}{n^2 p}\sum_t \|x_t x_t' - S\|^2
$$

The resulting matrix is always positive definite, and $\delta^*$ decreases as the number of observations grows.

**James-Stein expected returns (Jorion, 1986).** The means are shrunk towards the common mean $\bar\mu$:

$$
\hat\mu_{JS} = w\, \bar\mu \mathbf{1} + (1 - w)\, \hat\mu, \qquad w = \min\left(1, \frac{p - 2}{n\,(\hat\mu - \bar\mu\mathbf 1)' \hat\Sigma^{-1} (\hat\mu - \bar\mu \mathbf 1)}\right)
$$

On 2 years of data, $w = 1$: the gaps between mean returns cannot be told apart statistically. This is the main reason for the poor performance of "naive" mean-variance (Michaud, 1989).

### 17.3 Optimisation problem

$$
\max_w \; \mu' w - \frac{\gamma}{2} w' \Sigma w - \lambda_1 \|w\|_1 - \lambda_2 \|w\|_2^2 - \frac{c}{h}\, \|w - w_0\|_1
$$

$$
\text{s.t.} \quad \mathbf 1' w = 1, \qquad -s_{max} \le w_i \le w_{max}
$$

- **γ**: risk aversion.
- **$\lambda_1$, $\lambda_2$**: elastic-net penalties (LASSO and ridge).
- **$c$**: proportional cost. It is amortised over the holding period $h$ (in years) to be comparable with an annual return.
- **$w_0$**: the current portfolio (1/N by default).

The non-differentiable terms are smoothed by splitting the variables: $w = u - v$ and $w - w_0 = b - s$, with $u, v, b, s \ge 0$. This gives a quadratic programme solved by SLSQP, with exact gradients. Unneeded variables are dropped: $v$ in long-only, $(b, s)$ without costs.

**Closed-form results used as tests**, with no constraint other than the budget:

$$
w_{GMV} = \frac{\Sigma^{-1}\mathbf 1}{\mathbf 1'\Sigma^{-1}\mathbf 1}, \qquad w^* = w_{GMV} + \frac{1}{\gamma}\left( \Sigma^{-1}\mu - \frac{\mathbf 1'\Sigma^{-1}\mu}{\mathbf 1'\Sigma^{-1}\mathbf 1}\Sigma^{-1}\mathbf 1 \right), \qquad \sigma^2(\bar\mu) = \frac{a\bar\mu^2 - 2b\bar\mu + c}{ac - b^2}
$$

with $a = \mathbf 1'\Sigma^{-1}\mathbf 1$, $b = \mathbf 1'\Sigma^{-1}\mu$, $c = \mu'\Sigma^{-1}\mu$.

**Efficient frontier.** The minimum variance is found for a grid of target returns, from the minimum-variance portfolio to the highest attainable return. The page overlays three frontiers:
- the unconstrained frontier (closed form);
- the frontier with bounded short sales;
- the long-only frontier.

**Tangency portfolio** (maximum Sharpe): the best point of the grid, refined by a golden-section search on the target return.

**Risk contributions**: $RC_i = w_i (\Sigma w)_i / w'\Sigma w$, which sum to 1. **Effective number of assets**: $1/\sum w_i^2$.

### 17.4 LASSO and elastic-net

In long-only, $\|w\|_1 = \mathbf 1' w = 1$ is constant: the L1 penalty changes nothing. The no-short-selling constraint then acts as a regularisation by itself (Jagannathan and Ma, 2003). With short sales, the L1 penalty reduces the gross exposure and sets weights exactly to zero (Brodie et al., 2009).

The LASSO tab plots the regularisation path of the minimum-variance portfolio:
- the covariance is estimated on the first 60% of the days;
- the volatility is measured on the following 40%;
- as a function of $\lambda_1$, it tracks the number of assets, the gross exposure and the in-sample and out-of-sample volatilities.

This is the bias-variance trade-off: the in-sample vol rises with $\lambda_1$, while the out-of-sample vol first falls, then rises again.

### 17.5 Out-of-sample backtest

The backtest is *walk-forward*. At each rebalancing $t$ (every 21 days by default), the rule sees only the returns of the $W$ days strictly before $t$; a test checks there is no look-ahead. The weights then drift with prices. The costs $c \sum_i |w_i^{new} - w_i^{drift}|$ are charged at each rebalancing.

The strategies compared are:
- **1/N**;
- **long-only minimum variance** (Ledoit-Wolf, capped weights);
- **mean-variance** with sample means and short sales;
- **long-only mean-variance** with shrinkage;
- **elastic-net minimum variance** with shorts;
- **cost-penalised mean-variance**.

The measures are the annualised return, volatility, Sharpe ratio (3-month EUR rate), maximum drawdown, turnover and cumulative costs.

The result reproduces DeMiguel, Garlappi and Uppal (2009):
- 1/N is hard to beat;
- mean-variance at sample means with shorts accumulates huge turnover and high volatility;
- minimum variance gives the lowest volatility;
- constraints, shrinkage and cost penalties reduce estimation error and turnover.

With 2 years of history the sample is still short: the gaps are indicative.

---

## 18. Research: volatility-managed portfolios

*Files: `qplat/research/vol_managed.py`, `api/routers/research.py`*

### 18.1 Data

The daily factors of the Kenneth French data library are downloaded once a week into the `factor_returns` table:
- market (Mkt-RF), size (SMB) and value (HML), since July 1926;
- momentum, since November 1926;
- profitability (RMW) and investment (CMA), since July 1963;
- risk-free rate.

Monthly returns are obtained by compounding daily returns. A month's realised variance is the sum of squared deviations of daily returns from their monthly mean:

$$
RV_t = \sum_{d \in t} \left( f_d - \bar f_t \right)^2
$$

### 18.2 The strategy (Moreira and Muir, 2017)

$$
f^\sigma_{t+1} = \frac{c}{RV_t}\, f_{t+1}
$$

The exposure in month $t+1$ is inversely proportional to the realised variance of month $t$. Two versions are offered:
- **As in the paper**, $c$ is chosen on the whole sample so that $f^\sigma$ has the same volatility as $f$.
- **In real time**, $c_t$ uses only the past: ratio of the standard deviations of $f$ and $f/RV$ over an expanding window, after 10 years of history.

Two robustness options are added:
- a leverage cap;
- costs proportional to the change in exposure, $|w_t - w_{t-1}|$.

### 18.3 The test

$$
f^\sigma_{t+1} = \alpha + \beta f_{t+1} + \varepsilon_{t+1}
$$

Standard errors are Newey-West (6 lags, Bartlett kernel). The **appraisal ratio** $\alpha / \sigma_\varepsilon$ (annualised) measures the Sharpe gain from combining $f$ and $f^\sigma$:

$$
SR_{new}^2 = SR_{f}^2 + \left(\frac{\alpha}{\sigma_\varepsilon}\right)^2
$$

A positive alpha means the strategy expands the mean-variance frontier. As a robustness check, the alpha against the three Fama-French factors is computed too.

**Replication.** On 1926-2015 (the paper's sample), the market factor gives α = 4.9% a year, β = 0.60 and an appraisal ratio of 0.33, as in Table I of Moreira and Muir. The effect is strong on the market, momentum and profitability, weak or absent on size and investment.

### 18.4 Why it works

Months are sorted into quintiles of the previous month's realised variance. From the calmest quintile to the most turbulent:
- next month's volatility rises sharply, because volatility is persistent;
- the mean return does not rise in proportion.

The mean / variance ratio, which sets the optimal exposure $w^* = \mu / (\gamma \sigma^2)$ of a mean-variance investor, therefore falls with past volatility. Cutting exposure after a turbulent month follows this rule. The strategy also avoids part of the crashes, which come in periods that are already volatile: 1929-1932, 2008, and the 2009 momentum crash.

### 18.5 Limits

- **Real-time constant.** The alpha falls sharply when $c$ is estimated without looking ahead (Cederburg, O'Doherty, Wang and Yan, 2020).
- **Leverage.** The exposure exceeds 10 times the factor after very calm months. Capping it reduces the alpha.
- **Implementation.** The market is tradable (futures), but the long-short factors are theoretical portfolios, with no transaction costs or short-selling constraints.
- **Stability over time.** The alpha varies a lot from one decade to the next (chart by decade).

---

## 19. Applied theory: replication, hedging, stochastic calculus, P and Q, short rate, predictive regression

*Files: `qplat/theory/replication.py`, `qplat/theory/hedging.py`, `qplat/theory/stochastic.py`, `qplat/theory/measures.py`, `qplat/theory/vasicek.py`, `qplat/theory/predictive.py`, `api/routers/theory.py`*

### 19.1 Replication on the binomial tree

At each period, the stock moves from $S$ to $uS$ or $dS$, and the bank account is multiplied by the gross rate $R$. At each node, the option is replicated by $\Delta$ shares and $B$ in the bank:

$$
\Delta = \frac{V_u - V_d}{S_u - S_d}, \qquad B = \frac{V_u - \Delta S_u}{R}, \qquad V = \Delta S + B = \frac{\pi V_u + (1-\pi) V_d}{R}, \qquad \pi = \frac{R - d}{u - d}
$$

The risk-neutral probability $\pi$ exists and lies between 0 and 1 if and only if $d < R < u$. Otherwise the tree is rejected, because there is an arbitrage. Under $\pi$, $\mathbb E_Q[S_1/S_0] = R$: the stock earns the risk-free rate.

**Checks** on the textbook example ($S_0 = 100$, $u = 1.2$, $d = 0.8$, $R = 1.05$, put $K = 110$, all tested):
- **One period**: $P_0 = 10.714$, $\Delta = -0.75$, $B = 85.714$.
- **Two periods**: $P_0 = 11.820$; at the intermediate nodes, $(\Delta, B) = (-0.2917, 40)$ and $(-1, 104.762)$.
- **Path probabilities**: $Q(S_2 = 96) = 2 \times 0.625 \times 0.375 = 0.46875$, and the direct valuation $\sum Q \times \text{payoff} / R^N$ gives back the induction price.
- **Self-financing**: the portfolio set at the parent node is worth exactly the option at each child node. The page shows it for every node.
- **Convergence**: with $u = e^{\sigma\sqrt{\Delta t}}$ and $d = 1/u$, the tree converges to Black-Scholes.

**Market maker.** The market maker sells at the ask, keeps the margin (ask − price) and rebalances along a chosen path. Each purchase or sale of shares is funded by the bank account, and the hedge pays the client exactly at expiry, whatever the path.

### 19.2 Dynamic delta hedging

An option is sold at the Black-Scholes price with the implied vol $\sigma_i$, then hedged $N$ times. The underlying follows a geometric Brownian motion under the real-world probability: drift $\mu$ and realised vol $\sigma_r$, with exact simulation. Cash earns $r$ and the shares held receive the dividend.

- **Drift independence.** With $\sigma_r = \sigma_i$, the mean P&L is zero whatever $\mu$, up to the discretisation error. The price is the cost of replication; Girsanov changes the drift, not the volatility.
- **Hedging error.** It decays in $1/\sqrt N$, because the quadratic variation $(dS)^2 = \sigma^2 S^2 dt$ becomes deterministic. Derman and Kamal's approximation:

$$
\text{sd}(\text{P\&L}) \approx \sqrt{\pi/4}\; \mathcal V\, \sigma / \sqrt N
$$

where $\mathcal V$ is the vega. The gap with the simulation is below 10% (automated test).

- **Gamma against theta.** Over one step, the short hedged position earns

$$
\tfrac12\, \Gamma S^2 \left( \sigma_i^2\, dt - \left(\tfrac{dS}{S}\right)^2 \right)
$$

If $\sigma_r \ne \sigma_i$:
- hedged with the delta at the implied vol, the position has a path-dependent P&L, with mean $\approx \tfrac12 \int \Gamma S^2 (\sigma_i^2 - \sigma_r^2)\, dt$;
- hedged with the delta at the realised vol, it locks in $BS(\sigma_i) - BS(\sigma_r)$, with less dispersion (Carr, 2005; Ahmad and Wilmott, 2005).

### 19.3 On real data

Every month, an at-the-money 21-day SPY call is sold. Its price is set at the day's VIX (30-day implied vol of the S&P 500). It is then hedged every day with the actual closes, at the USD rate and with SPY's dividend. The monthly P&L:
- has a 0.99 correlation with the gamma-theta forecast;
- wins most months, because the realised vol is usually below the VIX;
- loses in turbulent months.

This is the variance risk premium of section 12.6, weighted by gamma.

### 19.4 Stochastic calculus, checked numerically

Classic stochastic-calculus results are recomputed on thousands of exactly simulated Brownian paths: $\Delta B = \sqrt{\Delta t}\, Z$.

- **Scaling.** $B_t \sim N(0, t)$: the paths stay in the band $\pm 1.96\sqrt t$ with probability 95%.
- **Total variation.** $\mathbb E\left[\sum |\Delta B_i|\right] = N \sqrt{T/N}\, \mathbb E|Z| = \sqrt{2NT/\pi} \to \infty$. The paths have no finite length, so the Riemann-Stieltjes integral does not apply.
- **Quadratic variation.** $\sum (\Delta B_i)^2 \to T$, with variance $2T^2/N \to 0$: the rule $(dB)^2 = dt$.
- **Evaluation point.** The left-point sum $L_N = \sum B_{t_i} \Delta B_i$ tends to $\tfrac12 B_T^2 - \tfrac12 T$ (zero expectation: the Itô integral is a martingale). The right-point sum $R_N$ tends to $\tfrac12 B_T^2 + \tfrac12 T$ (expectation $T$), since $R_N - L_N = \sum (\Delta B_i)^2$. Itô's lemma recovers it: $d(B^2) = 2B\,dB + dt$.
- **Martingales.** $B_t$, $B_t^2 - t$ and $e^{\lambda B_t - \lambda^2 t/2}$ have a constant expectation. $B_t^2$ and $e^{\lambda B_t}$ drift, with $\mathbb E[e^{\lambda B_t}] = e^{\lambda^2 t/2}$ (the Laplace transform of the normal law).

### 19.5 Girsanov and importance sampling

With $Y = dQ/dP = \exp(\theta B_T - \tfrac12\theta^2 T)$, we have $\mathbb E_P[Y] = 1$ and, under $Q$, $B_T \sim N(\theta T, T)$: the density is the density under $P$ multiplied by $Y$. The possible paths do not change, only their weights; the drift moves, not the volatility. The page checks $\mathbb E_P[Y] \approx 1$ and $\mathbb E_P[Y B_T] = \theta T$.

**Application.** The theorem is read the other way round: we simulate under a measure where the rare event becomes typical, then correct by $dP/dQ$ (section 7.3). The page compares plain Monte Carlo and importance sampling on a far out-of-the-money call, put or digital:
- the exact price, the variance reduction and the convergence;
- the standard error as a function of $\theta$. It is smallest near $\theta^*$ and rises beyond, when a few weights become huge.

### 19.6 Real-world P and risk-neutral Q on a real stock

**Two lognormals, one vol.** Under $P$, $\ln S_T \sim N\big(\ln S_0 + (\mu - q - \tfrac12\sigma^2)T,\ \sigma^2 T\big)$; under $Q$, $\mu$ is replaced by $r$. Girsanov shifts the drift by $\lambda = (\mu - r)/\sigma$, the market price of risk, and leaves $\sigma$ unchanged: both laws use the at-the-money implied vol of the maturity. For a lognormal, $\text{mode} = e^{m - s^2} < \text{median} = e^{m} < \text{mean} = e^{m + s^2/2}$, with $m$ and $s^2$ the mean and variance of $\ln S_T$. Under $Q$, the mean is the forward $S_0 e^{(r-q)T}$.

**The market's $Q$ (Breeden-Litzenberger, 1978).** With $C(K) = D\,\mathbb E_Q[(S_T - K)^+]$:
$$Q(S_T \le K) = 1 + \frac{1}{D}\frac{\partial C}{\partial K}, \qquad q(K) = \frac{1}{D}\frac{\partial^2 C}{\partial K^2}.$$
Call prices come from the SVI surface (section 15) on a uniform grid of 2,001 strikes, from $F e^{-12\sigma\sqrt T}$ to $F e^{6\sigma\sqrt T}$, and the derivatives are taken by central finite differences. Checks shown: mass of the density, $\mathbb E_Q[S_T]$ against the forward (gap of the order of 0.01% on SPY), negative mass (butterfly arbitrage), mass outside the grid. The skew fattens the left tail: at the same ATM vol, $Q(S_T < 0.8\,S_0)$ at 3 months is about 6% for SPY, against 1.5% for the lognormal. To keep the mean at the forward, the median and the mode move up above the spot.

**The expected return $\mu$.** Three possible sources:
- CAPM: $\mu = r + \beta \cdot \text{premium}$, with $\beta$ estimated against SPY on the history and the market premium equal to the arithmetic mean of the Fama-French market factor since 1926 (about 7.8% a year);
- the stock's history: $\hat\mu = 252\,\overline{\Delta \ln S} + \tfrac12\hat\sigma^2 + q$, with standard error $\hat\sigma/\sqrt{\text{years}}$, about 12 points for SPY over two years. This is why CAPM is the default;
- a free value.

The page also overlays the empirical law: the historical returns over the horizon, in overlapping windows that are therefore highly correlated.

**Fan and pricing kernel.** The 5%, 50% and 95% quantiles are plotted by horizon under $P$, under lognormal $Q$ and under the market's $Q$. The ratio $q/p$ is the state-price density up to the discount factor. For two lognormals it equals $\exp(-\lambda W_T - \tfrac12\lambda^2 T)$, decreasing in $S_T$ when $\mu > r$. With the smile it is much steeper on the left, and its non-monotonic shape around the spot is the *pricing kernel puzzle* (Jackwerth, 2000).

**Tests.** On a flat smile, Breeden-Litzenberger gives back the lognormal (density within $10^{-5}$, distribution function within $10^{-5}$, mean equal to the forward). Also tested: the mode < median < mean order and the closed forms, a shift of every quantile by $e^{(\mu - r)T}$ between $P$ and $Q$, the fatter left tail under a skew with the mean unchanged, the decreasing kernel when $\mu > r$, and the standard error of $\hat\mu$ on 40 simulated years.


### 19.7 Short rate: Ornstein-Uhlenbeck and Vasicek

*File: `qplat/theory/vasicek.py`*

**The process.** The short rate follows $dr = \kappa(\theta - r)\,dt + \sigma\, dW$: it is pulled back towards $\theta$ at speed $\kappa$. Its law is Gaussian:

$$
\mathbb E[r_t] = \theta + (r_0 - \theta)e^{-\kappa t}, \qquad \text{Var}(r_t) = \frac{\sigma^2}{2\kappa}\left(1 - e^{-2\kappa t}\right)
$$

The stationary law is $N(\theta, \sigma^2/2\kappa)$ and the half-life of a deviation from the mean is $\ln 2 / \kappa$.

**Data.** 3-month rates over decades, downloaded once a week into the `short_rates` table:
- USD: 3-month Treasury bills since 1990, published by the US Treasury (simple yield, converted to a continuous rate $\ln(1 + 0.25\,y)/0.25$);
- EUR: 3-month zero rate of the ECB AAA curve since 2004 (already continuous).

The sample is the last observation of each month (default), of each week, or every day.

**Estimation by regression.** Sampled at step $\Delta t$, the process is exactly an AR(1):

$$
r_{t+\Delta t} = a + b\, r_t + \varepsilon, \qquad b = e^{-\kappa \Delta t}, \quad a = \theta(1 - b), \quad \text{Var}(\varepsilon) = \frac{\sigma^2 (1 - b^2)}{2\kappa}
$$

Ordinary least squares give $\hat a$, $\hat b$ and the residual standard deviation, hence $\hat\kappa = -\ln \hat b / \Delta t$, $\hat\theta = \hat a / (1 - \hat b)$ and $\hat\sigma$. The standard errors of $\hat\kappa$ and $\hat\theta$ come from the delta method; the half-life interval is the image of the 95% interval on $b$. If $\hat b \ge 1$, no pull-back is detected and the process is not estimated.

**Small-sample bias.** The slope $\hat b$ is biased downwards, by about $-(1 + 3b)/n$ (Kendall, 1954), so $\hat\kappa$ overstates the pull-back. The page shows it by Monte Carlo: 400 paths of the same length are simulated exactly with the estimated parameters taken as the truth, and $\kappa$ is re-estimated on each one. On monthly US rates since 1990, $\hat\kappa \approx 0.12$ (a 6-year half-life), but the 95% interval of the half-life runs from 3 to 52 years and the simulated mean of $\hat\kappa$ exceeds the true value by almost half. Corrected for the Kendall bias, the slope is almost exactly 1: the mean reversion of rates is barely identifiable. This is the same bias as Stambaugh's (1999) for predictive regressions on a persistent variable.

**Instability.** The parameters are re-estimated from several start dates. Since 2009, rates start at zero and end around 4 to 5%: the slope exceeds 1 and no pull-back appears. $\theta$ and the half-life change completely from one monetary-policy regime to the next.

**Vasicek curve (1977).** Under the risk-neutral measure, the price of a zero-coupon bond is affine in $r$:

$$
P(t, t+\tau) = A(\tau)\, e^{-B(\tau)\, r_t}, \qquad B(\tau) = \frac{1 - e^{-\kappa\tau}}{\kappa}, \qquad \ln A(\tau) = \left(\theta - \frac{\sigma^2}{2\kappa^2}\right)(B - \tau) - \frac{\sigma^2 B^2}{4\kappa}
$$

The zero rate $-\ln P/\tau$ starts at $r$ and tends to $\theta - \sigma^2/(2\kappa^2)$; the instantaneous forward is $f(0,t) = \mathbb E_Q[r_t] - \tfrac12 \sigma^2 B(t)^2$ (convexity).

**P against Q.** Girsanov changes the drift, not the volatility: $\sigma$ is the one from the time series. Two curves are compared with today's market zero curve (section 3), with $r_0$ equal to the 3-month zero rate:
- **under P**, with the historical $\kappa$ and $\theta$: the curve that rate expectations alone would give, with no risk premium;
- **under Q**, with $(\kappa_Q, \theta_Q)$ calibrated by least squares on 11 pillars from 3 months to 30 years (several starting points, because a small $\kappa$ and a large $\theta$ offset each other).

In November 2026 on the dollar, the calibration gives $\kappa_Q \approx 0.11$, close to the historical $\kappa$, but $\theta_Q \approx 6\%$ against $\theta \approx 2\%$; the fit error is 9 bp. The difference between the 10-year yields under Q and under P, about 160 bp, is the model's term premium. The page also plots the market's one-month forwards, Vasicek's, and the law of the short rate under P (expectation and 5% and 95% quantiles), as well as the probability of a negative rate.

**Limits.** Two constant parameters do not reproduce the curve exactly (Hull-White makes $\theta$ time-dependent for that). The Gaussian model allows negative rates (Cox-Ingersoll-Ross replaces $\sigma$ with $\sigma\sqrt r$). A single factor moves all rates together: slope and curvature never move independently.

**Tests.** Moments of the exact simulation, parameters recovered by the regression on a long simulated series, no pull-back on a rising series, slope bias in line with Kendall, limits of the zero rate ($r_0$ at 0, $\theta - \sigma^2/2\kappa^2$ at infinity, average of the expected path when $\sigma \to 0$), forward equal to $-\partial_t \ln P$, zero-coupon price equal to the Monte Carlo of $\mathbb E[e^{-\int r}]$, exact calibration round trip, probability of a negative rate.

### 19.8 Predictive regression and the Stambaugh bias

*File: `qplat/theory/predictive.py`*

**The system.** A predictive regression explains the next period's return with a variable known today, which is itself persistent:

$$
r_{t+1} = \alpha + \beta\, x_t + u_{t+1}, \qquad x_{t+1} = \mu + \rho\, x_t + v_{t+1}, \qquad \gamma = \frac{\text{Cov}(u, v)}{\text{Var}(v)}
$$

In continuous time, this is a stock whose drift depends on an Ornstein-Uhlenbeck factor: $d\ln X = (a + bY - \tfrac12\sigma_X^2)\,dt + \sigma_X\, dB^X$ and $dY = \theta(\bar Y - Y)\,dt + \sigma_Y\, dB^Y$, with $d\langle B^X, B^Y\rangle = \varrho\, dt$. Sampled every $\Delta t$, this model gives exactly the system above, with $\rho = e^{-\theta\Delta t}$ and $\beta = b\,(1 - e^{-\theta\Delta t})/\theta$. Both shocks share the increments of $B^Y$, hence a non-zero covariance even when $\varrho = 0$ (`continuous_to_discrete`, integrals in closed form, checked against a fine simulation).

**The bias.** In small samples, $\hat\rho$ is biased downwards by about $-(1 + 3\rho)/n$ (Kendall, 1954). Since $u = \gamma v + \eta$ with $\eta$ independent of $v$, the error on $\rho$ carries over to $\beta$ (Stambaugh, 1999):

$$
\mathbb E[\hat\beta - \beta] = \gamma\, \mathbb E[\hat\rho - \rho] \approx -\gamma\, \frac{1 + 3\rho}{n}
$$

With a valuation ratio, $\rho$ is close to 1 and the shock correlation close to −1 (a price rise lowers $D/P$ in the same month): $\gamma < 0$, so $\hat\beta$ is biased upwards, towards "predictability". The t-statistic is no longer normal and rejects $\beta = 0$ too often.

**Corrections.**
- Stambaugh: $\hat\beta - \hat\gamma\,(-(1 + 3\hat\rho)/n)$.
- Amihud and Hurvich (2004): $\hat\rho^c = \hat\rho + (1 + 3\hat\rho)/n + 3(1 + 3\hat\rho)/n^2$ (capped at 0.9999), corrected residuals $v^c_{t+1} = x_{t+1} - \hat\mu^c - \hat\rho^c x_t$, then a regression of $r_{t+1}$ on $x_t$ and $v^c_{t+1}$. The coefficient on $x_t$ is $\hat\beta^c$, with standard error $\sqrt{\widehat{\text{Var}}(\hat\beta^c) + \hat\phi^2 (1 + 3/n + 9/n^2)^2\, \widehat{\text{Var}}(\hat\rho)}$, where $\hat\phi$ is the coefficient on $v^c$.
- Bootstrap under the null: 2,000 histories where $x$ follows its corrected AR(1) and the return is its mean plus a residual; the $(u, v)$ pairs are drawn together to keep their correlation. The p-value is the share of histories whose $\hat\beta$ exceeds the observed one.

**Simulator.** The page simulates 4,000 samples (2,000 beyond 600 observations) with $\beta = 0$, unit-variance shocks, and a chosen persistence $\rho$, correlation and size $n$. It shows the $(\hat\rho - \rho, \hat\beta)$ scatter around the line of slope $\gamma$, the distribution of the OLS and Amihud-Hurvich t-statistics, and the actual false-positive rate at the 5% level. With $\rho = 0.98$, a correlation of −0.95 and 240 months, the OLS t exceeds 1.645 in 19% of cases; after correction, 6%.

**Dividend yield (Shiller's data).** Monthly S&P composite index since 1871 (price, 12-month dividends), downloaded once a week from shillerdata.com into the `shiller_monthly` table. Return $r_{t+1} = \ln\big((P_{t+1} + D_{t+1}/12)/P_t\big)$, predictor $x_t = \ln(D_t/P_t)$. Shiller's prices are monthly averages of closes, which adds a little autocorrelation to returns. Results in November 2026:

| Since | n | $\hat\rho$ | corr(u, v) | $\hat\beta$ | t | Estimated bias | $\hat\beta^c$ | Corrected t |
|---|---|---|---|---|---|---|---|---|
| 1871 | 1,868 | 0.9978 | −0.97 | −0.0002 | −0.08 | +0.0020 | −0.0021 | −1.07 |
| 1927 | 1,196 | 0.9974 | −0.97 | +0.0017 | 0.66 | +0.0031 | −0.0006 | −0.24 |
| 1950 | 920 | 0.9971 | −0.98 | +0.0053 | 2.07 | +0.0042 | +0.0026 | 1.02 |
| 1990 | 440 | 0.9918 | −0.99 | +0.0074 | 1.22 | +0.0087 | −0.0004 | −0.07 |

Since 1950 the classic regression looks significant (t = 2.07), but the estimated bias is 80% of the coefficient; the bootstrap gives a p-value of 0.18 and an actual 5% t threshold of 2.53. Since 1990 the bias exceeds the coefficient itself.

**Sentiment score.** The same regression with, as $x_t$, the average Claude score (section 23) of the headlines usable before the 4 pm New York close (a headline published later counts for the next session), and as $r_{t+1}$ the next session's log return: SPY for the pooled news on SPY, QQQ, AAPL, MSFT and NVDA, or a single name's own return. The score can be smoothed by an exponential average (3- or 10-session half-life), restarted after every coverage gap; smoothing makes it persistent and therefore exposed to the bias. Only pairs of consecutive sessions that are both covered are used, and the estimation needs at least 10 pairs. Scoring, interrupted from 21 October to 23 November 2026 (credit exhausted, section 22.3), was caught up in one go; at the end of November 2026 the sample holds 26 to 29 pairs of sessions depending on the series. With so little data, and after trying six series and three smoothings, a significant coefficient (AAPL, negative β: overreaction then reversal the next day) remains to be confirmed out of sample; the page says so.

**Tests.** Simulated bias in line with Stambaugh's formula, slope $\gamma$ of the $(\hat\rho - \rho, \hat\beta)$ scatter, no bias when the shocks are independent (and a 5% test size), over-rejection of the OLS t and correct size for Amihud-Hurvich, corrections on a single sample, bootstrap p-values under the null and under true predictability, exact mapping from continuous time to the discrete system against a fine Euler scheme.

---

## 20. Credit: CDS and the Merton model

*Files: `qplat/credit/cds.py`, `qplat/credit/merton.py`, `api/routers/credit.py`*

### 20.1 Default curve

Default is the first jump of a Poisson process with intensity $\lambda(t)$, piecewise constant between pillars $T_1 < \dots < T_n$ (and constant beyond the last one):

$$
Q(t) = \mathbb{P}(\tau > t) = \exp\left( -\int_0^t \lambda(s)\, ds \right)
$$

**Credit triangle**: with a constant intensity, $s \approx \lambda (1 - R)$.

### 20.2 The two legs of a CDS

Premium $c$ paid quarterly (ACT/360 basis, schedule built backwards from maturity), recovery $R$, discount curve $P(0,t)$:

$$
\text{Protection} = (1 - R) \int_0^T P(0,t)\, dF(t), \qquad F = 1 - Q
$$

$$
\text{RPV01} = \sum_k \alpha_k\, P(0,t_k)\, Q(t_k) \;+\; \underbrace{\int_0^T \alpha(t)\, P(0,t)\, dF(t)}_{\text{accrued premium paid on default}}
$$

The integrals are computed on a weekly grid that includes every payment date and pillar. On each sub-interval, $\lambda$ and the forward rate $f$ are constant, and the ISDA Standard Model formula is exact:

$$
\int_a^b \lambda\, P(t) Q(t)\, dt = \frac{\lambda}{\lambda + f} \left[ P(a)Q(a) - P(b)Q(b) \right]
$$

**Par spread**: $s = \text{Protection} / \text{RPV01}$.

**Upfront.** Since the 2009 Big Bang, a CDS trades with a standard coupon (100 bp for investment grade, 500 bp for high yield). The difference is settled at inception: $U = \text{Protection} - c \cdot \text{RPV01}$, positive if the protection buyer pays.

### 20.3 Bootstrap

We start from the quoted par spreads for $T_1 < \dots < T_n$. $\lambda_j$ is solved sequentially (Brent) on the segment $(T_{j-1}, T_j]$ so that the CDS of maturity $T_j$ reprices its spread, the previous segments being already fixed. Each quoted spread is repriced within $10^{-12}$. A curve that is too inverted would require a negative intensity: it is rejected.

There is no free source of CDS spreads. The platform therefore offers typical curves (A, BBB, BB, B, distressed), free input, and the curve implied by the Merton model (section 20.6).

### 20.4 Risks of a position

Value for the protection buyer: $N(\text{Protection} - c \cdot \text{RPV01})$; for the seller, the opposite.

| Measure | Definition |
|---|---|
| CS01 | change in value for +1 bp on every quoted spread, curve re-bootstrapped ($\approx N \cdot \text{RPV01} \cdot 10^{-4}$) |
| IR01 | +1 bp on the rate curve, quoted spreads unchanged (re-bootstrap) |
| Recovery +1% | quoted spreads unchanged: a higher recovery implies a higher intensity |
| Jump-to-default | $\pm N(1 - R) - V$: P&L if the issuer defaults immediately |
| 1-day carry | $\mp N c / 360$ |

### 20.5 Merton model (1974)

The asset value $V$ follows a geometric Brownian motion with volatility $\sigma_V$. The debt is a zero-coupon with face value $D$ at horizon $T$, and default occurs if $V_T < D$. The equity is therefore a call on the assets:

$$
E = V N(d_1) - D e^{-rT} N(d_2), \qquad d_{1,2} = \frac{\ln(V/D) + (r \pm \sigma_V^2/2) T}{\sigma_V \sqrt T}
$$

$$
\sigma_E E = N(d_1)\, \sigma_V V \qquad \text{(Itô's lemma)}
$$

**Calibration.** $E$ (price × number of shares) and $\sigma_E$ (1-year ATM implied vol from the SVI surface when it exists, otherwise 1-year realised vol) are observed. The two equations are solved for $(V, \sigma_V)$ by least squares, in log variables normalised by $E$, with a tolerance of $10^{-14}$.

**Default point.** The annual balance sheet is downloaded every week (Yahoo Finance) and converted into the quote currency if needed. By default, the KMV convention is used: $D$ = short-term debt + ½ long-term debt. Total debt or a free value are also possible.

**Outputs:**

$$
\text{DD} = d_2, \qquad \text{PD}^{\mathbb Q} = N(-d_2), \qquad B = V - E = D e^{-rT} - \text{Put}(V, D)
$$

$$
s = -\frac1T \ln\frac{B}{D e^{-rT}}, \qquad R_{impl} = \frac{\mathbb{E}^{\mathbb Q}[V_T \mid V_T < D]}{D} = \frac{V e^{rT} N(-d_1)}{D\, N(-d_2)}
$$

**Term structure.** With $V$ and $\sigma_V$ fixed, the default probability and the spread are recomputed for debt of varying maturity $T$.

**Sensitivities.**
- Spread as a function of equity vol.
- Spread as a function of the share price, with debt unchanged: this is the equity / credit link, the basis of capital-structure arbitrage.
- Change in spread for a 1% fall in the share price.

### 20.6 From structural to CDS

The Merton survival $Q(T) = N(d_2(T))$ is sampled every quarter. A piecewise-constant intensity is derived from it, then par CDS spreads with a market recovery (usually 40%, distinct from the model's implied recovery). This curve can be sent to the CDS pricer.

**Credit implied vol.** If an observed 5-year CDS is entered, Brent finds the equity vol $\sigma_E$ for which Merton gives back that spread.

**Known limit.** For a large, lightly indebted company, Merton gives near-zero spreads, especially at short maturities. The asset process is continuous: a firm 9 standard deviations from its default point cannot reach it within a year. Observed spreads are much higher: this is the *credit spread puzzle*. The classic extensions add:
- a barrier that can be crossed at any time (Black-Cox);
- an uncertain default point (CreditGrades);
- jumps in asset value.

---

## 21. Rate and FX options

*Files: `qplat/pricers/capfloor.py`, `qplat/fx/options.py`, `qplat/fx/smile.py`, `api/routers/caps_fx.py`*

### 21.1 Caps and floors

A cap of maturity $T$ and frequency $f$ is a series of caplets on the periods $(t_{i-1}, t_i]$, with $t_i = i/f$. The first period, already fixed today, is excluded. The simple forward rate is read from the curve:

$$
F_i = \frac{1}{\tau_i} \left( \frac{P(0, t_{i-1})}{P(0, t_i)} - 1 \right), \qquad \tau_i = t_i - t_{i-1}
$$

Caplet $i$ is an option on $L_i$, fixed at $t_{i-1}$ and paid at $t_i$.

**Black-76** (lognormal rate):

$$
\text{Caplet}_i = N \tau_i P(0,t_i) \left[ F_i N(d_1) - K N(d_2) \right], \qquad d_{1,2} = \frac{\ln(F_i/K) \pm \sigma^2 t_{i-1}/2}{\sigma \sqrt{t_{i-1}}}
$$

**Bachelier** (normal rate, usable with zero or negative rates; vol in basis points):

$$
\text{Caplet}_i = N \tau_i P(0,t_i) \left[ (F_i - K) N(d) + \sigma_n \sqrt{t_{i-1}}\, n(d) \right], \qquad d = \frac{F_i - K}{\sigma_n \sqrt{t_{i-1}}}
$$

Floorlets are the corresponding puts.

**Parity**: cap − floor = payer swap $= \sum_i N \tau_i P(0,t_i)(F_i - K)$. The **ATM** strike is the forward swap rate of the same periods, $S = \dfrac{P(0,t_1) - P(0,t_n)}{\sum_i \tau_i P(0,t_i)}$; at that strike, cap and floor are worth the same.

**Running premium**: premium divided by the annuity $\sum_i N \tau_i P(0,t_i)$.

**Implied flat vol**: the single vol that reprices the whole cap, found by Brent. This is the usual market quote.

**Greeks**:
- **DV01**: change for a +1 bp parallel shift of the curve, vol unchanged; **gamma** is the second difference over ±1 bp.
- **Vega**: per 1% of lognormal vol or 1 bp of normal vol.
- **Theta**: every date brought one day closer.

The caplet table gives, for each one, the contribution, the delta per 1 bp of forward and the vega.

**Limits.**
- Cap vols are not published for free: they are entered by hand.
- Forwards come from government curves (Treasury, ECB), not from SOFR / €STR swap curves.

### 21.2 FX options: Garman-Kohlhagen

The underlying is the price of one unit of **foreign** currency in **domestic** currency (EUR/USD: foreign EUR, domestic USD). The foreign rate plays the role of a dividend:

$$
V = \varphi \left[ S e^{-r_f T} N(\varphi d_1) - K e^{-r_d T} N(\varphi d_2) \right], \qquad F = S e^{(r_d - r_f) T}
$$

$r_d$ and $r_f$ are the USD and EUR zero-coupon rates at expiry. Forward points $(F - S) \times 10^4$ follow from covered interest parity, with no cross-currency basis.

**Greeks** (closed forms, checked by finite differences):
- **Delta**: spot delta $\varphi e^{-r_f T} N(\varphi d_1)$, forward delta $\varphi N(\varphi d_1)$, and premium-adjusted delta, equal to the spot delta minus $V/S$.
- **Gamma, vega, vanna and volga**, the last two being the cross sensitivities that drive the smile.
- **Theta**.
- **Two rhos**: domestic $\varphi K T e^{-r_d T} N(\varphi d_2)$ and foreign $-\varphi S T e^{-r_f T} N(\varphi d_1)$.

### 21.3 The delta-quoted FX smile

For each expiry, the FX market quotes three numbers.
- **ATM**: the vol of the delta-neutral straddle, with strike $K_{ATM} = F e^{\sigma_{ATM}^2 T / 2}$ (the call and put deltas cancel).
- **25Δ risk reversal**: $RR = \sigma_{25C} - \sigma_{25P}$, the skew of the smile.
- **25Δ market butterfly** (*broker fly*): a single vol $\sigma_{ATM} + BF_{mkt}$ prices the strangle whose strikes are the 25 deltas at that vol.

**Strike of a delta** (spot delta, not premium-adjusted):

$$
K = F \exp\left( -\varphi N^{-1}\!\left(\varphi\, \Delta\, e^{r_f T}\right) \sigma \sqrt T + \tfrac12 \sigma^2 T \right)
$$

Beyond one year, the forward delta is used, without the $e^{r_f T}$ factor.

**Smile butterfly** (Clark, 2011). The market butterfly is not the smile average $(\sigma_{25C} + \sigma_{25P})/2 - \sigma_{ATM}$. Brent finds the smile butterfly $BF_s$ such that:
- the pillars are $\sigma_{25C/P} = \sigma_{ATM} + BF_s \pm RR/2$, at their own 25-delta strikes;
- the smile they define exactly reprices the market strangle.

### 21.4 Vanna-Volga interpolation

With the three pillars $K_1 < K_2 = K_{ATM} < K_3$ (Castagna and Mercurio, 2007), the price of a call of strike $K$ is the Black-Scholes price at the ATM vol, corrected by the market overprice of the three pillar options:

$$
C(K) = C_{BS}(K, \sigma_{ATM}) + \sum_{i=1}^{3} x_i(K) \left[ C_{BS}(K_i, \sigma_i) - C_{BS}(K_i, \sigma_{ATM}) \right]
$$

The weights $x_i(K)$ solve the $3 \times 3$ system that matches the vega, vanna and volga of the pillar portfolio with those of the option at $K$. The vol shown is the implied vol of that price. The first-order approximation is a Lagrange interpolation of the three vols in $\ln K$; it is plotted for comparison and departs from it in the wings.

**Risk-neutral density**: $q(K) = e^{r_d T} \partial^2 C / \partial K^2$, by finite differences on the Vanna-Volga prices. A negative density would signal a butterfly arbitrage.

**Option priced on the smile.** For a strike given by a delta, the strike and the vol depend on each other: we iterate to the fixed point. The **smile effect** is the difference between the premium at the smile vol and the premium at the ATM vol.

**Limit.** ATM, RR and BF quotes are not published for free. The ATM vol starts from EUR/USD's 1-year realised vol; the risk reversal and the butterfly are entered by hand.

---

## 22. Data and orchestration

*Files: `qplat/data/*.py`, `scripts/refresh.py`*

### 22.1 Sources

| Data | Source | Frequency |
|---|---|---|
| Closing prices (2 years) and last price | yfinance | every run |
| Name, sector, currency, dividend ($q$ = trailing 12-month yield) | yfinance | every run |
| Option chains (US) | yfinance | every run |
| Balance sheet: share count, short- and long-term debt, reporting currency (Merton model) | yfinance | once a week |
| USD rates | US Treasury (daily CSV), FRED then yfinance fallback | every run |
| 3-month rates since 1990 (USD) and 2004 (EUR), Vasicek model | US Treasury, ECB | once a week |
| EUR rates | ECB data API | every run |
| EUR/USD exchange rate (conversion of the portfolio into euros) | yfinance (EURUSD=X) | every run |
| VIX (30-day implied vol of the S&P 500, variance swaps) | yfinance (^VIX) | every run |
| Monthly S&P composite index since 1871: price, dividends, earnings (predictive regression) | Robert Shiller's data (shillerdata.com, falling back on the Yale copy) | once a week |
| Daily Fama-French factors since 1926 (market, SMB, HML, RMW, CMA, momentum, risk-free rate) | Kenneth French data library | once a week |
| News | Yahoo Finance RSS feeds (French edition for Europe), Alpha Vantage optional | every run |

### 22.2 Realised volatility

Default volatility of the pricers and 1-month vol of the overview:

$$
\sigma_{realised} = \sqrt{252} \times \text{std}\big(\ln(S_t / S_{t-1})\big)
$$

over the last 252 daily returns (1 year) or the last 21 (1 month).

### 22.3 Refresh

A cron job runs every 15 minutes on weekdays. The script only refreshes the underlyings whose market is open:

| Market | Time zone | Hours |
|---|---|---|
| US | New York | 9:30 – 16:00 |
| EU | Paris | 9:00 – 17:30 |

Each job is logged in the `refresh_log` table. An error on one underlying does not stop the others.

For the online version, GitHub Actions runs the same job every hour on weekdays (7:00 to 21:00 UTC), then republishes the site.

Sentiment scoring only covers news less than 7 days old, at most 100 per run. An interruption, such as exhausted credit, therefore never turns into a large catch-up bill.

---

## 23. AI news sentiment

*File: `qplat/data/sentiment.py` — model `claude-opus-5-5`, effort `low`*

### 23.1 Scoring

Headlines not yet scored are sent to Claude in batches of 25, grouped by underlying. The prompt asks, for each headline, for the likely impact on the underlying's price over the next sessions, from a shareholder's point of view. Headlines are treated as data, never as instructions. The answer is constrained by a JSON schema:

| Field | Content |
|---|---|
| `score` | number in $[-1, 1]$, clipped server-side |
| `label` | very_negative, negative, neutral, positive or very_positive |
| `rationale` | a one-sentence justification |

### 23.2 Aggregation

An underlying's sentiment is a recency-weighted average with a 3-day half-life. For an article $a$ days old with score $s$:

$$
w = 0.5^{\,a/3}, \qquad \text{Sentiment} = \frac{\sum w_i\, s_i}{\sum w_i}
$$

A sector's sentiment is the average of its underlyings' sentiments, weighted by their number of articles.

---

## 24. Validation

*Folder: `tests/` — 247 tests*

| Reference | Check |
|---|---|
| Hull, example 15.6 | call 4.7594 and put 0.8086 (S = 42, K = 40, r = 10%, σ = 20%, T = 0.5) |
| Arbitrage relations | put-call parity; in/out parity of barriers; par bond equal to 100 |
| Greeks | closed forms compared with finite differences |
| Convergence | tree and Monte Carlo towards Black-Scholes, including with a non-flat curve |
| Longstaff-Schwartz (2001) | American put S = 36, K = 40, r = 6%, σ = 20%, T = 1: about 4.48 by the tree and by LSM |
| Haug, table 4-13 | the 24 barrier values recovered within $10^{-4}$ |
| Digitals | Haug's values (cash and asset-or-nothing), parities, call-spread limit, closed-form delta and vega, Monte Carlo |
| Asians | one fixing = European; Kemna-Vorst limit; closed-form geometric vs Monte Carlo; control variate (reduction > 50); Lévy within 1% of Monte Carlo |
| Cliquets | closed form vs Monte Carlo; sum of forward returns; zero delta; global floor; payoff recomputed by hand |
| Bootstrap | each quote repriced within $10^{-10}$ |
| Autocall | degenerate cases (zero-coupon, prepaid forward, certain call) |
| Tree | a node recomputed by hand gives back the engine's value |
| Heston | Black-Scholes limit, parity, Monte Carlo, parameters recovered by calibration |
| SVI / Dupire | fit recovered, local vol of a flat surface, calendar-arbitrage detection, Monte Carlo under local vol |
| Risks | variance swap in the book (zero value at the fair strike, vega and gamma at inception, realised variance of a seasoned swap, vol shock); cap and FX option in the book (consistency with the pricers, current caplet at intrinsic value, vol shock on the FX smile); CDS in the book (consistency with the credit engine, buyer/seller symmetry, spread shock ≈ CS01, spread update); digital, Asian and cliquet in the book, past fixings read from history; valuation in euros, Black-Scholes consistency, exact linear stress, historical and parametric VaR, P&L explain |
| Stochastic calculus and Girsanov | total variation ≈ √(2N/π), quadratic variation → T with standard deviation √(2/N), Itô and right-point sums (expectations 0 and T), martingales and non-martingales, Girsanov (E_P[Y] = 1, mean θT), unbiased importance sampling with variance divided by more than 100 out of the money, Monte Carlo Greeks with importance sampling |
| Applied theory | textbook example (put 10.714 then 11.820, Δ and B at each node, Q(S₂ = 96) = 0.46875), self-financing at each node, no arbitrage d < R < u, market maker hedged on every path, tree convergence to Black-Scholes, hedging error in 1/√N (Derman-Kamal), drift independence, P&L with realised ≠ implied vol, synthetic backtest |
| Real-world P and risk-neutral Q | Breeden-Litzenberger on a flat smile = lognormal (density and distribution function within 1e-5, mean = forward), mode < median < mean, quantiles shifted by e^{(μ−r)T}, skew: fatter left tail with the forward unchanged, decreasing pricing kernel if μ > r, standard error of μ̂ in σ/√years |
| Predictive regression | simulated bias in line with Stambaugh, slope γ of the scatter, no bias without shock correlation, over-rejection of the OLS t and correct Amihud-Hurvich size, bootstrap p-values, exact mapping from continuous to discrete time |
| Ornstein-Uhlenbeck and Vasicek | moments of the exact simulation, parameters recovered by AR(1) regression, no pull-back on a rising series, slope bias in line with Kendall, limits of the zero rate, forward = −∂ ln P, zero-coupon = Monte Carlo, calibration round trip, probability of a negative rate |
| Research (Moreira-Muir) | compounded monthly return and realised variance, Newey-West OLS, same volatility by construction, constant variance → strategy = factor, positive alpha under volatility regimes and zero without, real-time version without look-ahead, leverage cap and costs |
| Allocation | unconstrained minimum variance and mean-variance equal to the closed forms, constrained frontier above the Markowitz frontier, maximum-Sharpe tangency (including the formula Σ⁻¹(μ − r)), long-only and caps respected, LASSO inactive in long-only and active with shorts, costs that reduce then freeze turnover, Ledoit-Wolf positive definite and less shrunk with more data, conversion into euros, backtest without look-ahead |
| Variance swaps | realised variance (no-mean convention), flat smile → σ², replication of the Heston smile = Heston expected variance, vol swap convexity (Jensen and approximation), VIX formula on a Black-Scholes chain, band truncation, 30-day interpolation, value of a seasoned swap and vega |
| Caps / floors | caplet = Black-76, parity cap − floor = swap, cap = floor at the ATM strike, Black ≈ Bachelier near the money, Black rejected with negative rates, implied flat vol |
| FX options | Garman-Kohlhagen = Black-Scholes with a foreign dividend, parity, Greeks by finite differences, delta ↔ strike round trip, delta-neutral straddle, Vanna-Volga reprices the pillars, flat smile, market strangle repriced, positive density |
| CDS | survival of a piecewise curve, closed-form protection leg, credit triangle, exact bootstrap, inverted curve rejected, par CDS with zero value, CS01 ≈ RPV01 × notional × 1 bp, jump-to-default |
| Merton | calibration round trip, debt = risk-free − put (Black-Scholes), monotonicity in leverage and vol, survival curve, implied vol of a spread |
| API | routes tested on a synthetic test database, including an option chain generated by Heston; English responses |

---

## 25. Limits and possible extensions

- **Volatility**: Heston and local volatility are calibrated separately. A local-stochastic volatility (LSV) model would combine the two.
- **Calendar**: no holidays (NYSE, Euronext); regular bond schedule computed backwards.
- **Bond future**: no *cheapest-to-deliver* option or convexity adjustment.
- **European options**: Yahoo does not publish option chains for Europe, so there is no EUR smile.
- **Rates**: deterministic for pricing. The Vasicek model (section 19.7) is estimated and calibrated but not yet wired into the pricers; Hull-White, which fits the curve exactly, would allow pricing rate-sensitive products.

---

## 26. References

- Black, F. & Scholes, M. (1973). *The Pricing of Options and Corporate Liabilities*. Journal of Political Economy.
- Merton, R. (1973). *Theory of Rational Option Pricing*. Bell Journal of Economics.
- Merton, R. (1974). *On the Pricing of Corporate Debt: The Risk Structure of Interest Rates*. Journal of Finance.
- ISDA (2009). *ISDA CDS Standard Model* (CDS "Big Bang" conventions).
- Glasserman, P. (2003). *Monte Carlo Methods in Financial Engineering*. Springer (chapter 4.6, importance sampling).
- Derman, E. & Kamal, M. (1999). *When You Cannot Hedge Continuously: The Corrections of Black-Scholes*. Risk.
- Carr, P. (2005). *FAQ's in Option Pricing Theory*. Journal of Derivatives.
- Ahmad, R. & Wilmott, P. (2005). *Which Free Lunch Would You Like Today, Sir? Delta Hedging, Volatility Arbitrage and Optimal Portfolios*. Wilmott Magazine.
- Moreira, A. & Muir, T. (2017). *Volatility-Managed Portfolios*. Journal of Finance.
- Cederburg, S., O'Doherty, M., Wang, F. & Yan, X. (2020). *On the Performance of Volatility-Managed Portfolios*. Journal of Financial Economics.
- Fama, E. & French, K. (1993, 2015). *Common Risk Factors in the Returns on Stocks and Bonds*; *A Five-Factor Asset Pricing Model*. Journal of Financial Economics.
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
- Vasicek, O. (1977). *An Equilibrium Characterization of the Term Structure*. Journal of Financial Economics.
- Kendall, M. (1954). *Note on Bias in the Estimation of Autocorrelation*. Biometrika.
- Stambaugh, R. (1999). *Predictive Regressions*. Journal of Financial Economics.
- Amihud, Y. and Hurvich, C. (2004). *Predictive Regressions: A Reduced-Bias Estimation Method*. Journal of Financial and Quantitative Analysis.
- Goyal, A. and Welch, I. (2008). *A Comprehensive Look at the Empirical Performance of Equity Premium Prediction*. Review of Financial Studies.
- Shiller, R. (2000). *Irrational Exuberance*. Princeton University Press (monthly S&P data since 1871).
- Cox, J., Ingersoll, J. & Ross, S. (1985). *A Theory of the Term Structure of Interest Rates*. Econometrica.
- Hull, J. & White, A. (1990). *Pricing Interest-Rate-Derivative Securities*. Review of Financial Studies.
