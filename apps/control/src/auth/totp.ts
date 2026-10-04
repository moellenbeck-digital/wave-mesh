import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * RFC 6238 time-based one-time passwords, in the shape every authenticator
 * app produces: SHA-1, 30 seconds, six digits. Used twice -- to sign in to
 * INWX on a wave's behalf, and as the second factor of a password login here.
 */

export const TOTP_STEP_MS = 30_000;
const DIGITS = 6;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export class TotpSecretError extends Error {}

export function base32Decode(value: string): Buffer {
  const bytes: number[] = [];
  let accumulator = 0;
  let bits = 0;
  for (const char of value.replace(/[\s=-]/g, "").toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) throw new TotpSecretError("the TOTP secret is not base32");
    accumulator = (accumulator << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >> bits) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

export function base32Encode(data: Uint8Array): string {
  let out = "";
  let accumulator = 0;
  let bits = 0;
  for (const byte of data) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(accumulator >> bits) & 0x1f];
    }
  }
  if (bits > 0) out += BASE32[(accumulator << (5 - bits)) & 0x1f];
  return out;
}

const stepAt = (atMs: number): number => Math.floor(atMs / TOTP_STEP_MS);

function codeForStep(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = (digest[digest.length - 1] ?? 0) & 0x0f;
  const code = (digest.readUInt32BE(offset) & 0x7fff_ffff) % 10 ** DIGITS;
  return String(code).padStart(DIGITS, "0");
}

export function totp(secret: string, atMs: number): string {
  return codeForStep(base32Decode(secret), stepAt(atMs));
}

/**
 * 20 random bytes -- the 160 bits RFC 4226 recommends for SHA-1 -- as base32,
 * which is what an app expects in its QR code and what a person types when
 * the camera will not cooperate.
 */
export const newTotpSecret = (): string => base32Encode(crypto.getRandomValues(new Uint8Array(20)));

/** The URI an authenticator app reads from a QR code. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(TOTP_STEP_MS / 1000),
  });
  return `otpauth://totp/${label}?${params}`;
}

/**
 * Checks a code and returns the step it belongs to, or null.
 *
 * One step either side is accepted: a phone's clock drifts, and a person
 * types the code the moment before it changes. A step at or before
 * `lastUsedStep` is refused even when the code is right -- a code seen over a
 * shoulder or in a proxy log must not work a second time within its minute.
 */
export function verifyTotp(
  secret: string,
  code: string,
  atMs: number,
  lastUsedStep: number | null = null,
): number | null {
  const typed = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(typed)) return null;
  const key = base32Decode(secret);
  const now = stepAt(atMs);
  for (const step of [now - 1, now, now + 1]) {
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    // Constant time, although six digits leak little: there is no reason to
    // let them leak anything.
    if (timingSafeEqual(Buffer.from(codeForStep(key, step)), Buffer.from(typed))) return step;
  }
  return null;
}
