// Minimal STUN client (RFC 5389 Binding Request) that shares the data-path
// socket. Sharing the socket is the whole point: the mapping a STUN server
// reports is only useful if it belongs to the port the peer traffic uses.

import { bytesToHex } from "./proto.ts";

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

export interface Mapped {
  ip: string;
  port: number;
}

type Pending = {
  resolve: (m: Mapped) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class StunClient {
  private pending = new Map<string, Pending>();

  constructor(private readonly send: (data: Uint8Array, port: number, ip: string) => void) {}

  /** True if the datagram is a STUN message (checked via the magic cookie). */
  static looksLikeStun(buf: Uint8Array): boolean {
    if (buf.length < 20) return false;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    return v.getUint32(4) === MAGIC_COOKIE;
  }

  query(ip: string, port: number, timeoutMs = 2500): Promise<Mapped> {
    const packet = new Uint8Array(20);
    const v = new DataView(packet.buffer);
    v.setUint16(0, BINDING_REQUEST);
    v.setUint16(2, 0); // no attributes
    v.setUint32(4, MAGIC_COOKIE);
    crypto.getRandomValues(packet.subarray(8, 20));
    const txid = bytesToHex(packet.subarray(8, 20));

    return new Promise<Mapped>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(txid);
        reject(new Error(`STUN timeout: ${ip}:${port}`));
      }, timeoutMs);
      this.pending.set(txid, { resolve, reject, timer });
      // Retransmit once: UDP, and the first packet also has to open the NAT.
      this.send(packet, port, ip);
      setTimeout(() => this.pending.has(txid) && this.send(packet, port, ip), 400);
    });
  }

  /** Feed an inbound datagram; returns true when it was a response we awaited. */
  handle(buf: Uint8Array): boolean {
    if (!StunClient.looksLikeStun(buf)) return false;
    const v = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (v.getUint16(0) !== BINDING_SUCCESS) return true; // STUN, but not a success we can use
    const txid = bytesToHex(buf.subarray(8, 20));
    const p = this.pending.get(txid);
    if (!p) return true;
    this.pending.delete(txid);
    clearTimeout(p.timer);
    const mapped = parseMapped(buf, v);
    if (mapped) p.resolve(mapped);
    else p.reject(new Error("STUN response without usable address"));
    return true;
  }
}

function parseMapped(buf: Uint8Array, v: DataView): Mapped | null {
  const end = Math.min(buf.length, 20 + v.getUint16(2));
  let off = 20;
  while (off + 4 <= end) {
    const type = v.getUint16(off);
    const len = v.getUint16(off + 2);
    const val = off + 4;
    if (val + len > buf.length) break;

    if ((type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_MAPPED_ADDRESS) && buf[val + 1] === 0x01) {
      const xor = type === ATTR_XOR_MAPPED_ADDRESS;
      const port = v.getUint16(val + 2) ^ (xor ? MAGIC_COOKIE >>> 16 : 0);
      const raw = v.getUint32(val + 4) ^ (xor ? MAGIC_COOKIE : 0);
      const ip = [raw >>> 24, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join(".");
      return { ip, port };
    }
    off = val + len + ((4 - (len % 4)) % 4); // attributes are 4-byte aligned
  }
  return null;
}

export const DEFAULT_STUN_SERVERS = ["stun.l.google.com:19302", "stun.cloudflare.com:3478"];

/**
 * Compare mappings observed from two different STUN servers on the same local
 * port. This is the single best predictor of whether hole punching can work.
 */
export function classifyMapping(results: Mapped[]): string {
  const [first, ...rest] = results.filter(Boolean);
  if (!first || rest.length === 0) return "unknown (need two STUN answers)";
  const sameIp = rest.every((r) => r.ip === first.ip);
  const samePort = rest.every((r) => r.port === first.port);
  if (sameIp && samePort) return "endpoint-independent (cone) - hole punching should work";
  if (sameIp) return "address-dependent / symmetric - direct punching will likely FAIL, needs relay (M4)";
  return "multiple external IPs - load-balanced NAT, punching unreliable";
}
