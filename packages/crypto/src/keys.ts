import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto";

/**
 * Raw 32-byte keys wrapped in the minimal DER envelopes node:crypto expects.
 * Both WireGuard and our own signatures exchange keys as raw bytes in base64,
 * so every conversion happens here rather than at each call site.
 */
const SPKI_PREFIX = {
  ed25519: Buffer.from("302a300506032b6570032100", "hex"),
  x25519: Buffer.from("302a300506032b656e032100", "hex"),
} as const;

const PKCS8_PREFIX = {
  ed25519: Buffer.from("302e020100300506032b657004220420", "hex"),
  x25519: Buffer.from("302e020100300506032b656e04220420", "hex"),
} as const;

export type Curve = keyof typeof SPKI_PREFIX;

export interface KeyPair {
  /** Base64, 44 characters -- the format `wg` prints. */
  publicKey: string;
  privateKey: string;
}

const RAW_LEN = 32;

export function rawToPublicKeyObject(raw: Buffer, curve: Curve): KeyObject {
  if (raw.length !== RAW_LEN) throw new Error(`public key must be ${RAW_LEN} bytes, got ${raw.length}`);
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX[curve], raw]), format: "der", type: "spki" });
}

export function rawToPrivateKeyObject(raw: Buffer, curve: Curve): KeyObject {
  if (raw.length !== RAW_LEN) throw new Error(`private key must be ${RAW_LEN} bytes, got ${raw.length}`);
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX[curve], raw]), format: "der", type: "pkcs8" });
}

const rawFromPublic = (key: KeyObject): Buffer =>
  key.export({ format: "der", type: "spki" }).subarray(-RAW_LEN);

const rawFromPrivate = (key: KeyObject): Buffer =>
  key.export({ format: "der", type: "pkcs8" }).subarray(-RAW_LEN);

export function generateKeyPair(curve: Curve): KeyPair {
  // Narrowed explicitly: the overloads of generateKeyPairSync do not accept a union.
  const { publicKey, privateKey } =
    curve === "ed25519" ? generateKeyPairSync("ed25519") : generateKeyPairSync("x25519");
  return {
    publicKey: rawFromPublic(publicKey).toString("base64"),
    privateKey: rawFromPrivate(privateKey).toString("base64"),
  };
}

/** Derives the public key of an existing private key, as `wg pubkey` does. */
export function publicKeyFromPrivate(privateKeyBase64: string, curve: Curve): string {
  const key = rawToPrivateKeyObject(Buffer.from(privateKeyBase64, "base64"), curve);
  return rawFromPublic(createPublicKey(key)).toString("base64");
}

export const isValidKey = (value: string): boolean =>
  /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, "base64").length === RAW_LEN;

/** WireGuard exchanges keys as base64; the UAPI wants hex. */
export const keyToHex = (base64: string): string => Buffer.from(base64, "base64").toString("hex");
export const hexToKey = (hex: string): string => Buffer.from(hex, "hex").toString("base64");
