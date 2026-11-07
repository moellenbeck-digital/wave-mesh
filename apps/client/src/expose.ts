import { createHash } from "node:crypto";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { readFile, stat } from "node:fs/promises";
import { isIP, connect as netConnect, type Server, type Socket } from "node:net";
import { createSecureContext, createServer, type SecureContext, connect as tlsConnect } from "node:tls";
import type { CertRecord, ExposedEntry } from "./state.ts";

/**
 * The device's side of `wave expose` (D12).
 *
 * The pier hands over a TCP connection, ClientHello and all, and cannot read a
 * byte of it. What it hands it to is this: a TLS listener on the device's own
 * wave address that answers with the certificate the device holds for the name
 * (D7), and moves what it decrypts to the service the person named.
 *
 * Everything here is plain functions and one small class, with no daemon and no
 * tunnel in it: the daemon decides *when* and on *which address*, this decides
 * what is a valid name, which certificate covers it and how bytes move.
 */

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The label under the pier zone, or null for anything that is not exactly one
 * name below it. Bare (`app`) or full (`app.pier.wave.example.com`), never the
 * zone itself, a wildcard, a deeper name or somebody else's domain -- the same
 * line the server draws, drawn here first so a mistake changes nothing.
 */
export function exposeLabel(given: string, zone: string): string | null {
  const name = given.trim().toLowerCase().replace(/\.$/, "");
  const suffix = zone.toLowerCase();
  const label = name.endsWith(`.${suffix}`) ? name.slice(0, -(suffix.length + 1)) : name;
  // `??--` is reserved, `xn--` is punycode: the server refuses both.
  return LABEL.test(label) && label.slice(2, 4) !== "--" ? label : null;
}

/** The full name of an exposed entry: the server's answer, or rebuilt for an entry from before it was kept. */
export const exposedDnsName = (entry: Pick<ExposedEntry, "name" | "dnsName">, zone: string): string =>
  entry.dnsName ?? `${entry.name}.${zone}`;

export interface LocalTarget {
  /** The URL as it will be stored: scheme, host and port, nothing else. */
  url: string;
  host: string;
  port: number;
  secure: boolean;
}

/**
 * `http(s)://host:port`, and nothing more. No path, no credentials, no query:
 * the daemon moves bytes and cannot honour a path, and a password in a URL
 * would end up in the state file and in every listing.
 */
