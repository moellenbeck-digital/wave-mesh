import { z } from "zod";

/**
 * Wire format between a node and a relay.
 *
 * Data frames are binary and deliberately minimal: one 32-byte disco key plus
 * the payload. Outbound the key names the recipient, inbound it names the
 * sender, so both directions share one shape. The payload is WireGuard
 * ciphertext or a sealed discovery packet -- the relay can read neither.
 */

export const KEY_LENGTH = 32;
export const MAX_PAYLOAD = 64 * 1024;

export function encodeFrame(discoKey: string, payload: Uint8Array): Uint8Array {
  const key = Buffer.from(discoKey, "base64");
  if (key.length !== KEY_LENGTH) throw new Error("disco key must be 32 bytes");
  const frame = new Uint8Array(KEY_LENGTH + payload.length);
  frame.set(key, 0);
  frame.set(payload, KEY_LENGTH);
  return frame;
}

export function decodeFrame(frame: Uint8Array): { discoKey: string; payload: Uint8Array } | null {
  if (frame.length <= KEY_LENGTH || frame.length > KEY_LENGTH + MAX_PAYLOAD) return null;
  return {
    discoKey: Buffer.from(frame.subarray(0, KEY_LENGTH)).toString("base64"),
    payload: frame.subarray(KEY_LENGTH),
  };
}

// --- handshake (JSON, once per connection) ----------------------------------

export const ClientHello = z.object({ t: z.literal("hello"), discoKey: z.string() });
export const RelayChallenge = z.object({
  t: z.literal("challenge"),
  relayKey: z.string(),
  nonce: z.string(),
  box: z.string(),
});
export const ClientProof = z.object({ t: z.literal("proof"), token: z.string() });
export const RelayReady = z.object({ t: z.literal("ready") });
export const RelayError = z.object({ t: z.literal("error"), message: z.string() });

export const ClientHandshake = z.discriminatedUnion("t", [ClientHello, ClientProof]);
export const RelayHandshake = z.discriminatedUnion("t", [RelayChallenge, RelayReady, RelayError]);

export type ClientHandshake = z.infer<typeof ClientHandshake>;
export type RelayHandshake = z.infer<typeof RelayHandshake>;
