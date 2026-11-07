import { isIP } from "node:net";
import type { FilterRule } from "@wave/proto";
import { and, asc, eq, isNotNull, ne, or, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, wavePiers, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { serviceLabel } from "./services.ts";

/**
 * Names in the open network, through the pier (D12).
 *
 * Two locks, and both are checked here and nowhere else: an operator allows the
 * pier for a device (`nodes.pier_allowed`), and only then may that device claim
 * a name and a port. A row in `wave_piers` is the claim. What the pier does with
 * it -- read the SNI, look the name up, splice -- lives in `apps/pier`; what the
 * zone says about it lives in `pier-dns.ts`.
 *
 * Names live in a zone of their own, `<pierLabel>.<dnsSuffix>` -- by default
 * `app.pier.wave.example.com`. One wildcard record points the whole zone at the
 * pier (written by `admin.ts set-pier`), so a claim writes nothing to DNS, and
 * a name can never collide with a device or a service: those are one label
 * under the suffix, these are one label under the pier zone. Every write takes
 * the row lock on the wave, which is where `netmap_version` is serialised.
 */

export interface PierRow {
  id: string;
  name: string;
  nodeId: string;
  port: number;
}

/** The node an operator made the pier, and the addresses the world reaches it at. */
export interface PierHost {
  id: string;
  hostname: string;
  /** Wave address, which is what the other devices route to. */
  waveIpv4: string;
  waveIpv6: string;
  /** Public address, configured with `admin.ts set-pier`. At least one is set. */
  publicIpv4: string | null;
  publicIpv6: string | null;
}

/** Something a person has to fix, with the status the route answers. */
export interface PierRefusal {
  error: string;
  status: 400 | 403 | 404 | 409;
}

export type SetPierResult =
  | { pier: PierRow; host: PierHost; dnsName: string; changed: boolean }
  | PierRefusal;

type NodeRow = typeof nodes.$inferSelect;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** The zone the pier serves: `pier.wave.example.com` for the default label. */
export const pierZone = (wave: { pierLabel: string; dnsSuffix: string }): string =>
  `${wave.pierLabel}.${wave.dnsSuffix}`;

/** Whether a label may name the pier zone: one DNS label, nothing else. */
export const isPierLabel = (label: string): boolean => LABEL.test(label);

/**
 * The label of a pier name as a device gives it: bare (`app`) or full
 * (`app.pier.wave.example.com`), one label under the zone, or null.
 *
 * Stricter than a service name, because this one is offered to the internet
 * and to a CA: at most 63 characters (what DNS allows, and longer would only
 * fail at the CA after being signed into every netmap), and no `??--` label --
 * those are reserved, and `xn--` is punycode, the way a name that looks like
 * someone else's (`pаypal`, with a Cyrillic а) would get in.
 */
export function pierLabel(given: string, zone: string): string | null {
  const label = serviceLabel(given, zone);
  if (!label || !LABEL.test(label) || label.slice(2, 4) === "--") return null;
  return label;
}

export const toPierHost = (node: NodeRow): PierHost | null =>
  node.pierIpv4 || node.pierIpv6
    ? {
        id: node.id,
        hostname: node.hostname,
        waveIpv4: node.ipv4,
        waveIpv6: node.ipv6,
        publicIpv4: node.pierIpv4,
        publicIpv6: node.pierIpv6,
      }
    : null;

/** The pier of a wave, if an operator has set one. */
export async function findPierHost(db: Database, waveId: string): Promise<PierHost | null> {
  const rows = await db
    .select()
    .from(nodes)
    .where(and(eq(nodes.waveId, waveId), or(isNotNull(nodes.pierIpv4), isNotNull(nodes.pierIpv6))))
    .limit(1);
  const row = rows[0];
  return row ? toPierHost(row) : null;
}

/**
 * A public name has to be somewhere the internet can resolve it. `.internal` is
 * the placeholder a wave keeps until it has a domain of its own, and it can
 * never be delegated -- so no record could ever make a name under it reachable.
 */
const isPublicSuffix = (suffix: string): boolean => suffix !== "internal" && !suffix.endsWith(".internal");

/**
 * Lets a device claim `name` for `port`, or changes the port of a claim it has.
 *
 * The name is a label under the pier zone, bare (`app`) or full
 * (`app.pier.wave.example.com`). Whether it is free is decided under the lock:
 * a name some other device has already put out is a 409.
 */
export async function setPier(
  db: Database,
  input: { waveId: string; nodeId: string; name: string; port: number },
): Promise<SetPierResult> {
  return db.transaction(async (tx) => {
    const waveRows = await tx.select().from(waves).where(eq(waves.id, input.waveId)).limit(1).for("update");
    const wave = waveRows[0];
    if (!wave) return { error: "the wave is gone", status: 404 };

    const siblings = await tx.select().from(nodes).where(eq(nodes.waveId, input.waveId));
    const self = siblings.find((node) => node.id === input.nodeId);
    if (!self) return { error: "unknown node", status: 404 };

    // The operator's lock comes first: a device that may not hear a different
    // answer for a name that is taken than for one that is free.
    if (!self.pierAllowed) {
      return {
        error: `the pier is not allowed for ${self.hostname}; an operator grants it with \`admin.ts allow-pier\``,
        status: 403,
      };
    }

    // Only the pier zone, and only one label inside it -- a name from
    // elsewhere would be a route for a name the wildcard does not cover.
    const zone = pierZone(wave);
    const label = pierLabel(input.name, zone);
    if (!label) return { error: `${input.name} is not a name under ${zone}`, status: 400 };
    if (!isPublicSuffix(wave.dnsSuffix)) {
      return {
        error: `${wave.dnsSuffix} is a placeholder domain and cannot be reached from the open network; give the wave a domain of its own first`,
        status: 409,
      };
    }

    const host = siblings.map(toPierHost).find((entry): entry is PierHost => entry !== null);
    if (!host) {
      return {
        error: "this wave has no pier; an operator sets one with `admin.ts set-pier`",
        status: 409,
      };
    }

    const fqdn = `${label}.${zone}`;
    const existing = await tx.select().from(wavePiers).where(eq(wavePiers.waveId, input.waveId));
    const same = existing.find((pier) => pier.name === label);
    if (same && same.nodeId !== self.id) {
      return { error: `${fqdn} is already put out by another device`, status: 409 };
    }

    let changed: boolean;
    let row: PierRow;
    if (same) {
      changed = same.port !== input.port;
      if (changed) {
        await tx
          .update(wavePiers)
          .set({ port: input.port, updatedAt: new Date() })
          .where(eq(wavePiers.id, same.id));
      }
      row = { id: same.id, name: same.name, nodeId: same.nodeId, port: input.port };
    } else {
      changed = true;
      row = { id: newId("pier"), name: label, nodeId: self.id, port: input.port };
      await tx.insert(wavePiers).values({ ...row, waveId: input.waveId });
    }

    if (changed) {
      await tx
        .update(waves)
        .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
        .where(eq(waves.id, input.waveId));
    }
    return { pier: row, host, dnsName: fqdn, changed };
  });
}

export async function listPiers(db: Database, waveId: string, nodeId?: string): Promise<PierRow[]> {
  return db
    .select({ id: wavePiers.id, name: wavePiers.name, nodeId: wavePiers.nodeId, port: wavePiers.port })
    .from(wavePiers)
    .where(
      nodeId ? and(eq(wavePiers.waveId, waveId), eq(wavePiers.nodeId, nodeId)) : eq(wavePiers.waveId, waveId),
    )
    .orderBy(asc(wavePiers.name));
}

/**
 * Takes one claim back -- only a device's own, so one device cannot end
 * another's. Null when there was nothing to remove.
 */
export async function removePier(
  db: Database,
  input: { waveId: string; nodeId: string; name: string },
): Promise<PierRow | null> {
  const gone = await db
    .delete(wavePiers)
    .where(
      and(
        eq(wavePiers.waveId, input.waveId),
        eq(wavePiers.nodeId, input.nodeId),
        eq(wavePiers.name, input.name),
      ),
    )
    .returning({ id: wavePiers.id, name: wavePiers.name, nodeId: wavePiers.nodeId, port: wavePiers.port });
  const row = gone[0];
  if (!row) return null;
  await bumpNetmap(db, input.waveId);
  return row;
}

/**
 * Takes every claim of one device back: what `deny-pier` does, because a lock
 * that is closed and leaves the door open is no lock.
 */
export async function removePiersOf(db: Database, waveId: string, nodeId: string): Promise<PierRow[]> {
  const gone = await db
    .delete(wavePiers)
    .where(and(eq(wavePiers.waveId, waveId), eq(wavePiers.nodeId, nodeId)))
    .returning({ id: wavePiers.id, name: wavePiers.name, nodeId: wavePiers.nodeId, port: wavePiers.port });
  if (gone.length > 0) await bumpNetmap(db, waveId);
  return gone;
}

const bumpNetmap = (db: Database, waveId: string) =>
  db
    .update(waves)
    .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
    .where(eq(waves.id, waveId));

/**
 * The first lock, opened or closed for one device. Closing it takes the
 * device's names with it, in the same transaction: the flag decides who may
 * *claim*, and a claim made before it was withdrawn must not outlive it.
 *
 * Under the wave's lock, the one `setPier()` takes: without it a claim that
 * had read "allowed" could commit after the names were cleared, and stand
 * without the permission it needed -- the netmap would carry it, the pier
 * would splice it, and only the certificate would be refused.
 */
export async function setPierAllowed(
  db: Database,
  waveId: string,
  nodeId: string,
  allowed: boolean,
): Promise<{ hostname: string; taken: PierRow[] } | null> {
  return db.transaction(async (tx) => {
    await tx.select({ id: waves.id }).from(waves).where(eq(waves.id, waveId)).limit(1).for("update");
    const updated = await tx
      .update(nodes)
      .set({ pierAllowed: allowed })
      .where(and(eq(nodes.waveId, waveId), eq(nodes.id, nodeId)))
      .returning({ hostname: nodes.hostname });
    const row = updated[0];
    if (!row) return null;
    const taken = allowed ? [] : await removePiersOf(tx as unknown as Database, waveId, nodeId);
    return { hostname: row.hostname, taken };
  });
}

export type SetPierHostResult =
  | {
      host: PierHost;
      /** The zone the wildcard record now has to cover. */
      zone: string;
      /** The zone it covered before, when the label moved; its record has to go. */
      previousZone: string | null;
    }
  | { conflict: string }
  | { invalid: string };

/**
 * Makes one node the pier of its wave, with the addresses the world reaches it
 * at -- configured, never guessed: behind an ingress the node cannot know them.
 *
 * One pier per wave. A second node would be a second answer to "where is this
 * name", and the wildcard record can only hold one of them. `label` names the
 * zone it serves; it moves only while nobody holds a name in it, because every
 * name and every certificate for one hangs under the old zone.
 */
export async function setPierHost(
  db: Database,
  input: { waveId: string; nodeId: string; ipv4?: string; ipv6?: string; label?: string },
): Promise<SetPierHostResult> {
  if (input.ipv4 === undefined && input.ipv6 === undefined) {
    return { invalid: "a pier needs a public address, IPv4 or IPv6 or both" };
  }
  if (input.ipv4 !== undefined && isIP(input.ipv4) !== 4)
    return { invalid: `${input.ipv4} is not an IPv4 address` };
  if (input.ipv6 !== undefined && isIP(input.ipv6) !== 6)
    return { invalid: `${input.ipv6} is not an IPv6 address` };
  const label = input.label?.trim().toLowerCase();
  if (label !== undefined && !isPierLabel(label)) {
    return { invalid: `${input.label} is not a single DNS label` };
  }

  return db.transaction(async (tx) => {
    const waveRows = await tx.select().from(waves).where(eq(waves.id, input.waveId)).limit(1).for("update");
    const wave = waveRows[0];
    if (!wave) return { invalid: "the wave is gone" };
    // The wildcard has to be resolvable from the open network, and nothing
    // under `.internal` ever is.
    if (!isPublicSuffix(wave.dnsSuffix)) {
      return {
        invalid: `${wave.dnsSuffix} is a placeholder domain and cannot be reached from the open network; give the wave a domain of its own first`,
      };
    }
    const other = await tx
      .select({ hostname: nodes.hostname })
      .from(nodes)
      .where(
        and(
          eq(nodes.waveId, input.waveId),
          ne(nodes.id, input.nodeId),
          or(isNotNull(nodes.pierIpv4), isNotNull(nodes.pierIpv6)),
        ),
      )
      .limit(1);
    if (other[0]) {
      return {
        conflict: `${other[0].hostname} is already the pier of this wave; \`admin.ts clear-pier\` it first`,
      };
    }

    const moving = label !== undefined && label !== wave.pierLabel;
    if (moving) {
      const held = await tx
        .select({ name: wavePiers.name })
        .from(wavePiers)
        .where(eq(wavePiers.waveId, input.waveId))
        .orderBy(asc(wavePiers.name));
      if (held.length > 0) {
        const zone = pierZone(wave);
        return {
          conflict: `names are put out under ${zone} (${held.map((row) => `${row.name}.${zone}`).join(", ")}); remove them before the zone moves`,
        };
      }
    }

    const before = await tx
      .select()
      .from(nodes)
      .where(and(eq(nodes.waveId, input.waveId), eq(nodes.id, input.nodeId)))
      .limit(1);
    const wasPier = before[0] ? toPierHost(before[0]) !== null : false;

    const updated = await tx
      .update(nodes)
      .set({ pierIpv4: input.ipv4 ?? null, pierIpv6: input.ipv6 ?? null })
      .where(and(eq(nodes.waveId, input.waveId), eq(nodes.id, input.nodeId)))
      .returning();
    const host = updated[0] ? toPierHost(updated[0]) : null;
    if (!host) return { invalid: "unknown node" };
    await tx
      .update(waves)
      .set({ netmapVersion: sql`${waves.netmapVersion} + 1`, ...(moving ? { pierLabel: label } : {}) })
      .where(eq(waves.id, input.waveId));
    const zone = pierZone({ pierLabel: moving ? label : wave.pierLabel, dnsSuffix: wave.dnsSuffix });
    // Only a pier that was already serving left a record under the old zone.
    return { host, zone, previousZone: moving && wasPier ? pierZone(wave) : null };
  });
}

/** Ends the pier of a wave; its claims stay, and wait for a new one. */
export async function clearPierHost(
  db: Database,
  waveId: string,
): Promise<{ host: PierHost; zone: string } | null> {
  const before = await findPierHost(db, waveId);
  if (!before) return null;
  await db
    .update(nodes)
    .set({ pierIpv4: null, pierIpv6: null })
    .where(and(eq(nodes.waveId, waveId), eq(nodes.id, before.id)));
  await bumpNetmap(db, waveId);
  const rows = await db.select().from(waves).where(eq(waves.id, waveId)).limit(1);
  const wave = rows[0];
  return { host: before, zone: wave ? pierZone(wave) : "" };
}

/**
 * What a device that owns names lets the pier do, under a policy (M7).
 *
 * A policy is default deny, and the pier is no member the policy has heard of.
 * The claim is itself the grant -- two locks and a named port -- so it opens
 * exactly that: the pier's wave address to this device's address on this port,
 * TCP, and nothing else. Without a policy nothing is added: everything is let in
 * already, and a rule here would turn "no policy" into "some policy".
 */
export function pierFilter(
  host: Pick<PierHost, "waveIpv4" | "waveIpv6">,
  self: { ipv4: string; ipv6: string },
  piers: Pick<PierRow, "port">[],
): FilterRule[] {
  const ports = [...new Set(piers.map((pier) => pier.port))].sort((a, b) => a - b);
  if (ports.length === 0) return [];
  return [
    {
      src: [`${host.waveIpv4}/32`, `${host.waveIpv6}/128`],
      dst: [`${self.ipv4}/32`, `${self.ipv6}/128`],
      ports: ports.map((port) => ({ proto: "tcp" as const, from: port, to: port })),
    },
  ];
}
