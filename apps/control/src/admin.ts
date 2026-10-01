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
import { desc, eq } from "drizzle-orm";
import { describeEnforcement, describeReach, enforcementText } from "./acl/describe.ts";
import { compilePolicy } from "./acl/evaluate.ts";
import { aclSubjects, getPolicy, invalidTags, removePolicy, setPolicy, setTags } from "./acl/store.ts";
import { checkPolicy } from "./acl/validate.ts";
import { audit, listAudit, shellActor } from "./audit.ts";
import { setPassword } from "./auth/password.ts";
import { createDb } from "./db/client.ts";
import { certificateOrders, nodes, users } from "./db/schema.ts";
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
import { DEFAULT_DNS_BASE, deleteWave, ensureWaveForUser, setWaveDomain } from "./waves/provision.ts";
import { listServices, removeService, serviceUrl } from "./waves/services.ts";

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
  if (kind === "ionos") return readSecret(`IONOS API key, <public prefix>.<secret> (${suffix}): `);
  if (kind !== "inwx") return readSecret(`API token for ${kind} (${suffix}): `);

  if (!process.stdin.isTTY) return readSecret("");
  console.log(`INWX signs in with an account rather than a token (${suffix}).`);
  console.log("Worth knowing: it has nothing that can be scoped to one zone, so this credential can");
  console.log("do everything the account can. A sub-account for this domain alone is the way to narrow it.");
  const user = await readLine("  INWX username: ");
  const password = await readSecret("  INWX password (not echoed): ");
  const totpSecret = await readSecret("  TOTP shared secret, empty if the account has no 2FA: ");
  return JSON.stringify({ user, password, ...(totpSecret ? { totpSecret } : {}) });
}

