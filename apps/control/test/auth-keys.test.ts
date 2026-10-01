import { beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { nodes, users, waveAuthKeys, waveMembers } from "../src/db/schema.ts";
import { createAuthKey, listAuthKeys, revokeAuthKey } from "../src/waves/auth-keys.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Enrolling without a browser (D11's prerequisite).
 *
 * A connector in a cluster is deployed, not clicked, so the approval has to be
 * given in advance. What these tests hold on to is that it stays an approval:
 * for one wave, once unless it says otherwise, and withdrawable.
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

function makeMachine(hostname: string) {
  const machine = generateKeyPair("ed25519");
  return {
    machine,
    body: {
      machineKey: machine.publicKey,
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname,
      os: "linux" as const,
    },
  };
}

const register = (machine: ReturnType<typeof makeMachine>, authKey?: string) => {
  const path = "/v1/machine/register";
  const payload = JSON.stringify({ ...machine.body, ...(authKey ? { authKey } : {}) });
  return app.request(path, {
    method: "POST",
    body: payload,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.machine.publicKey,
        machinePrivateKey: machine.machine.privateKey,
        method: "POST",
        path,
        body: payload,
      }),
    },
  });
};

/** A wave with an owner, as the shell would leave it. */
async function wave(email = "robin@example.com") {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  jar.absorb(
    await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
      headers: { cookie: jar.header() },
    }),
  );
  await createWaveAs((path, init) => app.request(path, init), jar, email);

  const [member] = await db.select().from(waveMembers).limit(1);
  const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);
  if (!member || !user) throw new Error("no wave was created");
  return { waveId: member.waveId, userId: user.id };
}

describe("a pre-auth key", () => {
  test("enrols a device without anyone opening a link", async () => {
    const { waveId, userId } = await wave();
    const key = await createAuthKey(db, { waveId, userId, label: "cluster" });

    const res = await register(makeMachine("connector"), key.token);
    const body = (await res.json()) as { status: string; nodeId: string };
    expect(body.status).toBe("authorized");

    const [node] = await db.select().from(nodes).where(eq(nodes.id, body.nodeId)).limit(1);
    expect(node?.waveId).toBe(waveId);
    // The device belongs to whoever made the key, not to nobody.
    expect(node?.userId).toBe(userId);
  });

  test("is spent after one device unless it says otherwise", async () => {
    const { waveId, userId } = await wave();
    const key = await createAuthKey(db, { waveId, userId });

    expect(((await (await register(makeMachine("a"), key.token)).json()) as { status: string }).status).toBe(
      "authorized",
    );
    const second = await register(makeMachine("b"), key.token);
    expect(second.status).toBe(403);
  });

  test("a reusable one enrols a whole deployment", async () => {
    const { waveId, userId } = await wave();
    const key = await createAuthKey(db, { waveId, userId, reusable: true });

    for (const host of ["a", "b", "c"]) {
      const res = await register(makeMachine(host), key.token);
      expect(res.status).toBe(200);
    }
    expect((await listAuthKeys(db, waveId))[0]?.uses).toBe(3);
  });

  test("an expired key is no key", async () => {
    const { waveId, userId } = await wave();
    const key = await createAuthKey(db, { waveId, userId, days: 1 });
    await db
      .update(waveAuthKeys)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(waveAuthKeys.id, key.id));

    expect((await register(makeMachine("late"), key.token)).status).toBe(403);
  });

  test("revoking one stops it, and leaves what it enrolled alone", async () => {
    const { waveId, userId } = await wave();
    const key = await createAuthKey(db, { waveId, userId, reusable: true });
    await register(makeMachine("first"), key.token);

    expect(await revokeAuthKey(db, waveId, key.id)).toBe(true);
    expect((await register(makeMachine("second"), key.token)).status).toBe(403);
    // The device that came in before is still in the wave: it has keys of its
    // own now, and taking it out is `remove-device`.
    expect(await db.select().from(nodes)).toHaveLength(1);
  });

  test("a key from nowhere is refused", async () => {
    await wave();
    expect((await register(makeMachine("stranger"), "wavekey-nonsense")).status).toBe(403);
  });

  // Re-registering is how a device rotates its WireGuard key, and it must not
  // cost a use of the key it came in with -- least of all a single-use one.
  test("a device already in the wave spends nothing by registering again", async () => {
    const { waveId, userId } = await wave();
    const key = await createAuthKey(db, { waveId, userId });
    const machine = makeMachine("connector");

    await register(machine, key.token);
    const again = await register(machine, key.token);
    expect(((await again.json()) as { status: string }).status).toBe("authorized");
    expect((await listAuthKeys(db, waveId))[0]?.uses).toBe(1);
  });
});
