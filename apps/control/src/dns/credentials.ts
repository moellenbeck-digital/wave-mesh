import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.ts";
import { dnsCredentials } from "../db/schema.ts";
import { cloudflareProvider } from "./cloudflare.ts";
import { hetznerProvider } from "./hetzner.ts";
import { inwxProvider } from "./inwx.ts";
import { ionosProvider } from "./ionos.ts";
import {
  type AutomaticKind,
  type DnsProvider,
  DnsProviderError,
  isAutomaticKind,
  isProviderKind,
  type ProviderKind,
} from "./provider.ts";

/**
 * The provider token at rest.
 *
 * A token that may write a zone is the one secret here whose loss costs
 * somebody their domain rather than their wave, so it is sealed rather than
 * stored: a database dump, a backup or a replica is then not a set of keys to
 * other people's DNS. The key lives in the environment (WAVE_DNS_SECRET),
 * which is the same place the netmap signing key lives and the one place a
 * dump does not reach.
 *
 * AES-256-GCM: the tag is what makes a tampered ciphertext an error instead of
 * a token with a flipped bit, which would fail somewhere far from here.
 */
const VERSION = "v1";

export function sealSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    body.toString("base64url"),
  ].join(".");
}

export function openSecret(sealed: string, key: Buffer): string {
  const [version, iv, tag, body] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || !body) throw new Error("not a sealed secret");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

/** Exactly what a provider needs to be built, and nothing that identifies a wave. */
export function buildProvider(kind: AutomaticKind, token: string, http?: typeof fetch): DnsProvider {
  if (kind === "cloudflare") return cloudflareProvider(token, http);
  if (kind === "hetzner") return hetznerProvider(token, http);
  if (kind === "ionos") return ionosProvider(token, http);
  return inwxProvider(token, http);
}

export interface StoredCredential {
  waveId: string;
  provider: ProviderKind;
  updatedAt: Date;
}

/**
 * Records how a wave answers dns-01: with a token, or with a person.
 *
 * The manual mode has nothing to seal, which is why the column is nullable --
 * writing an empty ciphertext would only look like a secret that is not one.
 */
export async function storeDnsCredential(
  db: Database,
  input: { waveId: string; provider: ProviderKind; token?: string; key?: Buffer },
): Promise<void> {
  let tokenSealed: string | null = null;
  if (input.provider !== "manual") {
    if (!input.token) throw new Error(`${input.provider} needs an API token`);
    if (!input.key) throw new Error("a provider token needs WAVE_DNS_SECRET to be sealed with");
    tokenSealed = sealSecret(input.token, input.key);
  }
  await db
    .insert(dnsCredentials)
    .values({ waveId: input.waveId, provider: input.provider, tokenSealed })
    .onConflictDoUpdate({
      target: dnsCredentials.waveId,
      set: { provider: input.provider, tokenSealed, updatedAt: new Date() },
    });
}

export async function removeDnsCredential(db: Database, waveId: string): Promise<boolean> {
  const gone = await db
    .delete(dnsCredentials)
    .where(eq(dnsCredentials.waveId, waveId))
    .returning({ waveId: dnsCredentials.waveId });
  return gone.length > 0;
}

export async function findDnsCredential(db: Database, waveId: string): Promise<StoredCredential | null> {
  const rows = await db.select().from(dnsCredentials).where(eq(dnsCredentials.waveId, waveId)).limit(1);
  const row = rows[0];
  if (!row || !isProviderKind(row.provider)) return null;
  return { waveId: row.waveId, provider: row.provider, updatedAt: row.updatedAt };
}

/**
 * How a wave answers dns-01: by itself, or by asking a person.
 *
 * Null when the wave has said neither -- not an error but the ordinary state of
 * a wave that has never wanted a certificate, and the caller turns it into
 * words somebody can act on.
 */
export type DnsMode = { kind: "manual" } | { kind: "automatic"; provider: DnsProvider };

export async function loadDnsMode(
  db: Database,
  waveId: string,
  key: Buffer | undefined,
  http?: typeof fetch,
): Promise<DnsMode | null> {
  const rows = await db.select().from(dnsCredentials).where(eq(dnsCredentials.waveId, waveId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  if (!isProviderKind(row.provider)) throw new DnsProviderError(`unknown DNS provider ${row.provider}`);
  if (!isAutomaticKind(row.provider)) return { kind: "manual" };

  if (!row.tokenSealed) throw new DnsProviderError(`${row.provider} has no stored token`);
  if (!key) throw new DnsProviderError("WAVE_DNS_SECRET is not set, so the stored token cannot be opened");
  return { kind: "automatic", provider: buildProvider(row.provider, openSecret(row.tokenSealed, key), http) };
}

/**
 * Proves the token can really write the zone, by writing something and taking
 * it away again.
 *
 * This is also the domain verification D6 asks for: in provider-API mode the
 * proof of ownership *is* write access, so there is nothing else to check --
 * and finding out now beats finding out inside an order, where the failure
 * arrives as a challenge that never validates.
 */
export async function verifyZoneAccess(provider: DnsProvider, dnsSuffix: string): Promise<void> {
  const name = `_wave-verify.${dnsSuffix}`;
  const value = randomBytes(16).toString("base64url");
  await provider.setTxt(name, value);
  await provider.removeTxt(name, value);
}
