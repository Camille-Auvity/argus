import { currentLang, locale } from "./i18n";

const nf = (min: number, max: number) =>
  new Intl.NumberFormat(locale(), { minimumFractionDigits: min, maximumFractionDigits: max });

const cache = new Map<string, Intl.NumberFormat>();
function fmt(min: number, max: number) {
  const key = `${locale()}:${min}:${max}`;
  if (!cache.has(key)) cache.set(key, nf(min, max));
  return cache.get(key)!;
}

export function num(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return fmt(digits, digits).format(x);
}

export function pct(x: number | null | undefined, digits = 2): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  // French puts a (narrow) space before %, English does not
  return currentLang() === "fr" ? `${fmt(digits, digits).format(x * 100)} %` : `${fmt(digits, digits).format(x * 100)}%`;
}

export function signed(x: number | null | undefined, digits = 2, asPct = false): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  // sign of the *displayed* value, so -0.001 shown with 2 digits reads "0,00", not "−0,00"
  const shown = Number((asPct ? x * 100 : x).toFixed(digits));
  const body = asPct ? pct(Math.abs(x), digits) : num(Math.abs(x), digits);
  return `${shown > 0 ? "+" : shown < 0 ? "−" : ""}${body}`;
}

export function bp(x: number | null | undefined): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  return `${fmt(0, 1).format(x * 10000)} bp`;
}

export function ccySymbol(ccy: string | undefined): string {
  return ccy === "EUR" ? "€" : ccy === "USD" ? "$" : ccy ?? "";
}

export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const minutes = Math.round((Date.now() - t) / 60000);
  const fr = currentLang() === "fr";
  if (minutes < 1) return fr ? "à l'instant" : "just now";
  if (minutes < 60) return fr ? `il y a ${minutes} min` : `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return fr ? `il y a ${hours} h` : `${hours} h ago`;
  return fr ? `il y a ${Math.round(hours / 24)} j` : `${Math.round(hours / 24)} d ago`;
}

export function tenorLabel(years: number): string {
  if (years < 1) return `${Math.round(years * 12)}M`;
  return `${Number.isInteger(years) ? years : years.toFixed(1)}Y`;
}

/** Amount in a currency, compact for large values: 12 345 €, 1,23 M€. */
export function money(x: number | null | undefined, ccy = "EUR", digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const sym = ccySymbol(ccy);
  if (Math.abs(x) >= 1e6) return `${num(x / 1e6, 2)} M${sym}`;
  return `${num(x, digits)} ${sym}`;
}

export function signedMoney(x: number | null | undefined, ccy = "EUR", digits = 0): string {
  if (x === null || x === undefined || !Number.isFinite(x)) return "—";
  const shown = Number(x.toFixed(digits));
  return `${shown > 0 ? "+" : shown < 0 ? "−" : ""}${money(Math.abs(x), ccy, digits)}`;
}
