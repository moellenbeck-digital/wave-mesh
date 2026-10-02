import { spawnSync } from "node:child_process";
import { FALLBACK, type Locale, matchLocale } from "./index.ts";

/**
 * The language of the person at this machine, for the CLI, the tray and
 * wave-admin.
 *
 * `WAVE_LANG` first, as the one override that works on every platform. Then
 * the POSIX order -- `LANGUAGE` (GNU's list), `LC_ALL`, `LC_MESSAGES`, `LANG` --
 * because that is what a terminal sets. Only when none of them says anything
 * the platform is asked: a tray started by launchd or the Task Scheduler has
 * no `LANG` at all, and the language lives in the system settings there.
 *
 * `C` and `POSIX` are not a language, so they fall through rather than meaning
 * English -- but on a server where that is all there is, the result is the
 * fallback, which is English anyway.
 */
export function systemLocale(
  env: Record<string, string | undefined> = process.env,
  platform: NodeJS.Platform = process.platform,
  ask: (command: string, args: string[]) => string | null = run,
): Locale {
  const fromEnv = [env.WAVE_LANG, ...(env.LANGUAGE ?? "").split(":"), env.LC_ALL, env.LC_MESSAGES, env.LANG];
  for (const candidate of fromEnv) {
    const locale = matchLocale(candidate);
    if (locale) return locale;
  }
  if (platform === "darwin") {
    // The first entry of the preferred languages, e.g. "de-DE" in a plist array.
    const out = ask("defaults", ["read", "-g", "AppleLanguages"]);
    const first = out?.match(/"?([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]+)*)"?/)?.[1];
    const locale = matchLocale(first);
    if (locale) return locale;
  }
  if (platform === "win32") {
    // The display language, not the regional format: a German Windows set to
    // Swiss date formats is still read in German.
    const out = ask("powershell", ["-NoProfile", "-NonInteractive", "-Command", "(Get-UICulture).Name"]);
    const locale = matchLocale(out);
    if (locale) return locale;
  }
  return matchLocale(Intl.DateTimeFormat().resolvedOptions().locale) ?? FALLBACK;
}

function run(command: string, args: string[]): string | null {
  try {
    const result = spawnSync(command, args, { encoding: "utf8", timeout: 2000, windowsHide: true });
    return result.status === 0 ? result.stdout.trim() : null;
  } catch {
    return null;
  }
}
