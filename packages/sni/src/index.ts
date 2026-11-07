/**
 * Reading which name a connection asks for, without opening it.
 *
 * Two readers share this: the connector's egress (a pod calling a name in the
 * wave) and the pier (the open network calling a name a device put out). Both
 * route on a name and must never terminate TLS, so both only *look* at the first
 * bytes -- the SNI of a ClientHello, or the Host of a plain HTTP request -- and
 * pass every byte on untouched.
 */

/** A name as it is compared: trimmed, lower case, without the root dot. */
export const normalise = (name: string): string => name.trim().toLowerCase().replace(/\.$/, "");

/** What reading the start of a connection came to. */
export type Sniffed = { name: string } | "more" | "none";

/** Enough to read any ClientHello or request head; beyond it the client is not one of either. */
export const MAX_SNIFF = 16 * 1024;

/**
 * The server name a TLS ClientHello asks for.
 *
 * The handshake may be split across several records -- rare, but a large
 * ClientHello (post-quantum key shares are over a kilobyte) is allowed to --
 * so the handshake bytes of consecutive records are put together first.
 */
export function sniFromClientHello(data: Uint8Array): Sniffed {
  const handshake: number[] = [];
  let offset = 0;
  let needed = -1;
  while (offset + 5 <= data.length) {
    if (data[offset] !== 0x16) return "none"; // not a handshake record
    const length = ((data[offset + 3] ?? 0) << 8) | (data[offset + 4] ?? 0);
    if (offset + 5 + length > data.length) {
      for (const byte of data.subarray(offset + 5)) handshake.push(byte);
      break;
    }
    for (const byte of data.subarray(offset + 5, offset + 5 + length)) handshake.push(byte);
    offset += 5 + length;
    if (needed < 0 && handshake.length >= 4) {
      if (handshake[0] !== 0x01) return "none"; // not a ClientHello
      needed = 4 + (((handshake[1] ?? 0) << 16) | ((handshake[2] ?? 0) << 8) | (handshake[3] ?? 0));
    }
    if (needed >= 0 && handshake.length >= needed) break;
  }
  if (needed < 0 && handshake.length >= 4) {
    if (handshake[0] !== 0x01) return "none";
    needed = 4 + (((handshake[1] ?? 0) << 16) | ((handshake[2] ?? 0) << 8) | (handshake[3] ?? 0));
  }
  if (needed < 0 || handshake.length < needed) return data.length >= MAX_SNIFF ? "none" : "more";

  const hello = Uint8Array.from(handshake.slice(4, needed));
  let at = 2 + 32; // version, random
  const read8 = () => hello[at++] ?? 0;
  const read16 = () => {
    const value = ((hello[at] ?? 0) << 8) | (hello[at + 1] ?? 0);
    at += 2;
    return value;
  };
  at += 1 + (hello[at] ?? 0); // session id
  if (at + 2 > hello.length) return "none";
  at += 2 + (((hello[at] ?? 0) << 8) | (hello[at + 1] ?? 0)); // cipher suites
  if (at + 1 > hello.length) return "none";
  at += 1 + (hello[at] ?? 0); // compression methods
  if (at + 2 > hello.length) return "none";
  const end = Math.min(hello.length, at + 2 + (((hello[at] ?? 0) << 8) | (hello[at + 1] ?? 0)));
  at += 2;
  while (at + 4 <= end) {
    const type = read16();
    const length = read16();
    const next = at + length;
    if (type === 0x0000) {
      at += 2; // server name list length
      while (at + 3 <= next) {
        const kind = read8();
        const size = read16();
        if (kind === 0) {
          const name = new TextDecoder().decode(hello.subarray(at, at + size));
          return name ? { name: normalise(name) } : "none";
        }
        at += size;
      }
      return "none";
    }
    at = next;
  }
  return "none";
}

/** The Host of a plain HTTP request, without its port. */
export function hostFromHttp(data: Uint8Array): Sniffed {
  const text = new TextDecoder("latin1").decode(data.subarray(0, MAX_SNIFF));
  const headEnd = text.indexOf("\r\n\r\n");
  if (headEnd < 0) return data.length >= MAX_SNIFF ? "none" : "more";
  for (const line of text.slice(0, headEnd).split("\r\n").slice(1)) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "host") {
      const value = line.slice(colon + 1).trim();
      // [v6]:port, name:port, or a bare name.
      const name = value.startsWith("[") ? value.slice(1, value.indexOf("]")) : value.replace(/:\d+$/, "");
      return name ? { name: normalise(name) } : "none";
    }
  }
  return "none";
}
