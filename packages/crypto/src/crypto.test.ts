import { describe, expect, test } from "bun:test";
import { generateKeyPair, hexToKey, isValidKey, keyToHex, publicKeyFromPrivate } from "./keys.ts";
import { canonicalJson, sign, verify } from "./sign.ts";

describe("key pairs", () => {
  test("generates WireGuard-shaped X25519 keys", () => {
    const { publicKey, privateKey } = generateKeyPair("x25519");
    expect(isValidKey(publicKey)).toBe(true);
    expect(isValidKey(privateKey)).toBe(true);
    expect(publicKey).toHaveLength(44);
  });

  test("derives the same public key as the generator did", () => {
    const pair = generateKeyPair("x25519");
    expect(publicKeyFromPrivate(pair.privateKey, "x25519")).toBe(pair.publicKey);
  });

  test("derives Ed25519 public keys too", () => {
    const pair = generateKeyPair("ed25519");
    expect(publicKeyFromPrivate(pair.privateKey, "ed25519")).toBe(pair.publicKey);
  });

  test("converts between the base64 wire format and the UAPI's hex", () => {
    const { publicKey } = generateKeyPair("x25519");
    expect(hexToKey(keyToHex(publicKey))).toBe(publicKey);
    expect(keyToHex(publicKey)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("rejects malformed keys", () => {
    expect(isValidKey("nope")).toBe(false);
    expect(isValidKey(`${"A".repeat(42)}=`)).toBe(false);
  });
});

describe("signatures", () => {
  test("round-trips", () => {
    const { publicKey, privateKey } = generateKeyPair("ed25519");
    const sig = sign(privateKey, "hello");
    expect(verify(publicKey, "hello", sig)).toBe(true);
  });

  test("rejects a tampered message", () => {
    const { publicKey, privateKey } = generateKeyPair("ed25519");
    expect(verify(publicKey, "hello!", sign(privateKey, "hello"))).toBe(false);
  });

  test("rejects a signature from another key", () => {
    const a = generateKeyPair("ed25519");
    const b = generateKeyPair("ed25519");
    expect(verify(a.publicKey, "hello", sign(b.privateKey, "hello"))).toBe(false);
  });

  test("returns false instead of throwing on garbage input", () => {
    expect(verify("not-a-key", "hello", "not-a-signature")).toBe(false);
  });
});

describe("canonicalJson", () => {
  test("is independent of key order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  test("keeps array order", () => {
    expect(canonicalJson([3, 1, 2])).toBe("[3,1,2]");
  });

  test("sorts nested objects", () => {
    expect(canonicalJson({ z: { y: 1, x: 2 }, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"z":{"x":2,"y":1}}',
    );
  });

  test("drops undefined properties, so they cannot change a signature", () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  test("signature survives a JSON round trip with reordered keys", () => {
    const { publicKey, privateKey } = generateKeyPair("ed25519");
    const doc = { peers: [{ id: "n1", ip: "100.64.0.1" }], version: 3 };
    const sig = sign(privateKey, canonicalJson(doc));
    const reparsed = JSON.parse('{"version":3,"peers":[{"ip":"100.64.0.1","id":"n1"}]}');
    expect(verify(publicKey, canonicalJson(reparsed), sig)).toBe(true);
  });
});
