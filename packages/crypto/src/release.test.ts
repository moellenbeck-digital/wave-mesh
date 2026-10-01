import { describe, expect, test } from "bun:test";
import { generateKeyPair } from "./keys.ts";
import { RELEASE_PUBLIC_KEYS, signRelease, verifyRelease } from "./release.ts";

const manifest = { version: "0.2.0", channel: "stable", archives: [] };

describe("release signatures", () => {
  test("verify against the trusted keys, whatever order the fields come in", () => {
    const key = generateKeyPair("ed25519");
    const { signature, keyId } = signRelease(manifest, key.privateKey);
    expect(keyId).toBe(key.publicKey);
    const reordered = { archives: [], channel: "stable", version: "0.2.0" };
    expect(verifyRelease(reordered, signature, keyId, [key.publicKey])).toBe(true);
  });

  test("a key the build does not carry proves nothing, even if it signed correctly", () => {
    const key = generateKeyPair("ed25519");
    const { signature, keyId } = signRelease(manifest, key.privateKey);
    expect(verifyRelease(manifest, signature, keyId)).toBe(false);
    expect(RELEASE_PUBLIC_KEYS).not.toContain(keyId);
  });

  test("a changed channel breaks the signature", () => {
    const key = generateKeyPair("ed25519");
    const { signature, keyId } = signRelease(manifest, key.privateKey);
    expect(verifyRelease({ ...manifest, channel: "develop" }, signature, keyId, [keyId])).toBe(false);
  });

  test("the built-in keys are well-formed", () => {
    expect(RELEASE_PUBLIC_KEYS.length).toBeGreaterThan(0);
    for (const key of RELEASE_PUBLIC_KEYS) expect(Buffer.from(key, "base64").length).toBe(32);
  });
});
