/**
 * Which language a person reads, and nothing else.
 *
 * Every program here -- the web pages, the control server's own pages, the
 * CLI, the tray, wave-admin -- keeps its own texts beside its code. What they
 * share is this: how a language tag is read, how a browser's or a session's
 * choice is found, and what happens when nothing fits. Two programs deciding
 * that differently would show one person two languages on one screen.
 *
 * Pure on purpose: the web pages import this into the browser, and the client
 * is compiled with `bun build --compile`. What has to ask the operating system
 * lives in `./system`.
 */

export type Locale = "en" | "de";

export const LOCALES: readonly Locale[] = ["en", "de"];

/** What a person gets when nothing they said is a language we have. */
export const FALLBACK: Locale = "en";

/** The cookie the language switcher sets, read by the web app and the control server alike. */
export const LOCALE_COOKIE = "wave_lang";

/**
 * A language tag as any of the places we read it spells it: `de`, `de-AT`,
 * `de_DE.UTF-8`, `en-US`, `German`. Null for anything that is not one of ours
 * -- including `C` and `POSIX`, which say "no language", not "English".
 */
export function matchLocale(tag: string | null | undefined): Locale | null {
  if (!tag) return null;
  const primary =
    tag
      .trim()
      .toLowerCase()
      .split(/[-_.@\s]/)[0] ?? "";
  if (primary === "de" || primary === "german" || primary === "deutsch") return "de";
  if (primary === "en" || primary === "english") return "en";
  return null;
}

/** The first candidate that is one of ours, else the fallback. */
export function pickLocale(...candidates: (string | null | undefined)[]): Locale {
  for (const candidate of candidates) {
    const locale = matchLocale(candidate);
    if (locale) return locale;
  }
  return FALLBACK;
}

/**
 * The best of ours from an `Accept-Language` header, by its q-values. Null
 * when it names none of ours, so the caller can fall back explicitly.
 */
export function fromAcceptLanguage(header: string | null | undefined): Locale | null {
  if (!header) return null;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      const weight = q ? Number(q.slice(2)) : 1;
      return { tag, weight: Number.isFinite(weight) ? weight : 0, index };
    })
    .filter((entry) => entry.weight > 0)
    // Stable on equal weights: the order the browser wrote is its preference.
    .sort((a, b) => b.weight - a.weight || a.index - b.index);
  for (const entry of ranked) {
    const locale = matchLocale(entry.tag);
    if (locale) return locale;
  }
  return null;
}

/** Reads one cookie out of a `Cookie` header. */
function cookieValue(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

/**
 * The language of a browser request: the switcher's cookie, then the
 * browser's own list, then the fallback. The one rule for both the web app and
 * the control server, which serve pages under the same origin.
 */
export function requestLocale(headers: { cookie?: string | null; acceptLanguage?: string | null }): Locale {
  return (
    matchLocale(cookieValue(headers.cookie, LOCALE_COOKIE)) ??
    fromAcceptLanguage(headers.acceptLanguage) ??
    FALLBACK
  );
}

/** The BCP 47 tag for `Intl` -- formats dates and numbers the way the texts around them read. */
export const intlTag = (locale: Locale): string => (locale === "de" ? "de-DE" : "en-GB");

/**
 * A message is a string or a function of its parameters. Plurals and word
 * order differ between languages, so a function is the honest shape for
 * anything with a number or a name in it.
 */
// biome-ignore lint/suspicious/noExplicitAny: parameters differ per message; the catalog type pins them
export type Messages = Record<string, string | ((...args: any[]) => string)>;

/**
 * Picks a catalog. The English one is the shape; the German one must have the
 * same keys with the same parameters -- spelt `satisfies typeof en` at the
 * definition, so a missing or extra key is a type error, not a blank label.
 */
export function messagesFor<T extends Messages>(catalogs: Record<Locale, T>, locale: Locale): T {
  return catalogs[locale];
}
