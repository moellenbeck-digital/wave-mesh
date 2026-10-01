import { createHash, diffieHellman } from "node:crypto";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { rawToPrivateKeyObject, rawToPublicKeyObject } from "@wave/crypto";

/**
 * Authenticated encryption between two disco keys.
 *
 * Discovery packets travel on the same unauthenticated UDP socket as WireGuard
 * traffic, and they are what teaches us which address belongs to which peer.
 * If they were forgeable, anyone could redirect a peer's traffic to an address
 * of their choosing, so every packet is sealed to the recipient's disco key.
 */

const NONCE_LENGTH = 24;
const CONTEXT = "wave-disco-v1";

/** X25519 shared secret, hashed with a context string as the symmetric key. */
export function sharedKey(privateKeyBase64: string, peerPublicKeyBase64: string): Uint8Array {
  const secret = diffieHellman({
    privateKey: rawToPrivateKeyObject(Buffer.from(privateKeyBase64, "base64"), "x25519"),
    publicKey: rawToPublicKeyObject(Buffer.from(peerPublicKeyBase64, "base64"), "x25519"),
  });
  return new Uint8Array(createHash("sha256").update(CONTEXT).update(secret).digest());
}

export function seal(key: Uint8Array, plaintext: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  return { nonce, ciphertext: xchacha20poly1305(key, nonce).encrypt(plaintext) };
}

/** Returns null on any authentication failure -- a forged packet is just noise. */
export function open(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array): Uint8Array | null {
  try {
    return xchacha20poly1305(key, nonce).decrypt(ciphertext);
  } catch {
    return null;
  }
}

export { NONCE_LENGTH };
