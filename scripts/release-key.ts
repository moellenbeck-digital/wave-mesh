#!/usr/bin/env bun
/**
 * Makes a new release signing key (D13).
 *
 *   bun scripts/release-key.ts > release-key.txt
 *
 * Prints two lines: the private key, which belongs in the repository secret
 * WAVE_RELEASE_SIGNING_KEY and nowhere else, and the public key, which goes
 * into RELEASE_PUBLIC_KEYS in packages/crypto/src/release.ts. The private
 * line comes first so that `head -1 | gh secret set WAVE_RELEASE_SIGNING_KEY`
 * never puts it on a screen.
 *
 * Rotating: add the new public key to the list, ship a release signed with the
 * old one, switch the secret, and drop the old key from the list a release
 * later -- a device only trusts the keys of the binary it is running.
 */
import { generateKeyPair } from "../packages/crypto/src/index.ts";

const key = generateKeyPair("ed25519");
console.log(key.privateKey);
console.error(`public key: ${key.publicKey}`);
console.log(key.publicKey);
