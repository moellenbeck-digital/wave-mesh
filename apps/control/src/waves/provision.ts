import { eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, users, waveMembers, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { allocatePrefix } from "../net/addressing.ts";
import { invitesFor } from "./invites.ts";
import { type FoundWave, isAmbiguous, resolveWave } from "./lookup.ts";

/**
 * Waves are carved out of this range, one block each.
 *
 * **Not** CGNAT (100.64.0.0/10), however tempting it looks. Other mesh VPNs
 * use that range, and where one runs it may not merely use it -- it can install
 * a firewall rule dropping packets from 100.64.0.0/10 that arrive on any
 * interface other than its own. A wave numbered inside it therefore carries
 * IPv4 in one direction only: the replies reach the host and are dropped before
 * anything sees them, while IPv6 keeps working because the ULAs differ. Measured, not
 * guessed -- see the note in CLAUDE.md.
 *
 * 10.64.0.0/10 instead. It can collide with a corporate 10/8, which is a real
 * cost; the difference is that a collision there is visible and avoidable by
 * setting WAVE_IPV4_CONTAINER, while the CGNAT one is enforced by software the
 * user did not configure and looks like a broken tunnel.
 *
 * A block each, rather than the whole range, because a device can be in several
 * waves at once. Two waves numbering from the bottom would both claim the same
 * address, and the client would end up with two host routes for it.
 */
export const IPV4_CONTAINER = "10.64.0.0/10";

/**
 * /16 per wave: 65 534 nodes in a wave, 64 waves on a server. Changing it later
 * means renumbering every wave but the first, so it is not a knob to turn
 * lightly -- if the number of waves ever matters more than their size, a /20
 * would give 1024 waves of 4094 nodes.
 */
const IPV4_PREFIX_LENGTH = 16;

/** Random ULA /48 per wave, so addresses stay distinct if two are ever bridged. */
function randomIpv6Prefix(): string {
  const b = crypto.getRandomValues(new Uint16Array(2));
  // Written without leading zeros, because that is how the kernel prints
  // addresses back to us and the two forms have to compare equal.
  return `fd7a:${(b[0] ?? 0).toString(16)}:${(b[1] ?? 0).toString(16)}::/48`;
}

/**
 * What a wave's names sit under when its owner names no domain of their own.
 *
 * `.internal` is reserved for exactly this (RFC 8375's sibling case): it can
 * never be delegated, so a placeholder suffix cannot one day collide with a
 * real zone. The price is that no public certificate can ever be issued for it
 * -- which is why the owner is asked for a domain at creation and can change it
 * later (D6/D7).
 */
export const DEFAULT_DNS_BASE = "wave.internal";

/** A domain name: at least two labels, no scheme, no trailing dot. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * The stored form of a suffix someone typed. Leading and trailing dots go, case
 * goes -- DNS does not distinguish it and two spellings of one zone would be
 * two waves as far as the unique index is concerned.
 */
export function normaliseDnsSuffix(input: string): string {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/^\.+|\.+$/g, "");
  // 253 is the whole name; a node's own label still has to fit in front of it.
  if (normalized.length > 200 || !DOMAIN.test(normalized)) {
    throw new Error(`not a domain name: ${input}`);
  }
  return normalized;
}

function slugify(input: string | null): string {
  const slug = (input ?? "")
    .split("@")[0]
    ?.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  return slug && /^[a-z]/.test(slug) ? slug : `wave-${crypto.randomUUID().slice(0, 6)}`;
}

export interface ProvisionedWave {
  /** Null when nothing was created and nothing had to be: see `deferred`. */
  waveId: string | null;
  created: boolean;
  /** An invitation is waiting for this address, so no own wave was made. */
  deferred: boolean;
}

/** What the create form starts with, so neither field is ever empty. */
export interface WaveSuggestion {
  name: string;
  dnsSuffix: string;
}

export const suggestWave = (nameHint: string | null): WaveSuggestion => {
  const name = slugify(nameHint);
  return { name, dnsSuffix: `${name}.${DEFAULT_DNS_BASE}` };
};

/**
 * A wave's own name. It stays a slug because it is also a selector: `admin.ts`
 * resolves a wave by name, and `resolveWave()` naming two matches instead of
 * guessing is only useful if the name is something one can type back.
 */
