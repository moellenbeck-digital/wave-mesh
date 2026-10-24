#!/usr/bin/env bun
/**
 * Operator commands. Accounts are created here rather than through a signup
 * page, so a publicly reachable server is not a place where anyone can make
 * themselves a user.
 *
 *   bun src/admin.ts set-password <email>
 *
 * A <wave> is named by its name, its id or the address of its owner -- an
 * ambiguous name is reported, never guessed.
 */
import { basename } from "node:path";
import { systemLocale } from "@wave/i18n/system";
import { and, desc, eq } from "drizzle-orm";
import { describeEnforcement, describeReach, enforcementText } from "./acl/describe.ts";
import { compilePolicy } from "./acl/evaluate.ts";
import { aclSubjects, getPolicy, invalidTags, removePolicy, setPolicy, setTags } from "./acl/store.ts";
import { checkPolicy } from "./acl/validate.ts";
import { adminMessages } from "./admin-messages.ts";
import { audit, listAudit, shellActor } from "./audit.ts";
import { setPassword } from "./auth/password.ts";
import { disableTwoFactor, hasTwoFactor } from "./auth/two-factor.ts";
import { ensureSeatFor, SeatLimitError } from "./billing/seats.ts";
import { billingStateOf } from "./billing/subscriptions.ts";
import { createDb } from "./db/client.ts";
import { certificateOrders, nodes, users, waveMembers } from "./db/schema.ts";
import {
  buildProvider,
  findDnsCredential,
  removeDnsCredential,
  storeDnsCredential,
  verifyZoneAccess,
} from "./dns/credentials.ts";
import { type AutomaticKind, isAutomaticKind, isProviderKind, PROVIDER_KINDS } from "./dns/provider.ts";
import { loadConfig } from "./env.ts";
import { createAuthKey, listAuthKeys, revokeAuthKey } from "./waves/auth-keys.ts";
import { createInvite, listInvites, looksLikeEmail, normaliseEmail, revokeInvite } from "./waves/invites.ts";
import { type FoundWave, isAmbiguous, resolveWave } from "./waves/lookup.ts";
import { addMember, listMembers, removeMember } from "./waves/members.ts";
import { findNode, listNodes, removeNode, setWildcardAllowed } from "./waves/nodes.ts";
import {
  createWave,
  DEFAULT_DNS_BASE,
  deleteWave,
  ensureWaveForUser,
  mayCreateWaves,
  normaliseDnsSuffix,
  normaliseWaveName,
  setWaveDomain,
} from "./waves/provision.ts";
import { listServices, removeService, serviceUrl } from "./waves/services.ts";

/**
 * The operator reads in the language of this machine (WAVE_LANG, then the
 * locale variables), not of any browser: there is none. Only what is said to
 * the person changes -- commands, flags and the audit entries stay as they are.
 */
const locale = systemLocale();
const m = adminMessages(locale);

/**
 * Reads one visible line, or the whole of a pipe when there is no terminal.
 *
 * Visible because it is not a secret: what it asks for is the wave's own name,
 * typed back, and a confirmation nobody can read is one people answer blind.
 */
async function readLine(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const piped = await new Response(Bun.stdin.stream()).text();
    return piped.trim();
  }
  process.stdout.write(prompt);
  process.stdin.resume();
  return new Promise((resolve) => {
    const onData = (chunk: Buffer): void => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolve(chunk.toString("utf8").trim());
    };
    process.stdin.on("data", onData);
  });
}

/** Reads a password without echoing it, or from a pipe when there is no terminal. */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const piped = await new Response(Bun.stdin.stream()).text();
    return piped.trim();
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  return new Promise((resolve) => {
    let value = "";
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) {
          process.stdout.write("\n");
          process.exit(130);
        }
        if (byte === 13 || byte === 10) {
          process.stdin.off("data", onData);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdout.write("\n");
          resolve(value);
          return;
        }
        if (byte === 127 || byte === 8) {
          value = value.slice(0, -1);
          continue;
        }
        value += String.fromCharCode(byte);
      }
    };
    process.stdin.on("data", onData);
  });
}

