import { afterEach, describe, expect, test } from "bun:test";
import { connect, createServer, type Server, type Socket } from "node:net";
import { createServer as createTlsServer, type Server as TlsServer, connect as tlsConnect } from "node:tls";
import { generateCertificateKey, selfSignedCertificate, toPem } from "@wave/crypto";
import type { ProfileStatus } from "@wave/ipc";
import { assessTunnel } from "../src/health.ts";
import { describeChange, pierHostFromEnv } from "../src/main.ts";
import { type Pier, startPier } from "../src/proxy.ts";
import { type PierTable, pierTable } from "../src/table.ts";

/**
 * The pier: the name is read right, only names from the netmap get through,
 * the bytes arrive untouched, and everything else is closed without a word.
 */

const NAME = "app.wave.example.com";

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

const status = (overrides: Record<string, unknown> = {}) =>
  [
    {
      controlUrl: "https://wave.example.com",
      state: "up",
      self: { hostname: "pier", dnsName: "pier.wave.example.com", ipv4: "10.64.0.1", ipv6: "" },
      peers: [{ hostname: "laptop", dnsName: "laptop.wave.example.com", ipv4: "10.64.0.2", ipv6: "" }],
      piers: [{ name: "app", dnsName: NAME, ipv4: "10.64.0.2", port: 8443 }],
      ...overrides,
    },
  ] as unknown as ProfileStatus[];

describe("which names there are", () => {
  test("the piers of the netmap, by their full name", () => {
    expect(pierTable(status()).get(NAME)).toEqual({ ipv4: "10.64.0.2", port: 8443 });
  });

  test("a name is compared lower case and without the root dot", () => {
    const table = pierTable(
      status({ piers: [{ name: "app", dnsName: "App.Wave.Example.com.", ipv4: "10.64.0.2", port: 443 }] }),
    );
    expect(table.has(NAME)).toBe(true);
  });

  test("an address that no peer has is no target: the pier never leaves the wave", () => {
    const table = pierTable(
      status({
        piers: [
          { name: "app", dnsName: NAME, ipv4: "169.254.169.254", port: 80 },
          { name: "lan", dnsName: "lan.wave.example.com", ipv4: "192.168.1.1", port: 443 },
        ],
      }),
    );
    expect(table.size).toBe(0);
  });

  test("nothing while the tunnel is not up", () => {
    expect(pierTable(status({ state: "connecting" })).size).toBe(0);
    expect(pierTable([]).size).toBe(0);
  });

  test("a wave named by its server is the one asked, not the first", () => {
    const other = { ...(status()[0] as ProfileStatus), controlUrl: "https://other.example.com", piers: [] };
    const both = [other, ...status()] as ProfileStatus[];
    expect(pierTable(both, "https://wave.example.com").has(NAME)).toBe(true);
    expect(pierTable(both, "https://other.example.com").size).toBe(0);
  });
});

