import { afterEach, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { createServer as createTlsServer, connect as tlsConnect } from "node:tls";
import { generateCertificateKey, selfSignedCertificate, toPem } from "@wave/crypto";
import { startPier } from "../../pier/src/proxy.ts";
import {
  chooseCertificate,
  ExposeListeners,
  type ExposeTarget,
  exposeLabel,
  nameCovers,
  type PemPair,
  parseLocalUrl,
} from "../src/expose.ts";
import type { CertRecord } from "../src/state.ts";

/**
 * `wave expose`, the device's side: what is a valid name and URL, which
 * certificate covers a name, and that the listener ends TLS with it and moves
 * the bytes to the service -- also through the real pier.
 */

const SUFFIX = "wave.example.com";
const NAME = "app.wave.example.com";

describe("the name", () => {
  test("a label or a full name under the wave's domain", () => {
    expect(exposeLabel("app", SUFFIX)).toBe("app");
    expect(exposeLabel("App.Wave.Example.com.", SUFFIX)).toBe("app");
  });

  test("nothing else: no zone, no wildcard, no deeper name, no foreign domain", () => {
    for (const bad of [
      "",
      SUFFIX,
      `*.${SUFFIX}`,
      `a.b.${SUFFIX}`,
      "app.example.org",
      "app.wave.example.com.evil.net",
      "-app",
      "a_b",
      "a b",
    ]) {
      expect(exposeLabel(bad, SUFFIX)).toBeNull();
    }
  });
});

describe("the local URL", () => {
  test("http(s) with a host and a port, on this device or in the LAN", () => {
    expect(parseLocalUrl("http://localhost:3000")).toMatchObject({
      host: "localhost",
      port: 3000,
      secure: false,
    });
    expect(parseLocalUrl("https://nas.lan:5001/")).toMatchObject({
      host: "nas.lan",
      port: 5001,
      secure: true,
    });
    expect(parseLocalUrl("http://192.168.1.20:8080")?.url).toBe("http://192.168.1.20:8080");
    expect(parseLocalUrl("http://[::1]:8080")).toMatchObject({ host: "::1", port: 8080 });
  });

  test("a default port stays written down", () => {
    expect(parseLocalUrl("http://nas.lan:80")).toMatchObject({ port: 80, url: "http://nas.lan:80" });
    expect(parseLocalUrl("https://nas.lan:443")).toMatchObject({ port: 443 });
  });

  test("anything else is refused", () => {
    for (const bad of [
      "",
      "localhost:3000",
      "http://localhost",
      "ftp://localhost:21",
      "http://localhost:0",
      "http://localhost:70000",
      "http://user:pw@localhost:3000",
      "http://localhost:3000/app",
      "http://localhost:3000?x=1",
      "http://localhost:3000#x",
      "http://:3000",
      "http://a b:3000",
    ]) {
      expect(parseLocalUrl(bad)).toBeNull();
    }
  });
});

const record = (name: string, names: string[], notAfter = "2099-01-01T00:00:00Z"): CertRecord => ({
  name,
  names,
  renewAt: "2098-01-01T00:00:00Z",
  notAfter,
  hook: null,
});

describe("which certificate covers a name", () => {
  test("exact names and one level of wildcard", () => {
    expect(nameCovers(NAME, NAME)).toBe(true);
    expect(nameCovers(`*.${SUFFIX}`, NAME)).toBe(true);
    expect(nameCovers(`*.${SUFFIX}`, SUFFIX)).toBe(false);
    expect(nameCovers(`*.${SUFFIX}`, `a.b.${SUFFIX}`)).toBe(false);
    expect(nameCovers("laptop.wave.example.com", NAME)).toBe(false);
  });

  test("none, a valid one, or one that has run out", () => {
    const now = new Date("2030-01-01T00:00:00Z");
    expect(chooseCertificate([record("laptop.wave.example.com", [])], NAME, now)).toBeNull();
    expect(chooseCertificate([record(NAME, [NAME])], NAME, now)).toMatchObject({ record: { name: NAME } });
    expect(
      chooseCertificate([record(`wildcard.${SUFFIX}`, [`*.${SUFFIX}`, SUFFIX])], NAME, now),
    ).toMatchObject({
      record: {},
    });
    expect(chooseCertificate([record(NAME, [NAME], "2020-01-01T00:00:00Z")], NAME, now)).toMatchObject({
      expired: {},
    });
    // A valid one wins over an expired one for the same name.
    expect(
      chooseCertificate(
        [record(NAME, [NAME], "2020-01-01T00:00:00Z"), record(`wildcard.${SUFFIX}`, [`*.${SUFFIX}`])],
        NAME,
        now,
      ),
    ).toMatchObject({ record: { name: `wildcard.${SUFFIX}` } });
  });
});

function pemFor(names: string[]): PemPair & { ca: string } {
  const key = generateCertificateKey();
  const der = selfSignedCertificate({
    privateKeyPem: key.privateKeyPem,
    names,
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
  });
  const cert = toPem("CERTIFICATE", der);
  return { key: Buffer.from(key.privateKeyPem), cert: Buffer.from(cert), ca: cert };
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

/** A service that answers every request with who it thinks it is, and what it was sent. */
async function service(): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server: Server = createServer((socket) => {
    socket.on("data", (chunk) => {
      seen.push(chunk.toString());
      socket.end(`service says: ${chunk.toString()}`);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, seen };
}

function target(fqdn: string, local: string, port = 0): ExposeTarget {
  const parsed = parseLocalUrl(local);
  if (!parsed) throw new Error(`bad local url ${local}`);
  return { fqdn, local: parsed, port };
}

async function listeners(certs: Record<string, PemPair | "none" | "expired">, upstreamCa?: string) {
  const log: string[] = [];
  const set = new ExposeListeners({
    upstreamCa,
    certificate: async (fqdn) => certs[fqdn] ?? "none",
    log: (line) => log.push(line),
  });
  closers.push(() => set.close());
  return { set, log };
}

/** One TLS request, verified against `ca` by name -- nothing between could have answered. */
const ask = (port: number, servername: string, ca: string, text = "hello") =>
  new Promise<string>((resolve, reject) => {
    const socket = tlsConnect({ host: "127.0.0.1", port, servername, ca }, () => socket.write(text));
    let body = "";
    socket.on("data", (chunk) => (body += chunk.toString()));
    socket.on("close", () => resolve(body));
    socket.on("error", reject);
  });

describe("the listener", () => {
  test("ends TLS with the device's certificate and moves the bytes to the service", async () => {
    const svc = await service();
    const pem = pemFor([NAME]);
    const { set } = await listeners({ [NAME]: pem });

    const states = await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    expect(states.get(NAME)?.state).toBe("listening");
    const port = set.boundPort(0) as number;

    expect(await ask(port, NAME, pem.ca)).toBe("service says: hello");
    expect(svc.seen).toEqual(["hello"]);
  });

  test("a name without a certificate opens nothing, and says why", async () => {
    const svc = await service();
    const { set } = await listeners({});
    const states = await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    expect(states.get(NAME)).toEqual({ state: "no-certificate" });
    expect(set.ports()).toEqual([]);
  });

  test("an expired certificate is not served", async () => {
    const svc = await service();
    const { set } = await listeners({ [NAME]: "expired" });
    const states = await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    expect(states.get(NAME)).toEqual({ state: "certificate-expired" });
    expect(set.ports()).toEqual([]);
  });

  test("the listener opens as soon as a certificate covers the name, and not before", async () => {
    const svc = await service();
    const pem = pemFor([NAME]);
    const certs: Record<string, PemPair | "none" | "expired"> = {};
    const { set } = await listeners(certs);
    const wanted = [target(NAME, `http://127.0.0.1:${svc.port}`)];

    expect((await set.reconcile("127.0.0.1", wanted)).get(NAME)?.state).toBe("no-certificate");
    certs[NAME] = pem;
    expect((await set.reconcile("127.0.0.1", wanted)).get(NAME)?.state).toBe("listening");
  });

  test("no wave address, no listener", async () => {
    const svc = await service();
    const { set } = await listeners({ [NAME]: pemFor([NAME]) });
    const states = await set.reconcile(null, [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    expect(states.get(NAME)).toEqual({ state: "no-address" });
  });

  test("two names share a port and each gets its own certificate and service", async () => {
    const one = await service();
    const two = await service();
    const other = "blog.wave.example.com";
    const a = pemFor([NAME]);
    const b = pemFor([other]);
    const { set } = await listeners({ [NAME]: a, [other]: b });

    await set.reconcile("127.0.0.1", [
      target(NAME, `http://127.0.0.1:${one.port}`),
      target(other, `http://127.0.0.1:${two.port}`),
    ]);
    const port = set.boundPort(0) as number;
    expect(set.ports()).toEqual([0]);

    expect(await ask(port, NAME, a.ca, "a")).toBe("service says: a");
    expect(await ask(port, other, b.ca, "b")).toBe("service says: b");
    expect(one.seen).toEqual(["a"]);
    expect(two.seen).toEqual(["b"]);
  });

  test("a name that is not exposed gets no handshake", async () => {
    const svc = await service();
    const pem = pemFor([NAME]);
    const { set } = await listeners({ [NAME]: pem });
    await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    const port = set.boundPort(0) as number;

    await expect(ask(port, "other.wave.example.com", pem.ca)).rejects.toBeDefined();
    expect(svc.seen).toEqual([]);
  });

  test("removing the name closes the listener", async () => {
    const svc = await service();
    const pem = pemFor([NAME]);
    const { set } = await listeners({ [NAME]: pem });
    await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    const port = set.boundPort(0) as number;

    await set.reconcile("127.0.0.1", []);
    expect(set.ports()).toEqual([]);
    await expect(ask(port, NAME, pem.ca)).rejects.toBeDefined();
  });

  test("a renewed certificate is used by the next connection without a restart", async () => {
    const svc = await service();
    const first = pemFor([NAME]);
    const second = pemFor([NAME]);
    const certs: Record<string, PemPair | "none" | "expired"> = { [NAME]: first };
    const { set } = await listeners(certs);
    await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    const port = set.boundPort(0) as number;

    expect(await ask(port, NAME, first.ca)).toBe("service says: hello");
    certs[NAME] = second;
    expect(await ask(port, NAME, second.ca)).toBe("service says: hello");
    await expect(ask(port, NAME, first.ca)).rejects.toBeDefined();
  });

  test("a port that is taken is reported, not thrown", async () => {
    const svc = await service();
    const pem = pemFor([NAME]);
    const taken = createServer();
    await new Promise<void>((resolve) => taken.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((done) => taken.close(() => done())));
    const address = taken.address();
    const port = typeof address === "object" && address ? address.port : 0;

    const { set, log } = await listeners({ [NAME]: pem });
    const states = await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`, port)]);
    expect(states.get(NAME)?.state).toBe("failed");
    expect(log.some((line) => line.includes(`could not listen on 127.0.0.1:${port}`))).toBe(true);
  });

  test("an https service is reached over TLS", async () => {
    const upstream = pemFor(["localhost"]);
    const hits: string[] = [];
    const secure = createTlsServer({ key: upstream.key, cert: upstream.cert }, (socket) => {
      socket.on("data", (chunk) => {
        hits.push(chunk.toString());
        socket.end("secure service");
      });
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((done) => secure.close(() => done())));
    const address = secure.address();
    const upstreamPort = typeof address === "object" && address ? address.port : 0;

    const pem = pemFor([NAME]);
    const { set } = await listeners({ [NAME]: pem }, upstream.ca);
    await set.reconcile("127.0.0.1", [target(NAME, `https://localhost:${upstreamPort}`)]);
    const port = set.boundPort(0) as number;
    expect(await ask(port, NAME, pem.ca, "ping")).toBe("secure service");
    expect(hits).toEqual(["ping"]);
  });

  // The hop to the service is checked like any other TLS connection: a LAN
  // service with a certificate nobody vouches for is not reached, and the log
  // says why. (Use http:// for it, or give it a certificate that is trusted.)
  test("an https service whose certificate is not trusted is not reached", async () => {
    const upstream = pemFor(["localhost"]);
    const hits: string[] = [];
    const secure = createTlsServer({ key: upstream.key, cert: upstream.cert }, (socket) => {
      socket.on("data", (chunk) => hits.push(chunk.toString()));
      socket.on("error", () => {});
    });
    await new Promise<void>((resolve) => secure.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise<void>((done) => secure.close(() => done())));
    const address = secure.address();
    const upstreamPort = typeof address === "object" && address ? address.port : 0;

    const pem = pemFor([NAME]);
    const { set, log } = await listeners({ [NAME]: pem });
    await set.reconcile("127.0.0.1", [target(NAME, `https://localhost:${upstreamPort}`)]);
    const port = set.boundPort(0) as number;
    expect(await ask(port, NAME, pem.ca, "ping")).toBe("");
    expect(hits).toEqual([]);
    expect(log.some((line) => line.includes(`-> localhost:${upstreamPort}`))).toBe(true);
  });
});

describe("through the pier", () => {
  // The whole path of D12 on loopback: a client on the internet side, the pier
  // reading the SNI and splicing, the device ending TLS with its certificate
  // and the service behind it. The pier holds no key -- it is given none.
  test("a browser reaches the service, and the session ends on the device", async () => {
    const svc = await service();
    const pem = pemFor([NAME]);
    const { set } = await listeners({ [NAME]: pem });
    await set.reconcile("127.0.0.1", [target(NAME, `http://127.0.0.1:${svc.port}`)]);
    const devicePort = set.boundPort(0) as number;

    const pier = await startPier({
      host: "127.0.0.1",
      port: 0,
      log: () => {},
      table: () => new Map([[NAME, { ipv4: "10.64.0.2", port: devicePort }]]),
      resolveTarget: (to) => ({ host: "127.0.0.1", port: to.port }),
    });
    closers.push(() => pier.close());

    expect(await ask(pier.port, NAME, pem.ca, "GET /")).toBe("service says: GET /");
    expect(svc.seen).toEqual(["GET /"]);
  });
});
