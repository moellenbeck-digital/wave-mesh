import { NONCE_LENGTH, open, seal } from "./box.ts";

/**
 * Wire format:
 *
 *   magic(6) | version(1) | senderDiscoKey(32) | nonce(24) | ciphertext
 *
 * The magic prefix is what keeps discovery packets apart from WireGuard's own
 * messages, whose first byte is 1..4. The sender's key travels in the clear
 * because the receiver needs it to derive the shared secret -- it is a public
 * key, and the payload it protects is authenticated.
 */
export const DISCO_MAGIC = new Uint8Array([0x77, 0x61, 0x76, 0x65, 0x64, 0x63]); // "wavedc"
export const DISCO_VERSION = 1;
const HEADER_LENGTH = DISCO_MAGIC.length + 1 + 32 + NONCE_LENGTH;

export const MessageType = { Ping: 1, Pong: 2, CallMeMaybe: 3 } as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

export interface Endpoint {
  ip: string;
  port: number;
}

export type DiscoMessage =
  | { type: "ping"; txid: Uint8Array }
  /** Echoes the ping's txid and tells the sender which address we saw it from. */
  | { type: "pong"; txid: Uint8Array; observed: Endpoint }
  | { type: "call-me-maybe"; endpoints: Endpoint[] };

export const looksLikeDisco = (packet: Uint8Array): boolean => {
  if (packet.length < HEADER_LENGTH) return false;
  return DISCO_MAGIC.every((byte, index) => packet[index] === byte);
};

export const newTxid = (): Uint8Array => crypto.getRandomValues(new Uint8Array(8));
export const txidToHex = (txid: Uint8Array): string => Buffer.from(txid).toString("hex");

function encodeEndpoint(endpoint: Endpoint): Uint8Array {
  const isIpv6 = endpoint.ip.includes(":");
  const address = isIpv6 ? ipv6ToBytes(endpoint.ip) : Uint8Array.from(endpoint.ip.split(".").map(Number));
  const out = new Uint8Array(1 + address.length + 2);
  out[0] = isIpv6 ? 6 : 4;
  out.set(address, 1);
  new DataView(out.buffer).setUint16(1 + address.length, endpoint.port);
  return out;
}

function decodeEndpoint(bytes: Uint8Array, offset: number): { endpoint: Endpoint; next: number } | null {
  const family = bytes[offset];
  const length = family === 4 ? 4 : family === 6 ? 16 : 0;
  if (!length || offset + 1 + length + 2 > bytes.length) return null;
  const address = bytes.subarray(offset + 1, offset + 1 + length);
  const port = new DataView(bytes.buffer, bytes.byteOffset).getUint16(offset + 1 + length);
  const ip = family === 4 ? Array.from(address).join(".") : bytesToIpv6(address);
  return { endpoint: { ip, port }, next: offset + 1 + length + 2 };
}

function encodeMessage(message: DiscoMessage): Uint8Array {
  switch (message.type) {
    case "ping": {
      const out = new Uint8Array(9);
      out[0] = MessageType.Ping;
      out.set(message.txid, 1);
      return out;
    }
    case "pong": {
      const observed = encodeEndpoint(message.observed);
      const out = new Uint8Array(9 + observed.length);
      out[0] = MessageType.Pong;
      out.set(message.txid, 1);
      out.set(observed, 9);
      return out;
    }
    case "call-me-maybe": {
      const parts = message.endpoints.map(encodeEndpoint);
      const out = new Uint8Array(1 + parts.reduce((sum, p) => sum + p.length, 0));
      out[0] = MessageType.CallMeMaybe;
      let offset = 1;
      for (const part of parts) {
        out.set(part, offset);
        offset += part.length;
      }
      return out;
    }
  }
}

function decodeMessage(bytes: Uint8Array): DiscoMessage | null {
  const type = bytes[0];
  if (type === MessageType.Ping && bytes.length >= 9) {
    return { type: "ping", txid: bytes.slice(1, 9) };
  }
  if (type === MessageType.Pong && bytes.length >= 9) {
    const observed = decodeEndpoint(bytes, 9);
    if (!observed) return null;
    return { type: "pong", txid: bytes.slice(1, 9), observed: observed.endpoint };
  }
  if (type === MessageType.CallMeMaybe) {
    const endpoints: Endpoint[] = [];
    let offset = 1;
    while (offset < bytes.length) {
      const decoded = decodeEndpoint(bytes, offset);
      if (!decoded) return null;
      endpoints.push(decoded.endpoint);
      offset = decoded.next;
    }
    return { type: "call-me-maybe", endpoints };
  }
  return null;
}

export function encodeDisco(input: {
  senderDiscoKey: string;
  sharedKey: Uint8Array;
  message: DiscoMessage;
}): Uint8Array {
  const { nonce, ciphertext } = seal(input.sharedKey, encodeMessage(input.message));
  const packet = new Uint8Array(HEADER_LENGTH + ciphertext.length);
  let offset = 0;
  packet.set(DISCO_MAGIC, offset);
  offset += DISCO_MAGIC.length;
  packet[offset++] = DISCO_VERSION;
  packet.set(Buffer.from(input.senderDiscoKey, "base64"), offset);
  offset += 32;
  packet.set(nonce, offset);
  offset += NONCE_LENGTH;
  packet.set(ciphertext, offset);
  return packet;
}

export interface DecodedDisco {
  senderDiscoKey: string;
  message: DiscoMessage;
}

/**
 * Decodes a packet, given a way to look up the shared key for a sender. The
 * lookup returning null (an unknown peer) and decryption failing are both just
 * "not for us".
 */
export function decodeDisco(
  packet: Uint8Array,
  sharedKeyFor: (senderDiscoKey: string) => Uint8Array | null,
): DecodedDisco | null {
  if (!looksLikeDisco(packet)) return null;
  let offset = DISCO_MAGIC.length;
  if (packet[offset++] !== DISCO_VERSION) return null;

  const senderDiscoKey = Buffer.from(packet.subarray(offset, offset + 32)).toString("base64");
  offset += 32;
  const nonce = packet.subarray(offset, offset + NONCE_LENGTH);
  offset += NONCE_LENGTH;

  const key = sharedKeyFor(senderDiscoKey);
  if (!key) return null;

  const plaintext = open(key, nonce, packet.subarray(offset));
  if (!plaintext) return null;

  const message = decodeMessage(plaintext);
  return message ? { senderDiscoKey, message } : null;
}

function ipv6ToBytes(ip: string): Uint8Array {
  const [head, tail] = ip.split("::");
  const parse = (part: string) =>
    part
      ? part
          .split(":")
          .filter(Boolean)
          .map((h) => Number.parseInt(h, 16))
      : [];
  const left = parse(head ?? "");
  const right = tail === undefined ? [] : parse(tail);
  const groups = [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  for (const [index, group] of groups.entries()) view.setUint16(index * 2, group);
  return out;
}

function bytesToIpv6(bytes: Uint8Array): string {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const groups: string[] = [];
  for (let i = 0; i < 8; i++) groups.push(view.getUint16(i * 2).toString(16));
  return groups
    .join(":")
    .replace(/\b(?:0:){2,}/, ":")
    .replace(/^0:/, ":");
}
