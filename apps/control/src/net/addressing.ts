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
 * Lowest free block of `prefixLength` bits inside `container`.
 *
 * Waves used to share the whole range, which only worked because a node
 * belonged to exactly one of them. Now that a device can be in several at once,
 * two waves handing out the same address would leave the client with two host
 * routes for it -- so every wave gets a block of its own.
 */
export function allocatePrefix(container: string, prefixLength: number, taken: Iterable<string>): string {
  const outer = parseIpv4Cidr(container);
  const blockSize = 2 ** (32 - prefixLength);
  if (blockSize > outer.size) {
    throw new Error(`a /${prefixLength} does not fit inside ${container}`);
  }

  // Blocks outside the container are ignored rather than rejected: a wave that
  // predates this allocation sits somewhere else entirely and holds nothing here.
  const used = new Set<number>();
  for (const cidr of taken) {
    const block = parseIpv4Cidr(cidr);
    if (block.base >= outer.base && block.base < outer.base + outer.size) used.add(block.base);
  }

  for (let offset = 0; offset < outer.size; offset += blockSize) {
    const candidate = (outer.base + offset) >>> 0;
    if (!used.has(candidate)) return `${intToIpv4(candidate)}/${prefixLength}`;
  }
  throw new ContainerFullError(
    `${container} is full: it holds ${outer.size / blockSize} blocks of /${prefixLength} and every one is taken`,
  );
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