/**
 * The credential for one provider, in whatever shape that provider has.
 *
 * Three of them have a token and one has an account, so this cannot be a
 * single prompt. Down a pipe it is always one read -- `readSecret` drains
 * stdin, so INWX cannot be asked in three parts there and takes its JSON whole.
 */
async function readCredential(kind: AutomaticKind, suffix: string): Promise<string> {
  if (kind === "ionos") return readSecret(m.ionosPrompt(suffix));
  if (kind !== "inwx") return readSecret(m.tokenPrompt(kind, suffix));

  if (!process.stdin.isTTY) return readSecret("");
  console.log(m.inwxIntro(suffix));
  console.log(m.inwxScope);
  const user = await readLine(m.inwxUser);
  const password = await readSecret(m.inwxPassword);
  const totpSecret = await readSecret(m.inwxTotp);
  return JSON.stringify({ user, password, ...(totpSecret ? { totpSecret } : {}) });
}

const COMMANDS = [
  "set-password",
  "disable-2fa",
  "create-wave",
  "set-domain",
  "members",
  "add-member",
  "remove-member",
  "invite",
  "revoke-invite",
  "devices",
  "remove-device",
  "delete-wave",
  "services",
  "remove-service",
  "auth-key",
  "auth-keys",
  "revoke-auth-key",
  "allow-wildcard",
  "deny-wildcard",
  "set-dns-provider",
  "dns-provider",
  "remove-dns-provider",
  "certs",
  "acl",
  "set-acl",
  "remove-acl",
  "tag",
  "untag",
  "audit",
] as const;

/**
 * The commands that change a wave, and so leave an entry in its audit log.
 * Recorded in one place, when the command has succeeded -- the next command
 * added cannot forget it. `delete-wave` is not here: its log goes with it.
 */
const CHANGES = new Set([
  "create-wave",
  "set-domain",
  "add-member",
  "remove-member",
  "invite",
  "revoke-invite",
  "remove-device",
  "remove-service",
  "auth-key",
  "revoke-auth-key",
  "allow-wildcard",
  "deny-wildcard",
  "set-dns-provider",
  "remove-dns-provider",
  "set-acl",
  "remove-acl",
  "tag",
  "untag",
]);

/**
 * How this program was started, so the usage names the command that was
 * actually typed.
 *
 * Compiled into a single binary, `Bun.main` is a path inside the embedded
 * filesystem and the file on disk is `process.execPath`; run from the
 * repository it is the source file itself. Printing `bun src/admin.ts` at
 * somebody holding `wave-admin` sends them looking for a checkout.
 */
const invocation = Bun.main.endsWith(".ts") ? "bun src/admin.ts" : basename(process.execPath);

const usage = `${m.usageTitle}
  ${invocation} set-password  <email>
  ${invocation} disable-2fa   <email>
  ${invocation} create-wave   <email> <name> [domain]
  ${invocation} set-domain    <wave> <domain>
  ${invocation} members       <wave>
  ${invocation} add-member    <wave> <email> [admin|member]
  ${invocation} remove-member <wave> <email>
  ${invocation} invite        <wave> <email> [admin|member]
  ${invocation} revoke-invite <wave> <email>
  ${invocation} devices       <wave>
  ${invocation} remove-device <wave> <hostname|node-id>
  ${invocation} delete-wave   <wave>

  ${invocation} set-dns-provider    <wave> <${PROVIDER_KINDS.join("|")}>
  ${invocation} dns-provider        <wave>
  ${invocation} remove-dns-provider <wave>
  ${invocation} certs               <wave>
  ${invocation} services            <wave>
  ${invocation} remove-service      <wave> <name>
  ${invocation} auth-key            <wave> [label] [--reusable] [--days N]
  ${invocation} auth-keys           <wave>
  ${invocation} revoke-auth-key     <wave> <id>
  ${invocation} allow-wildcard      <wave> <hostname|node-id>
  ${invocation} deny-wildcard       <wave> <hostname|node-id>

  ${invocation} acl                 <wave>
  ${invocation} set-acl             <wave> <file|->
  ${invocation} remove-acl          <wave>
  ${invocation} tag                 <wave> <hostname|node-id> <tag:name>...
  ${invocation} untag               <wave> <hostname|node-id> [tag:name...]
  ${invocation} audit               <wave> [--limit N]

${m.usageNotes}`;

