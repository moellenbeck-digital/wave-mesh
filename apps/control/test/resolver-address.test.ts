import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { Netmap } from "@wave/proto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, waves } from "../src/db/schema.ts";
import { resolverAddressFor } from "../src/net/addressing.ts";
import { buildNetmap } from "../src/netmap/build.ts";
import {
  approveDevice,
  CookieJar,
  createTestDb,
  createWaveAs,
  testConfig,
  testSigningKey,
} from "./helpers.ts";

/**
 * The address a wave reserves for its resolver.
 *
 * It exists for the clients whose resolver has no socket of its own -- a phone
 * (D10). There the query only arrives if the address is *routed* into the
 * tunnel and held by nobody: an address the tunnel interface holds is answered
 * locally by a kernel with nothing listening behind it, and the packet never
 * reaches the tunnel at all. So it has to belong to the wave and to no device
 * in it, which only the side that allocates addresses can arrange.
 */
let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

async function signUp(email: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const callback = await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(callback);
  await createWaveAs((path, init) => app.request(path, init), jar, email);
  return jar;
}

/** A device asking to be let in, and a browser letting it. */
async function enrol(hostname: string, jar: CookieJar): Promise<void> {
  const machine = generateKeyPair("ed25519");
  const body = JSON.stringify({
    machineKey: machine.publicKey,
    nodeKey: generateKeyPair("x25519").publicKey,
    discoKey: generateKeyPair("x25519").publicKey,
    hostname,
    os: "linux" as const,
  });
  const res = await app.request("/v1/machine/register", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.publicKey,
        machinePrivateKey: machine.privateKey,
        method: "POST",
        path: "/v1/machine/register",
        body,
      }),
    },
  });
  const pending = (await res.json()) as { authUrl: string };
  await approveDevice((path, init) => app.request(path, init), jar, pending.authUrl);
}

const firstNode = async () => {
  const rows = await db.select().from(nodes).limit(1);
  const row = rows[0];
  if (!row) throw new Error("no node was enrolled");
  return row;
};

describe("the resolver's reserved address", () => {
  test("is in the netmap, out of the wave's own block", async () => {
    const jar = await signUp("robin@example.com");
    await enrol("laptop", jar);

    const node = await firstNode();
    const [wave] = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    if (!wave) throw new Error("no wave");

    const netmap = await buildNetmap(db, node.id);
    expect(netmap?.dns.resolverAddress).toBe(resolverAddressFor(wave.ipv4Prefix));
  });

  test("is not given to a device", async () => {
    const jar = await signUp("robin@example.com");
    // Enough devices that the allocator walks past the reservation.
    for (let i = 0; i < 60; i++) await enrol(`node-${i}`, jar);

    const node = await firstNode();
    const [wave] = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    if (!wave) throw new Error("no wave");
    const reserved = resolverAddressFor(wave.ipv4Prefix);

    const all = await db.select().from(nodes).where(eq(nodes.waveId, node.waveId));
    expect(all.length).toBe(60);
    expect(all.map((row) => row.ipv4)).not.toContain(reserved);

    const netmap = await buildNetmap(db, node.id);
    expect(netmap?.dns.resolverAddress).toBe(reserved);
  });

  /**
   * A wave numbered before the reservation existed may already have given that
   * address to a node. Pointing every device's DNS at it would take that device
   * off the network, so the netmap says nothing instead -- and the clients that
   * need it say so themselves.
   */
  test("is left out rather than pointed at a device that holds it", async () => {
    const jar = await signUp("robin@example.com");
    await enrol("laptop", jar);

    const node = await firstNode();
    const [wave] = await db.select().from(waves).where(eq(waves.id, node.waveId)).limit(1);
    if (!wave) throw new Error("no wave");
    const reserved = resolverAddressFor(wave.ipv4Prefix);
    await db.update(nodes).set({ ipv4: reserved }).where(eq(nodes.id, node.id));

    const netmap = await buildNetmap(db, node.id);
    expect(netmap?.dns.resolverAddress).toBeUndefined();
    // And it stays a netmap: the field is optional, not defaulted, so nothing
    // invents one -- which would canonicalise differently from what was signed.
    const parsed = Netmap.parse(netmap);
    expect("resolverAddress" in parsed.dns).toBe(false);
  });
});
