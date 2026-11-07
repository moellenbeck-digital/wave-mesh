import type { PierDnsState, PierRecord } from "@wave/proto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { waves } from "../db/schema.ts";
import { loadDnsMode } from "../dns/credentials.ts";
import type { AddressType } from "../dns/provider.ts";
import { findPierHost, type PierHost, pierZone } from "./piers.ts";

/**
 * What the zone says about the pier (D12).
 *
 * One wildcard record, `*.<pier zone>`, points every name under the pier zone
 * at the pier -- never at the wave address of a device behind it: that one is
 * only reachable from inside, where the wave's own resolver answers instead.
 * It is written when an operator sets the pier and taken away when the pier
 * ends, and a device putting a name out writes nothing at all. A name nobody
 * has claimed still resolves to the pier, which closes the connection without
 * a word, exactly as it does for a scanner that tries a name by hand.
 *
 * It follows the other DNS work here in its two modes. A provider token and the
 * server writes the record; `manual`, or nothing configured, and the answer
 * names the record somebody has to create -- or delete -- by hand, as with
 * dns-01. A provider that refuses is not an exception for the caller to catch:
 * the pier is already stored, so it comes back as `failed` with the provider's
 * own words, and setting the pier again tries again.
 */

export interface PierDnsOutcome {
  state: PierDnsState;
  /** What the zone needs -- or, after an unpublish, what is left to delete. */
  records: PierRecord[];
  error?: string;
}

interface Wanted {
  type: AddressType;
  value: string | null;
}

/** The wildcard record name for a pier zone. */
export const wildcardOf = (zone: string): string => `*.${zone}`;

/** The records the zone carries: one per family the pier has an address for. */
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

/** Points the whole pier zone at the pier. */
export async function publishPierZone(
  ctx: PierDnsContext,
  input: { waveId: string; zone: string; host: Pick<PierHost, "publicIpv4" | "publicIpv6"> },
): Promise<PierDnsOutcome> {
  const name = wildcardOf(input.zone);
  const records = recordsFor(name, input.host);
  try {
    const mode = await loadDnsMode(ctx.db, input.waveId, ctx.dnsSecret, ctx.http);
    if (!mode) return { state: "unconfigured", records };
    if (mode.kind === "manual") return { state: "manual", records };

    for (const entry of wanted(input.host)) {
      // A family the pier has no address for is cleared, not left behind: an
      // old AAAA would keep sending IPv6 clients to a pier that moved.
      if (entry.value) await mode.provider.setAddress(name, entry.value);
      else await mode.provider.removeAddress(name, entry.type);
    }
    return { state: "published", records };
  } catch (error) {
    return { state: "failed", records, error: (error as Error).message };
  }
}

/** Takes the wildcard away, as the pier ends. */
export async function unpublishPierZone(
  ctx: PierDnsContext,
  input: { waveId: string; zone: string; host: Pick<PierHost, "publicIpv4" | "publicIpv6"> | null },
): Promise<PierDnsOutcome> {
  const name = wildcardOf(input.zone);
  // Without a pier there is nothing the wave told us the zone pointed at, so
  // there is nothing to name in a request to delete -- but the provider is
  // asked for both types regardless, because it removes by name.
  const records = input.host ? recordsFor(name, input.host) : [];
  try {
    const mode = await loadDnsMode(ctx.db, input.waveId, ctx.dnsSecret, ctx.http);
    if (!mode) return { state: "unconfigured", records };
    if (mode.kind === "manual") return { state: "manual", records };

    await mode.provider.removeAddress(name, "A");
    await mode.provider.removeAddress(name, "AAAA");
    return { state: "published", records: [] };
  } catch (error) {
    return { state: "failed", records, error: (error as Error).message };
  }
}

/**
 * The wildcard a device leaves behind when it is removed from its wave -- only
 * if it was the pier, because nothing answers for the zone any more.
 *
 * Called *before* the device goes: its public addresses go with the row, and
 * so would the only record of what the zone pointed at. Never throws -- the
 * removal must not be undone by a provider that is having a bad day -- and
 * null when there was nothing to do.
 */
export async function unpublishPierZoneOfNode(
  ctx: PierDnsContext,
  input: { waveId: string; nodeId: string },
): Promise<{ name: string; outcome: PierDnsOutcome } | null> {
  const host = await findPierHost(ctx.db, input.waveId);
  if (host?.id !== input.nodeId) return null;
  const rows = await ctx.db.select().from(waves).where(eq(waves.id, input.waveId)).limit(1);
  const wave = rows[0];
  if (!wave) return null;
  const zone = pierZone(wave);
  return {
    name: wildcardOf(zone),
    outcome: await unpublishPierZone(ctx, { waveId: input.waveId, zone, host }),
  };
}