const [command, ...rest] = process.argv.slice(2);
if (!command || !(COMMANDS as readonly string[]).includes(command)) {
  console.error(usage);
  process.exit(1);
}

const config = loadConfig();
const { db, close } = createDb(config.databaseUrl);

/** The wave the command resolved, for the audit entry. */
let touched: FoundWave | null = null;
/** What the audit entry carries beyond the arguments, when there is more. */
let auditDetail: Record<string, unknown> | undefined;

/** Every path ends here, so the pool is never left open on an error exit. */
async function done(code: number, message?: string): Promise<never> {
  if (message) (code === 0 ? console.log : console.error)(message);
  if (code === 0 && touched && CHANGES.has(command ?? "")) {
    // The arguments after the wave, as typed: what an operator would write
    // again to repeat it. Nothing secret is ever an argument here -- the DNS
    // credential is read from the terminal.
    await audit(db, touched.id, shellActor(), {
      action: `admin.${command}`,
      target: rest.slice(1).join(" ") || null,
      ...(auditDetail ? { detail: auditDetail } : {}),
    });
  }
  await close();
  process.exit(code);
}

async function wave(selector: string | undefined): Promise<FoundWave> {
  if (!selector) return done(1, usage);
  const found = await resolveWave(db, selector);
  if (!found) return done(1, m.noWaveMatches(selector));
  if (isAmbiguous(found)) {
    const list = found.ambiguous.map((w) => m.ambiguousEntry(w.name, w.id, w.ownerEmail)).join("\n");
    return done(1, m.severalWaves(selector, list));
  }
  touched = found;
  return found;
}

/** The account behind an address, which `add-member` needs and cannot create. */
async function account(email: string): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, normaliseEmail(email)))
    .limit(1);
  return rows[0] ?? null;
}

const asRole = (value: string | undefined): "admin" | "member" => (value === "admin" ? "admin" : "member");

/**
 * One function for the whole dispatch, so that `return done(...)` ends the
 * command: at the top level TypeScript cannot see that an awaited `never`
 * stops execution, and every later line would count as reachable.
 */
