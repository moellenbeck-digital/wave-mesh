import { afterEach, describe, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { connect as tlsConnect } from "node:tls";
import { type ExposedName, englishText, type PierRow } from "@wave/ipc";
import { startPier } from "../../pier/src/proxy.ts";
import { certPaths } from "../src/certs.ts";
import { loadProfiles, saveProfiles } from "../src/state.ts";
import { type Fixture, freePort, service as startService, setUp as startUp } from "./expose-fixture.ts";

/**
 * `wave expose` through the daemon (D12): what it checks before it asks the
 * server, what it keeps afterwards, when the listener opens -- and the whole
 * way from a browser through the pier and the device's own certificate to the
 * service, on loopback.
 */

const NAME = "app.pier.wave.example.com";

const fixture: Fixture = { cleanup: [] };
const cleanup = fixture.cleanup;
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  fixture.control?.stop();
  fixture.control = undefined;
});

const setUp = (extra: Parameters<typeof startUp>[1] = {}) => startUp(fixture, extra);
const service = () => startService(fixture);

const isNotice = (value: unknown): value is { code: string; params: Record<string, string> } =>
  typeof value === "object" && value !== null && "code" in value;

describe("what is checked before the server is asked", () => {
  test("a name outside the pier zone, a bad URL: refused, nothing asked, nothing kept", async () => {
    const { daemon, statePath, control: server } = await setUp();
    const cases: Array<[string, string, string]> = [
      ["app.example.org", "http://localhost:3000", "expose-bad-name"],
      // Under the wave's domain, but not under the pier zone.
      ["app.wave.example.com", "http://localhost:3000", "expose-bad-name"],
      ["pier.wave.example.com", "http://localhost:3000", "expose-bad-name"],
      ["*.pier.wave.example.com", "http://localhost:3000", "expose-bad-name"],
      ["a.b.pier.wave.example.com", "http://localhost:3000", "expose-bad-name"],
      ["app", "localhost:3000", "expose-bad-url"],
      ["app", "http://localhost", "expose-bad-url"],
      ["app", "http://user:pw@localhost:3000", "expose-bad-url"],
      ["app", "ftp://localhost:21", "expose-bad-url"],
    ];
    for (const [name, url, code] of cases) {
      const result = await daemon.expose(undefined, name, url);
      expect(isNotice(result) && result.code).toBe(code);
    }
    expect(server.pierCalls).toEqual([]);
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([]);
  });

  test("its own listener behind its own name is refused", async () => {
    const { daemon, control: server } = await setUp();
    const result = await daemon.expose(undefined, "app", "http://127.0.0.1:443");
    expect(isNotice(result) && result.code).toBe("expose-loop");
    expect(server.pierCalls).toEqual([]);
  });

  test("a port something else already answers on is refused before the claim", async () => {
    // A database on 0.0.0.0, say: the claim would open the pier's way to it,
    // and the internet's bytes would reach it with no TLS in front.
    const busy = await service();
    const svc = await service();
    const { daemon, statePath, control: server } = await setUp();
    const result = await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, busy.port);
    expect(isNotice(result) && result.code).toBe("expose-port-busy");
    expect(server.pierCalls).toEqual([]);
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([]);
  });

  test("the operator's lock: a translated refusal with the next step, and no state change", async () => {
    const { daemon, statePath, control: server } = await setUp();
    server.pierAllowed = false;
    const result = await daemon.expose(undefined, "app", "http://localhost:3000");
    expect(isNotice(result)).toBe(true);
    if (!isNotice(result)) throw new Error("unreachable");
    expect(result.code).toBe("pier-not-allowed");
    expect(englishText(result)).toContain("allow-pier");
    expect(englishText(result)).toContain("laptop");
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([]);
    expect(server.piers.size).toBe(0);
  });

  test("without the zone in a netmap, the server names it", async () => {
    const { daemon, control: server } = await setUp({ pier: undefined });
    const result = await daemon.expose(undefined, "app.pier.wave.example.com", "http://localhost:3000");
    expect(isNotice(result)).toBe(false);
    expect(server.pierCalls).toEqual(["GET /v1/piers", "POST /v1/piers"]);
  });
});

