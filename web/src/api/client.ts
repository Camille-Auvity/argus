// Typed client for the FastAPI backend (/api, proxied by Vite in dev).

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

export const modelsApi = {
  heston: (ticker: string) => request<HestonResponse>(`/api/models/${encodeURIComponent(ticker)}/heston`),
  surface: (ticker: string) => request<SurfaceResponse>(`/api/models/${encodeURIComponent(ticker)}/surface`),
  exotics: (ticker: string, req: ExoticsRequest) => post<ExoticsResponse>(`/api/models/${encodeURIComponent(ticker)}/exotics`, req),
};

// ----------------------------------------------------------------------------- portfolio

export type PositionKind = "equity" | "option" | "barrier" | "autocall" | "bond" | "future";

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
  stress: { base_value: number; spot_shocks: number[]; vol_shocks: number[]; pnl: number[][]; rate_shocks: { shift: number; pnl: number }[] };
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
};