describe("splicing connections", () => {
  let pier: Pier | undefined;
  const servers: (Server | TlsServer)[] = [];
  afterEach(async () => {
    await pier?.close();
    for (const server of servers.splice(0)) server.close();
    pier = undefined;
  });

  /** A device that records what arrives and answers once it has seen a ClientHello. */
  async function device(): Promise<{ port: number; received: () => Buffer; connections: () => number }> {
    let received = Buffer.alloc(0);
    let connections = 0;
    const server = createServer((socket: Socket) => {
      connections++;
      socket.on("data", (data: Buffer) => {
        received = Buffer.concat([received, data]);
        socket.write("pong");
      });
      socket.on("error", () => {});
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    return {
      port: typeof address === "object" && address ? address.port : 0,
      received: () => received,
      connections: () => connections,
    };
  }

  async function start(
    table: PierTable,
    target: number,
    options: Partial<Parameters<typeof startPier>[0]> = {},
  ): Promise<number> {
    pier = await startPier({
      host: "127.0.0.1",
      port: 0,
      table: () => table,
      resolveTarget: () => ({ host: "127.0.0.1", port: target }),
      log: () => {},
      ...options,
    });
    return pier.port;
  }

  /** Sends bytes and collects what comes back until the other side closes. */
  const exchange = (port: number, data?: Buffer | string, wait = 1000) =>
    new Promise<{ answer: Buffer; closed: boolean }>((resolve) => {
      let answer = Buffer.alloc(0);
      let closed = false;
      const socket = connect(port, "127.0.0.1", () => {
        if (data) socket.write(data);
      });
      socket.on("data", (chunk: Buffer) => (answer = Buffer.concat([answer, chunk])));
      socket.on("close", () => {
        closed = true;
        resolve({ answer, closed });
      });
      socket.on("error", () => {});
      setTimeout(() => {
        socket.destroy();
        resolve({ answer, closed });
      }, wait);
    });

  const known = (port: number): PierTable => new Map([[NAME, { ipv4: "10.64.0.2", port }]]);

  test("the ClientHello arrives at the device byte for byte, and its answer comes back", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port);
    const hello = await clientHello(NAME);

    const { answer } = await exchange(port, hello);
    expect(target.received().equals(hello)).toBe(true);
    expect(answer.toString()).toBe("pong");
  });

  test("a ClientHello that comes in two pieces is waited for", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port);
    const hello = await clientHello(NAME);

    const received = await new Promise<Buffer>((resolve) => {
      const socket = connect(port, "127.0.0.1", () => {
        socket.write(hello.subarray(0, 30));
        setTimeout(() => socket.write(hello.subarray(30)), 100);
      });
      socket.on("data", () => resolve(target.received()));
      socket.on("error", () => {});
      setTimeout(() => {
        socket.destroy();
        resolve(target.received());
      }, 1500);
    });
    expect(received.equals(hello)).toBe(true);
  });

  // The property the whole design rests on: the session ends on the device,
  // with the device's own certificate, and the pier never held a key.
  test("a real TLS session ends on the device, with the certificate it holds", async () => {
    const key = generateCertificateKey();
    const der = selfSignedCertificate({
      privateKeyPem: key.privateKeyPem,
      names: [NAME],
      notBefore: new Date(Date.now() - 60_000),
      notAfter: new Date(Date.now() + 3_600_000),
    });
    const certificate = toPem("CERTIFICATE", der);
    const tls = createTlsServer({ key: key.privateKeyPem, cert: certificate }, (socket) => {
      socket.on("data", () => socket.end("hello from the device"));
      socket.on("error", () => {});
    });
    servers.push(tls);
    await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
    const address = tls.address();
    const target = typeof address === "object" && address ? address.port : 0;
    const port = await start(known(target), target);

    const body = await new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port, servername: NAME, ca: certificate }, () => {
        socket.write("hi");
      });
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString()));
      socket.on("end", () => resolve(text));
      socket.on("error", reject);
    });
    // Verified against the device's certificate by name: nothing in between
    // could have answered this handshake.
    expect(body).toBe("hello from the device");
  });

  test("a name that is not a pier is closed without a word", async () => {
    const target = await device();
    const port = await start(new Map(), target.port);

    const { answer, closed } = await exchange(port, await clientHello("example.com"));
    expect(answer.length).toBe(0);
    expect(closed).toBe(true);
    expect(target.connections()).toBe(0);
  });

  test("no name at all is closed without a word", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port);

    // A TLS client that sends no SNI, a plain HTTP request and noise.
    const noSni = await new Promise<Buffer>((resolve) => {
      const server = createServer((socket) => {
        socket.once("data", (data: Buffer) => {
          resolve(data);
          socket.destroy();
          server.close();
        });
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const serverPort = typeof address === "object" && address ? address.port : 0;
        // An IP address as the host sends no SNI.
        tlsConnect({ host: "127.0.0.1", port: serverPort, rejectUnauthorized: false }).on("error", () => {});
      });
    });
    for (const data of [noSni, "GET / HTTP/1.1\r\nHost: app.wave.example.com\r\n\r\n", Buffer.alloc(64, 7)]) {
      const { answer, closed } = await exchange(port, data);
      expect(answer.length).toBe(0);
      expect(closed).toBe(true);
    }
    expect(target.connections()).toBe(0);
  });

  test("a device that is not there closes the connection, with no error page", async () => {
    // Nothing listens on this port: take one that was just free.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
    const address = probe.address();
    const dead = typeof address === "object" && address ? address.port : 1;
    await new Promise<void>((resolve) => probe.close(() => resolve()));

    const port = await start(known(dead), dead);
    const { answer, closed } = await exchange(port, await clientHello(NAME));
    expect(answer.length).toBe(0);
    expect(closed).toBe(true);
  });

  test("a client that never says a name is let go", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port, { sniffTimeoutMs: 100 });
    const { closed } = await exchange(port, undefined, 1000);
    expect(closed).toBe(true);
    expect(target.connections()).toBe(0);
  });

  test("a client trickling its first bytes is let go at the deadline, not kept alive by each byte", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port, { sniffTimeoutMs: 300 });
    const hello = await clientHello(NAME);
    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      socket.on("error", () => {});
      let at = 0;
      const drip = setInterval(() => {
        if (at < hello.length - 1) socket.write(hello.subarray(at, ++at));
      }, 50);
      socket.on("close", () => {
        clearInterval(drip);
        resolve(true);
      });
      setTimeout(() => {
        clearInterval(drip);
        socket.destroy();
        resolve(false);
      }, 2000);
    });
    expect(closed).toBe(true);
    expect(target.connections()).toBe(0);
  });

  test("a ClientHello split into a few pieces still gets through", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port);
    const hello = await clientHello(NAME);
    const answer = await new Promise<string>((resolve) => {
      let got = "";
      const socket = connect(port, "127.0.0.1", async () => {
        for (let at = 0; at < hello.length; at += 64) {
          socket.write(hello.subarray(at, at + 64));
          await Bun.sleep(5);
        }
      });
      socket.on("data", (chunk: Buffer) => {
        got += chunk.toString();
        socket.destroy();
      });
      socket.on("error", () => {});
      socket.on("close", () => resolve(got));
    });
    expect(answer).toBe("pong");
  });

  test("one name cannot take every slot of the pier", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port, { maxConnections: 8, maxPerName: 1 });
    const held = connect(port, "127.0.0.1", async () => held.write(await clientHello(NAME)));
    held.on("error", () => {});
    await Bun.sleep(200);
    const { closed, answer } = await exchange(port, await clientHello(NAME));
    expect(closed).toBe(true);
    expect(answer.length).toBe(0);
    held.destroy();
  });

  test("the table is read for every connection, so a name added later works", async () => {
    const target = await device();
    const table: PierTable = new Map();
    const port = await start(table, target.port);
    expect((await exchange(port, await clientHello(NAME))).answer.length).toBe(0);

    table.set(NAME, { ipv4: "10.64.0.2", port: target.port });
    expect((await exchange(port, await clientHello(NAME))).answer.toString()).toBe("pong");

    table.delete(NAME);
    expect((await exchange(port, await clientHello(NAME))).answer.length).toBe(0);
  });

  test("past its limit it takes no more connections", async () => {
    const target = await device();
    const port = await start(known(target.port), target.port, { maxConnections: 1, sniffTimeoutMs: 5000 });
    const held = connect(port, "127.0.0.1");
    held.on("error", () => {});
    await Bun.sleep(100);

    const { closed } = await exchange(port, await clientHello(NAME));
    expect(closed).toBe(true);
    expect(target.connections()).toBe(0);
    held.destroy();
  });

  test("a refusal is written down once per window, not once per knock", async () => {
    const lines: string[] = [];
    const target = await device();
    const port = await start(new Map(), target.port, { log: (line) => lines.push(line) });
    for (let knock = 0; knock < 5; knock++) await exchange(port, await clientHello("example.com"));
    expect(lines.filter((line) => line.includes("closed")).length).toBe(1);
    expect(lines.join("\n")).toContain("example.com");
  });
});

