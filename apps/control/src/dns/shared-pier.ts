import type { SharedPierConfig } from "../env.ts";
import { buildProvider, type DnsMode } from "./credentials.ts";

/**
 * The zone of the shared pier belongs to the server, not to a wave: its records
 * -- the wildcard of every wave's random zone, and the dns-01 challenges for
 * names under it -- are written with the server's own token
 * (`WAVE_SHARED_PIER_DNS_*`), never with a wave's. Which one a name needs is
 * decided by the name alone, here.
 */
export const underSharedDomain = (name: string, config: SharedPierConfig | undefined): boolean => {
  if (!config) return false;
  const lower = name.toLowerCase().replace(/^\*\./, "");
  return lower === config.domain || lower.endsWith(`.${config.domain}`);
};

export const sharedPierMode = (config: SharedPierConfig, http?: typeof fetch): DnsMode => ({
  kind: "automatic",
  provider: buildProvider(config.provider, config.token, http),
});
