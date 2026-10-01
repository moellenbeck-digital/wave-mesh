import {
  type Answer,
  decodeQuery,
  encodeIpv4,
  encodeIpv6,
  encodeResponse,
  isWithinZone,
  normalizeName,
  type Query,
  RecordType,
  ResponseCode,
} from "./message.ts";

/**
 * A split-DNS resolver: it answers for the wave's own zone and forwards the
 * suffixes the netmap delegates. Everything else is deliberately not its
 * business -- the operating system is told to send only these names here, so
 * the rest of the machine's name resolution keeps working exactly as before.
 */

/** Wave records change when a node is renamed or renumbered, so keep TTLs short. */
const TTL_SECONDS = 60;

export interface ZoneRecord {
  name: string;
  ipv4?: string;
  ipv6?: string;
}

export interface ResolverConfig {
  /** The wave's own zone, e.g. "rl.wave.example.com". */
  zone: string;
  records: ZoneRecord[];
  /** Suffixes handed to another nameserver, e.g. an internal corporate zone. */
  routes: { suffix: string; nameservers: string[] }[];
  /**
   * The in-addr.arpa and ip6.arpa zones covering this wave's addresses. Inside
   * them an unknown address is NXDOMAIN; outside, the query is not ours.
   */
  reverse?: string[];
}

export type Resolution =
  | { kind: "answer"; packet: Uint8Array }
  | { kind: "forward"; nameservers: string[] }
  | { kind: "drop" };

/**
 * The address a PTR question asks about, as bytes -- 4 for in-addr.arpa, 16 for
 * ip6.arpa. Bytes rather than text because the same address has many spellings:
 * a record says fd7a:8b47:c285::2, the question spells out every nibble.
 */
export function addressFromPtrName(name: string): Uint8Array | null {
  const labels = normalizeName(name).split(".");
  const suffix = labels.slice(-2).join(".");
  const body = labels.slice(0, -2).reverse();

  if (suffix === "in-addr.arpa") {
    if (body.length !== 4) return null;
    const octets = body.map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    return new Uint8Array(octets);
  }
  if (suffix === "ip6.arpa") {
    if (body.length !== 32 || body.some((n) => !/^[0-9a-f]$/.test(n))) return null;
    const out = new Uint8Array(16);
    for (let i = 0; i < 16; i++) {
      out[i] = Number.parseInt(`${body[i * 2]}${body[i * 2 + 1]}`, 16);
    }
    return out;
  }
  return null;
}

const sameAddress = (bytes: Uint8Array, address: string | undefined, v6: boolean): boolean => {
  if (!address) return false;
  try {
    const encoded = v6 ? encodeIpv6(address) : encodeIpv4(address);
    return encoded.length === bytes.length && encoded.every((byte, i) => byte === bytes[i]);
  } catch {
    return false;
  }
};

/**
 * The reverse zones a wave covers. Each wave gets a /16 of IPv4 and a /48 of
 * IPv6 (see D5), so the zone is the same for every address in it -- which is
 * what makes it derivable from our own without the netmap carrying prefixes.
 */
export function reverseZonesFor(addresses: string[]): string[] {
  const zones = new Set<string>();
  for (const entry of addresses) {
    const address = entry.split("/")[0] ?? "";
    if (address.includes(":")) {
      try {
        const bytes = encodeIpv6(address);
        const nibbles: string[] = [];
        // The first 48 bits, one nibble per label, most significant last.
        for (let i = 0; i < 6; i++) {
          const byte = bytes[i] as number;
          nibbles.push((byte >> 4).toString(16), (byte & 0xf).toString(16));
        }
        zones.add(`${nibbles.reverse().join(".")}.ip6.arpa`);
      } catch {
        // Not an address we can reverse; nothing to route.
      }
    } else {
      const [a, b] = address.split(".");
      if (a && b) zones.add(`${b}.${a}.in-addr.arpa`);
    }
  }
  return [...zones];
}

function answersFor(record: ZoneRecord, query: Query): Answer[] {
  const name = query.question.name;
  const answers: Answer[] = [];
  if (query.question.type === RecordType.A && record.ipv4) {
    answers.push({ name, type: RecordType.A, ttl: TTL_SECONDS, address: record.ipv4 });
  }
  if (query.question.type === RecordType.AAAA && record.ipv6) {
    answers.push({ name, type: RecordType.AAAA, ttl: TTL_SECONDS, address: record.ipv6 });
  }
  return answers;
}

