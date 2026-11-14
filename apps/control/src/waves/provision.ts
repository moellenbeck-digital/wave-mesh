import { asc, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { nodes, users, waveBilling, waveMembers, wavePiers, waves } from "../db/schema.ts";
import { newId } from "../ids.ts";
import { allocatePrefix, ContainerFullError, freeBlocks } from "../net/addressing.ts";
import { invitesFor } from "./invites.ts";
import { type FoundWave, isAmbiguous, resolveWave } from "./lookup.ts";
import { findPierHost, pierZone } from "./piers.ts";

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
 * /16 for a **billed** wave: 65 534 nodes in a wave, 64 waves on a server.
 * Changing it for existing waves means renumbering them, which is not done;
 * what grows the number of waves is the smaller block of the free ones
 * (WAVE_FREE_IPV4_PREFIX_LENGTH, a /24 by default: 16 384 free waves of 253
 * devices in the default container). The allocator numbers the two sizes from
 * opposite ends of the container so the small ones do not break up the /16s
 * (see `allocatePrefix`). Billed waves keep this length whatever the free ones
 * use.
 */
export const IPV4_PREFIX_LENGTH = 16;

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

/** A suffix under the placeholder: not delegable, so no CA can ever validate a name in it. */
export const isPlaceholderSuffix = (suffix: string): boolean =>
  suffix === DEFAULT_DNS_BASE || suffix.endsWith(`.${DEFAULT_DNS_BASE}`);

/** A domain name: at least two labels, no scheme, no trailing dot. */
const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/**
 * A name or domain that cannot be stored. Its own class, so a page can say it
 * in the reader's language from `kind` and `input` instead of passing on an
 * English message -- the message stays what the shell and the log have always
 * read.
 */
export class InvalidInputError extends Error {
  constructor(
    readonly kind: "domain" | "wave-name",
    readonly input: string,
  ) {
    super(kind === "domain" ? `not a domain name: ${input}` : `not a wave name: ${input}`);
    this.name = "InvalidInputError";
  }
}

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
    throw new InvalidInputError("domain", input);
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
  if (!name || !/^[a-z]/.test(name)) throw new InvalidInputError("wave-name", input);
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
  | { state: "needed" }
  | { state: "closed" };

/**
 * Whether the **shell** may make a wave for someone without being asked to:
 * `wave-admin set-password`, which has no browser to ask for a domain.
 *
 * Not where waves are sold. There a placeholder wave would be a wave nobody
 * paid for -- the person removed from a booked seat could get one with a new
 * password. Whether a *person* may create a wave in the browser is decided per
 * user, in one place, by `waveCreationDenial()` (billing/free-account.ts, ticket
 * #117): a confirmed user may, up to the free limits of their account.
 * `wave-admin create-wave` is the explicit operator way and stays.
 */
export const mayCreateWaves = (config: { billing?: unknown }): boolean => !config.billing;

/**
 * The address comes from the session, so this costs no lookup of its own.
 * `closed` is `needed` on a server where nobody can create one: the form has
 * nothing to offer then, only the reason.
 */
export async function waveSetup(
  db: Database,
  userId: string,
  email: string | null,
  canCreate = true,
): Promise<WaveSetup> {
  const member = await db
    .select({ waveId: waveMembers.waveId })
    .from(waveMembers)
    .where(eq(waveMembers.userId, userId))
    .limit(1);

  const existing = member[0];
  if (existing) return { state: "ready", waveId: existing.waveId };

  const waiting = (await invitesFor(db, email))[0];
  if (waiting) return { state: "invited", wave: waiting.waveName };
  return canCreate ? { state: "needed" } : { state: "closed" };
}

/** A refusal the person who typed it can fix, as opposed to a thrown error. */
export type WaveCreation = { waveId: string } | { conflict: "suffix" };

/**
 * How much of the container must stay free for billed waves: `blocks` whole
 * /16s after the new wave is numbered. `enforce` refuses the wave that would
 * go below it (a free sign-up); without it the wave is made and a warning
 * goes to the log (a customer who has paid, the operator's shell).
 */
export interface CapacityReserve {
  blocks: number;
  enforce: boolean;
}

/** The container is not full, but what is left is held back for billed waves. */
export class CapacityReserveError extends ContainerFullError {
  constructor(message: string) {
    super(message);
    this.name = "CapacityReserveError";
  }
}

/** One lock for every numbering of a wave: see `createWave`. */
const PREFIX_LOCK = "wave-ipv4-prefix-allocation";

/**
 * Creates a wave with the name and DNS suffix its owner chose.
 *
 * The suffix is what every node name in the wave hangs under, so it is asked
 * for here rather than assigned: a wave that will ever need a certificate has
 * to sit under a publicly registered domain (D6/D7), and renaming a zone later
 * renames every device in it. The placeholder under `wave.internal` is only
 * the answer for someone who does not have a domain yet.
 *
 * Choosing the block and inserting the wave happen under one advisory lock,
 * taken last and held to the end of the surrounding transaction. The unique
 * index on `ipv4_prefix` only stops two identical blocks; a /24 inside a /16
 * another request has just taken is a different string and would be accepted,
 * two waves with overlapping addresses. The lock makes the second request wait
 * until the first is committed and then read its block. Ordinary Postgres and
 * PGlite both have `pg_advisory_xact_lock`. Callers already in a transaction
 * keep the lock until it ends -- that is the point, so they must not take
 * another lock afterwards that a creator may hold while waiting for this one.
 */
export async function createWave(
  db: Database,
  input: {
    userId: string;
    name: string;
    dnsSuffix: string;
    container?: string;
    accountId?: string;
    /** Block size; billed waves' /16 unless the caller says it is a free one. */
    prefixLength?: number;
    reserve?: CapacityReserve;
  },
): Promise<WaveCreation> {
  const waveId = newId("w");
  const container = input.container ?? IPV4_CONTAINER;
  const prefixLength = input.prefixLength ?? IPV4_PREFIX_LENGTH;

  // The prefix is read again on every attempt, under the lock. What the loop
  // is still for is the other conflict, a name or suffix somebody else just
  // took: the insert says so by returning nothing, and a taken suffix never
  // comes free by trying again, so the two are told apart rather than both
  // being retried into a misleading error.
  for (let attempt = 0; attempt < 5; attempt++) {
    const inserted = await db.transaction(async (tx) => {
      const t = tx as unknown as Database;
      await t.execute(sql`select pg_advisory_xact_lock(hashtext(${PREFIX_LOCK}))`);
      const made = await t
        .insert(waves)
        .values({
          id: waveId,
          name: input.name,
          dnsSuffix: input.dnsSuffix,
          ownerUserId: input.userId,
          // Only a billed wave has a customer account; a self-hosted one never does.
          ...(input.accountId ? { accountId: input.accountId } : {}),
          ipv4Prefix: await allocateWavePrefix(t, container, prefixLength, input.reserve),
          ipv6Prefix: randomIpv6Prefix(),
        })
        .onConflictDoNothing()
        .returning({ id: waves.id });
      if (made[0]) {
        await t.insert(waveMembers).values({ waveId, userId: input.userId, role: "owner" });
      }
      return made[0];
    });

    if (inserted) return { waveId };
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

/**
 * A block of the given size no wave overlaps, and -- when asked -- whether
 * enough whole /16s stay free behind it. Called with the prefix lock held.
 */
async function allocateWavePrefix(
  db: Database,
  container: string,
  prefixLength: number,
  reserve?: CapacityReserve,
): Promise<string> {
  const held = (await db.select({ prefix: waves.ipv4Prefix }).from(waves)).map((row) => row.prefix);
  const prefix = allocatePrefix(container, prefixLength, held);
  if (!reserve || reserve.blocks <= 0) return prefix;

  const left = freeBlocks(container, IPV4_PREFIX_LENGTH, [...held, prefix]);
  // A container smaller than one billed block has nothing to reserve.
  if (left >= reserve.blocks || freeBlocks(container, IPV4_PREFIX_LENGTH, []) === 0) return prefix;

  const detail = `${left} whole /${IPV4_PREFIX_LENGTH} blocks of ${container} would be left after ${prefix}, the reserve is ${reserve.blocks}`;
  console.warn(`waves: capacity below reserve: ${detail}`);
  if (reserve.enforce) throw new CapacityReserveError(`address reserve reached: ${detail}`);
  return prefix;
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
): Promise<
  | { id: string; name: string }
  | { ambiguous: FoundWave[] }
  | { conflict: "suffix" }
  | { conflict: "piers"; names: string[] }
  | { conflict: "pier"; hostname: string; zone: string }
  | null
> {
  const normalized = normaliseDnsSuffix(domain);

  const found = await resolveWave(db, selector);
  if (found === null || isAmbiguous(found)) return found;
  if (found.dnsSuffix === normalized) return { id: found.id, name: found.name };

  // A name put out through the pier (D12) lives in the pier zone under the
  // suffix, with a certificate on the old one, and the pier itself has a
  // wildcard record there. Moving the zone would leave all of it behind, so
  // the names go first -- the owner removes them with `wave expose --remove`,
  // or an operator with `deny-pier` -- and then the pier, with `clear-pier`.
  const waveRows = await db.select().from(waves).where(eq(waves.id, found.id)).limit(1);
  const zone = waveRows[0] ? pierZone(waveRows[0]) : found.dnsSuffix;
  const held = await db
    .select({ name: wavePiers.name })
    .from(wavePiers)
    .where(eq(wavePiers.waveId, found.id))
    .orderBy(asc(wavePiers.name));
  if (held.length > 0) {
    return { conflict: "piers", names: held.map((row) => `${row.name}.${zone}`) };
  }
  const pier = await findPierHost(db, found.id);
  if (pier) return { conflict: "pier", hostname: pier.hostname, zone };

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
    // The billing row before the wave: the order invitations and the sweep
    // take them in (billing/seats.ts, billing/subscriptions.ts). The cascade
    // below would otherwise reach for it while holding the wave, and an
    // invitation created at the same moment holds it while reaching for the
    // wave -- each waiting for the other until Postgres kills one.
    await tx
      .select({ waveId: waveBilling.waveId })
      .from(waveBilling)
      .where(eq(waveBilling.waveId, waveId))
      .for("update");
    const found = await tx.select({ name: waves.name }).from(waves).where(eq(waves.id, waveId)).limit(1);
    const wave = found[0];
    if (!wave) return null;

    const members = await tx.select({ id: nodes.id }).from(nodes).where(eq(nodes.waveId, waveId));
    await tx.delete(waves).where(eq(waves.id, waveId));
    return { name: wave.name, nodeIds: members.map((node) => node.id) };
  });
}