describe("where it listens", () => {
  test("on a named address, never everywhere", () => {
    expect(() => pierHostFromEnv({})).toThrow(/WAVE_PIER_HOST/);
    expect(() => pierHostFromEnv({ WAVE_PIER_HOST: "0.0.0.0" })).toThrow(/never 0.0.0.0/);
    expect(() => pierHostFromEnv({ WAVE_PIER_HOST: "::" })).toThrow(/never 0.0.0.0/);
    expect(pierHostFromEnv({ WAVE_PIER_HOST: "10.42.0.9" })).toBe("10.42.0.9");
    expect(pierHostFromEnv({ WAVE_POD_IP: "10.42.0.7" })).toBe("10.42.0.7");
  });
});

describe("saying what changed", () => {
  test("names that came, moved and went, once each", () => {
    const before: PierTable = new Map([
      ["a.wave.example.com", { ipv4: "10.64.0.2", port: 443 }],
      ["b.wave.example.com", { ipv4: "10.64.0.3", port: 443 }],
    ]);
    const after: PierTable = new Map([
      ["a.wave.example.com", { ipv4: "10.64.0.2", port: 8443 }],
      ["c.wave.example.com", { ipv4: "10.64.0.4", port: 443 }],
    ]);
    expect(describeChange(before, after)).toEqual([
      "pier: serving a.wave.example.com -> 10.64.0.2:8443",
      "pier: serving c.wave.example.com -> 10.64.0.4:443",
      "pier: no longer serving b.wave.example.com",
    ]);
    expect(describeChange(after, after)).toEqual([]);
  });
});

describe("whether it still works", () => {
  test("the tunnel has to be up, and the relay connected when there is one", () => {
    expect(assessTunnel(status())).toEqual({ healthy: true });
    expect(assessTunnel([])).toMatchObject({ healthy: false });
    expect(assessTunnel(status({ state: "connecting" }))).toMatchObject({ healthy: false });
    expect(assessTunnel(status({ relay: { url: "https://r", connected: false } }))).toMatchObject({
      healthy: false,
    });
  });
});
