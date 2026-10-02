"use client";

import type { Locale } from "@wave/i18n";
import { createContext, type ReactNode, useContext } from "react";

/**
 * Only the locale crosses from server to browser, never the messages: a
 * catalog holds functions for everything with a number or a name in it, and
 * functions cannot be serialised as props. Client components import the same
 * catalogs and pick by this value.
 */
const LocaleContext = createContext<Locale>("en");

export function LocaleProvider({ locale, children }: { locale: Locale; children: ReactNode }) {
  return <LocaleContext.Provider value={locale}>{children}</LocaleContext.Provider>;
}

export const useLocale = (): Locale => useContext(LocaleContext);