export function parseLocalUrl(input: string): LocalTarget | null {
  // Taken apart by hand rather than by `URL`: it drops a port that is the
  // scheme's default, and "port 80" is exactly what has to stay written down.
  const match = /^(https?):\/\/(\[[0-9a-f:.]+\]|[^\s/?#:@[\]]+):(\d{1,5})\/?$/i.exec(input.trim());
  if (!match) return null;
  const scheme = (match[1] as string).toLowerCase();
  const hostPart = match[2] as string;
  const port = Number(match[3]);
  if (port < 1 || port > 65535) return null;
  let host: string;
  try {
    host = new URL(`${scheme}://${hostPart}`).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return null;
  }
  if (!host || isForbiddenTarget(host)) return null;
  return { url: `${scheme}://${hostPart.toLowerCase()}:${port}`, host, port, secure: scheme === "https" };
}

/**
 * Addresses a pier name must never lead to, whatever the URL said: link-local
 * (169.254.0.0/16, fe80::/10) is where cloud metadata services live -- an
 * instance's credentials, one GET away -- and nothing a person means to put
 * on the internet sits there. Checked on the resolved address at connect time,
 * not on the URL, so a name that resolves there (or is made to) does not get
 * around it.
 */
export function isForbiddenTarget(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = lower.startsWith("::ffff:") ? lower.slice(7) : lower;
  if (isIP(mapped) === 4) return mapped.startsWith("169.254.");
  if (isIP(lower) === 6) {
    // `::ffff:a9fe:…` is 169.254.x.x written the way `URL` writes it back.
    return /^fe[89ab][0-9a-f]:/.test(lower) || lower.startsWith("::ffff:a9fe:") || lower === "fd00:ec2::254";
  }
  return false;
}

/**
 * Whether something already answers on `host:port`. Asked before a port is
 * claimed: the claim opens the pier's way to that port at once, and until this
 * device's own listener holds it, whatever else listens there -- a database on
 * 0.0.0.0, say -- would get the internet's bytes without TLS in front.
 * Connecting rather than binding, because on macOS a bind to one address
 * succeeds next to a service bound to all of them.
 */
export function somethingListens(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const done = (answer: boolean) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** Whether one certificate name stands for the given name. */
export function nameCovers(certName: string, fqdn: string): boolean {
  const have = certName.toLowerCase();
  const want = fqdn.toLowerCase();
  if (have === want) return true;
  // A wildcard stands for exactly one label, never the zone or something deeper.
  if (!have.startsWith("*.")) return false;
  const rest = have.slice(1);
  return want.endsWith(rest) && !want.slice(0, -rest.length).includes(".") && want.length > rest.length;
}

export type CertChoice = { record: CertRecord } | { expired: CertRecord } | null;

/** The certificate this device holds that covers the name: one that is valid, else one that was. */
export function chooseCertificate(certs: CertRecord[], fqdn: string, now: Date = new Date()): CertChoice {
  let stale: CertRecord | null = null;
  for (const record of certs) {
    const names = record.names.length > 0 ? record.names : [record.name];
    if (!names.some((name) => nameCovers(name, fqdn))) continue;
    const end = Date.parse(record.notAfter);
    if (Number.isNaN(end) || end > now.getTime()) return { record };
    stale = record;
  }
  return stale ? { expired: stale } : null;
}

/** Where the proxy to one name stands -- what `wave pier status` says about it. */
export type ListenerState =
  | { state: "listening"; address: string; port: number }
  | { state: "no-certificate" }
  | { state: "certificate-expired" }
  | { state: "no-address" }
  | { state: "tunnel-down" }
  | { state: "failed"; reason: string };

export interface ExposeTarget {
  /** The full name, which is what the client's SNI will carry. */
  fqdn: string;
  local: LocalTarget;
  /** The port on the wave address. */
  port: number;
}

export interface PemPair {
  key: Buffer;
  cert: Buffer;
}

export interface ExposeOptions {
  /** The key and chain for a name, or why there are none. Read fresh, so a renewal is picked up. */
  certificate: (fqdn: string) => Promise<PemPair | "none" | "expired">;
  log?: (message: string) => void;
  maxConnections?: number;
  /**
   * What an `https` service is checked against instead of the system's roots.
   * Only the tests say otherwise: a service on the LAN has no certificate a
   * public CA signed, and the check itself is not optional.
   */
  upstreamCa?: string | Buffer;
  /** How long the service may take to accept. */
  connectTimeoutMs?: number;
  /** How long a connection may sit without a byte in either direction. */
  idleTimeoutMs?: number;
}

interface Bound {
  host: string;
  port: number;
  server: Server;
  open: Set<Socket>;
}

/**
 * The listeners of one tunnel: one per port, however many names share it. SNI
 * picks the name, the name picks the certificate and the service.
 */
export class ExposeListeners {
  private readonly bound = new Map<number, Bound>();
  private targets = new Map<string, ExposeTarget>();
  private readonly contexts = new Map<string, { digest: string; context: SecureContext }>();
  /** A refusal said once per change, not once per second. */
  private readonly told = new Map<number, string>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: ExposeOptions) {
    this.log = options.log ?? (() => {});
  }

  /** Whether one of these listeners holds the port already. */
  holds(port: number): boolean {
    return this.bound.has(port);
  }

  /**
   * Brings the listeners in line with what is exposed. Called whenever
   * something may have changed -- a certificate arrived, a name came or went,
   * the tunnel came up -- and cheap when nothing did.
   *
   * `address` is the device's own wave address, never `0.0.0.0`: bound
   * everywhere, the proxy would also answer on the LAN and on the internet
   * interface, and the only way in is meant to be the pier.
   */
  async reconcile(address: string | null, targets: ExposeTarget[]): Promise<Map<string, ListenerState>> {
    this.targets = new Map(targets.map((target) => [target.fqdn.toLowerCase(), target]));
    const states = new Map<string, ListenerState>();
    const wanted = new Map<number, ExposeTarget[]>();

    for (const target of targets) {
      const key = target.fqdn.toLowerCase();
      if (!address) {
        states.set(key, { state: "no-address" });
        continue;
      }
      const have = await this.options.certificate(target.fqdn);
      if (have === "none" || have === "expired") {
        states.set(key, { state: have === "none" ? "no-certificate" : "certificate-expired" });
        continue;
      }
      wanted.set(target.port, [...(wanted.get(target.port) ?? []), target]);
    }

    // What is no longer wanted, or is bound to an address that has changed.
    for (const [port, bound] of this.bound) {
      if (wanted.has(port) && bound.host === address) continue;
      await this.shut(port);
    }

    for (const [port, group] of wanted) {
      let bound = this.bound.get(port);
      if (!bound && address) {
        try {
          bound = await this.bind(address, port);
          this.told.delete(port);
          this.log(`expose: listening on ${address}:${port}`);
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          if (this.told.get(port) !== reason) {
            this.log(`expose: could not listen on ${address}:${port}: ${reason}`);
            this.told.set(port, reason);
          }
          for (const target of group) states.set(target.fqdn.toLowerCase(), { state: "failed", reason });
          continue;
        }
      }
      for (const target of group) {
        states.set(target.fqdn.toLowerCase(), {
          state: "listening",
          address: bound?.host ?? "",
          port,
        });
      }
    }
    return states;
  }

  /** The ports something is listening on, for the tests. */
  ports(): number[] {
    return [...this.bound.keys()];
  }

  /** Port actually bound -- differs from the asked one only when that was 0. */
  boundPort(requested: number): number | undefined {
    return this.bound.get(requested)?.port;
  }

  async close(): Promise<void> {
    for (const port of [...this.bound.keys()]) await this.shut(port);
  }

  private async shut(port: number): Promise<void> {
    const bound = this.bound.get(port);
    if (!bound) return;
    this.bound.delete(port);
    for (const socket of bound.open) socket.destroy();
    await new Promise<void>((done) => bound.server.close(() => done()));
    this.log(`expose: closed ${bound.host}:${port}`);
  }

  private async secureContext(fqdn: string): Promise<SecureContext | null> {
    const have = await this.options.certificate(fqdn);
    if (have === "none" || have === "expired") return null;
    // Keyed by what is in the files: a renewal writes a new chain, and the
    // next handshake must see it without anybody restarting anything.
    const digest = createHash("sha256").update(have.key).update(have.cert).digest("hex");
    const cached = this.contexts.get(fqdn);
    if (cached?.digest === digest) return cached.context;
    const context = createSecureContext({ key: have.key, cert: have.cert });
    this.contexts.set(fqdn, { digest, context });
    return context;
  }

  private bind(host: string, port: number): Promise<Bound> {
    const maxConnections = this.options.maxConnections ?? 256;
    const connectTimeout = this.options.connectTimeoutMs ?? 10_000;
    const idleTimeout = this.options.idleTimeoutMs ?? 5 * 60_000;
    const open = new Set<Socket>();

    const server = createServer(
      {
        // HTTP/1.1 only. The bytes are moved, not understood, and a browser that
        // negotiated h2 here would be speaking it to a service that may not.
        ALPNProtocols: ["http/1.1"],
        minVersion: "TLSv1.2",
        // Node waits two minutes for a handshake by default; a peer opening
        // half-handshakes would hold that long, each one a certificate read.
        handshakeTimeout: 10_000,
        SNICallback: (servername, done) => {
          const name = servername?.toLowerCase();
          if (!name || !this.targets.has(name)) return done(new Error("unknown name"), undefined);
          this.secureContext(name).then(
            (context) => (context ? done(null, context) : done(new Error("no certificate"), undefined)),
            (error) => done(error instanceof Error ? error : new Error(String(error)), undefined),
          );
        },
      },
      (client) => {
        const name = (client.servername as string | undefined)?.toLowerCase() ?? "";
        const target = this.targets.get(name);
        if (!target || open.size >= maxConnections) return client.destroy();
        open.add(client);
        client.on("close", () => open.delete(client));
        client.on("error", () => client.destroy());
        client.setTimeout(idleTimeout, () => client.destroy());

        const { host: toHost, port: toPort, secure } = target.local;
        // Every address the target resolves to is checked before a byte goes
        // out: never link-local (metadata services), and never this listener
        // itself -- `https://app.pier.<zone>:443` as the service of
        // `app.pier.<zone>` resolves to the wave address, and every connection
        // would come back in until the slots ran out.
        const lookup = (
          hostname: string,
          options: object,
          callback: (error: Error | null, address: string | LookupAddress[], family?: number) => void,
        ) =>
          dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
            if (error) return callback(error, []);
            const refused = addresses.find(
              (entry) =>
                isForbiddenTarget(entry.address) || (entry.address === host && this.bound.has(toPort)),
            );
            if (refused)
              return callback(new Error(`${hostname} resolves to ${refused.address}, which is refused`), []);
            const wantsAll = (options as { all?: boolean }).all === true;
            const first = addresses[0];
            if (wantsAll) return callback(null, addresses);
            if (!first) return callback(new Error(`${hostname} has no address`), []);
            callback(null, first.address, first.family);
          });
        // An address is connected to without a lookup, so it is checked here.
        if (isIP(toHost) && (isForbiddenTarget(toHost) || (toHost === host && this.bound.has(toPort)))) {
          this.log(`expose: ${name} -> ${toHost}:${toPort}: refused target`);
          return client.destroy();
        }
        const upstream = secure
          ? tlsConnect({
              host: toHost,
              port: toPort,
              // An address is no name a certificate can be checked against.
              servername: isIP(toHost) ? undefined : toHost,
              ca: this.options.upstreamCa,
              lookup,
            })
          : netConnect({ host: toHost, port: toPort, lookup });
        upstream.setNoDelay(true);
        upstream.setTimeout(connectTimeout, () => {
          this.log(`expose: ${name} -> ${toHost}:${toPort}: no answer`);
          upstream.destroy();
        });
        upstream.once(secure ? "secureConnect" : "connect", () => {
          upstream.setTimeout(idleTimeout, () => upstream.destroy());
          client.pipe(upstream);
          upstream.pipe(client);
        });
        upstream.on("error", (error) => {
          this.log(`expose: ${name} -> ${toHost}:${toPort}: ${error.message}`);
          client.destroy();
        });
        client.on("close", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.setKeepAlive(true, 30_000);
      },
    );
    // The limit above counts finished handshakes; this one counts sockets, so
    // connections that never finish one cannot pile up past it either.
    server.maxConnections = maxConnections * 2;
    server.on("connection", (raw: Socket) => raw.on("error", () => raw.destroy()));

    return new Promise<Bound>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        const address = server.address();
        const actual = typeof address === "object" && address ? address.port : port;
        const bound: Bound = { host, port: actual, server, open };
        this.bound.set(port, bound);
        resolve(bound);
      });
    });
  }
}

/** Reads the key and chain a certificate record points at, or says there is none. */
export async function readPem(paths: { keyPath: string; chainPath: string }): Promise<PemPair | null> {
  try {
    await stat(paths.chainPath);
    const [key, cert] = await Promise.all([readFile(paths.keyPath), readFile(paths.chainPath)]);
    return { key, cert };
  } catch {
    return null;
  }
}
