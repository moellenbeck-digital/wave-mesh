import type { PierDnsState, PierRecord } from "@wave/proto";
import { and, eq, isNotNull, or } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, waves } from "../db/schema.ts";
import { loadDnsMode } from "../dns/credentials.ts";
import type { AddressType } from "../dns/provider.ts";
import { type PierHost, pierZone } from "./piers.ts";

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
 * Who is about to leave a wave: one device, every device of one member, or the
 * whole wave. Each of these can take the pier with it.
 */
export type Leaving = { nodeId: string } | { userId: string } | { wholeWave: true };

/** What a leaving pier left in the zone, read while its row still exists. */
export interface LeavingPier {
  waveId: string;
  zone: string;
  host: Pick<PierHost, "publicIpv4" | "publicIpv6">;
}

/**
 * The wildcard a wave leaves behind when its pier goes -- one device removed,
 * logged out, its member removed, or the whole wave deleted. Two steps, and
 * every path that deletes a node row takes both:
 *
 * - `pierLeaving()` *before* the delete: the pier's public addresses go with
 *   the row, and so would the only record of what the zone pointed at.
 * - `unpublishLeavingPier()` *after* it succeeded: a removal that is refused
 *   (the owner, an admin removed by an admin) must not take the record away.
 *
 * A wildcard left standing points at an address the operator may give up, and
 * whoever gets it next answers every name under the pier zone -- with
 * certificates, unless CAA says otherwise.
 */
export async function pierLeaving(
  db: Database,
  input: { waveId: string; leaving: Leaving },
): Promise<LeavingPier | null> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.waveId, input.waveId), or(isNotNull(nodes.pierIpv4), isNotNull(nodes.pierIpv6))))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const { leaving } = input;
  const goes =
    "wholeWave" in leaving ||
    ("nodeId" in leaving ? row.id === leaving.nodeId : row.userId === leaving.userId);
  if (!goes) return null;
  const waveRows = await db.select().from(waves).where(eq(waves.id, input.waveId)).limit(1);
  const wave = waveRows[0];
  if (!wave) return null;
  return {
    waveId: input.waveId,
    zone: pierZone(wave),
    host: { publicIpv4: row.pierIpv4, publicIpv6: row.pierIpv6 },
  };
}

/**
 * Takes the wildcard of a pier that has gone. Never throws -- the removal has
 * happened, and a provider having a bad day must not make it look undone --
 * and null when there was no pier among those leaving.
 */
export async function unpublishLeavingPier(
  ctx: PierDnsContext,
  pier: LeavingPier | null,
): Promise<{ name: string; outcome: PierDnsOutcome } | null> {
  if (!pier) return null;
  const outcome = await unpublishPierZone(ctx, pier);
  if (outcome.state === "failed") {
    console.error(`pier: could not take ${wildcardOf(pier.zone)} away: ${outcome.error}`);
  } else if (outcome.state !== "published") {
    console.log(`pier: ${wildcardOf(pier.zone)} has to be deleted by hand (${outcome.state})`);
  }
  return { name: wildcardOf(pier.zone), outcome };
}
