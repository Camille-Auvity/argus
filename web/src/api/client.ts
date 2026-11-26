// Typed client for the FastAPI backend (/api, proxied by Vite in dev).
// In the static build the same API runs in the browser (see src/engine).

import { engineRequest, STATIC_MODE } from "../engine/bridge";

export type Currency = "USD" | "EUR";

export interface RateSpec {
  mode: "curve" | "flat";
  currency: Currency;
  flat_rate: number;
}

export interface MarketParams {
  spot: number;
  vol: number;
  dividend_yield: number;
  rate: RateSpec;
}

export interface Greeks {
  price: number;
  delta: number;
  gamma: number;
  vega: number;
  theta: number;
  rho: number;
}

export interface MethodResult {
  method: string;
  greeks: Greeks;
  std_error: number | null;
  elapsed_ms: number;
}

export interface Profile {
  spots: number[];
  series: Record<string, number[]>;
}

export interface TickerSnapshot {
  ticker: string;
  name: string;
  sector: string | null;
  currency: Currency;
  market: "US" | "EU";
  last: number | null;
  last_date: string | null;
  change: number | null;
  change_pct: number | null;
  dividend_yield: number;
  realized_vol_1y: number | null;
  realized_vol_1m: number | null;
  sparkline: number[];
  sentiment: number | null;
}

export interface Status {
  open_markets: string[];
  markets: Record<string, { tz: string; open: string; close: string; currency: Currency }>;
  last_refresh: string | null;
  sentiment_model: string;
  anthropic_configured: boolean;
  static?: boolean;
}

export interface History {
  dates: string[];
  close: number[];
  realized_vol_1m: (number | null)[];
}

export interface VanillaRequest extends MarketParams {
  strike: number;
  expiry: number;
  option_type: "call" | "put";
  exercise: "european" | "american";
  tree_steps: number;
  mc_paths: number;
}

export interface BarrierRequest extends MarketParams {
  strike: number;
  expiry: number;
  barrier: number;
  barrier_type: "down-and-out" | "down-and-in" | "up-and-out" | "up-and-in";
  option_type: "call" | "put";
  rebate: number;
  monitoring_per_year: number | null;
  mc_paths: number;
}

export interface BarrierResponse {
  results: MethodResult[];
  vanilla_price: number;
  profile: Profile;
}

export interface DigitalRequest extends MarketParams {
  strike: number;
  expiry: number;
  option_type: "call" | "put";
  kind: "cash-or-nothing" | "asset-or-nothing";
  cash: number;
  mc_paths: number;
}

export interface DigitalResponse {
  results: MethodResult[];
  vanilla_price: number;
  call_spread: { width: number; price: number }[];
  profile: Profile;
}

export interface AsianRequest extends MarketParams {
  strike: number;
  expiry: number;
  n_fixings: number;
  option_type: "call" | "put";
  averaging: "arithmetic" | "geometric";
  mc_paths: number;
}

export interface AsianResponse {
  results: MethodResult[];
  vanilla_price: number;
  variance_reduction: number | null;
  cv_beta: number | null;
  convergence: { n_paths: number; plain: number; plain_se: number; cv: number; cv_se: number }[];
  profile: Profile;
}

export interface CliquetRequest extends MarketParams {
  maturity: number;
  frequency: 1 | 2 | 4 | 12;
  local_floor: number | null;
  local_cap: number | null;
  global_floor: number | null;
  global_cap: number | null;
  mc_paths: number;
}

export interface CliquetResponse {
  results: MethodResult[];
  reset_times: number[];
  floor_probability: number;
  cap_hit_rate: number | null;
  floor_hit_rate: number | null;
  histogram: { edges: number[]; counts: number[] };
  vol_profile: Profile;
}

export interface AutocallRequest extends MarketParams {
  maturity: number;
  frequency: 1 | 2 | 4 | 12;
  coupon_rate: number;
  autocall_barrier: number;
  coupon_barrier: number;
  protection_barrier: number;
  memory: boolean;
  mc_paths: number;
  with_greeks: boolean;
}

export interface AutocallResponse {
  price: number;
  std_error: number;
  expected_life: number;
  loss_probability: number;
  observation_times: number[];
  redemption_probabilities: number[];
  coupon_probabilities: number[];
  greeks: Greeks | null;
}

export interface CurveResponse {
  currency: Currency;
  asof: string;
  source: string;
  quote_type: "par" | "zero";
  quotes: { tenor: number; rate: number }[];
  grid: number[];
  curves: Record<string, { zero: number[]; forward: (number | null)[]; discount: number[] }>;
}