describe("putting a name out", () => {
  test("without a certificate the claim stands, and the next step is named", async () => {
    const svc = await service();
    const { daemon, statePath, control: server } = await setUp();
    const port = await freePort();

    const result = await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, port);
    if (isNotice(result)) throw new Error(englishText(result));
    expect(result).toMatchObject({ dnsName: NAME, port, state: "no-certificate" });
    expect(server.piers.get("app")).toBe(port);
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([
      { name: "app", dnsName: NAME, localUrl: `http://127.0.0.1:${svc.port}`, port },
    ]);
  });

  test("a host firewall that drops the port is named, with the line that lets the pier in", async () => {
    const svc = await service();
    const asked: Array<[string, number]> = [];
    const command = "sudo ufw allow in on wave0 to any port 8443 proto tcp";
    const log: string[] = [];
    const { daemon } = await startUp(fixture, {}, log, false, {
      hostFirewall: async (iface: string, port: number) => {
        asked.push([iface, port]);
        return { tool: "ufw", command };
      },
    });
    const port = await freePort();

    const result = await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, port);
    if (isNotice(result)) throw new Error(englishText(result));
    expect(result.firewall).toEqual({ tool: "ufw", interface: "wave0", command });
    expect(asked).toEqual([["wave0", port]]);
    expect(log.some((line) => line.includes("ufw drops incoming TCP") && line.includes(command))).toBe(true);

    const list = await daemon.exposedList(undefined);
    if (isNotice(list)) throw new Error(englishText(list));
    expect(list.names[0]?.firewall?.command).toBe(command);
  });

  test("the listener opens by itself once a certificate covers the name, and the whole path works", async () => {
    const svc = await service();
    const { daemon, statePath, control: server } = await setUp();
    const port = await freePort();
    await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, port);
    expect((await daemon.pierStatus())[0]?.state).toBe("no-certificate");

    // `wave cert app.pier.wave.example.com`: the server issues for the pier name.
    const issued = await daemon.cert(undefined, [NAME]);
    if (isNotice(issued) || "waiting" in issued) throw new Error("no certificate");
    // The fake CA made its own key instead of certifying the request's; a real
    // one certifies the node's, so for a handshake the two have to be put together.
    await writeFile(certPaths(statePath, NAME).keyPath, server.issuedKey as string);
    const rows = await daemon.pierStatus();
    expect(rows[0]).toMatchObject({ kind: "own", dnsName: NAME, state: "listening" });

    // A browser on the internet side, through the real pier, ends TLS on the
    // device with the certificate it holds -- checked against that chain by name.
    const chain = await readFile(certPaths(statePath, NAME).chainPath, "utf8");
    const pier = await startPier({
      host: "127.0.0.1",
      port: 0,
      log: () => {},
      table: () => new Map([[NAME, { ipv4: "10.64.0.2", port }]]),
      resolveTarget: (to) => ({ host: "127.0.0.1", port: to.port }),
    });
    cleanup.push(() => pier.close());

    const body = await new Promise<string>((resolve, reject) => {
      const socket = tlsConnect({ host: "127.0.0.1", port: pier.port, servername: NAME, ca: chain }, () =>
        socket.write("GET /"),
      );
      let text = "";
      socket.on("data", (chunk) => (text += chunk.toString()));
      socket.on("close", () => resolve(text));
      socket.on("error", reject);
    });
    expect(body).toBe("service says: GET /");
    expect(svc.seen).toEqual(["GET /"]);
  });

  test("removing it takes the claim and the listener away", async () => {
    const svc = await service();
    const { daemon, statePath, control: server } = await setUp();
    const port = await freePort();
    await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, port);
    await daemon.cert(undefined, [NAME]);
    expect((await daemon.pierStatus())[0]?.state).toBe("listening");

    const removed = await daemon.unexpose(undefined, NAME);
    if (isNotice(removed)) throw new Error(englishText(removed));
    expect(removed).toMatchObject({ state: "removed", dnsName: NAME, port });
    expect(server.piers.size).toBe(0);
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([]);
    expect(await daemon.pierStatus()).toEqual([]);

    // Gone, so the port is free again.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((done) => probe.close(() => done()));
  });

  test("taking the tunnel down closes the listener, and bringing it up opens it again", async () => {
    const svc = await service();
    const { daemon, control: server, statePath } = await setUp();
    const port = await freePort();
    await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, port);
    await daemon.cert(undefined, [NAME]);
    await writeFile(certPaths(statePath, NAME).keyPath, server.issuedKey as string);
    expect((await daemon.pierStatus())[0]?.state).toBe("listening");

    await daemon.down();
    expect((await daemon.pierStatus())[0]?.state).toBe("tunnel-down");
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, "127.0.0.1", resolve);
    });
    await new Promise<void>((done) => probe.close(() => done()));

    await daemon.up();
    expect((await daemon.pierStatus())[0]?.state).toBe("listening");
  });

  test("removing what was never put out says so and changes nothing", async () => {
    const { daemon } = await setUp();
    const result = await daemon.unexpose(undefined, "nothing");
    expect(isNotice(result) && result.code).toBe("unexpose-unknown");
  });

  test("a name the server no longer knows is still cleared here", async () => {
    const svc = await service();
    const { daemon, statePath, control: server } = await setUp();
    await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, await freePort());
    // What `deny-pier` does on the server: the claim is gone, the local half is not.
    server.piers.clear();
    const removed = await daemon.unexpose(undefined, "app");
    expect(isNotice(removed)).toBe(false);
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([]);
  });
});

