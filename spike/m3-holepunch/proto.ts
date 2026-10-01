// Wire formats for the M3 spike. Throwaway: no authentication, no encryption.
// The real implementation replaces disco packets with NaCl-box-sealed messages
// keyed by the peer's disco key (see docs/PLAN.md D1/D3).

/** Prefix that separates our discovery packets from WireGuard packets (0x01..0x04). */
export const DISCO_MAGIC = new Uint8Array([0x77, 0x61, 0x76, 0x65, 0x64, 0x63]); // "wavedc"
export const DISCO_VERSION = 1;

export const DiscoType = { Ping: 1, Pong: 2 } as const;
export type DiscoType = (typeof DiscoType)[keyof typeof DiscoType];

export interface DiscoPacket {
  type: DiscoType;
  /** 8 random bytes, echoed by Pong so the pinger can measure RTT. */
  txid: string;
  /** Sender name, so a peer can tell who reached it from an unknown address. */
  from: string;
}

export function encodeDisco(p: DiscoPacket): Uint8Array {
  const from = new TextEncoder().encode(p.from);
  const txid = hexToBytes(p.txid);
  const out = new Uint8Array(DISCO_MAGIC.length + 2 + 8 + 1 + from.length);
  let o = 0;
  out.set(DISCO_MAGIC, o);
  o += DISCO_MAGIC.length;
  out[o++] = DISCO_VERSION;
  out[o++] = p.type;
  out.set(txid, o);
  o += 8;
  out[o++] = from.length;
  out.set(from, o);
  return out;
}

export function decodeDisco(buf: Uint8Array): DiscoPacket | null {
  if (buf.length < DISCO_MAGIC.length + 11) return null;
  for (let i = 0; i < DISCO_MAGIC.length; i++) if (buf[i] !== DISCO_MAGIC[i]) return null;
  let o = DISCO_MAGIC.length;
  if (buf[o++] !== DISCO_VERSION) return null;
  const type = buf[o++] as DiscoType;
  if (type !== DiscoType.Ping && type !== DiscoType.Pong) return null;
  const txid = bytesToHex(buf.subarray(o, o + 8));
  o += 8;
  const nameLen = buf[o++] ?? 0;
  if (o + nameLen > buf.length) return null;
  return { type, txid, from: new TextDecoder().decode(buf.subarray(o, o + nameLen)) };
}

export function newTxid(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(8)));
}

export function bytesToHex(b: Uint8Array): string {
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(h: string): Uint8Array {
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// ---------------------------------------------------------------------------
// Rendezvous protocol (JSON over WebSocket). Stands in for the control server's
// /v1/control WebSocket; only does candidate exchange and the simultaneous
// "punch now" signal.
// ---------------------------------------------------------------------------

export interface Candidate {
  kind: "local" | "stun" | "learned";
  ip: string;
  port: number;
}

export const candKey = (c: { ip: string; port: number }) => `${c.ip}:${c.port}`;

export type ClientMessage =
  | { type: "hello"; room: string; name: string; candidates: Candidate[]; mapping: string }
  | { type: "result"; name: string; summary: string };

export type ServerMessage =
  | { type: "peer"; name: string; candidates: Candidate[]; mapping: string }
  | { type: "go" }
  | { type: "gone"; name: string }
  | { type: "error"; message: string };
