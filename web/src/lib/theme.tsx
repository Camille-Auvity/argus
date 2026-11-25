import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "dark" | "light";

/** Chart palette — the validated reference palette, stepped per mode (mirrors tokens.css). */
export interface ChartPalette {
  surface: string;
  text: string;
  textSecondary: string;
  muted: string;
  grid: string;
  axis: string;
  series: string[];
  good: string;
  critical: string;
  /** diverging blue <-> red with a gray midpoint, for sentiment */
  diverging: [string, string, string];
}

const PALETTES: Record<ThemeMode, ChartPalette> = {
  dark: {
    surface: "#1a1a19",
    text: "#ffffff",
    textSecondary: "#c3c2b7",
    muted: "#898781",
    grid: "#2c2c2a",
    axis: "#383835",
    series: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
    good: "#0ca30c",
    critical: "#e66767",
    diverging: ["#e66767", "#383835", "#3987e5"],
  },
  light: {
    surface: "#fcfcfb",
    text: "#0b0b0b",
    textSecondary: "#52514e",
    muted: "#898781",
    grid: "#e1e0d9",
    axis: "#c3c2b7",
    series: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
    good: "#0ca30c",
    critical: "#d03b3b",
    diverging: ["#d03b3b", "#f0efec", "#2a78d6"],
  },
};

interface ThemeCtx {
  mode: ThemeMode;
  palette: ChartPalette;
  toggle: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function initialMode(): ThemeMode {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "light" || stamped === "dark") return stamped;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((m) => {
      const next = m === "dark" ? "light" : "dark";
      try {
        localStorage.setItem("qplat-theme", next);
      } catch {
        /* storage unavailable: theme still switches for this session */
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ mode, palette: PALETTES[mode], toggle }), [mode, toggle]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}