describe("listing and status", () => {
  test("--list merges the server's names with what this device proxies", async () => {
    const svc = await service();
    const { daemon, statePath, control: server } = await setUp();
    await daemon.expose(undefined, "app", `http://127.0.0.1:${svc.port}`, await freePort());
    // A name the server has that this device has no service for, and the reverse.
    server.piers.set("other", 443);
    const [profile] = await loadProfiles(statePath);
    await saveProfiles(statePath, [
      {
        ...(profile as NonNullable<typeof profile>),
        exposed: [...(profile?.exposed ?? []), { name: "stale", localUrl: "http://127.0.0.1:1", port: 8443 }],
      },
    ]);

    const list = await daemon.exposedList(undefined);
    if (isNotice(list)) throw new Error(englishText(list));
    expect(list.allowed).toBe(true);
    expect(list.pier).toEqual({ publicIpv4: "203.0.113.10", publicIpv6: null });
    const byName = (name: string): ExposedName | undefined => list.names.find((entry) => entry.name === name);
    expect(byName("app")?.state).toBe("no-certificate");
    expect(byName("other")?.state).toBe("unmapped");
    expect(byName("stale")?.state).toBe("not-claimed");
  });

  test("on the pier node, the names it serves and whether each device can be reached", async () => {
    const { daemon } = await setUp({
      self: { hostname: "pier", dnsName: "pier.wave.example.com", ipv4: "10.64.0.1", ipv6: "", services: [] },
      pier: { zone: "pier.wave.example.com", self: true },
      piers: [
        { name: "app", dnsName: NAME, ipv4: "10.64.0.2", port: 443 },
        { name: "blog", dnsName: "blog.pier.wave.example.com", ipv4: "10.64.0.3", port: 443 },
        { name: "gone", dnsName: "gone.pier.wave.example.com", ipv4: "10.64.0.9", port: 443 },
      ],
      peers: [
        {
          hostname: "laptop",
          dnsName: "laptop.wave.example.com",
          ipv4: "10.64.0.2",
          ipv6: "",
          via: "203.0.113.5:41641",
          services: [],
        },
        {
          hostname: "desktop",
          dnsName: "desktop.wave.example.com",
          ipv4: "10.64.0.3",
          ipv6: "",
          services: [],
        },
      ],
    });
    const rows: PierRow[] = await daemon.pierStatus();
    const row = (dnsName: string) => rows.find((entry) => entry.dnsName === dnsName);
    expect(row(NAME)).toMatchObject({ kind: "served", state: "reachable", target: { hostname: "laptop" } });
    expect(row("blog.pier.wave.example.com")).toMatchObject({ kind: "served", state: "unreachable" });
    // An address no peer has: nothing to splice to.
    expect(row("gone.pier.wave.example.com")).toMatchObject({ kind: "served", state: "unreachable" });
  });

  test("elsewhere the names of other devices are only for the resolver, and serve nothing here", async () => {
    const { daemon } = await setUp({
      piers: [{ name: "blog", dnsName: "blog.pier.wave.example.com", ipv4: "10.64.0.3", port: 443 }],
    });
    expect(await daemon.pierStatus()).toEqual([]);
  });
});
