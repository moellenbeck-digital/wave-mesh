/** Address allocation inside a wave's prefixes. */

export function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    throw new Error(`not an IPv4 address: ${ip}`);
  }
  return (
    ((parts[0] ?? 0) * 2 ** 24 + (parts[1] ?? 0) * 2 ** 16 + (parts[2] ?? 0) * 2 ** 8 + (parts[3] ?? 0)) >>> 0
  );
}

export const intToIpv4 = (value: number): string =>
  [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");

export function parseIpv4Cidr(cidr: string): { base: number; size: number } {
  const [ip, bits] = cidr.split("/");
  const prefixLength = Number(bits);
  if (!ip || !Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`not an IPv4 CIDR: ${cidr}`);
  }
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return { base: (ipv4ToInt(ip) & mask) >>> 0, size: 2 ** (32 - prefixLength) };
}

/**
 * Where the wave's resolver answers, as an offset into its block.
 *
 * 53 for the obvious reason. What matters is only that it is a fixed offset the
 * allocator never hands to a node: the address has to belong to nobody, because
 * on a phone the resolver has no socket and is reached by *routing* its address
 * into the tunnel. An address the tunnel interface holds is answered locally by
 * the kernel -- where nothing is listening -- and the query never arrives.
 */
export const RESOLVER_OFFSET = 53;

/** The address this wave's resolver answers on. */
export const resolverAddressFor = (cidr: string): string => {
  const { base, size } = parseIpv4Cidr(cidr);
  if (size <= RESOLVER_OFFSET + 1) throw new Error(`${cidr} is too small to reserve a resolver address`);
  return intToIpv4((base + RESOLVER_OFFSET) >>> 0);
};

/**
 * Lowest free address in the prefix. Addresses are never reused while a node
 * still holds them, but a removed node's address becomes available again --
 * the alternative, monotonic allocation, exhausts a small prefix over time.
 */
export function allocateIpv4(cidr: string, taken: Iterable<string>): string {
  const { base, size } = parseIpv4Cidr(cidr);
  const used = new Set<number>();
  for (const ip of taken) used.add(ipv4ToInt(ip));

  // Skip the network address itself; the broadcast address is meaningless in a
  // /32-routed mesh but is left out as well to avoid surprising tooling.
  for (let offset = 1; offset < size - 1; offset++) {
    // And skip the resolver's, which belongs to the wave rather than to any
    // node in it. A wave numbered before this existed may already have given it
    // to somebody -- that node keeps it, and buildNetmap leaves the reservation
    // out instead of pointing DNS at a device.
    if (offset === RESOLVER_OFFSET) continue;
    const candidate = (base + offset) >>> 0;
    if (!used.has(candidate)) return intToIpv4(candidate);
  }
  throw new Error(`no free address left in ${cidr}`);
}

/**
 * Blocks of this many bits or longer count as small and are numbered from the
 * top of the container down; shorter ones (the /16 of a billed wave) from the
 * bottom up. Two ends of one range, so a crowd of small free waves chips away
 * at the last /16 instead of spreading over all of them and leaving no whole
 * /16 for a customer who pays (ticket #118).
 */
export const SMALL_BLOCK_PREFIX_LENGTH = 20;

/** Whether blocks of this length are numbered from the top of the container. */
export const allocatesFromTop = (prefixLength: number): boolean => prefixLength >= SMALL_BLOCK_PREFIX_LENGTH;

/** A half-open range [start, end) of IPv4 addresses, as numbers. */
interface Range {
  start: number;
  end: number;
}

/**
 * What the taken blocks occupy inside the container: sorted, merged, clipped
 * to the container. A block outside it holds nothing here -- a wave that
 * predates the allocation sits somewhere else entirely -- and one that
 * straddles its edge occupies only the part inside.
 */
