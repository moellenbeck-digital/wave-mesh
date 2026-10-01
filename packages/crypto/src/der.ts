/**
 * Just enough DER to build a CSR on a node and read it back on the server.
 *
 * Why by hand: the only things that need ASN.1 here are a PKCS#10 request, the
 * two fields of a certificate that ARI asks for (serial number and authority
 * key identifier) and the ECDSA signature envelope. A general X.509 library
 * brings a dependency injection container into a binary that is compiled with
 * `bun build --compile` -- and this project has already learned what build-time
 * transformation does to code that relies on runtime names (see the tray). The
 * encoder below is a few dozen lines and every one of them is exercised by a
 * round trip in the tests.
 *
 * Only definite-length encodings exist in DER, which is what makes a reader
 * this small correct rather than merely short.
 */

export const Tag = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** Tag byte of a context-specific element, e.g. `[0]` in a CSR's attributes. */
export const context = (number: number, constructed = true): number =>
  0x80 | (constructed ? 0x20 : 0) | number;

function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.of(length);
  const bytes: number[] = [];
  for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function encode(tag: number, ...content: Buffer[]): Buffer {
  const body = Buffer.concat(content);
  return Buffer.concat([Buffer.of(tag), encodeLength(body.length), body]);
}

export const sequence = (...content: Buffer[]): Buffer => encode(Tag.SEQUENCE, ...content);
export const set = (...content: Buffer[]): Buffer => encode(Tag.SET, ...content);
export const octetString = (content: Buffer): Buffer => encode(Tag.OCTET_STRING, content);
export const ia5String = (value: string): Buffer => encode(Tag.IA5_STRING, Buffer.from(value, "ascii"));
export const utf8String = (value: string): Buffer => encode(Tag.UTF8_STRING, Buffer.from(value, "utf8"));
export const boolean = (value: boolean): Buffer => encode(Tag.BOOLEAN, Buffer.of(value ? 0xff : 0x00));
export const nullValue = (): Buffer => encode(Tag.NULL);

/** A BIT STRING that holds whole bytes -- the only kind we ever write. */
export const bitString = (content: Buffer): Buffer => encode(Tag.BIT_STRING, Buffer.of(0), content);

/** Non-negative integer from its value bytes; a leading zero keeps it positive. */
export function integer(value: number | Buffer): Buffer {
  let bytes = typeof value === "number" ? numberToBytes(value) : value;
  while (bytes.length > 1 && bytes[0] === 0 && ((bytes[1] as number) & 0x80) === 0) bytes = bytes.subarray(1);
  const first = bytes[0] ?? 0;
  return encode(Tag.INTEGER, first & 0x80 ? Buffer.concat([Buffer.of(0), bytes]) : bytes);
}

function numberToBytes(value: number): Buffer {
  if (value === 0) return Buffer.of(0);
  const bytes: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return Buffer.from(bytes);
}

/** "1.2.840.113549.1.9.14" -- the first two arcs share a byte, the rest is base 128. */
export function oid(dotted: string): Buffer {
  const arcs = dotted.split(".").map(Number);
  const [first = 0, second = 0] = arcs;
  const bytes = [first * 40 + second];
  for (const arc of arcs.slice(2)) {
    const chunk: number[] = [arc % 128];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) {
      chunk.unshift((rest % 128) | 0x80);
    }
    bytes.push(...chunk);
  }
  return encode(Tag.OID, Buffer.from(bytes));
}

export interface Element {
  tag: number;
  /** The value bytes, without tag and length. */
  content: Buffer;
  /** Offset just past this element, for walking a sequence. */
  end: number;
  /** The element including its header -- what a signature is computed over. */
  raw: Buffer;
}

export function read(buffer: Buffer, offset = 0): Element {
  const tag = buffer[offset];
  const lengthByte = buffer[offset + 1];
  if (tag === undefined || lengthByte === undefined) throw new Error("truncated DER element");

  let cursor = offset + 2;
  let length = lengthByte;
  if (lengthByte & 0x80) {
    const count = lengthByte & 0x7f;
    // Indefinite length (0x80) is BER, not DER, and nothing here should use it.
    if (count === 0 || count > 4) throw new Error("unsupported DER length");
    length = 0;
    for (let i = 0; i < count; i++) {
      const byte = buffer[cursor + i];
      if (byte === undefined) throw new Error("truncated DER length");
      length = length * 256 + byte;
    }
    cursor += count;
  }
  const end = cursor + length;
  if (end > buffer.length) throw new Error("DER element runs past the end of the buffer");
  return { tag, content: buffer.subarray(cursor, end), end, raw: buffer.subarray(offset, end) };
}

/** The elements of a constructed value, in order. */
export function items(content: Buffer): Element[] {
  const out: Element[] = [];
  for (let offset = 0; offset < content.length; ) {
    const element = read(content, offset);
    out.push(element);
    offset = element.end;
  }
  return out;
}

/** Dotted form of an OID's value bytes, for comparing against a constant. */
export function oidString(content: Buffer): string {
  const first = content[0] ?? 0;
  const arcs = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (const byte of content.subarray(1)) {
    value = value * 128 + (byte & 0x7f);
    if (!(byte & 0x80)) {
      arcs.push(value);
      value = 0;
    }
  }
  return arcs.join(".");
}

const PEM_LINE = 64;

export function toPem(label: string, der: Buffer): string {
  const body = der.toString("base64");
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += PEM_LINE) lines.push(body.slice(i, i + PEM_LINE));
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** The first block of a PEM file, or the one with the given label. */
export function fromPem(pem: string, label?: string): Buffer {
  const pattern = new RegExp(
    `-----BEGIN ${label ?? "[A-Z0-9 ]+"}-----([\\s\\S]*?)-----END ${label ?? "[A-Z0-9 ]+"}-----`,
  );
  const match = pattern.exec(pem);
  if (!match?.[1]) throw new Error(`no ${label ?? "PEM"} block found`);
  return Buffer.from(match[1].replace(/\s+/g, ""), "base64");
}

/** Every block of a PEM file with the given label -- a chain has several. */
export function allFromPem(pem: string, label = "CERTIFICATE"): Buffer[] {
  const pattern = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`, "g");
  const out: Buffer[] = [];
  for (const match of pem.matchAll(pattern)) {
    if (match[1]) out.push(Buffer.from(match[1].replace(/\s+/g, ""), "base64"));
  }
  return out;
}
