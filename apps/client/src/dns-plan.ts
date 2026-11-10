import { isReservedZone, normalizeName, type ZoneRecord } from "@wave/dns";

/**
 * What the system is asked to send to the wave's resolver.
 *
 * Under a reserved zone (`.internal`) nothing else lives there, so the whole
 * zone goes, and doubles as the search domain: `ping laptop` works. Under a
 * domain the user already owns, the wave must not claim the zone -- its apex
 * and `www` belong to somebody else -- so only the names the wave knows are
 * routed, and there is no search domain: on Linux a search entry is routing for
 * the whole domain as well, and a bare `www` would be completed against
 * somebody else's domain.
 */
export interface DnsPlan {
  /** Zones sent here whole: the name itself and everything under it. */
  suffixes: string[];
  /** Single names sent here, and nothing beneath or beside them. */
  names: string[];
  /** The zone to complete bare hostnames with, only where that catches nothing. */
  search?: string;
}

export interface DnsPlanInput {
  zone: string;
  records: ZoneRecord[];
  /** Suffixes the netmap delegates to another nameserver. */
  routes: { suffix: string }[];
  reverse: string[];
}

/**
 * A name that is safe to hand to the system: letters, digits, `_` and `-` in
 * dot-separated labels. It ends up as a file name on macOS and a namespace in a
 * script on Windows, so anything else is left out rather than quoted.
 */
const SAFE_NAME = /^[a-z0-9_-]+(\.[a-z0-9_-]+)*$/;

export function planDns(input: DnsPlanInput): DnsPlan {
  const delegated = [...input.routes.map((route) => route.suffix), ...input.reverse];

  if (isReservedZone(input.zone)) {
    return { suffixes: [input.zone, ...delegated], names: [], search: input.zone };
  }

  const zone = normalizeName(input.zone);
  const covered = new Set(delegated.map(normalizeName));
  const names = [
    ...new Set(
      input.records
        .map((record) => normalizeName(record.name))
        // The zone itself is not a wave name; a name a delegated suffix names
        // already is routed whole.
        .filter((name) => name !== zone && SAFE_NAME.test(name) && !covered.has(name)),
    ),
  ].sort();
  return { suffixes: delegated, names };
}

/** Whether two plans ask the system for the same thing. */
export const dnsFingerprint = (plan: DnsPlan, resolver: string, port: number | undefined): string =>
  JSON.stringify([resolver, port ?? 53, plan.suffixes, plan.names, plan.search ?? null]);