async function main(): Promise<never> {
  if (command === "set-dns-provider") {
    const [selector, kind] = rest;
    if (!kind || !isProviderKind(kind)) return done(1, m.providerMustBe(PROVIDER_KINDS.join(", ")));
    const target = await wave(selector);

    // Refused before anything is asked for: `.internal` cannot be delegated,
    // so there is no zone anywhere that anybody could write this record in.
    if (target.dnsSuffix === DEFAULT_DNS_BASE || target.dnsSuffix.endsWith(`.${DEFAULT_DNS_BASE}`)) {
      return done(1, m.placeholderSuffix(target.name, target.dnsSuffix));
    }

    // The way out of needing a provider at all: the server names the record and
    // waits until it is there. Nothing is stored and nothing is verified here
    // -- creating the record *is* the proof that the zone is yours, and it
    // happens once per certificate instead of once here.
    if (!isAutomaticKind(kind)) {
      await storeDnsCredential(db, { waveId: target.id, provider: kind });
      console.log(m.manualMode(target.name));
      console.log(m.manualRecord);
      return done(0, m.manualRenewals);
    }

    if (!config.dnsSecret) {
      return done(1, m.noDnsSecret);
    }

    const token = await readCredential(kind, target.dnsSuffix);
    if (!token) return done(1, m.noCredential);

    // Tried before it is stored, and this is also the domain verification D6
    // asks for: in provider mode, being able to write the zone is the proof of
    // owning it. A credential that cannot is not one to keep.
    try {
      await verifyZoneAccess(buildProvider(kind, token), target.dnsSuffix);
    } catch (error) {
      return done(
        1,
        m.credentialCannotWrite(target.dnsSuffix, error instanceof Error ? error.message : String(error)),
      );
    }

    await storeDnsCredential(db, { waveId: target.id, provider: kind, token, key: config.dnsSecret });
    console.log(m.writesThrough(target.name, target.dnsSuffix, kind));
    return done(0, m.devicesCanAskCerts);
  }

  if (command === "services") {
    const target = await wave(rest[0]);
    const services = await listServices(db, target.id);
    const devices = await listNodes(db, target.id);

    console.log(`${target.name} (${target.dnsSuffix})`);
    for (const service of services) {
      const via = devices.find((device) => device.id === service.viaNodeId)?.hostname ?? service.viaNodeId;
      // The scheme as the browser would use it, so the shell and the web view
      // say the same thing about the same name.
      const url = serviceUrl(service.name, target.dnsSuffix, service.scheme);
      console.log(`  ${url.padEnd(48)} ${service.ipv4.padEnd(16)} ${m.via(via)}`);
    }
    if (services.length === 0) console.log(m.noServices);
    return done(0);
  }

  if (command === "remove-service") {
    const [selector, name] = rest;
    if (!name) return done(1, usage);
    const target = await wave(selector);
    const removed = await removeService(db, target.id, name.replace(`.${target.dnsSuffix}`, ""));
    // The cluster declares the whole set, so its operator puts this back on its
    // next round -- this is for a cluster that is gone, not one that disagrees.
    return done(
      removed ? 0 : 1,
      removed ? m.serviceRemoved(name, target.name) : m.noService(name, target.name),
    );
  }

  if (command === "auth-key") {
    const flags = rest.filter((entry) => entry.startsWith("--"));
    const [selector, label] = rest.filter((entry) => !entry.startsWith("--"));
    const target = await wave(selector);

    const owner = target.ownerEmail ? await account(target.ownerEmail) : null;
    // The devices become somebody's, and on the shell that somebody is the
    // owner -- there is no operator account to attribute them to.
    if (!owner) return done(1, m.noOwnerToEnrolFor(target.name));

    const days = Number(flags.find((flag) => flag.startsWith("--days="))?.split("=")[1] ?? 0) || undefined;
    const key = await createAuthKey(db, {
      waveId: target.id,
      userId: owner.id,
      label,
      reusable: flags.includes("--reusable"),
      days,
    });

    console.log(m.keyEnrols(target.name, key.expiresAt.toISOString()));
    console.log(m.keyShownOnce);
    console.log("");
    console.log(`  wave login ${config.baseUrl} --auth-key ${key.token}`);
    return done(0, "");
  }

  if (command === "auth-keys") {
    const target = await wave(rest[0]);
    const keys = await listAuthKeys(db, target.id);
    console.log(`${target.name} (${target.dnsSuffix})`);
    for (const key of keys) {
      const state: "revoked" | "expired" | "used" | "usable" = key.revokedAt
        ? "revoked"
        : key.expiresAt.getTime() < Date.now()
          ? "expired"
          : !key.reusable && key.uses > 0
            ? "used"
            : "usable";
      const kind = m.keyKind(key.reusable);
      console.log(
        `  ${key.id}  ${m.keyState(state).padEnd(10)} ${kind.padEnd(11)} ${m.keyDevices(key.uses)}  ${key.label ?? ""}`,
      );
    }
    if (keys.length === 0) console.log(m.noKeys);
    return done(0);
  }

  if (command === "revoke-auth-key") {
    const [selector, id] = rest;
    if (!id) return done(1, usage);
    const target = await wave(selector);
    const revoked = await revokeAuthKey(db, target.id, id);
    return done(revoked ? 0 : 1, revoked ? m.keyRevoked(id) : m.noUsableKey(id, target.name));
  }

  if (command === "allow-wildcard" || command === "deny-wildcard") {
    const [selector, host] = rest;
    if (!host) return done(1, usage);
    const target = await wave(selector);
    const found = await findNode(db, target.id, host);
    if (!found) return done(1, m.noDevice(host, target.name));

    const allowed = command === "allow-wildcard";
    const updated = await setWildcardAllowed(db, target.id, found.id, allowed);
    if (!updated) return done(1, m.noDevice(host, target.name));
    if (!allowed) return done(0, m.wildcardDenied(found.hostname, target.dnsSuffix));

    // Said plainly, because it is the one grant here that reaches past the
    // device it is given to.
    console.log(m.wildcardAllowed(found.hostname, target.dnsSuffix));
    return done(0, m.wildcardWarning);
  }

  if (command === "audit") {
    const [selector, flag, value] = rest;
    const target = await wave(selector);
    const limit = flag === "--limit" ? Math.max(1, Number(value) || 50) : 50;
    const entries = await listAudit(db, target.id, limit);
    console.log(m.newestFirst(target.name, target.dnsSuffix));
    for (const entry of entries) {
      console.log(
        `  ${entry.at}  ${entry.actor.padEnd(24)} ${entry.action.padEnd(22)} ${entry.target ?? ""}`,
      );
    }
    if (entries.length === 0) console.log(m.nothingRecorded);
    return done(0);
  }

  if (command === "acl") {
    const target = await wave(rest[0]);
    const stored = await getPolicy(db, target.id);
    if (!stored) return done(0, m.noPolicy(target.name));
    const subjects = await aclSubjects(db, target.id);
    console.log(JSON.stringify(stored.document, null, 2));
    console.log(m.policyVersion(stored.version, stored.updatedAt.toISOString()));
    for (const line of describeReach(
      compilePolicy(stored.document, subjects.nodes, subjects.services),
      subjects.nodes,
      locale,
    )) {
      console.log(line);
    }
    const unenforced = describeEnforcement(subjects.nodes, locale);
    if (unenforced.length === 0) return done(0, m.everyDeviceEnforces);
    console.log(m.netmapOnly);
    for (const line of unenforced) console.log(line);
    return done(0);
  }

  if (command === "set-acl") {
    const [selector, source] = rest;
    if (!source) return done(1, usage);
    const target = await wave(selector);
    const text = source === "-" ? await Bun.stdin.text() : await Bun.file(source).text();
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      return done(1, m.notJson((error as Error).message));
    }

    const subjects = await aclSubjects(db, target.id);
    const check = checkPolicy(raw, subjects, locale);
    for (const warning of check.warnings) console.log(m.note(warning));
    if (!check.policy) return done(1, m.refused(check.errors.map((error) => `  ${error}`).join("\n")));

    const version = await setPolicy(db, target.id, check.policy, null);
    auditDetail = { version, policy: check.policy };
    console.log(m.policySet(target.name, version));
    for (const line of describeReach(
      compilePolicy(check.policy, subjects.nodes, subjects.services),
      subjects.nodes,
      locale,
    )) {
      console.log(line);
    }
    // Said, because it is the difference between the two stages of M7: who
    // may see whom is enforced by the netmap on every device already; which
    // ports is up to each device to enforce.
    return done(0, m.withinThirtySeconds);
  }

  if (command === "remove-acl") {
    const target = await wave(rest[0]);
    const removed = await removePolicy(db, target.id);
    return done(removed ? 0 : 1, removed ? m.policyRemoved(target.name) : m.hadNoPolicy(target.name));
  }

  if (command === "tag" || command === "untag") {
    const [selector, host, ...names] = rest;
    if (!host || (command === "tag" && names.length === 0)) return done(1, usage);
    const bad = invalidTags(names);
    if (bad.length > 0) return done(1, m.badTags(bad.join(", ")));
    const target = await wave(selector);
    const found = await findNode(db, target.id, host);
    if (!found) return done(1, m.noDevice(host, target.name));

    const current = (await listNodes(db, target.id)).find((device) => device.id === found.id)?.tags ?? [];
    const next =
      command === "tag"
        ? [...current, ...names]
        : names.length === 0
          ? []
          : current.filter((tag) => !names.includes(tag));
    const updated = await setTags(db, target.id, found.id, next);
    if (!updated) return done(1, m.noDevice(host, target.name));
    if (updated.tags.length === 0) return done(0, m.untagged(updated.hostname));
    // Said, because it is the part people do not expect: a tag replaces the
    // owner as far as the policy is concerned.
    console.log(`${updated.hostname}: ${updated.tags.join(" ")}`);
    return done(0, m.judgedByTags);
  }

  if (command === "dns-provider") {
    const target = await wave(rest[0]);
    const credential = await findDnsCredential(db, target.id);
    return done(
      0,
      credential
        ? m.providerSet(
            target.name,
            target.dnsSuffix,
            credential.provider,
            credential.updatedAt.toISOString(),
          )
        : m.noProvider(target.name, target.dnsSuffix),
    );
  }

  if (command === "remove-dns-provider") {
    const target = await wave(rest[0]);
    const removed = await removeDnsCredential(db, target.id);
    return done(removed ? 0 : 1, removed ? m.providerRemoved(target.name) : m.hadNoProvider(target.name));
  }

  if (command === "certs") {
    const target = await wave(rest[0]);
    const rows = await db
      .select({ order: certificateOrders, hostname: nodes.hostname })
      .from(certificateOrders)
      .innerJoin(nodes, eq(nodes.id, certificateOrders.nodeId))
      .where(eq(certificateOrders.waveId, target.id))
      .orderBy(desc(certificateOrders.createdAt));

    console.log(`${target.name} (${target.dnsSuffix})`);
    for (const row of rows) {
      const until = row.order.expiresAt
        ? m.certUntil(row.order.expiresAt.toISOString())
        : (row.order.error ?? "");
      console.log(
        `  ${row.hostname.padEnd(20)} ${row.order.status.padEnd(8)} ${row.order.names.join(", ")}  ${until}`,
      );
      // A waiting order is one somebody has to act on, so it says what to
      // create instead of making the operator go and look for it.
      if (row.order.status !== "waiting") continue;
      for (const challenge of row.order.challenges) {
        console.log(`      TXT ${challenge.name}  ${challenge.value}`);
      }
    }
    if (rows.length === 0) console.log(m.noCertificates);
    return done(0);
  }

  if (command === "create-wave") {
    // The deliberate way to a wave, and on a server that sells them the only
    // one besides a subscription: set-password does not make one there, so a
    // new password for someone removed from a booked seat is not a free wave.
    // A wave made here has no billing row -- no seat limit, no pause, no
    // sweep -- exactly like one on a server nobody bills.
    const [email, rawName, rawDomain] = rest;
    if (!email || !rawName) return done(1, usage);
    const owner = await account(email);
    if (!owner) return done(1, m.noAccountHint(email));
    let name: string;
    let dnsSuffix: string;
    try {
      name = normaliseWaveName(rawName);
      dnsSuffix = normaliseDnsSuffix(rawDomain ?? `${name}.${DEFAULT_DNS_BASE}`);
    } catch (err) {
      return done(1, err instanceof Error ? err.message : String(err));
    }
    const created = await createWave(db, {
      userId: owner.id,
      name,
      dnsSuffix,
      container: config.ipv4Container,
    });
    if ("conflict" in created) return done(1, m.suffixTaken(dnsSuffix));
    await wave(created.waveId);
    return done(0, m.waveCreated(name, created.waveId, dnsSuffix, email));
  }

  if (command === "set-domain") {
    const [selector, domain] = rest;
    if (!domain) return done(1, usage);
    const target = await wave(selector);
    const updated = await setWaveDomain(db, target.id, domain);
    if (!updated) return done(1, m.noWaveMatches(selector ?? ""));
    if ("conflict" in updated) return done(1, m.suffixTaken(domain));
    console.log(m.namesNow(target.name, domain));
    return done(0, m.nextNetmap);
  }

  if (command === "delete-wave") {
    const target = await wave(rest[0]);
    // A booked wave goes when its subscription does: deleted here, Stripe
    // would go on charging for a wave that is gone, and the site would never
    // hear of it again.
    const billed = await billingStateOf(db, target.id);
    if (billed && billed !== "ended") return done(1, m.billedNotDeletable(target.name, billed));
    const devices = await listNodes(db, target.id);
    const members = await listMembers(db, target.id);
    // Said before it is asked, not after: the number of machines that will
    // have to be enrolled again is the whole of what this costs.
    console.log(m.deleteSummary(target.name, target.dnsSuffix, devices.length, members.length));
    console.log(m.deleteWarning);
    const typed = await readLine(m.typeToConfirm(target.name));
    if (typed !== target.name) return done(1, m.notDeleted);

    const deleted = await deleteWave(db, target.id);
    if (!deleted) return done(1, m.noWaveMatches(rest[0] ?? ""));
    // Connected devices are not told from here -- this process has no hub.
    // They find out when their control connection next asks for a netmap.
    return done(0, m.deleted(deleted.name, deleted.nodeIds.length));
  }

  if (command === "members") {
    const target = await wave(rest[0]);
    const members = await listMembers(db, target.id);
    const invites = await listInvites(db, target.id);

    console.log(`${target.name} (${target.dnsSuffix})`);
    for (const member of members) {
      const devices = m.deviceCount(member.nodeCount);
      console.log(`  ${member.role.padEnd(6)} ${member.email ?? member.userId}  ${devices}`);
    }
    for (const invite of invites) {
      console.log(m.invitedLine(invite.email, invite.role, invite.expiresAt.toISOString()));
    }
    return done(0);
  }

  if (command === "devices") {
    const target = await wave(rest[0]);
    const devices = await listNodes(db, target.id);
    // Only said under a policy: without one there is nothing to enforce.
    const policy = await getPolicy(db, target.id);

    console.log(`${target.name} (${target.dnsSuffix})`);
    for (const device of devices) {
      const seen = device.lastSeenAt ? device.lastSeenAt.toISOString() : m.neverSeen;
      const owner = device.email ?? device.userId;
      const wildcard = device.wildcardAllowed ? "  [wildcard]" : "";
      const tags = device.tags.length > 0 ? `  ${device.tags.join(" ")}` : "";
      const ports = policy ? `  [${enforcementText(device, locale)}]` : "";
      // Who is behind (D13). A client from before self-updates never says.
      const version = device.clientVersion
        ? `  v${device.clientVersion}${device.updateChannel ? ` (${device.updateChannel})` : ""}`
        : m.versionUnknown;
      console.log(
        `  ${device.hostname.padEnd(20)} ${device.ipv4.padEnd(16)} ${owner}  ${seen}${version}${wildcard}${tags}${ports}`,
      );
    }
    if (devices.length === 0) console.log(m.noDevices);
    return done(0);
  }

  if (command === "remove-device") {
    const [selector, host] = rest;
    if (!host) return done(1, usage);
    const target = await wave(selector);
    const found = await findNode(db, target.id, host);
    if (!found) return done(1, m.noDevice(host, target.name));

    await removeNode(db, target.id, found.id);
    console.log(m.deviceRemoved(found.hostname, target.name));
    // The running server has the sockets, this process does not -- a device
    // that is connected right now learns it at its next heartbeat.
    return done(0, m.peerGone);
  }

  if (command === "add-member") {
    const [selector, email, role] = rest;
    if (!email) return done(1, usage);
    const target = await wave(selector);
    const found = await account(email);
    if (!found) {
      return done(1, m.noAccountHint(email));
    }
    // Held to the booking like an invitation: more seats are bought on the
    // site, not granted on the shell. Someone already in takes no new seat.
    let result: Awaited<ReturnType<typeof addMember>>;
    try {
      result = await db.transaction(async (tx) => {
        const t = tx as unknown as typeof db;
        const already = await t
          .select({ userId: waveMembers.userId })
          .from(waveMembers)
          .where(and(eq(waveMembers.waveId, target.id), eq(waveMembers.userId, found.id)))
          .limit(1);
        if (already.length === 0) await ensureSeatFor(t, target.id, email);
        return addMember(t, target.id, found.id, asRole(role));
      });
    } catch (error) {
      if (error instanceof SeatLimitError) return done(1, m.noSeatLeft(target.name, error.seats));
      throw error;
    }
    return done(
      0,
      result.added
        ? m.memberAdded(email, result.role, target.name)
        : m.memberExisted(email, target.name, result.role),
    );
  }

  if (command === "remove-member") {
    const [selector, email] = rest;
    if (!email) return done(1, usage);
    const target = await wave(selector);
    const found = await account(email);
    if (!found) return done(1, m.noAccount(email));

    // The operator acts as the owner here: this is the shell of the server.
    const result = await removeMember(db, target.id, "owner", found.id);
    if (result === "not-a-member") return done(1, m.notInWave(email, target.name));
    if (result === "owner") {
      return done(1, m.ownsWave(email, target.name));
    }
    if (result === "forbidden") return done(1, m.notAllowed);

    console.log(m.memberRemoved(email, target.name, result.removedNodes));
    return done(0, m.peersGone);
  }

  if (command === "invite") {
    const [selector, email, role] = rest;
    if (!email) return done(1, usage);
    if (!looksLikeEmail(normaliseEmail(email))) return done(1, m.notAnEmail(email));
    const target = await wave(selector);

    // Invitations are created by a member, and on the command line the owner is
    // who that is -- there is no operator account to attribute them to.
    const owner = target.ownerEmail ? await account(target.ownerEmail) : null;
    if (!owner) return done(1, m.noOwnerToInviteFor(target.name));

    let invite: Awaited<ReturnType<typeof createInvite>>;
    try {
      invite = await createInvite(db, {
        waveId: target.id,
        waveName: target.name,
        email,
        role: asRole(role),
        invitedByUserId: owner.id,
        baseUrl: config.baseUrl,
      });
    } catch (error) {
      // The operator is held to the booking like everyone else: more seats
      // are bought on the site, not granted on the shell.
      if (error instanceof SeatLimitError) return done(1, m.noSeatLeft(target.name, error.seats));
      throw error;
    }
    console.log(m.sendLink(invite.email, invite.expiresAt.toISOString()));
    return done(0, invite.url);
  }

  if (command === "revoke-invite") {
    const [selector, email] = rest;
    if (!email) return done(1, usage);
    const target = await wave(selector);
    const revoked = await revokeInvite(db, target.id, { email });
    return done(revoked ? 0 : 1, revoked ? m.inviteRevoked(email) : m.noInvite(email, target.name));
  }

  if (command === "disable-2fa") {
    // For the lost phone: whoever has lost their second factor cannot turn it
    // off themselves, which is the point of it. The operator confirms who they
    // are some other way -- that is why this is on the shell and not a button.
    const [email] = rest;
    if (!email) return done(1, usage);
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, normaliseEmail(email)))
      .limit(1);
    if (!user) return done(1, m.noAccount(email));
    if (!(await hasTwoFactor(db, user.id))) return done(0, m.twoFactorWasOff(email));
    await disableTwoFactor(db, user.id, "operator");
    return done(0, m.twoFactorOff(email));
  }

  // set-password, the only command that asks for input.
  const [email] = rest;
  if (!email) return done(1, usage);

  const password = await readSecret(m.passwordFor(email));
  if (password.length < 12) return done(1, m.passwordTooShort);
  if (process.stdin.isTTY) {
    const again = await readSecret(m.repeat);
    if (again !== password) return done(1, m.passwordsDiffer);
  }

  const { userId, created } = await setPassword(db, email, password);
  // Where waves are sold, a new password is no way to a free one: resetting it
  // for someone removed from a booked seat would otherwise hand them a wave.
  if (!mayCreateWaves(config)) return done(0, m.accountSaved(created, email, userId, m.waveBooked));
  const provisioned = await ensureWaveForUser(db, userId, email, config.ipv4Container);
  const waveNote = provisioned.deferred
    ? m.waveDeferred
    : m.waveNote(provisioned.waveId ?? "", provisioned.created === true);
  return done(0, m.accountSaved(created, email, userId, waveNote));
}

await main();
