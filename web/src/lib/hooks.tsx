import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { api, type TickerSnapshot } from "../api/client";

export function useDebounced<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export function useTickers() {
  return useQuery({ queryKey: ["tickers"], queryFn: api.tickers, staleTime: 60_000, refetchInterval: 120_000 });
}

export function useStatus() {
  return useQuery({ queryKey: ["status"], queryFn: api.status, refetchInterval: 60_000 });
}

// ----------------------------------------------------------------------------- selected underlying

interface TickerCtx {
  ticker: string;
  setTicker: (t: string) => void;
  snapshot: TickerSnapshot | undefined;
}

const Ctx = createContext<TickerCtx | null>(null);
const STORAGE_KEY = "qplat-ticker";

function savedTicker(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) || "SPY";
  } catch {
    return "SPY";
  }
}

export function TickerProvider({ children }: { children: ReactNode }) {
  const [ticker, setTickerState] = useState(savedTicker);
  const { data } = useTickers();
  const snapshot = data?.find((t) => t.ticker === ticker);

  const value = useMemo<TickerCtx>(
    () => ({
      ticker,
      snapshot,
      setTicker: (t: string) => {
        setTickerState(t);
        try {
          localStorage.setItem(STORAGE_KEY, t);
        } catch {
          /* selection still works for this session */
        }
      },
    }),
    [ticker, snapshot],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTicker(): TickerCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTicker outside TickerProvider");
  return ctx;
}
