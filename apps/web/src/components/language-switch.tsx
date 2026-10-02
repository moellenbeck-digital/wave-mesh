"use client";

import { LOCALE_COOKIE, type Locale } from "@wave/i18n";
import { useRouter } from "next/navigation";
import { Fragment } from "react";

/** In the order the header reads them, each named in its own language. */
const CHOICES: { locale: Locale; name: string }[] = [
  { locale: "de", name: "Deutsch" },
  { locale: "en", name: "English" },
];

/**
 * DE | EN in the header, signed in or not -- the login page needs it most.
 *
 * The choice is a cookie and not a path prefix: the control server serves
 * pages of its own under the same origin and reads the same `wave_lang`, so
 * one cookie switches both. A year, because a language is not something one
 * picks per session. Then a refresh, which re-renders the server components
 * with the new cookie while the page and whatever was typed into it stay.
 */
export function LanguageSwitch({ locale, label }: { locale: Locale; label: string }) {
  const router = useRouter();

  function choose(next: Locale) {
    if (next === locale) return;
    // biome-ignore lint/suspicious/noDocumentCookie: one plain cookie; the Cookie Store API is still missing from browsers we serve
    document.cookie = `${LOCALE_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
    router.refresh();
  }

  return (
    <fieldset className="flex items-center text-caption">
      <legend className="sr-only">{label}</legend>
      {CHOICES.map((choice, index) => {
        const active = choice.locale === locale;
        return (
          <Fragment key={choice.locale}>
            {index > 0 ? (
              <span aria-hidden className="text-slate opacity-50">
                |
              </span>
            ) : null}
            <button
              type="button"
              lang={choice.locale}
              title={choice.name}
              aria-label={choice.name}
              aria-pressed={active}
              onClick={() => choose(choice.locale)}
              className={`cursor-pointer rounded px-1.5 py-0.5 font-medium tracking-wide transition-colors focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 ${
                active ? "text-accent" : "text-slate hover:text-navy"
              }`}
            >
              {choice.locale.toUpperCase()}
            </button>
          </Fragment>
        );
      })}
    </fieldset>
  );
}
