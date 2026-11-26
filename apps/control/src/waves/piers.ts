import { randomInt } from "node:crypto";
import { isIP } from "node:net";
import type { FilterRule } from "@wave/proto";
import { and, asc, eq, isNotNull, isNull, ne, or, sql } from "drizzle-orm";
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
  /**
   * Whether this is the shared pier of the server (`nodes.shared_pier`): a
   * member of its own hosting wave only, and to every other wave a peer of
   * exactly the devices that put a name out through it.
   */
  shared: boolean;
}

/** Something a person has to fix, with the status the route answers. */
export interface PierRefusal {
  error: string;
  status: 400 | 403 | 404 | 409;
}

export type SetPierResult =
  | { pier: PierRow; host: PierHost; dnsName: string; zone: string; changed: boolean }
  | PierRefusal;

type NodeRow = typeof nodes.$inferSelect;

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** What `pierZone()` needs to know about a wave. */
export interface ZoneOfWave {
  pierLabel: string;
  dnsSuffix: string;
  pierZoneMode?: string;
  sharedPierName?: string | null;
}

/**
 * The zone the pier serves, and the one place that puts it together.
 *
 * `pier.wave.example.com` for the default label under the wave's own suffix;
 * `k3x9q7mz.wavepier.net` while the wave uses the shared pier's zone -- which
 * takes the mode, the wave's random label and the domain of the shared pier
 * (`WAVE_SHARED_PIER_DOMAIN`, passed in by the caller). Missing any of the
 * three, it is the wave's own zone: a name is never put under a zone nobody
 * writes.
 */
export const pierZone = (wave: ZoneOfWave, sharedDomain?: string): string =>
  usesSharedZone(wave, sharedDomain)
    ? `${wave.sharedPierName}.${sharedDomain}`
    : `${wave.pierLabel}.${wave.dnsSuffix}`;

/** Whether a wave's names live under the shared pier domain. */
export const usesSharedZone = (wave: ZoneOfWave, sharedDomain?: string): boolean =>
  wave.pierZoneMode !== "own" && !!wave.sharedPierName && !!sharedDomain;

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
        shared: node.sharedPier,
      }
    : null;

/** The shared pier of the server, with the wave it is a member of. */
export interface SharedPier {
  host: PierHost;
  node: NodeRow;
  waveId: string;
}

export async function findSharedPier(db: Database): Promise<SharedPier | null> {
  const rows = await db.select().from(nodes).where(eq(nodes.sharedPier, true)).limit(1);
  const row = rows[0];
  const host = row ? toPierHost(row) : null;
  return row && host ? { host, node: row, waveId: row.waveId } : null;
}

/**
 * The pier a wave's names go out through: one of its own, or else the
 * shared one. The hosting wave of the shared pier finds it as its own.
 */
export async function effectivePier(db: Database, waveId: string): Promise<PierHost | null> {
  return (await findPierHost(db, waveId)) ?? (await findSharedPier(db))?.host ?? null;
}

const RANDOM_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

/**
 * A random label for a wave's zone under the shared pier domain: eight
 * characters, a letter first, never `??--`. Random rather than the wave's name
 * because names are neither unique nor fixed, and because the label stands in
 * the CT logs for good -- it should not say whose wave it is.
 */
export function randomPierName(): string {
  for (;;) {
    let name = RANDOM_ALPHABET[randomInt(26)] as string;
    while (name.length < 8) name += RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)];
    if (name.slice(2, 4) !== "--") return name;
  }
}

/**
 * The wave's random label, given on first need and then kept. Taken under the
 * unique index: two waves that drew the same label do not both get it, the
 * loser draws again.
 */
export async function ensureSharedPierName(db: Database, waveId: string): Promise<string | null> {
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await db
      .select({ name: waves.sharedPierName })
      .from(waves)
      .where(eq(waves.id, waveId))
      .limit(1);
    if (!rows[0]) return null;
    if (rows[0].name) return rows[0].name;
    try {
      await db
        .update(waves)
        .set({ sharedPierName: randomPierName() })
        .where(and(eq(waves.id, waveId), isNull(waves.sharedPierName)));
    } catch {
      // The unique index refused a label another wave holds; draw again.
    }
  }
  throw new Error("could not find a free label for the shared pier zone");
}

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
  input: { waveId: string; nodeId: string; name: string; port: number; sharedDomain?: string },
): Promise<SetPierResult> {
  // Drawing the random label can lose to another wave under the unique index,
  // which aborts the transaction; the second draw is all but certain to win.
  for (let attempt = 0; ; attempt++) {
    try {
      return await setPierOnce(db, input);
    } catch (error) {
      if (attempt >= 2 || !isUniqueViolation(error)) throw error;
    }
  }
}

