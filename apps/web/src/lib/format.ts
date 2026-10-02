import { intlTag, type Locale } from "@wave/i18n";
import { appMessages } from "@/i18n/app";

/**
 * Every function here takes the locale of the request rather than asking the
 * browser: relative times are rendered on the server and again in the
 * browser, and both must use the same language -- the one the texts around
 * them are in. Formatters are built once per locale; `Intl` is not cheap.
 */
const formatters = new Map<Locale, { relative: Intl.RelativeTimeFormat; absolute: Intl.DateTimeFormat }>();

function formatsFor(locale: Locale) {
  let formats = formatters.get(locale);
  if (!formats) {
    const tag = intlTag(locale);
    formats = {
      relative: new Intl.RelativeTimeFormat(tag, { numeric: "auto" }),
      absolute: new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }),
    };
    formatters.set(locale, formats);
  }
  return formats;
}

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.348],
  ["month", 12],
];

/** "3 minutes ago". Null is a node that has never reported in. */
export function timeAgo(value: string | null, locale: Locale): string {
  if (!value) return appMessages(locale).never;
  const { relative } = formatsFor(locale);
  let amount = (Date.now() - new Date(value).getTime()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(amount) < size) return relative.format(-Math.round(amount), unit);
    amount /= size;
  }
  return relative.format(-Math.round(amount), "year");
}

export function formatDate(value: string | null, locale: Locale): string {
  return value ? formatsFor(locale).absolute.format(new Date(value)) : "—";
}

/** The day alone, without the time `formatDate` adds. */
export function formatDay(value: string, locale: Locale): string {
  return new Date(value).toLocaleDateString(intlTag(locale), { dateStyle: "medium" });
}

const OS_NAMES: Record<string, string> = {
  linux: "Linux",
  darwin: "macOS",
  windows: "Windows",
};

export const osName = (os: string, locale: Locale): string =>
  OS_NAMES[os] ?? (os === "other" ? appMessages(locale).osUnknown : os);
