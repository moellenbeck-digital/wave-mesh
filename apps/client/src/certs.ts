import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createCsr, der, generateCertificateKey } from "@wave/crypto";
import type { CertChallengeRecord } from "@wave/proto";
import { ControlClient, verifyNetmap } from "./api.ts";
import {
  type CertRecord,
  findProfile,
  loadProfiles,
  type Profile,
  profileKey,
  updateProfile,
} from "./state.ts";

/**
 * Certificates on a node (D7).
 *
 * The key is made here and stays here. What travels is a certificate signing
 * request and, on the way back, a chain -- both of them public. That is the
 * whole reason the control server, and not the node, holds the DNS credential:
 * neither side is given the means to do the other's damage.
 */

export interface CertPaths {
  dir: string;
  keyPath: string;
  chainPath: string;
}

/**
 * Where a certificate lands: beside the state file, so it follows the same
 * split as the keys do -- the daemon's system-wide directory when it runs the
 * show, the user's own when the CLI does it alone.
 *
 * A wildcard is filed under `wildcard.<suffix>`: `*` is a perfectly ordinary
 * character in a unix path and an illegal one in a Windows filename, and a
 * directory whose name is a glob is a trap for every script that ever touches
 * it.
 */
export function certPaths(statePath: string, name: string): CertPaths {
  const dir = join(dirname(statePath), "certs", name.replace(/^\*\./, "wildcard."));
  return { dir, keyPath: join(dir, "key.pem"), chainPath: join(dir, "fullchain.pem") };
}