const COMMANDS = [
  "set-password",
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

const usage = `usage:
  ${invocation} set-password  <email>
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

<wave> is a wave name, a wave id or the address of its owner.
set-acl reads a policy from a file, or from a pipe with -; without one every device reaches
every other. acl prints the policy and who reaches whom under it.
set-dns-provider reads the credential from the terminal or from a pipe. cloudflare, hetzner and
ionos take one token; inwx takes an account and asks for its parts, or reads
{"user":"…","password":"…","totpSecret":"…"} from a pipe.`;

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
  if (!found) return done(1, `no wave matches ${selector}`);
  if (isAmbiguous(found)) {
    const list = found.ambiguous
      .map((w) => `  ${w.name} (${w.id}), owner ${w.ownerEmail ?? "unknown"}`)
      .join("\n");
    return done(1, `${selector} matches several waves -- name one of them:\n${list}`);
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
    if (!kind || !isProviderKind(kind))
      return done(1, `provider must be one of ${PROVIDER_KINDS.join(", ")}`);
    const target = await wave(selector);

    // Refused before anything is asked for: `.internal` cannot be delegated,
    // so there is no zone anywhere that anybody could write this record in.
    if (target.dnsSuffix === DEFAULT_DNS_BASE || target.dnsSuffix.endsWith(`.${DEFAULT_DNS_BASE}`)) {
      return done(1, `${target.name} still uses the placeholder ${target.dnsSuffix}; set-domain first`);
    }

    // The way out of needing a provider at all: the server names the record and
    // waits until it is there. Nothing is stored and nothing is verified here
    // -- creating the record *is* the proof that the zone is yours, and it
    // happens once per certificate instead of once here.
    if (!isAutomaticKind(kind)) {
      await storeDnsCredential(db, { waveId: target.id, provider: kind });
      console.log(`${target.name} answers dns-01 by hand; no credential is stored.`);
      console.log("`wave cert` on a device prints the record to create and waits for it.");
      return done(0, "Renewals then need a person too -- a provider is the only way around that.");
    }

    if (!config.dnsSecret) {
      return done(1, "WAVE_DNS_SECRET is not set; without it a token would have to be stored in the clear");
    }

    const token = await readCredential(kind, target.dnsSuffix);
    if (!token) return done(1, "no credential given");

    // Tried before it is stored, and this is also the domain verification D6
    // asks for: in provider mode, being able to write the zone is the proof of
    // owning it. A credential that cannot is not one to keep.
    try {
      await verifyZoneAccess(buildProvider(kind, token), target.dnsSuffix);
    } catch (error) {
      return done(
        1,
        `the credential could not write ${target.dnsSuffix}: ${error instanceof Error ? error.message : error}`,
      );
    }

    await storeDnsCredential(db, { waveId: target.id, provider: kind, token, key: config.dnsSecret });
    console.log(`${target.name} writes ${target.dnsSuffix} through ${kind}.`);
    return done(0, "Devices can now ask for certificates with `wave cert`.");
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
      console.log(`  ${url.padEnd(48)} ${service.ipv4.padEnd(16)} via ${via}`);
    }
    if (services.length === 0) console.log("  no services");
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
      removed
        ? `${name} is gone from ${target.name}; a running operator would declare it again.`
        : `no service called ${name} in ${target.name}`,
    );
  }

  if (command === "auth-key") {
    const flags = rest.filter((entry) => entry.startsWith("--"));
    const [selector, label] = rest.filter((entry) => !entry.startsWith("--"));
    const target = await wave(selector);

    const owner = target.ownerEmail ? await account(target.ownerEmail) : null;
    // The devices become somebody's, and on the shell that somebody is the
    // owner -- there is no operator account to attribute them to.
    if (!owner) return done(1, `${target.name} has no owner account to enrol devices for`);

    const days = Number(flags.find((flag) => flag.startsWith("--days="))?.split("=")[1] ?? 0) || undefined;
    const key = await createAuthKey(db, {
      waveId: target.id,
      userId: owner.id,
      label,
      reusable: flags.includes("--reusable"),
      days,
    });

    console.log(`This key enrols devices into ${target.name} until ${key.expiresAt.toISOString()}.`);
    console.log("It is shown once; it cannot be read back, only replaced.");
    console.log("");
    console.log(`  wave login ${config.baseUrl} --auth-key ${key.token}`);
    return done(0, "");
  }

  if (command === "auth-keys") {
    const target = await wave(rest[0]);
    const keys = await listAuthKeys(db, target.id);
    console.log(`${target.name} (${target.dnsSuffix})`);
    for (const key of keys) {
      const state = key.revokedAt
        ? "revoked"
        : key.expiresAt.getTime() < Date.now()
          ? "expired"
          : !key.reusable && key.uses > 0
            ? "used"
            : "usable";
      const kind = key.reusable ? "reusable" : "single use";
      console.log(
        `  ${key.id}  ${state.padEnd(8)} ${kind.padEnd(11)} ${key.uses} device(s)  ${key.label ?? ""}`,
      );
    }
    if (keys.length === 0) console.log("  no pre-auth keys");
    return done(0);
  }

  if (command === "revoke-auth-key") {
    const [selector, id] = rest;
    if (!id) return done(1, usage);
    const target = await wave(selector);
    const revoked = await revokeAuthKey(db, target.id, id);
    return done(
      revoked ? 0 : 1,
      revoked
        ? `${id} cannot enrol anything any more; devices that used it keep their place.`
        : `no usable key ${id} in ${target.name}`,
    );
  }

  if (command === "allow-wildcard" || command === "deny-wildcard") {
    const [selector, host] = rest;
    if (!host) return done(1, usage);
    const target = await wave(selector);
    const found = await findNode(db, target.id, host);
    if (!found) return done(1, `no device called ${host} in ${target.name}`);

    const allowed = command === "allow-wildcard";
    const updated = await setWildcardAllowed(db, target.id, found.id, allowed);
    if (!updated) return done(1, `no device called ${host} in ${target.name}`);
    if (!allowed) return done(0, `${found.hostname} may no longer ask for *.${target.dnsSuffix}.`);

    // Said plainly, because it is the one grant here that reaches past the
    // device it is given to.
    console.log(`${found.hostname} may now ask for *.${target.dnsSuffix} and ${target.dnsSuffix}.`);
    console.log("Whoever holds that certificate's key can serve every name in the wave,");
    return done(0, "so it belongs on a machine you would trust with all of them.");
  }

  if (command === "audit") {
    const [selector, flag, value] = rest;
    const target = await wave(selector);
    const limit = flag === "--limit" ? Math.max(1, Number(value) || 50) : 50;
    const entries = await listAudit(db, target.id, limit);
    console.log(`${target.name} (${target.dnsSuffix}), newest first`);
    for (const entry of entries) {
      console.log(
        `  ${entry.at}  ${entry.actor.padEnd(24)} ${entry.action.padEnd(22)} ${entry.target ?? ""}`,
      );
    }
    if (entries.length === 0) console.log("  nothing recorded yet");
    return done(0);
  }

  if (command === "acl") {
    const target = await wave(rest[0]);
    const stored = await getPolicy(db, target.id);
    if (!stored) return done(0, `${target.name} has no policy: every device reaches every other.`);
    const subjects = await aclSubjects(db, target.id);
    console.log(JSON.stringify(stored.document, null, 2));
    console.log(`\nversion ${stored.version}, set ${stored.updatedAt.toISOString()}. Under it:`);
    for (const line of describeReach(
      compilePolicy(stored.document, subjects.nodes, subjects.services),
      subjects.nodes,
    )) {
      console.log(line);
    }
    const unenforced = describeEnforcement(subjects.nodes);
    if (unenforced.length === 0) return done(0, "\nEvery device enforces its ports.");
    console.log("\nThese devices are limited by the netmap only, not in their ports:");
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
      return done(1, `not JSON: ${(error as Error).message}`);
    }

    const subjects = await aclSubjects(db, target.id);
    const check = checkPolicy(raw, subjects);
    for (const warning of check.warnings) console.log(`  note: ${warning}`);
    if (!check.policy) return done(1, `refused:\n${check.errors.map((error) => `  ${error}`).join("\n")}`);

    const version = await setPolicy(db, target.id, check.policy, null);
    auditDetail = { version, policy: check.policy };
    console.log(`${target.name}: policy version ${version}. Under it:`);
    for (const line of describeReach(
      compilePolicy(check.policy, subjects.nodes, subjects.services),
      subjects.nodes,
    )) {
      console.log(line);
    }
    // Said, because it is the difference between the two stages of M7: who
    // may see whom is enforced by the netmap on every device already; which
    // ports is up to each device to enforce.
    return done(0, "Connected devices get the new netmap within thirty seconds.");
  }

  if (command === "remove-acl") {
    const target = await wave(rest[0]);
    const removed = await removePolicy(db, target.id);
    return done(
      removed ? 0 : 1,
      removed
        ? `${target.name} has no policy any more: every device reaches every other.`
        : `${target.name} had no policy`,
    );
  }

  if (command === "tag" || command === "untag") {
    const [selector, host, ...names] = rest;
    if (!host || (command === "tag" && names.length === 0)) return done(1, usage);
    const bad = invalidTags(names);
    if (bad.length > 0) return done(1, `not a tag: ${bad.join(", ")} (tags look like tag:nas)`);
    const target = await wave(selector);
    const found = await findNode(db, target.id, host);
    if (!found) return done(1, `no device called ${host} in ${target.name}`);

    const current = (await listNodes(db, target.id)).find((device) => device.id === found.id)?.tags ?? [];
    const next =
      command === "tag"
        ? [...current, ...names]
        : names.length === 0
          ? []
          : current.filter((tag) => !names.includes(tag));
    const updated = await setTags(db, target.id, found.id, next);
    if (!updated) return done(1, `no device called ${host} in ${target.name}`);
    if (updated.tags.length === 0)
      return done(0, `${updated.hostname} has no tags: it counts as its owner's again.`);
    // Said, because it is the part people do not expect: a tag replaces the
    // owner as far as the policy is concerned.
    console.log(`${updated.hostname}: ${updated.tags.join(" ")}`);
    return done(0, "The policy now judges it by these tags alone, no longer as its owner's device.");
  }

  if (command === "dns-provider") {
    const target = await wave(rest[0]);
    const credential = await findDnsCredential(db, target.id);
    return done(
      0,
      credential
        ? `${target.name} (${target.dnsSuffix}): ${credential.provider}, set ${credential.updatedAt.toISOString()}`
        : `${target.name} (${target.dnsSuffix}): no DNS credential, so no certificates`,
    );
  }

  if (command === "remove-dns-provider") {
    const target = await wave(rest[0]);
    const removed = await removeDnsCredential(db, target.id);
    return done(
      removed ? 0 : 1,
      removed
        ? `${target.name} has no DNS credential any more; issued certificates keep working until they expire.`
        : `${target.name} had no DNS credential`,
    );
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
        ? `until ${row.order.expiresAt.toISOString()}`
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
    if (rows.length === 0) console.log("  no certificates");
    return done(0);
  }

  if (command === "set-domain") {
    const [selector, domain] = rest;
    if (!domain) return done(1, usage);
    const target = await wave(selector);
    const updated = await setWaveDomain(db, target.id, domain);
    if (!updated) return done(1, `no wave matches ${selector}`);
    if ("conflict" in updated) return done(1, `another wave already answers for ${domain}`);
    console.log(`${target.name}: names are now <host>.${domain}`);
    return done(0, "Connected nodes pick this up with their next netmap.");
  }

  if (command === "delete-wave") {
    const target = await wave(rest[0]);
    const devices = await listNodes(db, target.id);
    const members = await listMembers(db, target.id);
    // Said before it is asked, not after: the number of machines that will
    // have to be enrolled again is the whole of what this costs.
    console.log(
      `${target.name} (${target.dnsSuffix}) has ${devices.length} device(s) and ${members.length} member(s).`,
    );
    console.log("Deleting it cannot be undone: every device loses its enrolment.");
    const typed = await readLine(`Type ${target.name} to confirm: `);
    if (typed !== target.name) return done(1, "Not deleted.");

    const deleted = await deleteWave(db, target.id);
    if (!deleted) return done(1, `no wave matches ${rest[0]}`);
    // Connected devices are not told from here -- this process has no hub.
    // They find out when their control connection next asks for a netmap.
    return done(
      0,
      `${deleted.name} is gone, with ${deleted.nodeIds.length} device(s). Connected ones drop on their next request.`,
    );
  }

  if (command === "members") {
    const target = await wave(rest[0]);
    const members = await listMembers(db, target.id);
    const invites = await listInvites(db, target.id);

    console.log(`${target.name} (${target.dnsSuffix})`);
    for (const member of members) {
      const devices = `${member.nodeCount} ${member.nodeCount === 1 ? "device" : "devices"}`;
      console.log(`  ${member.role.padEnd(6)} ${member.email ?? member.userId}  ${devices}`);
    }
    for (const invite of invites) {
      console.log(`  invited ${invite.email} as ${invite.role}, until ${invite.expiresAt.toISOString()}`);
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
      const seen = device.lastSeenAt ? device.lastSeenAt.toISOString() : "never seen";
      const owner = device.email ?? device.userId;
      const wildcard = device.wildcardAllowed ? "  [wildcard]" : "";
      const tags = device.tags.length > 0 ? `  ${device.tags.join(" ")}` : "";
      const ports = policy ? `  [${enforcementText(device)}]` : "";
      // Who is behind (D13). A client from before self-updates never says.
      const version = device.clientVersion
        ? `  v${device.clientVersion}${device.updateChannel ? ` (${device.updateChannel})` : ""}`
        : "  version unknown";
      console.log(
        `  ${device.hostname.padEnd(20)} ${device.ipv4.padEnd(16)} ${owner}  ${seen}${version}${wildcard}${tags}${ports}`,
      );
    }
    if (devices.length === 0) console.log("  no devices");
    return done(0);
  }

  if (command === "remove-device") {
    const [selector, host] = rest;
    if (!host) return done(1, usage);
    const target = await wave(selector);
    const found = await findNode(db, target.id, host);
    if (!found) return done(1, `no device called ${host} in ${target.name}`);

    await removeNode(db, target.id, found.id);
    console.log(`${found.hostname} is out of ${target.name}; it has to be let in again with wave login.`);
    // The running server has the sockets, this process does not -- a device
    // that is connected right now learns it at its next heartbeat.
    return done(0, "Nodes still running lose the peer with their next netmap.");
  }

  if (command === "add-member") {
    const [selector, email, role] = rest;
    if (!email) return done(1, usage);
    const target = await wave(selector);
    const found = await account(email);
    if (!found) {
      return done(
        1,
        `no account for ${email}. Create one with set-password, or use invite to let them in themselves.`,
      );
    }
    const result = await addMember(db, target.id, found.id, asRole(role));
    return done(
      0,
      result.added
        ? `${email} is now ${result.role} of ${target.name}.`
        : `${email} was already in ${target.name}; role is ${result.role}.`,
    );
  }

  if (command === "remove-member") {
    const [selector, email] = rest;
    if (!email) return done(1, usage);
    const target = await wave(selector);
    const found = await account(email);
    if (!found) return done(1, `no account for ${email}`);

    // The operator acts as the owner here: this is the shell of the server.
    const result = await removeMember(db, target.id, "owner", found.id);
    if (result === "not-a-member") return done(1, `${email} is not in ${target.name}`);
    if (result === "owner") {
      return done(1, `${email} owns ${target.name}; hand ownership over before removing them.`);
    }
    if (result === "forbidden") return done(1, "not allowed");

    console.log(`${email} is out of ${target.name}; ${result.removedNodes} device(s) removed with them.`);
    return done(0, "Nodes still running lose the peers with their next netmap.");
  }

  if (command === "invite") {
    const [selector, email, role] = rest;
    if (!email) return done(1, usage);
    if (!looksLikeEmail(normaliseEmail(email))) return done(1, `not an email address: ${email}`);
    const target = await wave(selector);

    // Invitations are created by a member, and on the command line the owner is
    // who that is -- there is no operator account to attribute them to.
    const owner = target.ownerEmail ? await account(target.ownerEmail) : null;
    if (!owner) return done(1, `${target.name} has no owner account to invite on behalf of`);

    const invite = await createInvite(db, {
      waveId: target.id,
      waveName: target.name,
      email,
      role: asRole(role),
      invitedByUserId: owner.id,
      baseUrl: config.baseUrl,
    });
    console.log(`Send ${invite.email} this link. It works once, until ${invite.expiresAt.toISOString()}:`);
    return done(0, invite.url);
  }

  if (command === "revoke-invite") {
    const [selector, email] = rest;
    if (!email) return done(1, usage);
    const target = await wave(selector);
    const revoked = await revokeInvite(db, target.id, { email });
    return done(
      revoked ? 0 : 1,
      revoked
        ? `The invitation for ${email} no longer works.`
        : `no open invitation for ${email} in ${target.name}`,
    );
  }

  // set-password, the only command that asks for input.
  const [email] = rest;
  if (!email) return done(1, usage);

  const password = await readSecret(`Password for ${email}: `);
  if (password.length < 12) return done(1, "Password must be at least 12 characters.");
  if (process.stdin.isTTY) {
    const again = await readSecret("Repeat: ");
    if (again !== password) return done(1, "Passwords do not match.");
  }

  const { userId, created } = await setPassword(db, email, password);
  const provisioned = await ensureWaveForUser(db, userId, email, config.ipv4Container);
  const waveNote = provisioned.deferred
    ? "no wave: an invitation is waiting for this address"
    : `wave ${provisioned.waveId}${provisioned.created ? " created" : ""}`;
  return done(0, `${created ? "Created" : "Updated"} ${email} (${userId}); ${waveNote}.`);
}

await main();
