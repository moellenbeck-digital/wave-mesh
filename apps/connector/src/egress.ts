import { connect, createServer, type Server, type Socket } from "node:net";
import type { ProfileStatus } from "@wave/ipc";

/**
 * The connector's other direction: from the cluster into the wave.
 *
 * A pod in this cluster calls `https://plausible.wave.example.com`. CoreDNS
 * answers every name under the wave's suffix with the ClusterIP of the
 * `wave-egress` Service, which points here. This reads the name the client
 * asked for -- SNI for TLS, the Host header for plain HTTP -- looks it up in
 * the wave's netmap and passes the connection on, byte for byte, to that
 * device or service. TLS is never opened: the pod checks the certificate of
 * the thing it called, and nothing in between sees the request.
 *
 * Three rules hold it in place:
 *
 * - **Only names from the netmap.** Anything else is refused, or this would be
 *   an open proxy into the internet for every pod in the cluster.
 * - **It listens on the pod's own address, never on `0.0.0.0`.** The pod
 *   shares its network with `wave0`; bound everywhere, the proxy would answer
 *   on the connector's wave address too, and every peer in the wave could use
 *   it as a hop to every other.
 * - **The connector's own services go straight to the local ingress.** Traffic
 *   that starts here leaves through OUTPUT, not PREROUTING, so the DNAT that
 *   forwards arriving packets would never see it.
 *
 * Names only, so HTTP and HTTPS only: SMB, SSH or a database carry no name to
 * read. Those would need a port per destination -- a different design.
 */

/** Where a name in the wave leads, as this connector reaches it. */
export interface Destination {
  ipv4: string;
  /** One of this connector's own services: reached through the local ingress. */
  local: boolean;
}

export type EgressTable = Map<string, Destination>;

const normalise = (name: string): string => name.trim().toLowerCase().replace(/\.$/, "");

/**
 * The names this connector may forward to, from the daemon's status: every
 * peer and every service a peer fronts, and the connector's own services.
 * Built from the netmap, so the ACL already decided what is in it -- a device
 * the policy keeps from this connector is not a peer and not a name here.
 */
export function egressTable(status: ProfileStatus[], controlUrl?: string): EgressTable {
  const table: EgressTable = new Map();
  const profile = controlUrl
    ? status.find((entry) => entry.controlUrl === controlUrl)
    : (status.find((entry) => entry.state === "up") ?? status[0]);
  if (profile?.state !== "up") return table;
  for (const peer of profile.peers) {
    if (peer.dnsName && peer.ipv4) table.set(normalise(peer.dnsName), { ipv4: peer.ipv4, local: false });
    for (const service of peer.services) {
      table.set(normalise(service.dnsName), { ipv4: service.ipv4, local: false });
    }
  }
  for (const service of profile.self?.services ?? []) {
    table.set(normalise(service.dnsName), { ipv4: service.ipv4, local: true });
  }
  return table;
}

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

/** A fatal TLS alert, unrecognized_name: the client is told why instead of a bare reset. */
const UNRECOGNIZED_NAME = Uint8Array.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70]);

export interface EgressOptions {
  /** The pod's own address. Never 0.0.0.0 -- see the comment at the top. */
  host: string;
  tlsPort: number;
  httpPort: number;
  /** Read for every connection, so the table can change underneath. */
  table: () => EgressTable;
  /** The cluster's internal ingress, for this connector's own services. */
  backend: string;
  /** Where wave destinations listen; only the tests say otherwise. */
  upstreamPorts?: { tls: number; http: number };
  log?: (message: string) => void;
  /** How long a client may take to say which name it wants. */
  sniffTimeoutMs?: number;
  maxConnections?: number;
}

export interface Egress {
  close(): Promise<void>;
  ports: { tls: number; http: number };
}

export async function startEgress(options: EgressOptions): Promise<Egress> {
  const log = options.log ?? console.log;
  const upstream = options.upstreamPorts ?? { tls: 443, http: 80 };
  const sniffTimeout = options.sniffTimeoutMs ?? 10_000;
  let open = 0;

  const serve = (kind: "tls" | "http") =>
    createServer((client: Socket) => {
      if (open >= (options.maxConnections ?? 512)) {
        client.destroy();
        return;
      }
      open++;
      client.on("close", () => open--);
      client.on("error", () => client.destroy());
      client.setTimeout(sniffTimeout, () => client.destroy());

      let buffered = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        const sniffed = kind === "tls" ? sniFromClientHello(buffered) : hostFromHttp(buffered);
        if (sniffed === "more") return;
        client.off("data", onData);
        client.pause();
        const destination = sniffed === "none" ? undefined : options.table().get(sniffed.name);
        if (!destination) {
          refuse(client, kind, sniffed === "none" ? "no name" : sniffed.name);
          return;
        }
        // The connector's own services are behind the local ingress; every
        // other name is a wave address, reached through wave0.
        const target = destination.local ? options.backend : destination.ipv4;
        const port = kind === "tls" ? upstream.tls : upstream.http;
        const server = connect({ host: target, port }, () => {
          client.setTimeout(0);
          server.write(buffered);
          client.pipe(server);
          server.pipe(client);
          client.resume();
        });
        server.on("error", (error) => {
          log(`egress: ${sniffed === "none" ? "?" : sniffed.name} -> ${target}:${port}: ${error.message}`);
          if (kind === "http" && !client.destroyed) {
            client.end("HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
          } else client.destroy();
        });
        client.on("close", () => server.destroy());
        server.on("close", () => client.destroy());
      };
      client.on("data", onData);
    });

  function refuse(client: Socket, kind: "tls" | "http", name: string) {
    // Said in the log: a pod calling a name that is not in the wave is either
    // a typo or a policy keeping it out, and both are worth seeing.
    log(`egress: refused ${name} (not a name in this wave)`);
    if (kind === "tls") client.end(UNRECOGNIZED_NAME);
    else {
      const body = `${name} is not a name in this wave\n`;
      client.end(
        `HTTP/1.1 421 Misdirected Request\r\nContent-Type: text/plain\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`,
      );
    }
  }

  const listen = (server: Server, port: number) =>
    new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, options.host, () => {
        const address = server.address();
        resolve(typeof address === "object" && address ? address.port : port);
      });
    });

  const tls = serve("tls");
  const http = serve("http");
  const ports = { tls: await listen(tls, options.tlsPort), http: await listen(http, options.httpPort) };
  log(`egress: listening on ${options.host}:${ports.tls} (TLS) and :${ports.http} (HTTP)`);
  return {
    ports,
    close: () =>
      Promise.all([
        new Promise<void>((resolve) => tls.close(() => resolve())),
        new Promise<void>((resolve) => http.close(() => resolve())),
      ]).then(() => {}),
  };
}