export function normaliseWaveName(input: string): string {
  const name = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!name || !/^[a-z]/.test(name)) throw new Error(`not a wave name: ${input}`);
  return name;
}

/**
 * Where an account stands before any device can join: it has a wave, or an
 * invitation is waiting for it, or it has to make one.
 *
 * One function because three places ask the same question -- the login
 * redirect, `/api/me` and the create page -- and an answer that differed
 * between them would send someone to a form they do not need.
 */
export type WaveSetup =
  | { state: "ready"; waveId: string }
  | { state: "invited"; wave: string }
  | { state: "needed" };

/** The address comes from the session, so this costs no lookup of its own. */
export async function waveSetup(db: Database, userId: string, email: string | null): Promise<WaveSetup> {
  const member = await db
    .select({ waveId: waveMembers.waveId })
    .from(waveMembers)
    .where(eq(waveMembers.userId, userId))
    .limit(1);

  const existing = member[0];
  if (existing) return { state: "ready", waveId: existing.waveId };

  const waiting = (await invitesFor(db, email))[0];
  if (waiting) return { state: "invited", wave: waiting.waveName };
  return { state: "needed" };
}

/** A refusal the person who typed it can fix, as opposed to a thrown error. */
export type WaveCreation = { waveId: string } | { conflict: "suffix" };

/**
 * Creates a wave with the name and DNS suffix its owner chose.
 *
 * The suffix is what every node name in the wave hangs under, so it is asked
 * for here rather than assigned: a wave that will ever need a certificate has
 * to sit under a publicly registered domain (D6/D7), and renaming a zone later
 * renames every device in it. The placeholder under `wave.internal` is only
 * the answer for someone who does not have a domain yet.
 */
export async function createWave(
  db: Database,
  input: { userId: string; name: string; dnsSuffix: string; container?: string },
): Promise<WaveCreation> {
  const waveId = newId("w");
  const container = input.container ?? IPV4_CONTAINER;

  // The prefix is re-read on every attempt: two waves created at once would
  // otherwise pick the same free block, and the unique index -- not the query
  // -- is what settles it. That race is worth retrying; a taken suffix is not,
  // because it never comes free by trying again. So the two are told apart
  // rather than both being retried into a misleading error.
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await db
      .insert(waves)
      .values({
        id: waveId,
        name: input.name,
        dnsSuffix: input.dnsSuffix,
        ownerUserId: input.userId,
        ipv4Prefix: await allocateWavePrefix(db, container),
        ipv6Prefix: randomIpv6Prefix(),
      })
      .onConflictDoNothing()
      .returning({ id: waves.id });

    if (inserted[0]) {
      await db.insert(waveMembers).values({ waveId, userId: input.userId, role: "owner" });
      return { waveId };
    }
    if (await suffixTaken(db, input.dnsSuffix)) return { conflict: "suffix" };
  }
  throw new Error(`could not allocate a prefix for ${input.name} in ${container}`);
}

const suffixTaken = async (db: Database, suffix: string): Promise<boolean> =>
  (await db.select({ id: waves.id }).from(waves).where(eq(waves.dnsSuffix, suffix)).limit(1)).length > 0;

/**
 * Returns the user's wave, creating one under the placeholder domain if there
 * is none.
 *
 * This is the path without a browser -- `admin.ts set-password` -- where
 * nobody can be asked for a domain. Where there *is* a browser, the wave is
 * made by its owner on the create page, with the suffix they chose.
 *
 * It does **not** create one when an invitation is waiting for this address.
 * Otherwise the order of two clicks would decide the outcome: someone invited
 * into a colleague's wave whose account is set up before they open the link
 * would end up with a wave of their own as well, and their next device would
 * have to be told which of the two it belongs to -- for a wave nobody asked
 * for.
 */
export async function ensureWaveForUser(
  db: Database,
  userId: string,
  nameHint: string | null,
  container: string = IPV4_CONTAINER,
): Promise<ProvisionedWave> {
  const member = await db
    .select({ waveId: waveMembers.waveId })
    .from(waveMembers)
    .where(eq(waveMembers.userId, userId))
    .limit(1);

  const existing = member[0];
  if (existing) return { waveId: existing.waveId, created: false, deferred: false };

  const account = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  const invited = await invitesFor(db, account[0]?.email ?? null);
  if (invited.length > 0) return { waveId: null, created: false, deferred: true };

  // Two users named robin@... collide on the suffix, so retry with a random
  // discriminator rather than refusing an account its network.
  const base = slugify(nameHint);
  for (let attempt = 0; attempt < 5; attempt++) {
    const name = attempt === 0 ? base : `${base}-${crypto.randomUUID().slice(0, 4)}`;
    const created = await createWave(db, {
      userId,
      name,
      dnsSuffix: `${name}.${DEFAULT_DNS_BASE}`,
      container,
    });
    if ("waveId" in created) return { waveId: created.waveId, created: true, deferred: false };
  }
  throw new Error("could not allocate a unique wave name");
}