export interface CurveHistory {
  dates: string[];
  series: Record<string, (number | null)[]>;
}

export interface BondRequest {
  currency: Currency;
  maturity: number;
  coupon_rate: number;
  frequency: 1 | 2 | 4;
}

export interface BondResponse {
  dirty_price: number;
  clean_price: number;
  accrued: number;
  ytm: number;
  macaulay_duration: number;
  modified_duration: number;
  convexity: number;
  dv01: number;
  cashflows: { time: number; amount: number; discount: number; pv: number }[];
}

export interface FuturePrice {
  price: number;
  basis: number | null;
  curve_currency: Currency;
}

export interface SmilePoint {
  strike: number;
  moneyness: number;
  iv: number;
  vendor_iv: number | null;
  mid: number;
  option_type: "call" | "put";
}

export interface SmileResponse {
  asof: string;
  spot: number;
  dividend_yield: number;
  expiries: { expiry: string; days: number; T: number; points: SmilePoint[] }[];
  atm_term_structure: { expiry: string; T: number; iv: number }[];
}

export interface NewsItem {
  id: string;
  ticker: string;
  published: string | null;
  title: string;
  publisher: string | null;
  url: string | null;
  summary: string | null;
  score: number | null;
  label: string | null;
  rationale: string | null;
}

