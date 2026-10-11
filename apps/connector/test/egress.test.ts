import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { RecordType, resolve } from "@wave/dns";
import type { ProfileStatus } from "@wave/ipc";
import {
  type Egress,
  egressResolver,
  egressTable,
  egressZone,
  hostFromHttp,
  sniFromClientHello,
  startEgress,
} from "../src/egress.ts";
import { egressFromEnv } from "../src/main.ts";

/**
 * The connector's way from the cluster into the wave. What matters: the name
 * is read right, only names from the netmap get through, and the bytes arrive
 * untouched -- TLS is passed on, never opened.
 */

const NAME = "plausible.wave.example.com";

/** A real ClientHello, as a TLS client sends it, caught before any answer. */
async function clientHello(servername: string): Promise<Buffer> {
  return new Promise((resolve) => {
    const server = createServer((socket) => {
      socket.once("data", (data: Buffer) => {
        resolve(data);
        socket.destroy();
        server.close();
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      tlsConnect({ host: "127.0.0.1", port, servername, rejectUnauthorized: false }).on("error", () => {});
    });
  });
}

/** The same handshake, cut into two TLS records -- allowed, and seen with large key shares. */
function inTwoRecords(hello: Buffer): Buffer {
  const payload = hello.subarray(5);
  const cut = 40;
  const record = (part: Buffer) =>
    Buffer.concat([Buffer.from([0x16, 0x03, 0x01, part.length >> 8, part.length & 0xff]), part]);
  return Buffer.concat([record(payload.subarray(0, cut)), record(payload.subarray(cut))]);
}

describe("reading the name", () => {
  test("SNI from a real ClientHello, whole, split, or not yet there", async () => {
    const hello = await clientHello(NAME);
    expect(sniFromClientHello(hello)).toEqual({ name: NAME });
    expect(sniFromClientHello(inTwoRecords(hello))).toEqual({ name: NAME });
    expect(sniFromClientHello(hello.subarray(0, 20))).toBe("more");
    expect(sniFromClientHello(Buffer.from("GET / HTTP/1.1\r\n"))).toBe("none");
  });

  test("Host from an HTTP request, port and case aside", () => {
    const request = (head: string) => Buffer.from(`GET / HTTP/1.1\r\n${head}\r\n\r\n`);
    expect(hostFromHttp(request(`host: Plausible.Wave.Example.com:80`))).toEqual({ name: NAME });
    expect(hostFromHttp(request("Accept: */*"))).toBe("none");
    expect(hostFromHttp(Buffer.from(`GET / HTTP/1.1\r\nHost: ${NAME}\r\n`))).toBe("more");
  });
});

describe("which names there are", () => {
  test("peers, the services they front, and our own services, from the netmap", () => {
    const service = (name: string, ipv4: string) => ({
      name,
      dnsName: `${name}.wave.example.com`,
      ipv4,
      url: "",
    });
    const status = [
      {
        controlUrl: "https://wave.example.com",
        state: "up",
        self: {
          hostname: "k3s",
          dnsName: "k3s.wave.example.com",
          ipv4: "10.64.0.9",
          ipv6: "",
          services: [service("git", "10.64.1.9")],
        },
        peers: [
          {
            hostname: "cluster-a",
            dnsName: "cluster-a.wave.example.com",
            ipv4: "10.64.0.5",
            ipv6: "",
            services: [service("plausible", "10.64.1.4")],
          },
        ],
      },
    ] as unknown as ProfileStatus[];
    const table = egressTable(status);
    expect(table.get(NAME)).toEqual({ ipv4: "10.64.1.4", local: false });
    expect(table.get("cluster-a.wave.example.com")).toEqual({ ipv4: "10.64.0.5", local: false });
    expect(table.get("git.wave.example.com")).toEqual({ ipv4: "10.64.1.9", local: true });
    expect(table.has("example.com")).toBe(false);
  });
});

describe("answering for the names", () => {
  /** A wire-format question, as CoreDNS forwards it. */
  function query(name: string, type: number): Uint8Array {
    const body: number[] = [];
    for (const label of name.split(".")) body.push(label.length, ...new TextEncoder().encode(label));
    body.push(0, type >> 8, type & 0xff, 0, 1);
    return Uint8Array.from([0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0, ...body]);
  }
  /** Response code and answer count, read straight from the header. */
  function answer(name: string, type: number = RecordType.A) {
    const table = new Map([[NAME, { ipv4: "10.64.1.4", local: false }]]);
    const decision = resolve(query(name, type), egressResolver(table, "wave.example.com", "10.43.0.53"));
    if (decision.kind !== "answer") return decision.kind;
    const packet = decision.packet;
    return {
      code: (packet[3] ?? 0) & 0x0f,
      answers: ((packet[6] ?? 0) << 8) | (packet[7] ?? 0),
      last: [...packet.subarray(-4)].join("."),
    };
  }

  test("a name in the netmap is the Service's address, never the wave's", () => {
    expect(answer(NAME)).toEqual({ code: 0, answers: 1, last: "10.43.0.53" });
  });

  test("a name the wave does not have is NXDOMAIN, not a connection refused later", () => {
    expect(answer("nothere.wave.example.com")).toMatchObject({ code: 3, answers: 0 });
  });

  test("AAAA for a known name is empty, so a client falls back to A at once", () => {
    expect(answer(NAME, RecordType.AAAA)).toMatchObject({ code: 0, answers: 0 });
  });

  test("outside the zone it is not ours to answer", () => {
    expect(answer("example.com")).toBe("drop");
  });

  test("the zone is our own name without our hostname", () => {
    const status = (state: string, hostname: string, dnsName: string) =>
      [{ controlUrl: "https://c", state, self: { hostname, dnsName } }] as unknown as ProfileStatus[];
    expect(egressZone(status("up", "k3s", "k3s.wave.example.com."))).toBe("wave.example.com");
    expect(egressZone(status("up", "k3s", "other.wave.example.com"))).toBeUndefined();
    expect(egressZone([])).toBeUndefined();
  });
});

describe("passing connections on", () => {
  let egress: Egress | undefined;
  let upstream: Server | undefined;
  afterEach(async () => {
    await egress?.close();
    upstream?.close();
    egress = undefined;
  });

  /** A destination that records what arrives and answers HTTP requests. */
  async function destination(): Promise<{ port: number; received: () => Buffer }> {
    let received = Buffer.alloc(0);
    upstream = createServer((socket: Socket) => {
      socket.on("data", (data: Buffer) => {
        received = Buffer.concat([received, data]);
        if (received.toString().includes("\r\n\r\n")) socket.end("HTTP/1.1 204 No Content\r\n\r\n");
      });
    });
    await new Promise<void>((resolve) => upstream?.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    return { port: typeof address === "object" && address ? address.port : 0, received: () => received };
  }

  async function start(
    table: Map<string, { ipv4: string; local: boolean }>,
    port: number,
    backend = "127.0.0.1",
  ) {
    egress = await startEgress({
      host: "127.0.0.1",
      tlsPort: 0,
      httpPort: 0,
      table: () => table,
      backend,
      upstreamPorts: { tls: port, http: port },
      log: () => {},
    });
    return egress.ports;
  }

  /** Sends bytes to a port and collects the answer until the other side closes. */
  const exchange = (port: number, data: Buffer | string) =>
    new Promise<Buffer>((resolve) => {
      let answer = Buffer.alloc(0);
      const socket = connect(port, "127.0.0.1", () => socket.write(data));
      socket.on("data", (chunk: Buffer) => (answer = Buffer.concat([answer, chunk])));
      socket.on("close", () => resolve(answer));
      socket.on("error", () => resolve(answer));
      setTimeout(() => socket.destroy(), 1500);
    });

  test("TLS goes on byte for byte, unopened", async () => {
    const target = await destination();
    const ports = await start(new Map([[NAME, { ipv4: "127.0.0.1", local: false }]]), target.port);
    const hello = await clientHello(NAME);
    await exchange(ports.tls, hello);
    expect(target.received().equals(hello)).toBe(true);
  });

  test("HTTP goes on with its request and comes back with the answer", async () => {
    const target = await destination();
    const ports = await start(new Map([[NAME, { ipv4: "127.0.0.1", local: false }]]), target.port);
    const answer = await exchange(
      ports.http,
      `POST /api/event HTTP/1.1\r\nHost: ${NAME}\r\nContent-Length: 0\r\n\r\n`,
    );
    expect(answer.toString()).toStartWith("HTTP/1.1 204");
    expect(target.received().toString()).toStartWith("POST /api/event HTTP/1.1");
  });

  test("a name that is not in the wave is refused, and says so", async () => {
    const target = await destination();
    const ports = await start(new Map(), target.port);
    const http = await exchange(ports.http, "GET / HTTP/1.1\r\nHost: example.com\r\n\r\n");
    expect(http.toString()).toStartWith("HTTP/1.1 421");
    const tls = await exchange(ports.tls, await clientHello("example.com"));
    // A fatal unrecognized_name alert, not a silent reset.
    expect([...tls]).toEqual([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x70]);
    expect(target.received().length).toBe(0);
  });

  test("our own services go to the local ingress, not to their wave address", async () => {
    const target = await destination();
    // The wave address is one nothing answers on; only the backend does.
    const ports = await start(
      new Map([[NAME, { ipv4: "192.0.2.1", local: true }]]),
      target.port,
      "127.0.0.1",
    );
    const answer = await exchange(ports.http, `GET / HTTP/1.1\r\nHost: ${NAME}\r\n\r\n`);
    expect(answer.toString()).toStartWith("HTTP/1.1 204");
  });
});

describe("switching it on", () => {
  test("only with the pod's own address, never everywhere", () => {
    expect(egressFromEnv({})).toBeUndefined();
    expect(() => egressFromEnv({ WAVE_EGRESS: "1" })).toThrow(/WAVE_POD_IP/);
    expect(() => egressFromEnv({ WAVE_EGRESS: "1", WAVE_POD_IP: "0.0.0.0" })).toThrow(/never 0.0.0.0/);
    expect(() => egressFromEnv({ WAVE_EGRESS: "1", WAVE_POD_IP: "10.42.0.7" })).toThrow(
      /WAVE_EGRESS_ADDRESS/,
    );
    expect(
      egressFromEnv({ WAVE_EGRESS: "1", WAVE_POD_IP: "10.42.0.7", WAVE_EGRESS_ADDRESS: "10.43.0.53" }),
    ).toEqual({ host: "10.42.0.7", address: "10.43.0.53", tlsPort: 8443, httpPort: 8080, dnsPort: 8053 });
  });
});
