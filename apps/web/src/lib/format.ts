const relative = new Intl.RelativeTimeFormat("de", { numeric: "auto" });
const absolute = new Intl.DateTimeFormat("de", { dateStyle: "medium", timeStyle: "short" });

const STEPS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["second", 60],
  ["minute", 60],
  ["hour", 24],
  ["day", 7],
  ["week", 4.348],
  ["month", 12],
];

/** "vor 3 Minuten". Null is a node that has never reported in. */
export function timeAgo(value: string | null): string {
  if (!value) return "noch nie";
  let amount = (Date.now() - new Date(value).getTime()) / 1000;
  for (const [unit, size] of STEPS) {
    if (Math.abs(amount) < size) return relative.format(-Math.round(amount), unit);
    amount /= size;
  }
  return relative.format(-Math.round(amount), "year");
}

export function formatDate(value: string | null): string {
  return value ? absolute.format(new Date(value)) : "—";
}

const OS_NAMES: Record<string, string> = {
  linux: "Linux",
  darwin: "macOS",
  windows: "Windows",
  other: "Unbekannt",
};

export const osName = (os: string): string => OS_NAMES[os] ?? os;