export interface SentimentSummary {
  by_ticker: { ticker: string; name: string | null; sector: string | null; market: string; sentiment: number;
    n_articles: number; last_article: string }[];
  by_sector: { sector: string; sentiment: number; n_articles: number }[];
  pending: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  if (STATIC_MODE) {
    // static build: the API runs in the browser (Pyodide worker), same routes and payloads
    const { status, body } = await engineRequest(init?.method ?? "GET", path, (init?.body as string | undefined) ?? null);
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(body);
    } catch {
      /* non-JSON body */
    }
    if (status >= 400) {
      const detail = (parsed as { detail?: unknown } | null)?.detail;
      throw new ApiError(status, typeof detail === "string" ? detail : JSON.stringify(detail ?? body));
    }
    return parsed as T;
  }
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {
      /* non-JSON error body */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

const post = <T>(path: string, body: unknown) => request<T>(path, { method: "POST", body: JSON.stringify(body) });

export const api = {
  status: () => request<Status>("/api/status"),
  tickers: () => request<TickerSnapshot[]>("/api/tickers"),
  history: (ticker: string, days = 500) =>
    request<History>(`/api/tickers/${encodeURIComponent(ticker)}/history?days=${days}`),
  refresh: (ticker: string) => post<Record<string, string>>(`/api/refresh/${encodeURIComponent(ticker)}`, {}),
  vanilla: (req: VanillaRequest) => post<{ results: MethodResult[] }>("/api/price/vanilla", req),
  vanillaProfile: (req: VanillaRequest) => post<Profile>("/api/price/vanilla/profile", req),
  barrier: (req: BarrierRequest) => post<BarrierResponse>("/api/price/barrier", req),
  autocall: (req: AutocallRequest) => post<AutocallResponse>("/api/price/autocall", req),
  digital: (req: DigitalRequest) => post<DigitalResponse>("/api/price/digital", req),
  asian: (req: AsianRequest) => post<AsianResponse>("/api/price/asian", req),
  cliquet: (req: CliquetRequest) => post<CliquetResponse>("/api/price/cliquet", req),
  fairCoupon: (req: AutocallRequest) => post<{ coupon_rate: number | null }>("/api/price/autocall/fair-coupon", req),
  curve: (ccy: Currency) => request<CurveResponse>(`/api/curves/${ccy}`),
  curveHistory: (ccy: Currency) => request<CurveHistory>(`/api/curves/${ccy}/history`),
  bond: (req: BondRequest) => post<BondResponse>("/api/bonds/analytics", req),
  equityFuture: (ticker: string, maturity: number) => post<FuturePrice>("/api/futures/equity", { ticker, maturity }),
  bondFuture: (req: BondRequest & { delivery: number; conversion_factor: number }) =>
    post<FuturePrice>("/api/futures/bond", req),
  smile: (ticker: string) => request<SmileResponse>(`/api/vol/${encodeURIComponent(ticker)}/smile`),
  news: (ticker?: string, limit = 100) =>
    request<NewsItem[]>(`/api/news?limit=${limit}${ticker ? `&ticker=${encodeURIComponent(ticker)}` : ""}`),
  sentimentSummary: () => request<SentimentSummary>("/api/sentiment/summary"),
  scoreSentiment: () => post<{ scored: number }>("/api/sentiment/score", {}),
};

// ----------------------------------------------------------------------------- method explainers

export interface CalcStep {
  label: string;
  formula: string;
  value: number;
  note: string;
}

export interface ExplainBS {
  inputs: { spot: number; strike: number; T: number; rate: number; dividend_yield: number; vol: number; option_type: string };
  steps: CalcStep[];
  price: number;
  prob_itm: number;
  forward: number;
  density: { s: number[]; pdf: number[] };
}

export interface TreeNode {
  i: number;
  j: number;
  t: number;
  spot: number;
  value: number;
  continuation: number;
  exercise_value: number;
  exercised: boolean;
}

export interface Boundary {
  t: number[];
  s: number[];
}

export interface ExplainTree {
  params: { dt: number; u: number; d: number; p: number; step_discount: number; steps: number };
  steps: CalcStep[];
  nodes: TreeNode[];
  price_display: number;
  convergence: { n: number[]; price: number[] };
  reference: number;
  reference_label: string;
  boundary: Boundary | null;
}

export interface ExplainMC {
  steps: CalcStep[];
  price: number;
  std_error: number;
  reference: number;
  antithetic: { with: { price: number; std_error: number }; without: { price: number; std_error: number }; variance_reduction: number | null };
  paths: { t: number[]; s: number[][] };
  terminal_histogram: { edges: number[]; counts: number[] };
  payoff_histogram: { edges: number[]; counts: number[]; otm_fraction: number };
  convergence: { n: number[]; mean: number[]; lo: number[]; hi: number[] };
}

export interface ExplainLSM {
  steps: CalcStep[];
  price: number;
  std_error: number;
  tree_price: number;
  european_price: number;
  boundary: Boundary;
  tree_boundary: Boundary;
  regression: {
    t: number;
    points: { s: number[]; cashflow: number[]; exercised: boolean[] };
    fit: { s: number[]; continuation: number[]; exercise: number[] };
    coefficients: number[];
    n_itm: number;
    n_exercised: number;
  } | null;
  lsm_steps: number;
  snapshot_step: number;
}

export interface ExplainGreeks {
  method: string;
  rows: { greek: string; formula: string; bump: number; bump_label: string; prices: Record<string, number>; value: number }[];
  closed_form: Record<string, number> | null;
}

export const explainApi = {
  blackScholes: (req: VanillaRequest) => post<ExplainBS>("/api/explain/black-scholes", req),
  tree: (req: VanillaRequest & { display_steps: number }) => post<ExplainTree>("/api/explain/tree", req),
  monteCarlo: (req: VanillaRequest) => post<ExplainMC>("/api/explain/monte-carlo", req),
  lsm: (req: VanillaRequest & { lsm_steps: number; snapshot_step: number | null }) => post<ExplainLSM>("/api/explain/lsm", req),
  greeks: (req: VanillaRequest & { method: "tree" | "mc" }) => post<ExplainGreeks>("/api/explain/greeks", req),
};

// ----------------------------------------------------------------------------- volatility models

export interface HestonResponse {
  asof: string;
  spot: number;
  dividend_yield: number;
  params: { v0: number; kappa: number; theta: number; sigma: number; rho: number };
  derived: { vol_initiale: number; vol_long_terme: number; feller: number; demi_vie_ans: number };
  quality: { rmse_vol: number; max_error_vol: number; n_points: number; n_evaluations: number; elapsed_s: number; success: boolean };
  curves: {
    expiry: string; T: number; days: number; rmse_vol: number;
    market: { strike: number[]; iv: number[] };
    calibrated_on: { strike: number[]; iv: number[] };
    model: { strike: number[]; iv: (number | null)[] };
  }[];
}

export interface SurfaceResponse {
  asof: string;
  spot: number;
  slices: {
    T: number; days: number; a: number; b: number; rho: number; m: number; s: number; rmse_vol: number; forward: number;
    market: { k: number[]; iv: number[] };
    fit: { k: number[]; iv: number[]; local: (number | null)[] };
  }[];
  arbitrage: {
    butterfly: { T: number; min_g: number; ok: boolean }[];
    calendar: { T1: number; T2: number; min_gap: number; ok: boolean }[];
  };
  grid: { k: number[]; T: number[]; implied: (number | null)[][]; local: (number | null)[][] };
}

export interface ExoticsRequest {
  barrier: { expiry: number; strike_pct: number; barrier_pct: number; barrier_type: BarrierRequest["barrier_type"]; option_type: "call" | "put" };
  autocall: { maturity: number; frequency: 1 | 2 | 4 | 12; coupon_rate: number; autocall_barrier: number; coupon_barrier: number;
    protection_barrier: number; memory: boolean };
  n_paths: number;
}

export interface ExoticsResponse {
  barrier: { atm_vol: number; rows: { model: string; price: number; std_error: number | null; elapsed_ms: number | null }[] };
  autocall: {
    atm_vol: number;
    observation_times: number[];
    rows: { model: string; price: number; std_error: number; loss_probability: number; expected_life: number;
      redemption_probabilities: number[]; elapsed_ms: number }[];
  };
}

export interface PathDependentRequest {
  digital: { expiry: number; strike_pct: number; option_type: "call" | "put" };
  asian: { expiry: number; strike_pct: number; n_fixings: number; option_type: "call" | "put" };
  cliquet: { maturity: number; frequency: 1 | 2 | 4 | 12; local_floor: number | null; local_cap: number | null;
    global_floor: number | null; global_cap: number | null };
  n_paths: number;
}

export interface ModelRow {
  model: string;
  price: number;
  std_error: number | null;
  elapsed_ms: number | null;
}

export interface PathDependentResponse {
  digital: { atm_vol: number; strike_vol: number; rows: ModelRow[] };
  asian: { atm_vol: number; rows: ModelRow[] };
  cliquet: { atm_vol: number; rows: ModelRow[] };
}

export const modelsApi = {
  heston: (ticker: string) => request<HestonResponse>(`/api/models/${encodeURIComponent(ticker)}/heston`),
  surface: (ticker: string) => request<SurfaceResponse>(`/api/models/${encodeURIComponent(ticker)}/surface`),
  exotics: (ticker: string, req: ExoticsRequest) => post<ExoticsResponse>(`/api/models/${encodeURIComponent(ticker)}/exotics`, req),
  pathDependent: (ticker: string, req: PathDependentRequest) =>
    post<PathDependentResponse>(`/api/models/${encodeURIComponent(ticker)}/path-dependent`, req),
};

// ----------------------------------------------------------------------------- portfolio

export type PositionKind = "equity" | "option" | "barrier" | "digital" | "asian" | "cliquet" | "autocall" | "bond" | "future" | "cds" | "capfloor" | "fxoption" | "varswap";

export interface Exposure {
  key: string;
  market_value: number;
  pnl: number;
  delta_cash: number;
  gamma_cash: number;
  vega: number;
  theta: number;
  rho: number;
  dv01: number;
  cs01: number;
  jtd: number;
  n: number;
}

export interface PositionRow {
  id: number;
  book: string;
  kind: PositionKind;
  ticker: string | null;
  quantity: number;
  params: Record<string, unknown>;
  label: string;
  description: string;
  currency: string;
  unit_price: number | null;
  entry_price: number | null;
  market_value: number | null;
  market_value_base: number | null;
  pnl_base: number | null;
  delta: number | null;
  delta_cash: number | null;
  gamma_cash: number | null;
  vega: number | null;
  theta: number | null;
  rho: number | null;
  dv01: number | null;
  cs01: number | null;
  jtd: number | null;
  error: string | null;
}

export interface PortfolioResponse {
  base_currency: string;
  valuation_date?: string;
  eurusd?: number;
  vol_source?: Record<string, string>;
  positions: PositionRow[];
  totals: Exposure | null;
  by_underlying: Exposure[];
  by_kind: Exposure[];
  by_book: Exposure[];
}

export interface RiskResponse {
  base_currency: string;
  history_days: number;
  stress: { base_value: number; spot_shocks: number[]; vol_shocks: number[]; pnl: number[][]; rate_shocks: { shift: number; pnl: number }[];
    spread_shocks: { shift: number; pnl: number }[] };
  var: {
    n_scenarios: number;
    tickers?: string[];
    var_95?: number; es_95?: number; var_99?: number; es_99?: number;
    parametric_var_95?: number; parametric_var_99?: number;
    histogram?: { edges: number[]; counts: number[] };
    worst_scenarios?: { index: number; pnl: number; date: string }[];
  };
  pnl_explain: {
    rows: { id: number; description: string; return: number; actual: number; delta: number; gamma: number; theta: number; residual: number }[];
    totals: { actual: number; delta: number; gamma: number; theta: number; residual: number };
  };
}

export interface PositionIn {
  kind: PositionKind;
  quantity: number;
  ticker: string | null;
  params: Record<string, unknown>;
  book: string;
  label: string;
}

export const portfolioApi = {
  get: () => request<PortfolioResponse>("/api/portfolio"),
  risk: () => request<RiskResponse>("/api/portfolio/risk"),
  add: (p: PositionIn) => post<{ id: number; entry_price: number }>("/api/portfolio/positions", p),
  remove: (id: number) => request<{ deleted: number }>(`/api/portfolio/positions/${id}`, { method: "DELETE" }),
  clear: () => request<{ deleted: number }>("/api/portfolio", { method: "DELETE" }),
  demo: () => post<{ created: number }>("/api/portfolio/demo", {}),
  updateSpreads: (id: number, spreads_bp: number[]) =>
    request<{ id: number; unit_price: number }>(`/api/portfolio/positions/${id}/spreads`, { method: "PATCH", body: JSON.stringify({ spreads_bp }) }),
};

// ----------------------------------------------------------------------------- credit

export interface CDSRequest {
  tenors: number[];
  spreads_bp: number[];
  recovery: number;
  rate: RateSpec;
  maturity: number;
  coupon_bp: number;
  notional: number;
  side: "buyer" | "seller";
}

export interface CDSResponse {
  risk: { value: number; par_spread: number; upfront: number; rpv01: number; cs01: number; ir01: number; rec01: number;
    jump_to_default: number; carry_1d: number };
  table: { tenor: number; quoted_bp: number; model_bp: number; hazard: number; survival: number; default_probability: number;
    rpv01: number; upfront_100: number; upfront_500: number }[];
  curves: { t: number[]; survival: number[]; default_probability: number[]; hazard: number[] };
  par_curve: { maturity: number; par_bp: number }[];
  pillars: number[];
  hazards: number[];
}

export interface MertonInputs {
  ticker: string;
  name: string;
  currency: Currency;
  spot: number;
  shares_outstanding: number;
  equity: number;
  short_term_debt: number;
  long_term_debt: number;
  total_debt: number;
  kmv_default_point: number;
  equity_vol: number;
  equity_vol_source: string;
  financial_currency: string;
  fundamentals_at: string | null;
}

export interface MertonRequest {
  equity: number;
  equity_vol: number;
  debt_face: number;
  horizon: number;
  currency: Currency;
  recovery: number;
  market_spread_bp: number | null;
}

export interface MertonResponse {
  rate: number;
  fit: { equity: number; equity_vol: number; debt_face: number; T: number; r: number; assets: number; asset_vol: number;
    d1: number; d2: number; default_probability: number; debt_value: number; spread: number; recovery: number;
    leverage: number; equity_delta: number };
  spread_bp: number;
  spread_change_for_equity_down_1pct_bp: number;
  term_structure: { T: number[]; spread_bp: number[]; default_probability: number[]; distance_to_default: number[] };
  cds: { tenors: number[]; spreads_bp: number[]; recovery: number };
  hazard: { pillars: number[]; hazards: number[] };
  by_vol: { equity_vol: number; spread_bp: number; pd: number; asset_vol: number }[];
  by_equity: { move: number; spread_bp: number; pd: number; distance_to_default: number }[];
  implied_equity_vol: number | null;
}

export const creditApi = {
  cds: (req: CDSRequest) => post<CDSResponse>("/api/credit/cds", req),
  mertonInputs: (ticker: string) => request<MertonInputs>(`/api/credit/merton/${encodeURIComponent(ticker)}/inputs`),
  merton: (req: MertonRequest) => post<MertonResponse>("/api/credit/merton", req),
};

// ----------------------------------------------------------------------------- caps, floors and FX options

export interface CapRequest {
  currency: Currency;
  maturity: number;
  frequency: 1 | 2 | 4 | 12;
  strike: number | null;
  kind: "cap" | "floor";
  model: "black" | "bachelier";
  vol: number;
  notional: number;
  market_price: number | null;
}

export interface CapResponse {
  strike: number;
  atm_strike: number;
  annuity: number;
  price: number;
  price_pct: number;
  running_bp: number;
  greeks: { price: number; dv01: number; gamma_1bp: number; vega: number; theta: number };
  parity: { other_kind: "cap" | "floor"; other_price: number; swap_value: number };
  implied_vol: number | null;
  caplets: { start: number; end: number; accrual: number; forward: number; discount: number; price: number; delta: number; vega: number }[];
  profile: { strike: number[]; cap: number[]; floor: number[] };
}

export interface FXMarketResponse {
  pair: string;
  spot: number;
  asof: string;
  realized_vol: Record<string, number | null>;
  tenors: { tenor: string; T: number; rd: number; rf: number; forward: number; points: number }[];
  history: number[];
}

export interface FXRequest {
  expiry: number;
  atm: number;
  rr25: number;
  bf25: number;
  convention: "spot" | "forward" | null;
  option_type: "call" | "put";
  strike_mode: "strike" | "delta" | "atm";
  strike: number | null;
  delta: number;
  notional: number;
  spot: number | null;
}

export interface FXResponse {
  market: { spot: number; forward: number; rd: number; rf: number; T: number; convention: "spot" | "forward" };
  smile: {
    atm: number; rr25: number; bf25_market: number; bf25_smile: number;
    pillars: Record<string, { strike: number; vol: number; delta: number }>;
    market_strangle: { vol: number; call_strike: number; put_strike: number; value: number };
    curve: { strike: number[]; vol: (number | null)[]; vol_first_order: number[]; call_delta: (number | null)[]; density: number[] };
  };
  option: {
    strike: number; vol: number; atm_vol: number; option_type: "call" | "put"; delta: number; smile_effect_usd: number;
    greeks: Record<string, number>;
  };
}

export const ratesFxApi = {
  cap: (req: CapRequest) => post<CapResponse>("/api/caps/price", req),
  fxMarket: () => request<FXMarketResponse>("/api/fx/market"),
  fx: (req: FXRequest) => post<FXResponse>("/api/fx/price", req),
};

// ----------------------------------------------------------------------------- variance swaps

export interface VarianceTermResponse {
  asof: string;
  spot: number;
  rows: { T: number; days: number; fair_vol: number; fair_variance: number; atm_vol: number; skew_premium: number;
    put_share: number; heston_vol: number }[];
}

export interface VarianceSwapRequest {
  maturity_days: number;
  vega_notional: number;
  strike_vol: number | null;
  elapsed_days: number;
  n_paths: number;
}

export interface VarianceModelRow {
  model: string;
  fair_vol: number;
  vol_swap: number | null;
  convexity: number | null;
  std_realized_vol: number | null;
  note: string;
}

export interface VarianceSwapResponse {
  asof: string;
  spot: number;
  T: number;
  T_total: number;
  atm_vol: number;
  fair_vol: number;
  fair_variance: number;
  put_share: number;
  replication: { k: number[]; density: number[]; F: number };
  listed: { expiry: string; days: number; listed_vol: number; surface_vol: number; n_strikes: number; strikes: number[];
    contributions: number[]; forward: number } | null;
  models: VarianceModelRow[];
  heston: { v0: number; kappa: number; theta: number; sigma: number; rho: number; convexity_approx_vol: number };
  realized_vol_distribution: { heston: number[]; edges: number[] };
  contract: { strike_vol: number; realized_vol_so_far: number; elapsed_days: number; variance_notional: number; value: number;
    vega: number; expected_variance_pts: number;
    profile: { realized_vol: number[]; variance_swap: number[]; volatility_swap: number[] } };
}

export interface VrpResponse {
  series: { date: string[]; vix: number[]; realized_past: (number | null)[] };
  aligned: { date: string[]; implied: number[]; realized_next: number[]; premium_pts2: number[] };
  monthly: { date: string; strike: number; realized: number; pnl: number }[];
  summary: { n_days: number; mean_implied: number; mean_realized: number; share_implied_above: number;
    mean_premium_vol_pts: number; monthly_hit_rate: number | null; monthly_mean_pnl: number | null; monthly_worst_pnl: number | null };
}

export interface VixCheckResponse {
  rows: { date: string; argus: number; vix: number | null; near_days: number; next_days: number; strikes: number }[];
  summary: { n: number; mean_abs_gap: number | null; median_abs_gap: number | null };
}

export const varianceApi = {
  term: (ticker: string) => request<VarianceTermResponse>(`/api/variance/${encodeURIComponent(ticker)}/term`),
  swap: (ticker: string, req: VarianceSwapRequest) => post<VarianceSwapResponse>(`/api/variance/${encodeURIComponent(ticker)}/swap`, req),
  vrp: () => request<VrpResponse>("/api/variance/vrp"),
  vixCheck: () => request<VixCheckResponse>("/api/variance/vix-check"),
};

// ----------------------------------------------------------------------------- allocation

export interface AllocationUniverse {
  base_currency: string;
  risk_free: number;
  assets: { ticker: string; name: string; currency: string; days: number }[];
}

export interface OptimizeRequest {
  tickers: string[];
  lookback_days: number;
  mean_method: "sample" | "shrunk" | "zero";
  cov_method: "sample" | "ledoit-wolf";
  objective: "mean-variance" | "min-variance" | "max-sharpe";
  gamma: number;
  long_only: boolean;
  short_max: number;
  w_max: number;
  l1: number;
  l2: number;
  cost: number;
  holding_days: number;
}

export interface AllocPortfolio {
  weights: Record<string, number>;
  risk_contributions: Record<string, number>;
  expected_return: number;
  volatility: number;
  sharpe: number;
  effective_n: number;
  gross_exposure: number;
  n_active: number;
  turnover: number;
  success: boolean;
}

export interface OptimizeResponse {
  base_currency: string;
  risk_free: number;
  n_obs: number;
  start: string;
  end: string;
  estimates: { tickers: string[]; mu: number[]; vol: number[]; corr: number[][]; cov_shrinkage: number; mean_shrinkage: number; sample_mu: number[] };
  optimal: AllocPortfolio;
  min_variance: AllocPortfolio;
  tangency: AllocPortfolio;
  equal_weight: AllocPortfolio;
  frontier: Record<"long_only" | "with_shorts" | "unconstrained", { ret: number; vol: number }[]>;
  lasso_path: { lambda: number; n_active: number; gross_exposure: number; in_sample_vol: number; out_of_sample_vol: number; weights: Record<string, number> }[];
}

export interface BacktestRequest {
  tickers: string[];
  window: number;
  rebalance_days: number;
  cost: number;
  gamma: number;
  short_max: number;
  w_max: number;
  l1: number;
}

export interface BacktestResponse {
  base_currency: string;
  risk_free: number;
  tickers: string[];
  dates: string[];
  strategies: { name: string; description: string; turnover: number; total_cost: number; wealth: number[]; n_rebalances: number;
    last_weights: Record<string, number>;
    stats: { annual_return: number; volatility: number; sharpe: number; max_drawdown: number; final_wealth: number } }[];
}

export const allocationApi = {
  universe: () => request<AllocationUniverse>("/api/allocation/universe"),
  optimize: (req: OptimizeRequest) => post<OptimizeResponse>("/api/allocation/optimize", req),
  backtest: (req: BacktestRequest) => post<BacktestResponse>("/api/allocation/backtest", req),
};

// ----------------------------------------------------------------------------- research

export type FactorKey = "mkt_rf" | "smb" | "hml" | "mom" | "rmw" | "cma";

export interface VolManagedStats {
  months: number; start: string; end: string; c: number; alpha: number; alpha_t: number; beta: number; r2: number;
  appraisal: number; sharpe_original: number; sharpe_managed: number; mean_original: number; mean_managed: number;
  vol_original: number; vol_managed: number; mdd_original: number; mdd_managed: number; weight_median: number;
  weight_p90: number; weight_max: number; weight_min: number; turnover: number; alpha_ff3: { alpha: number; t: number } | null;
}

export interface VolManagedSummary {
  data_end: string;
  rows: ({ factor: FactorKey; label: string } & Pick<VolManagedStats, "start" | "end" | "months" | "alpha" | "alpha_t" | "beta" | "r2" |
    "appraisal" | "sharpe_original" | "sharpe_managed" | "weight_max" | "alpha_ff3">)[];
}

export interface VolManagedRequest {
  factor: FactorKey;
  mode: "full" | "realtime";
  leverage_cap: number | null;
  cost_bp: number;
  start: string | null;
  end: string | null;
}

export interface VolManagedDetail {
  factor: FactorKey;
  label: string;
  stats: VolManagedStats;
  series: { dates: string[]; log_wealth_original: number[]; log_wealth_managed: number[]; weight: number[]; lagged_vol: number[] };
  buckets: { bucket: number; mean: number; vol: number; mean_over_var: number; lagged_vol: number; months: number }[];
  subperiods: { period: string; alpha: number; alpha_t: number; sharpe_original: number; sharpe_managed: number }[];
  episodes: { episode: string; start: string; end: string; original: number; managed: number }[];
}

export const researchApi = {
  volManagedSummary: (p: Omit<VolManagedRequest, "factor">) => {
    const q = new URLSearchParams({ mode: p.mode, cost_bp: String(p.cost_bp) });
    if (p.leverage_cap != null) q.set("leverage_cap", String(p.leverage_cap));
    if (p.start) q.set("start", p.start);
    if (p.end) q.set("end", p.end);
    return request<VolManagedSummary>(`/api/research/vol-managed/summary?${q}`);
  },
  volManaged: (req: VolManagedRequest) => post<VolManagedDetail>("/api/research/vol-managed", req),
};

// ----------------------------------------------------------------------------- applied theory labs

export interface TreeRequest {
  S0: number; u: number; d: number; R: number; K: number; option_type: "call" | "put"; steps: number; american: boolean;
  ask: number; path: string | null;
}

export interface TreeNodeOut {
  step: number; ups: number; spot: number; value: number; payoff: number; delta: number | null; bond: number | null;
  pi: number | null; exercised: boolean; parent_portfolio_value: number | null; path_count: number; probability: number;
}

export interface TreeResponse {
  pi: number; price: number; direct_value: number | null; steps: number; nodes: TreeNodeOut[];
  market_maker: {
    path: string; ask: number; price: number; spread_kept: number; terminal_spot: number; liability: number; hedge_value: number; net: number;
    steps: { step: number; move: string | null; spot: number; delta_before: number; delta_after: number; shares_traded: number;
      trade_cash: number; cash_before: number; cash_after: number; option_value: number; hedge_value: number }[];
  };
}

export interface HedgeRequest {
  S0: number; K: number; T: number; r: number; q: number; sigma_implied: number; sigma_real: number; mu: number;
  n_rebalance: number; n_paths: number; option_type: "call" | "put"; hedge_vol: "implied" | "realized";
}

export interface HedgeResponse {
  premium: number; vega: number; gamma_theta_mean: number; locked: number; derman_kamal: number;
  pnl: { mean: number; sd: number; p05: number; p95: number; histogram: { edges: number[]; counts: number[] } };
  path: { spot: number[]; delta: number[]; pnl: number[]; gamma_theta: number[] };
  convergence: { n: number; sd: number; mean: number; derman_kamal: number }[];
  drift: { mu: number; mean: number }[];
  mismatch: { sigma_real: number; implied_hedge_mean: number; implied_hedge_sd: number; realized_hedge_mean: number;
    realized_hedge_sd: number; locked: number }[];
}

export interface HedgeBacktestResponse {
  rate: number; dividend_yield: number;
  rows: { date: string; spot: number; implied: number; realized: number; premium_pct: number; pnl_pct: number; gamma_theta_pct: number }[];
  summary: { n: number; mean_pnl_pct: number; hit_rate: number; worst_pct: number; best_pct: number; corr_gamma_theta: number | null;
    mean_implied: number; mean_realized: number };
}

export const theoryApi = {
  tree: (req: TreeRequest) => post<TreeResponse>("/api/theory/tree", req),
  hedge: (req: HedgeRequest) => post<HedgeResponse>("/api/theory/hedge", req),
  hedgeBacktest: (horizon: number, option_type: "call" | "put") =>
    request<HedgeBacktestResponse>(`/api/theory/hedge-backtest?horizon=${horizon}&option_type=${option_type}`),
};

export interface BrownianResponse {
  paths: { t: number[]; paths: number[][]; band: number[] };
  variations: { n: number; total_variation: number; total_variation_theory: number; quadratic_variation: number;
    quadratic_variation_sd: number; quadratic_variation_sd_theory: number }[];
  ito: { mean_left: number; mean_right: number; T: number; max_gap_left: number; max_gap_right: number; rms_gap_left: number;
    histogram: { edges: number[]; left: number[]; right: number[] };
    example: { t: number[]; B: number[]; left_running: number[]; ito_running: number[] } };
  martingales: { t: number[]; lambda: number; series: Record<string, { mean: number[]; se: number[]; martingale: boolean }> };
}

export interface GirsanovResponse {
  b: number[]; density_P: number[]; density_Q: number[]; weight: number[]; mean_weight: number; mean_weight_se: number;
  q_mean_by_weighting: number; q_mean_theory: number; prob_above_q_mean: number; theta: number; T: number;
}

export interface ImportanceRequest { S0: number; K: number; T: number; r: number; q: number; vol: number; product: "call" | "put" | "digital"; n_paths: number }

export interface ImportanceResponse {
  exact: number; theta_star: number; plain: { price: number; se: number }; importance: { price: number; se: number };
  variance_reduction: number | null; itm_probability: number;
  theta_grid: { theta: number; price: number; se: number }[];
  convergence: { n: number; plain: number; plain_se: number; importance: number; importance_se: number }[];
}

export const stochasticApi = {
  brownian: () => request<BrownianResponse>("/api/theory/brownian"),
  girsanov: (theta: number, T: number) => request<GirsanovResponse>(`/api/theory/girsanov?theta=${theta}&T=${T}`),
  importance: (req: ImportanceRequest) => post<ImportanceResponse>("/api/theory/importance", req),
};
