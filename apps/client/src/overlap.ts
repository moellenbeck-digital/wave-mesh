/**
 * Guards against two waves claiming the same address.
 *
 * A control server hands every wave a block of its own, so the waves on one
 * server never collide. Two independent servers know nothing about each other
 * and can both hand out 100.64.0.0/16 — and then the client would end up with
 * two host routes for 100.64.0.5, one of which silently wins.
 *
 * There is no repair for that from here: renumbering a wave is the server's
 * business. So the second tunnel is refused, by name, and the first keeps
 * running untouched.
 */

interface Range {
  /** First address as a number; v6 is compared as a canonical string prefix. */
  start: bigint;
  end: bigint;
}

const ipv4ToBigInt = (ip: string): bigint =>
  ip.split(".").reduce((value, part) => (value << 8n) + BigInt(Number(part)), 0n);

/** Expands "::" and returns the address as one number. */
function ipv6ToBigInt(ip: string): bigint {
  const [head, tail] = ip.split("::");
  const left = head ? head.split(":").filter(Boolean) : [];
  const right = tail ? tail.split(":").filter(Boolean) : [];
  const missing = 8 - left.length - right.length;
  const groups =
    tail === undefined ? left : [...left, ...Array.from({ length: missing }, () => "0"), ...right];
  return groups.reduce((value, group) => (value << 16n) + BigInt(Number.parseInt(group || "0", 16)), 0n);
}

/** A CIDR as the span of addresses it covers. Unparseable input covers nothing. */
export function toRange(cidr: string): Range | null {
  const [address, bits] = cidr.split("/");
  if (!address) return null;
  const v6 = address.includes(":");
  const width = v6 ? 128 : 32;
  const prefix = bits === undefined ? width : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > width) return null;

  let base: bigint;
  try {
    base = v6 ? ipv6ToBigInt(address) : ipv4ToBigInt(address);
  } catch {
    return null;
  }
  const size = 1n << BigInt(width - prefix);
  const masked = (base / size) * size;
  // v4 and v6 must never compare equal, so v6 is lifted out of v4's range.
  const offset = v6 ? 1n << 160n : 0n;
  return { start: masked + offset, end: masked + size - 1n + offset };
}

const overlaps = (a: Range, b: Range): boolean => a.start <= b.end && b.start <= a.end;

export interface Claim {
  /** The wave holding these addresses, named by its control server. */
  controlUrl: string;
  cidrs: string[];
}

export interface Conflict {
  cidr: string;
  /** The profile that already holds an overlapping range. */
  heldBy: string;
  held: string;
}

/**
 * The first address `wanted` shares with something already configured, or null
 * when the two are disjoint.
 */
export function findConflict(wanted: string[], held: Claim[]): Conflict | null {
  const mine = wanted.flatMap((cidr) => {
    const range = toRange(cidr);
    return range ? [{ cidr, range }] : [];
  });

  for (const claim of held) {
    for (const cidr of claim.cidrs) {
      const range = toRange(cidr);
      if (!range) continue;
      for (const candidate of mine) {
        if (overlaps(candidate.range, range)) {
          return { cidr: candidate.cidr, heldBy: claim.controlUrl, held: cidr };
        }
      }
    }
  }
  return null;
}

/** What to tell the user, naming both waves so they know where to look. */
export const describeConflict = (profile: string, conflict: Conflict): string =>
  `${profile} wants ${conflict.cidr}, which ${conflict.heldBy} already uses (${conflict.held}). ` +
  "Two waves cannot share an address on one device — give one of them a different range on its " +
  `control server, then bring ${profile} up again. ${conflict.heldBy} keeps running.`;