/** The lowest block of the given range no wave holds yet. */
async function allocateWavePrefix(db: Database, container: string): Promise<string> {
  const held = await db.select({ prefix: waves.ipv4Prefix }).from(waves);
  return allocatePrefix(
    container,
    IPV4_PREFIX_LENGTH,
    held.map((row) => row.prefix),
  );
}

/**
 * Points a wave's names at a domain the owner controls. The placeholder suffix
 * a wave starts with cannot carry public certificates, so this is the step
 * before any of that becomes possible.
 */
export async function setWaveDomain(
  db: Database,
  selector: string,
  domain: string,
): Promise<{ id: string; name: string } | { ambiguous: FoundWave[] } | { conflict: "suffix" } | null> {
  const normalized = normaliseDnsSuffix(domain);

  const found = await resolveWave(db, selector);
  if (found === null || isAmbiguous(found)) return found;
  if (found.dnsSuffix === normalized) return { id: found.id, name: found.name };

  // Asked before writing, because the unique index answers with an exception
  // that no caller can tell from a database being down.
  if (await suffixTaken(db, normalized)) return { conflict: "suffix" };

  // Every node name in the wave hangs under this, so the netmap every device
  // holds is stale the moment it changes -- the version bump is what makes
  // them fetch a new one.
  await db
    .update(waves)
    .set({ dnsSuffix: normalized, netmapVersion: sql`${waves.netmapVersion} + 1` })
    .where(eq(waves.id, found.id));
  return { id: found.id, name: found.name };
}

/**
 * Renames a wave.
 *
 * Cheap, unlike the suffix: the name is a label for people. It is in no netmap,
 * on no certificate and in no device's configuration, so nothing has to be
 * pushed and no version is bumped -- a device never learns it and never needs
 * to. What it *is* is a selector on the shell, which is why it stays a slug
 * even when a person types it.
 *
 * Two waves may share a name; `resolveWave()` names both rather than guessing,
 * and refusing the second here would be a rule nobody could see coming.
 */
export async function renameWave(
  db: Database,
  selector: string,
  name: string,
): Promise<{ id: string; name: string } | { ambiguous: FoundWave[] } | null> {
  const normalized = normaliseWaveName(name);

  const found = await resolveWave(db, selector);
  if (found === null || isAmbiguous(found)) return found;
  if (found.name === normalized) return { id: found.id, name: normalized };

  await db.update(waves).set({ name: normalized }).where(eq(waves.id, found.id));
  return { id: found.id, name: normalized };
}

export interface DeletedWave {
  name: string;
  /** The devices that were in it, so their connections can be cut. */
  nodeIds: string[];
}

/**
 * Takes a whole wave away, with its devices, members and open invitations.
 *
 * One statement does all of it: wave_members, wave_invites and nodes all
 * reference the wave with `on delete cascade`, and taking them out by hand
 * first would only be a second place for the list to go out of date. What the
 * database cannot do is tell the devices, so the node ids are read out before
 * the delete and handed back -- their control connections are still open, and
 * a socket left up would keep answering heartbeats for a wave that no longer
 * exists.
 *
 * There is nothing to bump afterwards and nobody to push to. A netmap belongs
 * to a wave, and this one is gone; the nodes are told by being cut off.
 */
export async function deleteWave(db: Database, waveId: string): Promise<DeletedWave | null> {
  return db.transaction(async (tx) => {
    const found = await tx.select({ name: waves.name }).from(waves).where(eq(waves.id, waveId)).limit(1);
    const wave = found[0];
    if (!wave) return null;

    const members = await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.waveId, waveId));
    await tx.delete(waves).where(eq(waves.id, waveId));
    return { name: wave.name, nodeIds: members.map((node) => node.id) };
  });
}
