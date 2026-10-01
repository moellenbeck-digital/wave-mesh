import { createHash } from "node:crypto";
import { sign, verify } from "./sign.ts";

/**
 * Request signing between a node and the control server.
 *
 * The node has no password and no bearer token -- it proves possession of its
 * machine key on every request. Signing method, path, timestamp, nonce and a
 * hash of the body means a captured request cannot be replayed against a
 * different endpoint, and cannot be replayed at all once the timestamp window
 * has passed.
 */
export const SIGNATURE_SCHEME = "WaveSig";
export const MAX_CLOCK_SKEW_SECONDS = 300;

export interface SignatureParts {
  machineKey: string;
  timestamp: number;
  nonce: string;
  signature: string;
}

export const bodyHash = (body: string): string => createHash("sha256").update(body).digest("hex");

export function signatureMessage(parts: {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  bodyHash: string;
}): string {
  return [
    "wave-sig-v1",
    parts.method.toUpperCase(),
    parts.path,
    String(parts.timestamp),
    parts.nonce,
    parts.bodyHash,
  ].join("\n");
}

export function buildAuthorizationHeader(input: {
  machineKey: string;
  machinePrivateKey: string;
  method: string;
  path: string;
  body?: string;
  now?: Date;
}): string {
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const nonce = Buffer.from(crypto.getRandomValues(new Uint8Array(12))).toString("base64url");
  const message = signatureMessage({
    method: input.method,
    path: input.path,
    timestamp,
    nonce,
    bodyHash: bodyHash(input.body ?? ""),
  });
  const signature = sign(input.machinePrivateKey, message);
  return `${SIGNATURE_SCHEME} k=${input.machineKey},t=${timestamp},n=${nonce},s=${signature}`;
}

export function parseAuthorizationHeader(header: string | undefined | null): SignatureParts | null {
  if (!header?.startsWith(`${SIGNATURE_SCHEME} `)) return null;
  const fields = new Map<string, string>();
  for (const part of header.slice(SIGNATURE_SCHEME.length + 1).split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    fields.set(part.slice(0, eq).trim(), part.slice(eq + 1).trim());
  }
  const machineKey = fields.get("k");
  const timestamp = Number(fields.get("t"));
  const nonce = fields.get("n");
  const signature = fields.get("s");
  if (!machineKey || !nonce || !signature || !Number.isFinite(timestamp)) return null;
  return { machineKey, timestamp, nonce, signature };
}

export type VerificationFailure = "missing-signature" | "clock-skew" | "replayed-nonce" | "bad-signature";

export interface NonceStore {
  /** Returns false when the nonce was already used inside the window. */
  claim(nonce: string, expiresAt: number): boolean;
}

/** Per-process nonce store. A multi-instance deployment needs a shared one. */
export function createMemoryNonceStore(): NonceStore {
  const seen = new Map<string, number>();
  return {
    claim(nonce, expiresAt) {
      const now = Date.now();
      if (seen.size > 10_000) {
        for (const [key, expiry] of seen) if (expiry <= now) seen.delete(key);
      }
      const existing = seen.get(nonce);
      if (existing !== undefined && existing > now) return false;
      seen.set(nonce, expiresAt);
      return true;
    },
  };
}

export function verifySignedRequest(input: {
  header: string | undefined | null;
  method: string;
  path: string;
  body: string;
  nonces: NonceStore;
  now?: Date;
}): { ok: true; machineKey: string } | { ok: false; reason: VerificationFailure } {
  const parts = parseAuthorizationHeader(input.header);
  if (!parts) return { ok: false, reason: "missing-signature" };

  const nowSeconds = Math.floor((input.now ?? new Date()).getTime() / 1000);
  if (Math.abs(nowSeconds - parts.timestamp) > MAX_CLOCK_SKEW_SECONDS) {
    return { ok: false, reason: "clock-skew" };
  }

  const message = signatureMessage({
    method: input.method,
    path: input.path,
    timestamp: parts.timestamp,
    nonce: parts.nonce,
    bodyHash: bodyHash(input.body),
  });
  if (!verify(parts.machineKey, message, parts.signature)) return { ok: false, reason: "bad-signature" };

  // Claimed only after the signature checks out, so an attacker cannot burn
  // nonces on behalf of a node.
  if (
    !input.nonces.claim(
      `${parts.machineKey}:${parts.nonce}`,
      (parts.timestamp + MAX_CLOCK_SKEW_SECONDS) * 1000,
    )
  ) {
    return { ok: false, reason: "replayed-nonce" };
  }
  return { ok: true, machineKey: parts.machineKey };
}
