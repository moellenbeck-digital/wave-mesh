import { sign as nodeSign, verify as nodeVerify } from "node:crypto";
import { rawToPrivateKeyObject, rawToPublicKeyObject } from "./keys.ts";

/** Ed25519 signature over arbitrary bytes, base64-encoded. */
export function sign(privateKeyBase64: string, message: string | Uint8Array): string {
  const key = rawToPrivateKeyObject(Buffer.from(privateKeyBase64, "base64"), "ed25519");
  return nodeSign(null, Buffer.from(message), key).toString("base64");
}

export function verify(
  publicKeyBase64: string,
  message: string | Uint8Array,
  signatureBase64: string,
): boolean {
  try {
    const key = rawToPublicKeyObject(Buffer.from(publicKeyBase64, "base64"), "ed25519");
    return nodeVerify(null, Buffer.from(message), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    // Malformed key or signature is a failed verification, not a crash.
    return false;
  }
}

/**
 * Deterministic JSON encoding for anything that gets signed. Object keys are
 * emitted in sorted order so that two encoders agree byte for byte; without
 * this, a signature would depend on property insertion order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}
