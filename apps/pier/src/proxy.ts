import { connect, createServer, type Server, type Socket } from "node:net";
import { sniFromClientHello } from "@wave/sni";
import type { PierTable } from "./table.ts";

/**
 * The pier's one job: read the name, then move bytes (D12).
 *
 * A connection from the open network arrives on 443. The pier reads just enough
 * of it to find the SNI of the ClientHello, looks the name up in the netmap's
 * piers and opens a TCP connection through the tunnel to the device that owns
 * it -- then every byte, the ClientHello included, goes through untouched.
 *
 * That is the whole property, and each line below is in its service:
 *
 * - **It terminates nothing and holds no key.** It never answers a handshake,
 *   so a compromised pier gives away no session and no certificate -- that is
 *   only possible because the device serves its own, from D7.
 * - **It says nothing when it refuses.** An unknown name, no SNI, a client that
 *   is not speaking TLS, a target that is gone: the connection is closed, with
 *   no TLS alert and no error page. A friendly page would mean terminating TLS
 *   -- and an alert tells a scanner which names exist. What is wrong is in the
 *   log here, not on the wire.
 * - **Only names from the netmap.** The table is the signed netmap's list; the
 *   target is a wave address, never something the client chose.
 * - **TCP only.** HTTP/3 carries its ClientHello inside UDP; no HTTPS record
 *   with `h3` is published, so clients fall back to TCP.
 */

export interface PierOptions {
  /** Where to listen. Never 0.0.0.0 -- see `pierHostFromEnv` in main.ts. */
  host: string;
  port: number;
  /** Read for every connection, so the table can change underneath. */
  table: () => PierTable;
  log?: (message: string) => void;
  /** How long a client may take to say which name it wants. */
  sniffTimeoutMs?: number;
  /** How long the device may take to accept the connection through the tunnel. */
  connectTimeoutMs?: number;
  maxConnections?: number;
  /**
   * Where the target's port lives, when it is not the one in the netmap. Only
   * the tests say otherwise -- they have no wave address to connect to.
   */
  resolveTarget?: (target: { ipv4: string; port: number }) => { host: string; port: number };
}

export interface Pier {
  port: number;
  close(): Promise<void>;
  /** Connections open right now, both halves counted once. */
  open(): number;
}

/** How often a refusal is written down at most, so a port scan cannot fill the log. */
const REFUSAL_LOG_EVERY_MS = 30_000;

export async function startPier(options: PierOptions): Promise<Pier> {
  const log = options.log ?? console.log;
  const sniffTimeout = options.sniffTimeoutMs ?? 10_000;
  const connectTimeout = options.connectTimeoutMs ?? 10_000;
  const maxConnections = options.maxConnections ?? 1024;
  const resolve = options.resolveTarget ?? ((target) => ({ host: target.ipv4, port: target.port }));
  let open = 0;

  // The pier faces the internet, and the internet knocks on everything. One line
  // per window, with a count: enough to see that something is being refused and
  // by what name, not enough to be the way a scanner fills the disk.
  let refused = 0;
  let lastLogged = 0;
  const refuse = (client: Socket, reason: string) => {
    refused++;
    const now = Date.now();
    if (now - lastLogged >= REFUSAL_LOG_EVERY_MS) {
      log(`pier: closed ${refused} connection${refused === 1 ? "" : "s"} (this one: ${reason})`);
      lastLogged = now;
      refused = 0;
    }
    client.destroy();
  };

  const server: Server = createServer((client: Socket) => {
    if (open >= maxConnections) {
      refuse(client, "too many open connections");
      return;
    }
    open++;
    client.on("close", () => {
      open--;
    });
    client.on("error", () => client.destroy());
    client.setTimeout(sniffTimeout, () => refuse(client, "no name within the time allowed"));

    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const sniffed = sniFromClientHello(buffered);
      if (sniffed === "more") return;
      client.off("data", onData);
      client.pause();
      // The name is known; from here the time that counts is the target's.
      client.setTimeout(0);

      if (sniffed === "none") return refuse(client, "no server name");
      const target = options.table().get(sniffed.name);
      if (!target) return refuse(client, `${sniffed.name} is not a name this pier serves`);

      const destination = resolve(target);
      const upstream = connect(destination);
      upstream.setNoDelay(true);
      upstream.setTimeout(connectTimeout, () => {
        log(`pier: ${sniffed.name} -> ${destination.host}:${destination.port}: no answer`);
        upstream.destroy();
      });
      upstream.on("connect", () => {
        upstream.setTimeout(0);
        client.setTimeout(0);
        // Both ends are found dead eventually: a phone that left the wifi never
        // says goodbye, and a connection that outlives it is a slot nobody uses.
        client.setKeepAlive(true, 30_000);
        upstream.setKeepAlive(true, 30_000);
        upstream.write(buffered);
        buffered = Buffer.alloc(0);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
      });
      upstream.on("error", (error) => {
        log(`pier: ${sniffed.name} -> ${destination.host}:${destination.port}: ${error.message}`);
        client.destroy();
      });
      client.on("close", () => upstream.destroy());
      upstream.on("close", () => client.destroy());
    };
    client.on("data", onData);
  });

  const port = await new Promise<number>((resolvePort, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => {
      const address = server.address();
      resolvePort(typeof address === "object" && address ? address.port : options.port);
    });
  });
  log(`pier: listening on ${options.host}:${port}`);

  return {
    port,
    open: () => open,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
  };
}
