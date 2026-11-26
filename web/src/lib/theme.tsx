import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type ThemeMode = "dark" | "light";

/** Visual worlds. "classic" is the original design (dark / light toggle); the others have one fixed scheme each. */
export type Design = "classic" | "eyes" | "metro" | "billets" | "paper";

export const DESIGNS: { value: Design; label: string; mode: ThemeMode | null }[] = [
  { value: "classic", label: "Classique", mode: null },
  { value: "eyes", label: "Les cent yeux", mode: "light" },
  { value: "metro", label: "Plan de métro", mode: "dark" },
  { value: "billets", label: "Série de billets", mode: "light" },
  { value: "paper", label: "Working paper", mode: "light" },
];

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
  /** chart typography (mirrors the design's --font) */
  font: string;
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
    font: "Inter Variable, system-ui, sans-serif",
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
    font: "Inter Variable, system-ui, sans-serif",
  },
};

const DESIGN_PALETTES: Record<Exclude<Design, "classic">, ChartPalette> = {
  eyes: {
    surface: "#ffffff", text: "#0b1f24", textSecondary: "#3a5157", muted: "#546a6f", grid: "#e3ebe8", axis: "#b9c9c4",
    series: ["#1f4fd1", "#c99a2e", "#1e8a5a", "#5b3fa8", "#b23a48", "#0e7c86", "#8c6a2b", "#546a6f"],
    good: "#1e8a5a", critical: "#b23a48", diverging: ["#b23a48", "#e3ebe8", "#1f4fd1"],
    font: "Hanken Grotesk Variable, system-ui, sans-serif",
  },
  metro: {
    surface: "#16234a", text: "#f4f1e8", textSecondary: "#c9c6bc", muted: "#9aa3bd", grid: "#223163", axis: "#34447a",
    series: ["#4d8bf0", "#e5484d", "#f2a541", "#2ba84a", "#a78bfa", "#35c2c1", "#f4f1e8", "#9aa3bd"],
    good: "#2ba84a", critical: "#e5484d", diverging: ["#e5484d", "#34447a", "#4d8bf0"],
    font: "Red Hat Text Variable, system-ui, sans-serif",
  },
  billets: {
    surface: "#ffffff", text: "#1c2230", textSecondary: "#454b57", muted: "#6a6f78", grid: "#e4e7eb", axis: "#c0c7ce",
    series: ["#2f5da8", "#c8423b", "#d9812b", "#2e8b57", "#7b4b94", "#c9a227", "#8a8d91", "#1c2230"],
    good: "#2e8b57", critical: "#c8423b", diverging: ["#c8423b", "#e4e7eb", "#2f5da8"],
    font: "Public Sans Variable, system-ui, sans-serif",
  },
  paper: {
    surface: "#fcfcfa", text: "#16181d", textSecondary: "#3f434c", muted: "#6b6f78", grid: "#e8e6e0", axis: "#16181d",
    series: ["#2b4c7e", "#7a1f2b", "#5e7f3e", "#b8860b", "#6b4e9b", "#3f434c", "#a0522d", "#8a8f98"],
    good: "#2f6b3f", critical: "#9b1c1c", diverging: ["#9b1c1c", "#e8e6e0", "#2b4c7e"],
    font: "Source Serif 4 Variable, Georgia, serif",
  },
};

interface ThemeCtx {
  mode: ThemeMode;
  palette: ChartPalette;
  toggle: () => void;
  design: Design;
  setDesign: (d: Design) => void;
  /** the design picker is an easter egg: hidden until revealed (3 clicks on the logo, or typing "argus") */
  pickerOpen: boolean;
  togglePicker: () => void;
}

const Ctx = createContext<ThemeCtx | null>(null);

function initialMode(): ThemeMode {
  const stamped = document.documentElement.dataset.theme;
  if (stamped === "light" || stamped === "dark") return stamped;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** what a visitor sees before choosing anything */
export const DEFAULT_DESIGN: Design = "eyes";

function initialPicker(): boolean {
  try {
    return sessionStorage.getItem("argus-picker") === "1";
  } catch {
    return false;
  }
}

function initialDesign(): Design {
  const stamped = document.documentElement.dataset.design;
  return DESIGNS.some((d) => d.value === stamped) ? (stamped as Design) : DEFAULT_DESIGN;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [userMode, setMode] = useState<ThemeMode>(initialMode);
  const [design, setDesignState] = useState<Design>(initialDesign);
  const mode = DESIGNS.find((d) => d.value === design)?.mode ?? userMode;

  useEffect(() => {
    document.documentElement.dataset.theme = mode;
    document.documentElement.dataset.design = design;
  }, [mode, design]);

  const [pickerOpen, setPickerOpen] = useState<boolean>(initialPicker);
  const togglePicker = useCallback(() => {
    setPickerOpen((open) => {
      try {
        sessionStorage.setItem("argus-picker", open ? "0" : "1");
      } catch {
        /* storage unavailable: the picker still toggles for this page */
      }
      return !open;
    });
  }, []);

  // typing "argus" anywhere outside a text field toggles the picker
  useEffect(() => {
    let typed = "";
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName))) return;
      if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey) return;
      typed = (typed + e.key.toLowerCase()).slice(-5);
      if (typed === "argus") {
        typed = "";
        togglePicker();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [togglePicker]);

  const setDesign = useCallback((d: Design) => {
    setDesignState(d);
    try {
      localStorage.setItem("argus-design", d);
    } catch {
      /* storage unavailable: design still switches for this session */
    }
  }, []);

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

  const value = useMemo(
    () => ({ mode, palette: design === "classic" ? PALETTES[mode] : DESIGN_PALETTES[design], toggle, design, setDesign,
      pickerOpen, togglePicker }),
    [mode, toggle, design, setDesign, pickerOpen, togglePicker],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme(): ThemeCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useTheme outside ThemeProvider");
  return ctx;
}
