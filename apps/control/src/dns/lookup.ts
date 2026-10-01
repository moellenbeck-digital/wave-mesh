import { promises as dns, Resolver } from "node:dns";
import { zoneCandidates } from "./provider.ts";

/**
 * Looking a TXT record up, the only way that is any use here: **at the zone's
 * own nameservers**.
 *
 * Through a recursive resolver this would not work. The manual mode asks for a
 * record and then keeps looking until it appears, so the first look almost
 * always happens before it exists -- and a resolver caches that absence for as
 * long as the zone's SOA says. For `rolenz-digital.de` that is 3600 seconds:
 * one early question and the record stays invisible for an hour after it was
 * created, which looks exactly like a person who typed it in wrong.
 *
 * An authoritative server has no cache to poison. It also answers about its own
 * zone only, which is why the zone has to be found first.
 */

export type TxtLookup = (name: string) => Promise<string[]>;

const TIMEOUT_MS = 5_000;

/**
 * The addresses of the nameservers for the closest zone above this name.
 *
 * Walked from the longest candidate down, so a delegated subzone answers for
 * itself rather than its parent -- the same order the providers use, and for
 * the same reason.
 */
async function authoritiesFor(name: string): Promise<string[]> {
  for (const zone of zoneCandidates(name)) {
    const servers = await dns.resolveNs(zone).catch(() => [] as string[]);
    if (servers.length === 0) continue;

    const addresses: string[] = [];
    for (const server of servers) {
      addresses.push(...(await dns.resolve4(server).catch(() => [] as string[])));
    }
    if (addresses.length > 0) return addresses;
  }
  return [];
}

/**
 * The TXT values at this name, as its own nameservers see them.
 *
 * An empty array means "not there", whether the name does not exist, the zone
 * has no such record or a server would not answer -- for the one caller there
 * is, they are the same thing: keep waiting.
 */
export const lookupTxtAtAuthority: TxtLookup = async (name) => {
  const addresses = await authoritiesFor(name);
  if (addresses.length === 0) return [];

  for (const address of addresses) {
    const resolver = new Resolver({ timeout: TIMEOUT_MS, tries: 1 });
    resolver.setServers([address]);
    const chunks = await new Promise<string[][]>((resolve) => {
      resolver.resolveTxt(name, (error, records) => resolve(error ? [] : records));
    });
    // A TXT record is a list of strings that a client joins; a challenge value
    // fits in one, but joining is what every resolver does and costs nothing.
    const values = chunks.map((chunk) => chunk.join(""));
    if (values.length > 0) return values;
  }
  return [];
};
