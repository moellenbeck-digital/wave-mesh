import { publicKeyFromPrivate } from "./keys.ts";
import { canonicalJson, sign, verify } from "./sign.ts";

/**
 * The keys a release has to be signed with to be installed (D13).
 *
 * Compiled into every binary, and the only thing a device trusts about an
 * update. Where the bytes came from does not enter into it: the control
 * server passes releases through, it never signs one, and a server that could
 * would be able to run code as root on every device in its wave.
 *
 * Several are allowed so a key can be rotated: a release signed with the old
 * key carries a binary that already knows the new one. scripts/release-key.ts
 * makes a pair; the private half lives only in the repository secret
 * WAVE_RELEASE_SIGNING_KEY.
 */
export const RELEASE_PUBLIC_KEYS: readonly string[] = ["TSjv8YQ8duz5qzRzFD1d7m4enUPzQFJ6EwIdSHOsIS0="];

/** Signs a release manifest; the release job is the only caller. */
export function signRelease(manifest: unknown, privateKey: string): { signature: string; keyId: string } {
  return {
    signature: sign(privateKey, canonicalJson(manifest)),
    keyId: publicKeyFromPrivate(privateKey, "ed25519"),
  };
}

/**
 * Whether a manifest carries a valid signature from a key this build trusts.
 * The key named in the release has to be on the list -- a signature that
 * verifies against a key it brought along itself proves nothing.
 */
export function verifyRelease(
  manifest: unknown,
  signature: string,
  keyId: string,
  trusted: readonly string[] = RELEASE_PUBLIC_KEYS,
): boolean {
  if (!trusted.includes(keyId)) return false;
  return verify(keyId, canonicalJson(manifest), signature);
}
