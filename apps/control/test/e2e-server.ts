/**
 * The real control server backed by an in-process Postgres, for the end-to-end
 * test. Same app, same routes, same middleware -- only the database driver
 * differs, and the PGlite/node-postgres parity is covered by the unit tests.
 */
import { and, eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { createSession } from "../src/auth/session.ts";
import { identities, nodes, users, waves } from "../src/db/schema.ts";
import { loadConfig } from "../src/env.ts";
import { newId } from "../src/ids.ts";
import { resolveSigningKey } from "../src/netmap/signing-key.ts";
import { createAuthKey } from "../src/waves/auth-keys.ts";
import { setSharedPierHost } from "../src/waves/piers.ts";
import { createTestDb } from "./helpers.ts";

const config = loadConfig({ ...process.env, WAVE_DEV_AUTH: "1" });
const { db } = await createTestDb();

/**
 * The DNS of the shared pier's zone, kept in this process: a Cloudflare that
 * answers for exactly that zone and remembers what it was told, so a script
 * can see the wildcard a claim writes. Only with WAVE_SHARED_PIER_DOMAIN.
 */
const records = new Map<string, { type: string; name: string; content: string }>();
let nextRecord = 0;
const fakeDns = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  const method = init?.method ?? "GET";
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  if (url.pathname === "/client/v4/zones") {
    const name = url.searchParams.get("name");
    return ok(name === config.sharedPier?.domain ? [{ id: "z", name }] : []);
  }
  if (method === "POST") {
    const id = `r${++nextRecord}`;
    records.set(id, JSON.parse(String(init?.body)));
    return ok({ id });
  }
  if (method === "DELETE") {
    records.delete(url.pathname.split("/").pop() ?? "");
    return ok({});
  }
  const type = url.searchParams.get("type");
  const name = url.searchParams.get("name");
  return ok(
    [...records].filter(([, r]) => r.type === type && r.name === name).map(([id, r]) => ({ id, ...r })),
  );
}) as typeof fetch;

const app = createApp({
  db,
  config,
  providers: createProviders(config),
  signingKey: resolveSigningKey(config),
  ...(config.sharedPier ? { dnsFetch: fakeDns } : {}),
});

/**
 * What a production server does through its database or on a timer, reachable
 * here over HTTP because the database lives in this process and nowhere else:
 * `wave-admin` cannot reach it, and an hourly sweep is no use to a test.
 * Only in this file -- the server a deployment runs has none of it.
 */
const hooks: Record<string, (url: URL) => Promise<Response>> = {
  // The sweep index.ts runs hourly, now. `days` moves its clock forward past
  // the retention, which cannot be set to zero.
  "/__e2e/billing/sweep": async (url) => {
    const days = Number(url.searchParams.get("days") ?? 0);
    return Response.json({ deleted: await app.sweepBilling(new Date(Date.now() + days * 86_400_000)) });
  },
  // `wave-admin auth-key <wave>`: a single-use key, made by the wave's owner.
  "/__e2e/auth-key": async (url) => {
    const waveId = url.searchParams.get("wave") ?? "";
    const rows = await db
      .select({ owner: waves.ownerUserId })
      .from(waves)
      .where(eq(waves.id, waveId))
      .limit(1);
    const owner = rows[0]?.owner;
    if (!owner) return Response.json({ error: "no such wave" }, { status: 404 });
    const key = await createAuthKey(db, { waveId, userId: owner, label: "e2e" });
    return Response.json({ token: key.token });
  },
  // `wave-admin set-shared-pier <wave> <hostname> --ipv4 <addr>`.
  "/__e2e/shared-pier": async (url) => {
    const waveId = url.searchParams.get("wave") ?? "";
    const hostname = url.searchParams.get("node") ?? "";
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(and(eq(nodes.waveId, waveId), eq(nodes.hostname, hostname)))
      .limit(1);
    const nodeId = rows[0]?.id;
    if (!nodeId) return Response.json({ error: "no such node" }, { status: 404 });
    const set = await setSharedPierHost(db, { waveId, nodeId, ipv4: url.searchParams.get("ipv4") ?? "" });
    return Response.json(set, { status: "host" in set ? 200 : 409 });
  },
  // What the fake DNS of the shared pier holds now.
  "/__e2e/dns": async () => Response.json({ records: [...records.values()] }),
  // A person whose address nobody confirmed (an identity provider that says
  // `email_verified: false`). The dev login vouches for every address it is
  // given, so this is the only way to get such a session into a script: the
  // user has an identity, which makes it more than a payment's placeholder.
  "/__e2e/unverified-session": async (url) => {
    const email = (url.searchParams.get("email") ?? "").toLowerCase();
    if (!email) return Response.json({ error: "email needed" }, { status: 400 });
    const userId = newId("u");
    await db.insert(users).values({ id: userId, email, emailVerified: false, name: email });
    await db
      .insert(identities)
      .values({ id: newId("i"), userId, provider: "oidc", subject: `e2e:${userId}`, email });
    return Response.json({ token: (await createSession(db, userId)).token });
  },
};

const server = Bun.serve({
  port: config.port,
  hostname: process.env.WAVE_HOST ?? "0.0.0.0",
  fetch: (request, bunServer) => {
    const url = new URL(request.url);
    const hook = request.method === "POST" ? hooks[url.pathname] : undefined;
    return hook ? hook(url) : app.fetch(request, bunServer);
  },
  websocket: app.websocket,
});
console.log(`e2e control server on ${config.baseUrl} (bound to ${server.hostname}:${server.port})`);
