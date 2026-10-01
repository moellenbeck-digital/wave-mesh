/**
 * Just enough DNS to answer questions about names in a wave.
 *
 * Only what a split-DNS resolver needs: parse a query, build an answer with A,
 * AAAA or CNAME records, or say the name does not exist. Anything else is
 * forwarded verbatim to an upstream resolver, so it never has to be understood.
 */

export const RecordType = { A: 1, CNAME: 5, PTR: 12, AAAA: 28 } as const;
export type RecordType = (typeof RecordType)[keyof typeof RecordType];

export const ResponseCode = {
  NoError: 0,
  FormatError: 1,
  ServerFailure: 2,
  NameError: 3,
  NotImplemented: 4,
} as const;
export type ResponseCode = (typeof ResponseCode)[keyof typeof ResponseCode];

const CLASS_IN = 1;
const MAX_NAME_LENGTH = 255;
const POINTER_MASK = 0xc0;

export interface Question {
  name: string;
  type: number;
  class: number;
}

export interface Query {
  id: number;
  /** Whether the client wants us to resolve on its behalf. */
  recursionDesired: boolean;
  question: Question;
}

export type Answer =
  | { name: string; type: typeof RecordType.A; ttl: number; address: string }
  | { name: string; type: typeof RecordType.AAAA; ttl: number; address: string }
  | { name: string; type: typeof RecordType.CNAME; ttl: number; target: string }
  | { name: string; type: typeof RecordType.PTR; ttl: number; target: string };

/** Parses a query. Returns null for anything malformed rather than throwing. */
export function decodeQuery(packet: Uint8Array): Query | null {
  if (packet.length < 12) return null;
  const view = new DataView(packet.buffer, packet.byteOffset, packet.byteLength);

  const flags = view.getUint16(2);
  const isResponse = (flags & 0x8000) !== 0;
  const opcode = (flags >> 11) & 0xf;
  if (isResponse || opcode !== 0 || view.getUint16(4) !== 1) return null;

  const name = decodeName(packet, 12);
  if (!name) return null;
  if (name.next + 4 > packet.length) return null;

  return {
    id: view.getUint16(0),
    recursionDesired: (flags & 0x0100) !== 0,
    question: {
      name: name.value,
      type: view.getUint16(name.next),
      class: view.getUint16(name.next + 2),
    },
  };
}

function decodeName(packet: Uint8Array, offset: number): { value: string; next: number } | null {
  const labels: string[] = [];
  let cursor = offset;
  let length = 0;

  for (;;) {
    const size = packet[cursor];
    if (size === undefined) return null;
    // Compression pointers are legal but never appear in a question, which is
    // all we parse; refusing them keeps this free of loop handling.
    if ((size & POINTER_MASK) === POINTER_MASK) return null;
    cursor++;
    if (size === 0) break;

    length += size + 1;
    if (length > MAX_NAME_LENGTH || cursor + size > packet.length) return null;
    labels.push(new TextDecoder().decode(packet.subarray(cursor, cursor + size)));
    cursor += size;
  }
  return { value: labels.join("."), next: cursor };
}

function encodeName(name: string): Uint8Array {
  const labels = name.split(".").filter(Boolean);
  const bytes: number[] = [];
  for (const label of labels) {
    const encoded = new TextEncoder().encode(label);
    if (encoded.length > 63) throw new Error(`label too long: ${label}`);
    bytes.push(encoded.length, ...encoded);
  }
  bytes.push(0);
  return Uint8Array.from(bytes);
}

export function encodeIpv4(address: string): Uint8Array {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`not an IPv4 address: ${address}`);
  }
  return Uint8Array.from(parts);
}

export function encodeIpv6(address: string): Uint8Array {
  const [head, tail] = address.split("::");
  const parse = (part: string) =>
    part
      ? part
          .split(":")
          .filter(Boolean)
          .map((group) => Number.parseInt(group, 16))
      : [];
  const left = parse(head ?? "");
  const right = tail === undefined ? [] : parse(tail);
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (tail === undefined && missing !== 0))
    throw new Error(`not an IPv6 address: ${address}`);

  const groups = [...left, ...new Array(missing).fill(0), ...right];
  const out = new Uint8Array(16);
  const view = new DataView(out.buffer);
  for (const [index, group] of groups.entries()) view.setUint16(index * 2, group);
  return out;
}

const recordData = (answer: Answer): Uint8Array => {
  if (answer.type === RecordType.A) return encodeIpv4(answer.address);
  if (answer.type === RecordType.AAAA) return encodeIpv6(answer.address);
  return encodeName(answer.target);
};

export function encodeResponse(input: {
  query: Query;
  answers?: Answer[];
  code?: ResponseCode;
  /** Set when the answer comes from our own records rather than a cache. */
  authoritative?: boolean;
}): Uint8Array {
  const answers = input.answers ?? [];
  const parts: Uint8Array[] = [];

  const header = new Uint8Array(12);
  const headerView = new DataView(header.buffer);
  headerView.setUint16(0, input.query.id);
  const flags =
    0x8000 |
    ((input.authoritative ?? true) ? 0x0400 : 0) |
    (input.query.recursionDesired ? 0x0100 : 0) |
    (input.code ?? ResponseCode.NoError);
  headerView.setUint16(2, flags);
  headerView.setUint16(4, 1);
  headerView.setUint16(6, answers.length);
  parts.push(header);

  parts.push(encodeName(input.query.question.name));
  const questionTail = new Uint8Array(4);
  const questionView = new DataView(questionTail.buffer);
  questionView.setUint16(0, input.query.question.type);
  questionView.setUint16(2, input.query.question.class);
  parts.push(questionTail);

  for (const answer of answers) {
    parts.push(encodeName(answer.name));
    const data = recordData(answer);
    const tail = new Uint8Array(10);
    const tailView = new DataView(tail.buffer);
    tailView.setUint16(0, answer.type);
    tailView.setUint16(2, CLASS_IN);
    tailView.setUint32(4, answer.ttl);
    tailView.setUint16(8, data.length);
    parts.push(tail, data);
  }

  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const packet = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    packet.set(part, offset);
    offset += part.length;
  }
  return packet;
}

/** Case-insensitive, trailing-dot-insensitive comparison, as DNS requires. */
export const normalizeName = (name: string): string => name.toLowerCase().replace(/\.+$/, "");

export const isWithinZone = (name: string, zone: string): boolean => {
  const n = normalizeName(name);
  const z = normalizeName(zone);
  return n === z || n.endsWith(`.${z}`);
};
