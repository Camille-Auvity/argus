import { useQueryClient } from "@tanstack/react-query";
import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

/** Interface language. Texts are written inline as pairs, `tr("français", "English")`, next to where they are
 *  used: no key catalogue to keep in sync, and the French original stays readable in the code.
 *  English is the default for a first visit; French is chosen in the easter-egg menu (or with ?lang=fr). */
export type Lang = "en" | "fr";
export const DEFAULT_LANG: Lang = "en";
export const LANGS: { value: Lang; label: string }[] = [
  { value: "en", label: "English" },
  { value: "fr", label: "Français" },
];

function initialLang(): Lang {
  const stamped = document.documentElement.lang;
  return stamped === "fr" || stamped === "en" ? stamped : DEFAULT_LANG;
}

// module-level copy, so plain functions (number formatters, chart option builders) can read the language too
let current: Lang = initialLang();

/** The current language, outside React. */
export const currentLang = (): Lang => current;
/** The Intl locale of the current language. */
export const locale = (): string => (current === "fr" ? "fr-FR" : "en-US");
/** Pick the text of the current language: tr("Vue d'ensemble", "Overview"). Works for strings and JSX. */
export function tr<T>(fr: T, en: T): T {
  return current === "fr" ? fr : en;
}

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
}

const Ctx = createContext<LangCtx | null>(null);

export function LangProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(current);
  current = lang;

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const qc = useQueryClient();
  const setLang = useCallback((l: Lang) => {
    current = l;
    // API texts come back in the requested language: drop the cached responses of the other one
    qc.removeQueries();
    setLangState(l);
    try {
      localStorage.setItem("argus-lang", l);
    } catch {
      /* storage unavailable: the language still switches for this page */
    }
  }, [qc]);

  const value = useMemo(() => ({ lang, setLang }), [lang, setLang]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useLang outside LangProvider");
  return ctx;
}

/** Remounts its subtree when the language changes, so every inline tr() is evaluated again
 *  (the selected underlying, design and query cache live outside it and survive). */
export function LangKeyed({ children }: { children: ReactNode }) {
  const { lang } = useLang();
  return <Fragment key={lang}>{children}</Fragment>;
}