const isUniqueViolation = (error: unknown): boolean =>
  /shared_pier_name|23505|unique/i.test(error instanceof Error ? error.message : String(error));

async function setPierOnce(
  db: Database,
  input: { waveId: string; nodeId: string; name: string; port: number; sharedDomain?: string },
): Promise<SetPierResult> {
  return db.transaction(async (tx) => {
    const waveRows = await tx.select().from(waves).where(eq(waves.id, input.waveId)).limit(1).for("update");
    let wave = waveRows[0];
    if (!wave) return { error: "the wave is gone", status: 404 };

    const siblings = await tx.select().from(nodes).where(eq(nodes.waveId, input.waveId));
    const self = siblings.find((node) => node.id === input.nodeId);
    if (!self) return { error: "unknown node", status: 404 };

    // The operator's lock comes first: a device that may not hear a different
    // answer for a name that is taken than for one that is free.
    if (!self.pierAllowed) {
      return {
        error: `the pier is not allowed for ${self.hostname}; an owner or admin of the wave allows it (or an operator with \`admin.ts allow-pier\`)`,
        status: 403,
      };
    }

    const own = siblings.map(toPierHost).find((entry): entry is PierHost => entry !== null);
    const shared = own ? null : await findSharedPier(tx as unknown as Database);
    const host = own ?? shared?.host;
    if (!host) {
      return {
        error: "this wave has no pier; an operator sets one with `admin.ts set-pier`",
        status: 409,
      };
    }

    // The shared zone's random label, on first need -- the one moment that
    // decides the zone, so it is given here and not by whoever asks first.
    if (!own && wave.pierZoneMode !== "own" && input.sharedDomain && !wave.sharedPierName) {
      const name = randomPierName();
      await tx.update(waves).set({ sharedPierName: name }).where(eq(waves.id, input.waveId));
      wave = { ...wave, sharedPierName: name };
    }

    // Only the pier zone, and only one label inside it -- a name from
    // elsewhere would be a route for a name the wildcard does not cover.
    const zone = pierZone(wave, input.sharedDomain);
    const label = pierLabel(input.name, zone);
    if (!label) return { error: `${input.name} is not a name under ${zone}`, status: 400 };
    if (!usesSharedZone(wave, input.sharedDomain) && !isPublicSuffix(wave.dnsSuffix)) {
      return {
        error: `${wave.dnsSuffix} is a placeholder domain and cannot be reached from the open network; give the wave a domain of its own first`,
        status: 409,
      };
    }

    // Through the shared pier, one wave per machine: the pier is one address,
    // and a machine that put names out in two waves would route it on two
    // interfaces -- the client refuses the second wave for exactly that.
    if (host.shared) {
      const elsewhere = await tx
        .select({ waveName: waves.name })
        .from(wavePiers)
        .innerJoin(nodes, eq(nodes.id, wavePiers.nodeId))
        .innerJoin(waves, eq(waves.id, wavePiers.waveId))
        .where(and(eq(nodes.machineKey, self.machineKey), ne(wavePiers.waveId, input.waveId)))
        .limit(1);
      if (elsewhere[0]) {
        return {
          error: `this machine already puts names out through the shared pier in the wave ${elsewhere[0].waveName}; a machine can do that in one wave only`,
          status: 409,
        };
      }
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
    return { pier: row, host, dnsName: fqdn, zone, changed };
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

    const target = await tx
      .select({ sharedPier: nodes.sharedPier })
      .from(nodes)
      .where(and(eq(nodes.waveId, input.waveId), eq(nodes.id, input.nodeId)))
      .limit(1);
    if (target[0]?.sharedPier) {
      return { conflict: "this node is the shared pier; `admin.ts clear-shared-pier` it first" };
    }

    // A wave with a pier of its own serves its own zone. Names it put out
    // through the shared pier hang under the other one, so they go first.
    if (wave.pierZoneMode !== "own") {
      const held = await tx
        .select({ name: wavePiers.name })
        .from(wavePiers)
        .where(eq(wavePiers.waveId, input.waveId))
        .limit(1);
      if (held[0]) {
        return {
          conflict:
            "names are put out through the shared pier in this wave; remove them before it gets a pier of its own",
        };
      }
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
      .set({
        netmapVersion: sql`${waves.netmapVersion} + 1`,
        pierZoneMode: "own",
        ...(moving ? { pierLabel: label } : {}),
      })
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

/**
 * What a device that puts names out through the *shared* pier lets in, with or
 * without a policy.
 *
 * The shared pier is a peer of the device without being in its wave, so a
 * netmap without a filter -- "no policy, everything in" -- would let it reach
 * every port. The device therefore always gets a filter: everything from its
 * own wave's blocks to itself and the services it fronts (which is what "no
 * policy" means for the members), and from the pier only the claimed ports.
 * Under a policy the caller adds the policy's own rules instead of the first.
 */
export function waveWideFilter(
  wave: { ipv4Prefix: string; ipv6Prefix: string },
  destinations: string[],
): FilterRule {
  return {
    src: [wave.ipv4Prefix, wave.ipv6Prefix],
    dst: destinations,
    ports: [{ proto: "any", from: 1, to: 65535 }],
  };
}

/**
 * The waves whose names go out through the shared pier: every wave but the
 * pier's own that has no pier of its own and holds at least one name. Their
 * netmaps and the pier's depend on each other.
 */
export async function wavesOnSharedPier(db: Database, hostingWaveId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ waveId: wavePiers.waveId })
    .from(wavePiers)
    .where(
      and(
        ne(wavePiers.waveId, hostingWaveId),
        sql`not exists (select 1 from ${nodes} where ${nodes.waveId} = ${wavePiers.waveId} and (${nodes.pierIpv4} is not null or ${nodes.pierIpv6} is not null))`,
      ),
    )
    .orderBy(asc(wavePiers.waveId));
  return rows.map((row) => row.waveId);
}

/**
 * Whether a wave puts names out through the shared pier, and if so the
 * pier's wave -- the one other wave its netmaps depend on.
 */
export async function sharedPierLink(
  db: Database,
  waveId: string,
): Promise<{ hostingWaveId: string; pier: SharedPier } | null> {
  const pier = await findSharedPier(db);
  if (!pier || pier.waveId === waveId) return null;
  if (await findPierHost(db, waveId)) return null;
  const held = await db
    .select({ id: wavePiers.id })
    .from(wavePiers)
    .where(eq(wavePiers.waveId, waveId))
    .limit(1);
  return held[0] ? { hostingWaveId: pier.waveId, pier } : null;
}

export type SetSharedPierResult =
  | { host: PierHost; previous: PierHost | null }
  | { conflict: string }
  | { invalid: string };

/**
 * Makes one node the shared pier of the server, at the public addresses the
 * world reaches it at. The node lives in a wave of its own (the hosting wave);
 * moving the shared pier to another node clears the old one in the same
 * transaction, so there is never a moment with two.
 */
export async function setSharedPierHost(
  db: Database,
  input: { waveId: string; nodeId: string; ipv4?: string; ipv6?: string },
): Promise<SetSharedPierResult> {
  if (input.ipv4 === undefined && input.ipv6 === undefined) {
    return { invalid: "a pier needs a public address, IPv4 or IPv6 or both" };
  }
  if (input.ipv4 !== undefined && isIP(input.ipv4) !== 4)
    return { invalid: `${input.ipv4} is not an IPv4 address` };
  if (input.ipv6 !== undefined && isIP(input.ipv6) !== 6)
    return { invalid: `${input.ipv6} is not an IPv6 address` };

  return db.transaction(async (tx) => {
    await tx.select({ id: waves.id }).from(waves).where(eq(waves.id, input.waveId)).limit(1).for("update");
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
      return { conflict: `${other[0].hostname} is the pier of this wave; \`admin.ts clear-pier\` it first` };
    }
    const held = await tx
      .select({ id: wavePiers.id })
      .from(wavePiers)
      .where(eq(wavePiers.waveId, input.waveId))
      .limit(1);
    if (held[0]) {
      return { conflict: "this wave holds names of its own; the shared pier needs a wave to itself" };
    }

    const before = await tx.select().from(nodes).where(eq(nodes.sharedPier, true)).limit(1);
    const previous = before[0] ? toPierHost(before[0]) : null;
    if (before[0] && before[0].id !== input.nodeId) {
      await tx
        .update(nodes)
        .set({ sharedPier: false, pierIpv4: null, pierIpv6: null })
        .where(eq(nodes.id, before[0].id));
      await bumpNetmap(tx as unknown as Database, before[0].waveId);
    }
    const updated = await tx
      .update(nodes)
      .set({ sharedPier: true, pierIpv4: input.ipv4 ?? null, pierIpv6: input.ipv6 ?? null })
      .where(and(eq(nodes.waveId, input.waveId), eq(nodes.id, input.nodeId)))
      .returning();
    const host = updated[0] ? toPierHost(updated[0]) : null;
    if (!host) return { invalid: "unknown node" };
    await bumpNetmap(tx as unknown as Database, input.waveId);
    return { host, previous };
  });
}

/** Ends the shared pier; the names stay and wait for a new one. */
export async function clearSharedPierHost(db: Database): Promise<SharedPier | null> {
  const before = await findSharedPier(db);
  if (!before) return null;
  await db
    .update(nodes)
    .set({ sharedPier: false, pierIpv4: null, pierIpv6: null })
    .where(eq(nodes.id, before.node.id));
  await bumpNetmap(db, before.waveId);
  return before;
}

export type SetZoneModeResult =
  | { mode: "shared" | "own"; changed: boolean; previousZone: string; zone: string }
  | PierRefusal;

/**
 * Which zone a wave's names take under the shared pier: the random one under
 * the shared pier domain, or `pier.<own domain>`. Only while the wave holds no
 * name -- every name and every certificate hangs under the zone it was given
 * in -- and `own` only for a domain the open network can resolve.
 */
export async function setPierZoneMode(
  db: Database,
  input: { waveId: string; mode: "shared" | "own"; sharedDomain?: string },
): Promise<SetZoneModeResult> {
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(waves).where(eq(waves.id, input.waveId)).limit(1).for("update");
    const wave = rows[0];
    if (!wave) return { error: "the wave is gone", status: 404 };
    const previousZone = pierZone(wave, input.sharedDomain);
    if (wave.pierZoneMode === input.mode) {
      return { mode: input.mode, changed: false, previousZone, zone: previousZone };
    }
    if (input.mode === "shared") {
      if (!input.sharedDomain) {
        return { error: "this server has no shared pier domain (WAVE_SHARED_PIER_DOMAIN)", status: 409 };
      }
      const own = await tx
        .select({ id: nodes.id })
        .from(nodes)
        .where(
          and(
            eq(nodes.waveId, input.waveId),
            eq(nodes.sharedPier, false),
            or(isNotNull(nodes.pierIpv4), isNotNull(nodes.pierIpv6)),
          ),
        )
        .limit(1);
      if (own[0]) return { error: "this wave has a pier of its own, which serves its own zone", status: 409 };
    }
    if (input.mode === "own" && !isPublicSuffix(wave.dnsSuffix)) {
      return {
        error: `${wave.dnsSuffix} is a placeholder domain and cannot be reached from the open network; give the wave a domain of its own first`,
        status: 409,
      };
    }
    const held = await tx
      .select({ name: wavePiers.name })
      .from(wavePiers)
      .where(eq(wavePiers.waveId, input.waveId))
      .limit(1);
    if (held[0]) {
      return {
        error: `names are put out under ${previousZone}; remove them before the zone moves`,
        status: 409,
      };
    }
    const next = { ...wave, pierZoneMode: input.mode };
    await tx
      .update(waves)
      .set({ pierZoneMode: input.mode, netmapVersion: sql`${waves.netmapVersion} + 1` })
      .where(eq(waves.id, input.waveId));
    return { mode: input.mode, changed: true, previousZone, zone: pierZone(next, input.sharedDomain) };
  });
}