function occupiedRanges(outer: { base: number; size: number }, taken: Iterable<string>): Range[] {
  const outerEnd = outer.base + outer.size;
  const found: Range[] = [];
  for (const cidr of taken) {
    const block = parseIpv4Cidr(cidr);
    const start = Math.max(block.base, outer.base);
    const end = Math.min(block.base + block.size, outerEnd);
    if (start < end) found.push({ start, end });
  }
  found.sort((a, b) => a.start - b.start);
  const merged: Range[] = [];
  for (const range of found) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Lowest aligned block of `size` that overlaps none of the ranges, or null. */
function lowestFree(outer: { base: number; size: number }, size: number, ranges: Range[]): number | null {
  const outerEnd = outer.base + outer.size;
  let candidate = outer.base;
  let i = 0;
  while (candidate + size <= outerEnd) {
    while (i < ranges.length && (ranges[i] as Range).end <= candidate) i++;
    const hit = ranges[i];
    if (!hit || hit.start >= candidate + size) return candidate;
    // Every aligned candidate below the end of this range overlaps it.
    candidate = Math.ceil(hit.end / size) * size;
  }
  return null;
}

/** Highest aligned block of `size` that overlaps none of the ranges, or null. */
function highestFree(outer: { base: number; size: number }, size: number, ranges: Range[]): number | null {
  let candidate = outer.base + outer.size - size;
  let i = ranges.length - 1;
  while (candidate >= outer.base) {
    while (i >= 0 && (ranges[i] as Range).start >= candidate + size) i--;
    const hit = ranges[i];
    if (!hit || hit.end <= candidate) return candidate;
    candidate = Math.floor(hit.start / size) * size - size;
  }
  return null;
}

/** How many aligned blocks of `size` overlap none of the ranges. */
function countFree(outer: { base: number; size: number }, size: number, ranges: Range[]): number {
  if (size > outer.size) return 0;
  const total = outer.size / size;
  let touched = 0;
  let last = -1;
  for (const range of ranges) {
    const first = Math.max(Math.floor((range.start - outer.base) / size), last + 1);
    const through = Math.floor((range.end - 1 - outer.base) / size);
    if (through >= first) touched += through - first + 1;
    last = Math.max(last, through);
  }
  return total - touched;
}

const assertPrefixLength = (prefixLength: number): void => {
  if (!Number.isInteger(prefixLength) || prefixLength < 0 || prefixLength > 32) {
    throw new Error(`not a prefix length: ${prefixLength}`);
  }
};

/**
 * A free block of `prefixLength` bits inside `container`.
 *
 * Waves used to share the whole range, which only worked because a node
 * belonged to exactly one of them. Now that a device can be in several at once,
 * two waves handing out the same address would leave the client with two host
 * routes for it -- so every wave gets a block of its own.
 *
 * The taken blocks may be of any size: a candidate is only accepted at an
 * address aligned to its own size and when it overlaps none of them, whether
 * the taken one contains it, is contained in it or cuts into it. Small blocks
 * are numbered from the top of the container, large ones from the bottom (see
 * {@link allocatesFromTop}); within a size that is still the first free one.
 *
 * Only decides -- two callers running at once would get the same answer. Whoever
 * stores the result holds `createWave()`'s lock around reading and inserting.
 */
export function allocatePrefix(container: string, prefixLength: number, taken: Iterable<string>): string {
  assertPrefixLength(prefixLength);
  const outer = parseIpv4Cidr(container);
  const blockSize = 2 ** (32 - prefixLength);
  if (blockSize > outer.size) {
    throw new Error(`a /${prefixLength} does not fit inside ${container}`);
  }

  const ranges = occupiedRanges(outer, taken);
  const found = allocatesFromTop(prefixLength)
    ? highestFree(outer, blockSize, ranges)
    : lowestFree(outer, blockSize, ranges);
  if (found !== null) return `${intToIpv4(found)}/${prefixLength}`;

  const total = outer.size / blockSize;
  throw new ContainerFullError(
    `${container} is full: no free /${prefixLength} (${blockSize} addresses) is left; it holds ${total} blocks of /${prefixLength}: 0 free, ${total} taken or overlapped by a larger or smaller block`,
  );
}

/** How many whole blocks of `prefixLength` bits in `container` overlap none of the taken ones. */
export function freeBlocks(container: string, prefixLength: number, taken: Iterable<string>): number {
  assertPrefixLength(prefixLength);
  const outer = parseIpv4Cidr(container);
  return countFree(outer, 2 ** (32 - prefixLength), occupiedRanges(outer, taken));
}

export interface CapacityReport {
  container: string;
  totalAddresses: number;
  /** Addresses inside blocks some wave holds. */
  usedAddresses: number;
  /** usedAddresses / totalAddresses, 0 to 1. */
  usedShare: number;
  /** Blocks held, by their own prefix length. */
  used: { prefixLength: number; blocks: number }[];
  /** Whole blocks still free, by prefix length, out of all that fit. */
  free: { prefixLength: number; blocks: number; total: number }[];
}

/**
 * What is held in the container and what is left of it, per block size. The
 * figures for different sizes are not additive: a free /16 is also 256 free
 * /24s, and the report counts it in both.
 */
export function capacityOf(
  container: string,
  taken: Iterable<string>,
  lengths: number[] = [16, 24],
): CapacityReport {
  const outer = parseIpv4Cidr(container);
  const cidrs = [...taken];
  const ranges = occupiedRanges(outer, cidrs);
  const usedAddresses = ranges.reduce((sum, range) => sum + (range.end - range.start), 0);

  const held = new Map<number, number>();
  for (const cidr of cidrs) {
    const block = parseIpv4Cidr(cidr);
    if (block.base + block.size <= outer.base || block.base >= outer.base + outer.size) continue;
    const length = 32 - Math.log2(block.size);
    held.set(length, (held.get(length) ?? 0) + 1);
  }

  const shown = [...new Set([...lengths, ...held.keys()])].sort((a, b) => a - b);
  return {
    container,
    totalAddresses: outer.size,
    usedAddresses,
    usedShare: usedAddresses / outer.size,
    used: [...held]
      .map(([prefixLength, blocks]) => ({ prefixLength, blocks }))
      .sort((a, b) => a.prefixLength - b.prefixLength),
    free: shown.map((prefixLength) => {
      const size = 2 ** (32 - prefixLength);
      return {
        prefixLength,
        blocks: countFree(outer, size, ranges),
        total: size > outer.size ? 0 : outer.size / size,
      };
    }),
  };
}

/**
 * Node addresses a block of this length can hand out: all but the network and
 * broadcast address and, where the block is large enough to contain it, the
 * resolver's. A block no larger than the resolver's offset has no resolver
 * address at all (`resolverAddressFor` refuses it) and is reported as such.
 */
export function usableAddresses(prefixLength: number): { usable: number; resolverFits: boolean } {
  assertPrefixLength(prefixLength);
  const size = 2 ** (32 - prefixLength);
  const resolverFits = size > RESOLVER_OFFSET + 1;
  return { usable: Math.max(0, size - 2 - (resolverFits ? 1 : 0)), resolverFits };
}

/**
 * Deterministic IPv6 address inside the wave's /48, derived from the host part
 * of the IPv4 address so the two line up and are easy to correlate by eye.
 */
export function ipv6ForIpv4(ipv6Cidr: string, ipv4Cidr: string, ipv4: string): string {
  const [prefix] = ipv6Cidr.split("/");
  if (!prefix) throw new Error(`not an IPv6 CIDR: ${ipv6Cidr}`);
  const host = (ipv4ToInt(ipv4) - parseIpv4Cidr(ipv4Cidr).base) >>> 0;
  const base = prefix.replace(/::$/, "");
  return `${base}::${host.toString(16)}`;
}

/**
 * Whether an IPv4 address falls inside one of the given CIDRs. Used to keep the
 * development login off public interfaces; IPv6 ranges are not supported, so a
 * deployment that needs them should use a real identity provider instead.
 */
export function isWithin(ip: string, cidrs: string[]): boolean {
  let address: number;
  try {
    address = ipv4ToInt(ip);
  } catch {
    return false;
  }
  return cidrs.some((cidr) => {
    try {
      const { base, size } = parseIpv4Cidr(cidr);
      return address >= base && address < base + size;
    } catch {
      return false;
    }
  });
}

/** Hostnames must be unique per wave; collisions get a numeric suffix. */
export function uniqueHostname(requested: string, taken: Iterable<string>): string {
  const normalized =
    requested
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 63) || "node";
  const used = new Set(taken);
  if (!used.has(normalized)) return normalized;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${normalized.slice(0, 59)}-${n}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error(`cannot find a free hostname for ${requested}`);
}

/** Every block of the container is taken: the server cannot number another wave. */
export class ContainerFullError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerFullError";
  }
}