export interface IssueOptions {
  statePath: string;
  profile: Profile;
  /** The names to certify; without any, this device's own name in the wave. */
  names?: string[];
  /**
   * Add `*.<suffix>` and the zone's own name. Only a device an operator has
   * granted it gets past the server with this -- a wildcard stands for every
   * name in the wave.
   */
  wildcard?: boolean;
  hook?: string | null;
  log?: (message: string) => void;
  /** How long to wait for the CA before giving up. */
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export type IssuedCertificate = CertRecord & CertPaths;

/**
 * What came of asking.
 *
 * `waiting` is the manual mode: the wave has no DNS credential, the server has
 * named the records, and somebody has to create them. Asking again later takes
 * the same order up where it was left, so nothing is lost by stopping here --
 * and stopping is what lets an unattended renewal report the problem instead
 * of hanging on it for an hour.
 */
export type CertResult = { issued: IssuedCertificate } | { waiting: CertChallengeRecord[]; name: string };

const POLL_INTERVAL_MS = 3_000;

/**
 * Asks the control server for a certificate and writes it out.
 *
 * A fresh key every time, renewals included -- and a fresh one again when a
 * parked order is taken up later: a certificate is cheap, and a key that has
 * been on disk for a year through several renewals is the one thing this
 * design was meant to avoid keeping.
 */
export async function issueCertificate(options: IssueOptions): Promise<CertResult> {
  const log = options.log ?? (() => {});
  const client = new ControlClient(options.profile);
  const names = await resolveNames(options);
  const name = names[0] as string;

  const key = generateCertificateKey();
  const csr = der.toPem("CERTIFICATE REQUEST", createCsr({ privateKeyPem: key.privateKeyPem, names }));

  log(`asking for a certificate for ${names.join(", ")}`);
  const { orderId } = await client.orderCert(csr, names);

  const deadline = Date.now() + (options.timeoutMs ?? 10 * 60 * 1000);
  const sleep = options.sleep ?? ((ms) => Bun.sleep(ms));
  for (;;) {
    const status = await client.certOrder(orderId);
    if (status.status === "failed") throw new Error(status.error);
    if (status.status === "waiting") return { waiting: status.records, name };
    if (status.status === "issued") {
      const paths = certPaths(options.statePath, name);
      await writeCertificate(paths, key.privateKeyPem, status.chainPem);
      const record: CertRecord = {
        name,
        names,
        renewAt: status.renewAt,
        notAfter: status.notAfter,
        hook: options.hook ?? null,
      };
      await remember(options.statePath, profileKey(options.profile), record);
      log(`${name} is certified until ${status.notAfter}; renewing around ${status.renewAt}`);
      if (record.hook) await runHook(record.hook, paths, log);
      return { issued: { ...record, ...paths } };
    }
    if (Date.now() >= deadline) throw new Error(`the certificate for ${name} was not issued in time`);
    await sleep(POLL_INTERVAL_MS);
  }
}

/**
 * What to ask for: what was named, this device's own name, or the wave's
 * wildcard.
 *
 * The netmap is the source for both the name and the suffix rather than the
 * hostname and a guess: the server may have renamed the device to keep names
 * unique in the wave, and a certificate for a name that is not in the netmap
 * would be useless.
 */
async function resolveNames(options: IssueOptions): Promise<string[]> {
  const asked = options.names ?? [];
  if (asked.length > 0 && !options.wildcard) return asked;

  const profile = options.profile;
  if (!profile.netmapPublicKey) throw new Error("this wave has no pinned key yet — run `wave up` first");
  const signed = await new ControlClient(profile).netmap();
  const netmap = verifyNetmap(signed, profile.netmapPublicKey);

  if (!options.wildcard) return [netmap.self.dnsName];
  // The zone's own name comes with it: a machine that fronts the wildcard
  // fronts the apex too, and it is the same reach either way.
  const wildcard = [`*.${netmap.dns.suffix}`, netmap.dns.suffix];
  return [...wildcard, ...asked.filter((name) => !wildcard.includes(name))];
}

async function writeCertificate(paths: CertPaths, keyPem: string, chainPem: string): Promise<void> {
  await mkdir(paths.dir, { recursive: true, mode: 0o700 });
  // The chain is public and something a service has to be able to read; the
  // key is neither, and an existing file keeps its old mode on write.
  await writeFile(paths.chainPath, chainPem, { mode: 0o644 });
  await writeFile(paths.keyPath, keyPem, { mode: 0o600 });
  await chmod(paths.keyPath, 0o600).catch(() => {});
}

/** Keeps the record with the profile, so a restart still knows when to renew. */
async function remember(statePath: string, key: string, record: CertRecord): Promise<void> {
  const current = findProfile(await loadProfiles(statePath), key);
  const certs = [...(current?.certs ?? []).filter((entry) => entry.name !== record.name), record];
  await updateProfile(statePath, key, { certs });
}

/**
 * Runs whatever the operator asked to have run after a renewal.
 *
 * Through a shell on purpose: what goes here is `systemctl reload caddy`, and
 * asking people to split that into an argument vector would be the kind of
 * precision that buys nothing. It is their own command, in a daemon that is
 * already root.
 */
export async function runHook(
  hook: string,
  paths: CertPaths,
  log: (message: string) => void = () => {},
): Promise<void> {
  const command = process.platform === "win32" ? ["cmd.exe", "/c", hook] : ["/bin/sh", "-c", hook];
  const child = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WAVE_CERT: paths.chainPath, WAVE_CERT_KEY: paths.keyPath },
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const code = await child.exited;
  const output = `${out}${err}`.trim();
  // Logged, not thrown: the certificate is already on disk and valid, and a
  // hook that failed must not make the renewal look like it did not happen.
  if (code !== 0) log(`hook "${hook}" exited ${code}${output ? `: ${output.slice(0, 200)}` : ""}`);
  else if (output) log(`hook: ${output.slice(0, 200)}`);
}

/** Every name on a certificate, including records written before there were several. */
export const namesOf = (record: CertRecord): string[] =>
  record.names.length > 0 ? record.names : [record.name];

/** The certificates of one profile that have reached their renewal date. */
export function dueCertificates(profile: Profile, now: Date = new Date()): CertRecord[] {
  return (profile.certs ?? []).filter((record) => {
    const when = Date.parse(record.renewAt);
    // An unreadable date is treated as due: a certificate whose renewal window
    // cannot be read is one nobody would otherwise ever renew.
    return Number.isNaN(when) || when <= now.getTime();
  });
}
