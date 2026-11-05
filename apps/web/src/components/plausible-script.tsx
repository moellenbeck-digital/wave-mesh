import { plausibleConfig, scriptAttributes } from "@/lib/plausible";

/**
 * The Plausible script, or nothing. Rendered on the server for every request
 * and reading the environment then, so the same image tracks where ops sets
 * `NEXT_PUBLIC_PLAUSIBLE_*` and stays silent everywhere else.
 */
export function PlausibleScript() {
  const config = plausibleConfig(process.env);
  if (!config) return null;
  return <script {...scriptAttributes(config)} />;
}
