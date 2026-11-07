import type { PierDnsState, PierRecord } from "@wave/proto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { waves } from "../db/schema.ts";
import { loadDnsMode } from "../dns/credentials.ts";
import type { AddressType } from "../dns/provider.ts";
import { findPierHost, listPiers, type PierHost } from "./piers.ts";

/**
 * What the zone says about a name in the open network (D12).
 *
 * The public A/AAAA record of an exposed name points at the *pier*, never at
 * the wave address of the device behind it: a name can mean one of the two,
 * and the wave address is only reachable from inside. The pier is the only
 * thing this module ever writes into the zone, and it writes it for one name at
 * a time -- the names in `wave_piers`.
 *
 * It follows the other DNS work here in its two modes. A provider token and the
 * server writes the record; `manual`, or nothing configured, and the answer
 * names the record somebody has to create -- or delete -- by hand, as with
 * dns-01. A provider that refuses is not an exception for the caller to catch:
 * the grant is already stored, so it comes back as `failed` with the provider's
 * own words, and asking again tries again.
 */

export interface PierDnsOutcome {
  state: PierDnsState;
  /** What the pier's name needs -- or, after an unpublish, what is left to delete. */
  records: PierRecord[];
  error?: string;
}

interface Wanted {
  type: AddressType;
  value: string | null;
}

/** The records the pier's name carries: one per family the pier has an address for. */
function wanted(host: Pick<PierHost, "publicIpv4" | "publicIpv6">): Wanted[] {
  return [
    { type: "A", value: host.publicIpv4 },
    { type: "AAAA", value: host.publicIpv6 },
  ];
}

const recordsFor = (name: string, host: Pick<PierHost, "publicIpv4" | "publicIpv6">): PierRecord[] =>
  wanted(host).flatMap((entry) => (entry.value ? [{ type: entry.type, name, value: entry.value }] : []));

export interface PierDnsContext {
  db: Database;
  dnsSecret?: Buffer;
  http?: typeof fetch;
}

/** Writes the record of a name that has just been put out. */
export async function publishPierName(
  ctx: PierDnsContext,
  input: { waveId: string; fqdn: string; host: Pick<PierHost, "publicIpv4" | "publicIpv6"> },
): Promise<PierDnsOutcome> {
  const records = recordsFor(input.fqdn, input.host);
  try {
    const mode = await loadDnsMode(ctx.db, input.waveId, ctx.dnsSecret, ctx.http);
    if (!mode) return { state: "unconfigured", records };
    if (mode.kind === "manual") return { state: "manual", records };

    for (const entry of wanted(input.host)) {
      // A family the pier has no address for is cleared, not left behind: an
      // old AAAA would keep sending IPv6 clients to a pier that moved.
      if (entry.value) await mode.provider.setAddress(input.fqdn, entry.value);
      else await mode.provider.removeAddress(input.fqdn, entry.type);
    }
    return { state: "published", records };
  } catch (error) {
    return { state: "failed", records, error: (error as Error).message };
  }
}

/** Takes the record of a name away, as an exposure ends. */
export async function unpublishPierName(
  ctx: PierDnsContext,
  input: { waveId: string; fqdn: string; host: Pick<PierHost, "publicIpv4" | "publicIpv6"> | null },
): Promise<PierDnsOutcome> {
  // Without a pier there is nothing the wave told us the name pointed at, so
  // there is nothing to name in a request to delete -- but the provider is
  // asked for both types regardless, because it removes by name.
  const records = input.host ? recordsFor(input.fqdn, input.host) : [];
  try {
    const mode = await loadDnsMode(ctx.db, input.waveId, ctx.dnsSecret, ctx.http);
    if (!mode) return { state: "unconfigured", records };
    if (mode.kind === "manual") return { state: "manual", records };

    await mode.provider.removeAddress(input.fqdn, "A");
    await mode.provider.removeAddress(input.fqdn, "AAAA");
    return { state: "published", records: [] };
  } catch (error) {
    return { state: "failed", records, error: (error as Error).message };
  }
}

/**
 * The records a device leaves behind when it is removed from its wave.
 *
 * Called *before* the device goes: its claims disappear with it (they cascade),
 * and so would the only record of which names to take out of the zone. A removed
 * pier takes every name's record with it, because nothing answers for them any
 * more. Never throws -- the removal must not be undone by a provider that is
 * having a bad day -- and says what it could not do, per name.
 */
export async function unpublishPiersOfNode(
  ctx: PierDnsContext,
  input: { waveId: string; nodeId: string },
): Promise<{ fqdn: string; outcome: PierDnsOutcome }[]> {
  const waveRows = await ctx.db.select().from(waves).where(eq(waves.id, input.waveId)).limit(1);
  const wave = waveRows[0];
  if (!wave) return [];

  const host = await findPierHost(ctx.db, input.waveId);
  const claims = await listPiers(ctx.db, input.waveId, host?.id === input.nodeId ? undefined : input.nodeId);

  const outcomes: { fqdn: string; outcome: PierDnsOutcome }[] = [];
  for (const claim of claims) {
    const fqdn = `${claim.name}.${wave.dnsSuffix}`;
    outcomes.push({ fqdn, outcome: await unpublishPierName(ctx, { waveId: input.waveId, fqdn, host }) });
  }
  return outcomes;
}
