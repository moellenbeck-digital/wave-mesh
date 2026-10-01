/**
 * STUN client (RFC 5389 binding request) that shares the data-path socket.
 *
 * Sharing matters: the mapping a STUN server reports only describes the port
 * the request went out of, so asking from a separate socket would return an
 * address no peer can use.
 */

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const ATTR_MAPPED_ADDRESS = 0x0001;
const ATTR_XOR_MAPPED_ADDRESS = 0x0020;

export interface Mapped {
  ip: string;
  port: number;
}

export const looksLikeStun = (packet: Uint8Array): boolean => {
  if (packet.length < 20) return false;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  return view.getUint32(4) === MAGIC_COOKIE;
};

export function buildBindingRequest(): { packet: Uint8Array; txid: string } {
  const packet = new Uint8Array(20);
  const view = new DataView(packet.buffer);
  view.setUint16(0, BINDING_REQUEST);
  view.setUint16(2, 0);
  view.setUint32(4, MAGIC_COOKIE);
  crypto.getRandomValues(packet.subarray(8, 20));
  return { packet, txid: Buffer.from(packet.subarray(8, 20)).toString("hex") };
}

export function parseBindingResponse(packet: Uint8Array): { txid: string; mapped: Mapped } | null {
  if (!looksLikeStun(packet)) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);
  if (view.getUint16(0) !== BINDING_SUCCESS) return null;
  const txid = Buffer.from(packet.subarray(8, 20)).toString("hex");

  const end = Math.min(packet.length, 20 + view.getUint16(2));
  let offset = 20;
  while (offset + 4 <= end) {
    const type = view.getUint16(offset);
    const length = view.getUint16(offset + 2);
    const value = offset + 4;
    if (value + length > packet.length) break;

    if ((type === ATTR_XOR_MAPPED_ADDRESS || type === ATTR_MAPPED_ADDRESS) && packet[value + 1] === 0x01) {
      const xor = type === ATTR_XOR_MAPPED_ADDRESS;
      const port = view.getUint16(value + 2) ^ (xor ? MAGIC_COOKIE >>> 16 : 0);
      const raw = (view.getUint32(value + 4) ^ (xor ? MAGIC_COOKIE : 0)) >>> 0;
      const ip = [raw >>> 24, (raw >>> 16) & 255, (raw >>> 8) & 255, raw & 255].join(".");
      return { txid, mapped: { ip, port } };
    }
    offset = value + length + ((4 - (length % 4)) % 4);
  }
  return null;
}

/** Builds a success response for a request -- used by the STUN server. */
export function buildBindingResponse(request: Uint8Array, source: Mapped): Uint8Array {
  const response = new Uint8Array(32);
  const view = new DataView(response.buffer);
  view.setUint16(0, BINDING_SUCCESS);
  view.setUint16(2, 12); // one XOR-MAPPED-ADDRESS attribute
  view.setUint32(4, MAGIC_COOKIE);
  response.set(request.subarray(8, 20), 8);

  view.setUint16(20, ATTR_XOR_MAPPED_ADDRESS);
  view.setUint16(22, 8);
  response[24] = 0;
  response[25] = 0x01; // IPv4
  view.setUint16(26, source.port ^ (MAGIC_COOKIE >>> 16));
  const octets = source.ip.split(".").map(Number);
  const address =
    ((octets[0] ?? 0) * 2 ** 24 +
      (octets[1] ?? 0) * 2 ** 16 +
      (octets[2] ?? 0) * 2 ** 8 +
      (octets[3] ?? 0)) >>>
    0;
  view.setUint32(28, (address ^ MAGIC_COOKIE) >>> 0);
  return response;
}

export const isBindingRequest = (packet: Uint8Array): boolean => {
  if (!looksLikeStun(packet)) return false;
  return new DataView(packet.buffer, packet.byteOffset, packet.byteLength).getUint16(0) === BINDING_REQUEST;
};

/**
 * Comparing the mappings two different servers report is the cheapest reliable
 * predictor of whether hole punching can work at all.
 */
export function classifyMapping(
  results: Mapped[],
): "endpoint-independent" | "address-dependent" | "undetermined" {
  const [first, ...rest] = results;
  // One answer tells us our address but nothing about how the NAT behaves:
  // the question is whether the mapping changes per destination.
  if (!first || rest.length === 0) return "undetermined";
  const same = rest.every((r) => r.ip === first.ip && r.port === first.port);
  return same ? "endpoint-independent" : "address-dependent";
}