/** Decides what to do with one query. Pure, so the policy can be tested alone. */
export function resolve(packet: Uint8Array, config: ResolverConfig): Resolution {
  const query = decodeQuery(packet);
  // Not a question we understand: staying silent is better than guessing.
  if (!query) return { kind: "drop" };

  const name = normalizeName(query.question.name);

  // A name for an address. Without this the query is dropped, and everything
  // that looks one up before printing -- ping, ssh, traceroute -- waits for a
  // resolver that will never answer. We hold the mapping either way.
  if (query.question.type === RecordType.PTR) {
    const bytes = addressFromPtrName(name);
    const v6 = bytes?.length === 16;
    const record = bytes
      ? config.records.find((entry) => sameAddress(bytes, v6 ? entry.ipv6 : entry.ipv4, v6))
      : undefined;
    if (record) {
      const answers: Answer[] = [
        { name: query.question.name, type: RecordType.PTR, ttl: TTL_SECONDS, target: record.name },
      ];
      return { kind: "answer", packet: encodeResponse({ query, answers }) };
    }
    // Ours to answer for, but nobody holds that address: say so rather than
    // leaving the caller waiting.
    const ours = (config.reverse ?? []).some((zone) => isWithinZone(name, zone));
    if (ours) return { kind: "answer", packet: encodeResponse({ query, code: ResponseCode.NameError }) };
    return { kind: "drop" };
  }

  // A delegated suffix wins over the wave zone, so a route can carve out a
  // subdomain of it.
  const route = config.routes.find((entry) => isWithinZone(name, entry.suffix));
  if (route && route.nameservers.length > 0) return { kind: "forward", nameservers: route.nameservers };

  if (!isWithinZone(name, config.zone)) return { kind: "drop" };

  const record = config.records.find((entry) => normalizeName(entry.name) === name);
  if (!record) {
    return { kind: "answer", packet: encodeResponse({ query, code: ResponseCode.NameError }) };
  }
  // A known name without the requested type answers empty, not "no such name":
  // saying NXDOMAIN would tell the client the name does not exist at all.
  return { kind: "answer", packet: encodeResponse({ query, answers: answersFor(record, query) }) };
}

export interface DnsServer {
  address: string;
  port: number;
  queries: () => number;
  update: (config: ResolverConfig) => void;
  close: () => void;
}

export interface DnsServerOptions {
  address: string;
  port?: number;
  config: ResolverConfig;
  log?: (message: string) => void;
  /** Overridable for tests that must not talk to a real nameserver. */
  forward?: (packet: Uint8Array, nameserver: string) => Promise<Uint8Array | null>;
}

/** Asks an upstream nameserver and waits briefly for its answer. */
export async function forwardQuery(
  packet: Uint8Array,
  nameserver: string,
  timeoutMs = 3000,
): Promise<Uint8Array | null> {
  const [host, port] =
    nameserver.includes(":") && !nameserver.includes("::")
      ? [
          nameserver.slice(0, nameserver.lastIndexOf(":")),
          Number(nameserver.slice(nameserver.lastIndexOf(":") + 1)),
        ]
      : [nameserver, 53];

  const reply = Promise.withResolvers<Uint8Array | null>();
  const socket = await Bun.udpSocket({
    socket: {
      data: (_s, data) => reply.resolve(new Uint8Array(data)),
      error: () => reply.resolve(null),
    },
  });
  const timer = setTimeout(() => reply.resolve(null), timeoutMs);

  try {
    socket.send(packet, port, host ?? nameserver);
  } catch {
    reply.resolve(null);
  }
  const answer = await reply.promise;
  clearTimeout(timer);
  socket.close();
  return answer;
}

export async function startDnsServer(options: DnsServerOptions): Promise<DnsServer> {
  let config = options.config;
  let queries = 0;
  const log = options.log ?? (() => {});
  const forward = options.forward ?? forwardQuery;

  const socket = await Bun.udpSocket({
    hostname: options.address,
    port: options.port ?? 53,
    socket: {
      async data(socket, data, port, address) {
        queries++;
        const packet = new Uint8Array(data);
        const decision = resolve(packet, config);
        if (decision.kind === "drop") return;

        if (decision.kind === "answer") {
          send(socket, decision.packet, port, address);
          return;
        }
        for (const nameserver of decision.nameservers) {
          const answer = await forward(packet, nameserver);
          if (answer) {
            send(socket, answer, port, address);
            return;
          }
        }
      },
      error: (_socket, error) =>
        log(`dns socket error (ignored): ${error instanceof Error ? error.message : String(error)}`),
    },
  });

  log(`dns listening on ${options.address}:${socket.port}/udp for ${config.zone}`);
  return {
    address: options.address,
    port: socket.port,
    queries: () => queries,
    update: (next) => {
      config = next;
    },
    close: () => socket.close(),
  };
}

/** A failed send leaves a queued ICMP error behind; one retry gets past it. */
function send(socket: Bun.udp.Socket<"buffer">, data: Uint8Array, port: number, address: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      socket.send(data, port, address);
      return;
    } catch {
      // Try once more.
    }
  }
}
