import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { buildNetmap } from "../src/netmap/build.ts";
import { syncServices } from "../src/waves/services.ts";
import {
  approveDevice,
  CookieJar,
  createTestDb,
  createWaveAs,
  testConfig,
  testSigningKey,
} from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

async function login(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(callback);
  // Signing in no longer makes a wave; its DNS suffix is its owner's choice.
  await createWaveAs((path, init) => app.request(path, init), jar, email);
  return jar;
}

/** Enrols a device the way `wave up` does: register, approve, done. */
async function enrol(hostname: string, jar: CookieJar): Promise<void> {
  const machine = generateKeyPair("ed25519");
  const body = {
    machineKey: machine.publicKey,
    nodeKey: generateKeyPair("x25519").publicKey,
    discoKey: generateKeyPair("x25519").publicKey,
    hostname,
    os: "linux" as const,
  };
  const payload = JSON.stringify(body);
  const res = await app.request("/v1/machine/register", {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.publicKey,
        machinePrivateKey: machine.privateKey,
        method: "POST",
        path: "/v1/machine/register",
        body: payload,
      }),
    },
  });

  const pending = (await res.json()) as { authUrl: string };
  const approve = await approveDevice((path, init) => app.request(path, init), jar, pending.authUrl);
  expect(approve.status).toBe(200);
}

const waveOf = async (jar: CookieJar): Promise<{ id: string; name: string }> => {
  const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
    waves: { id: string; name: string }[];
  };
  const wave = me.waves[0];
  if (!wave) throw new Error("the dev login should have provisioned a wave");
  return wave;
};

describe("the frontend's API", () => {
  test("lists the login providers", async () => {
    const res = await app.request("/api/auth/providers");
    expect(res.status).toBe(200);
    // The ids as before, for an older frontend; the names beside them.
    expect(await res.json()).toEqual({ providers: ["dev"], labels: { dev: "Dev login" } });
  });

  test("hands out a wave's nodes to its members", async () => {
    const jar = await login("robin@example.com");
    await enrol("laptop", jar);
    const wave = await waveOf(jar);

    const res = await app.request(`/api/waves/${wave.id}/nodes`, { headers: { cookie: jar.header() } });
    expect(res.status).toBe(200);

    const { nodes } = (await res.json()) as {
      nodes: { hostname: string; ipv4: string; os: string; online: boolean }[];
    };
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.hostname).toBe("laptop");
    expect(nodes[0]?.ipv4).toBe("10.64.0.1");
    expect(nodes[0]?.os).toBe("linux");
    // Enrolled, but it never opened a control socket.
    expect(nodes[0]?.online).toBe(false);
  });

  // A service has no keys and no tunnel of its own, so the node that carries it
  // is the only place it can be seen. Without this, a connector shows up as a
  // device that joined and then did nothing.
  test("shows a connector's services under the connector", async () => {
    const jar = await login("robin@example.com");
    await enrol("connector", jar);
    const wave = await waveOf(jar);

    const before = (await (
      await app.request(`/api/waves/${wave.id}/nodes`, { headers: { cookie: jar.header() } })
    ).json()) as { nodes: { id: string; services: unknown[] }[] };
    const connector = before.nodes[0];
    if (!connector) throw new Error("the enrolled device should be listed");
    expect(connector.services).toEqual([]);

    const synced = await syncServices(db, {
      waveId: wave.id,
      viaNodeId: connector.id,
      names: ["grafana", "whoami"],
      secure: ["grafana"],
    });
    expect(synced).not.toHaveProperty("conflict");

    const after = (await (
      await app.request(`/api/waves/${wave.id}/nodes`, { headers: { cookie: jar.header() } })
    ).json()) as {
      nodes: { hostname: string; services: { name: string; ipv4: string; url: string }[] }[];
    };

    expect(after.nodes).toHaveLength(1);
    expect(after.nodes[0]?.hostname).toBe("connector");
    expect(after.nodes[0]?.services.map((service) => service.name)).toEqual(["grafana", "whoami"]);
    // The address comes out of the wave's own block, next to the devices.
    expect(after.nodes[0]?.services[0]?.ipv4).toMatch(/^10\.64\./);
    // The finished address, not its parts: the browser never assembles one,
    // and every device gets this same string in its netmap.
    expect(after.nodes[0]?.services.map((service) => service.url)).toEqual([
      "https://grafana.robin.wave.internal",
      "http://whoami.robin.wave.internal",
    ]);

    // And it is literally the same string the device is given. Two spellings
    // of one address is the thing this field exists to prevent: the browser
    // would show one and the tray on the machine next to it another.
    const netmap = await buildNetmap(db, connector.id);
    expect(netmap?.services?.map((service) => service.url)).toEqual(
      after.nodes[0]?.services.map((service) => service.url),
    );
  });

  test("refuses without a session", async () => {
    const jar = await login("robin@example.com");
    const wave = await waveOf(jar);
    expect((await app.request(`/api/waves/${wave.id}/nodes`)).status).toBe(401);
  });

  test("a wave someone else owns is simply unknown", async () => {
    const owner = await login("robin@example.com");
    const wave = await waveOf(owner);

    const stranger = await login("mallory@example.com");
    const res = await app.request(`/api/waves/${wave.id}/nodes`, { headers: { cookie: stranger.header() } });
    expect(res.status).toBe(404);
  });
});
