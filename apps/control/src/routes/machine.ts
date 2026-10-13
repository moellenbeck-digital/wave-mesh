import { createHash } from "node:crypto";
import { createMemoryNonceStore, type NonceStore, verifySignedRequest } from "@wave/crypto";
import { Candidate, PollRequest, RegisterRequest } from "@wave/proto";
import { and, asc, eq, sql } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { z } from "zod";
import { audit, userActor } from "../audit.ts";
import type { SessionUser } from "../auth/session.ts";
import { isSuspended } from "../billing/subscriptions.ts";
import type { Database } from "../db/client.ts";
import { authRequests, nodes, waveMembers, waveServices, waves } from "../db/schema.ts";
import type { Config } from "../env.ts";
import { localeOf } from "../i18n.ts";
import { newId } from "../ids.ts";
import { allocateIpv4, ipv6ForIpv4, uniqueHostname } from "../net/addressing.ts";
import { buildNetmap, type SigningKey, signNetmap } from "../netmap/build.ts";
import { authKeyWave, claimAuthKey } from "../waves/auth-keys.ts";
import { type NetmapHub, publishEndpoints } from "./control-ws.ts";
import { authenticateMachine } from "./machine-auth.ts";
import { pageMessages } from "./messages.ts";

const AUTH_REQUEST_TTL_MS = 15 * 60 * 1000;
const NODE_KEY_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

const EndpointsBody = z.object({ candidates: z.array(Candidate) });

export interface MachineRouteDeps {
  db: Database;
  config: Config;
  signingKey: SigningKey;
  hub?: NetmapHub;
  nonces?: NonceStore;
}

type Vars = { user: SessionUser | null };

export function machineRoutes({ db, config, signingKey, hub, nonces }: MachineRouteDeps) {
  const app = new Hono<{ Variables: Vars }>();
  const nonceStore = nonces ?? createMemoryNonceStore();

  /** Verifies the machine-key signature and returns the raw body it covered. */
  const authenticate = (c: Context) => authenticateMachine(c, nonceStore);

  const withNetmap = async (nodeId: string) => {
    const netmap = await buildNetmap(db, nodeId, config.relays);
    if (!netmap) throw new Error(`node ${nodeId} vanished while building its netmap`);
    return signNetmap(netmap, signingKey);
  };

  const bumpNetmapVersion = (waveId: string) =>
    db
      .update(waves)
      .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
      .where(eq(waves.id, waveId));

  app.post("/v1/machine/register", async (c) => {
    const { result, body } = await authenticate(c);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const parsed = RegisterRequest.safeParse(JSON.parse(body || "{}"));
    if (!parsed.success) return c.json({ error: "invalid request", detail: parsed.error.issues }, 400);
    const request = parsed.data;

    // The signature proves possession of the machine key; the body must not
    // claim a different one.
    if (request.machineKey !== result.machineKey) return c.json({ error: "machine key mismatch" }, 400);

    const existing = await db.select().from(nodes).where(eq(nodes.machineKey, request.machineKey)).limit(1);
    const node = existing[0];
    if (node) {
      await db
        .update(nodes)
        .set({
          nodeKey: request.nodeKey,
          discoKey: request.discoKey,
          lastSeenAt: new Date(),
          keyExpiresAt: new Date(Date.now() + NODE_KEY_TTL_MS),
        })
        .where(eq(nodes.id, node.id));
      await bumpNetmapVersion(node.waveId);
      await hub?.broadcast(node.waveId);
      return c.json({
        status: "authorized",
        nodeId: node.id,
        netmap: await withNetmap(node.id),
        netmapPublicKey: signingKey.publicKey,
      });
    }

    // A pre-auth key is a human's approval, given in advance and written down.
    // Checked only after the known-machine case above, so a device that is
    // already in the wave never spends one by registering again.
    if (request.authKey) {
      const target = await authKeyWave(db, request.authKey);
      if (target && (await isSuspended(db, target))) {
        return c.json({ error: "this wave is paused: its subscription is not active" }, 403);
      }
      const claimed = await claimAuthKey(db, request.authKey);
      if (!claimed) return c.json({ error: "this pre-auth key cannot be used" }, 403);

      const waveRows = await db.select().from(waves).where(eq(waves.id, claimed.waveId)).limit(1);
      const wave = waveRows[0];
      if (!wave) return c.json({ error: "this pre-auth key cannot be used" }, 403);

      const nodeId = await createNode(db, { wave, userId: claimed.userId, device: request });
      // Nobody clicked anything, so the key is the actor's stand-in: whoever
      // made it made this decision in advance.
      await audit(
        db,
        wave.id,
        { userId: claimed.userId, label: `auth-key:${claimed.id}` },
        { action: "device.enrol", target: request.hostname, detail: { authKey: claimed.id } },
      );
      await hub?.broadcast(wave.id);
      return c.json({
        status: "authorized",
        nodeId,
        netmap: await withNetmap(nodeId),
        netmapPublicKey: signingKey.publicKey,
      });
    }

    const pollSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");
    const requestId = newId("ar");
    await db.insert(authRequests).values({
      id: requestId,
      machineKey: request.machineKey,
      nodeKey: request.nodeKey,
      discoKey: request.discoKey,
      hostname: request.hostname,
      os: request.os,
      pollSecretHash: hash(pollSecret),
      expiresAt: new Date(Date.now() + AUTH_REQUEST_TTL_MS),
    });

    return c.json({
      status: "pending",
      authUrl: `${config.baseUrl}/machine/authorize?request=${requestId}`,
      pollSecret,
    });
  });

  app.post("/v1/machine/poll", async (c) => {
    const { result, body } = await authenticate(c);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const parsed = PollRequest.safeParse(JSON.parse(body || "{}"));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const rows = await db
      .select()
      .from(authRequests)
      .where(eq(authRequests.pollSecretHash, hash(parsed.data.pollSecret)))
      .limit(1);

    const request = rows[0];
    // Not found and "belongs to another machine" are the same answer on
    // purpose: polling must not reveal anything about other devices.
    if (!request || request.machineKey !== result.machineKey) return c.json({ status: "expired" });
    if (request.expiresAt.getTime() < Date.now()) return c.json({ status: "expired" });
    if (request.status !== "authorized" || !request.nodeId) return c.json({ status: "pending" });

    return c.json({
      status: "authorized",
      nodeId: request.nodeId,
      netmap: await withNetmap(request.nodeId),
      netmapPublicKey: signingKey.publicKey,
    });
  });

  app.get("/v1/netmap", async (c) => {
    const result = verifySignedRequest({
      header: c.req.header("authorization"),
      method: "GET",
      path: new URL(c.req.url).pathname,
      body: "",
      nonces: nonceStore,
    });
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const rows = await db.select().from(nodes).where(eq(nodes.machineKey, result.machineKey)).limit(1);
    const node = rows[0];
    if (!node) return c.json({ error: "unknown node" }, 404);

    await db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.id, node.id));
    return c.json(await withNetmap(node.id));
  });

  app.post("/v1/node/endpoints", async (c) => {
    const { result, body } = await authenticate(c);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const parsed = EndpointsBody.safeParse(JSON.parse(body || "{}"));
    if (!parsed.success) return c.json({ error: "invalid request" }, 400);

    const rows = await db.select().from(nodes).where(eq(nodes.machineKey, result.machineKey)).limit(1);
    const node = rows[0];
    if (!node) return c.json({ error: "unknown node" }, 404);

    await publishEndpoints(db, hub, node, parsed.data.candidates);
    return c.json({ ok: true });
  });

  app.post("/v1/node/logout", async (c) => {
    const { result } = await authenticate(c);
    if (!result.ok) return c.json({ error: result.reason }, 401);

    const rows = await db.select().from(nodes).where(eq(nodes.machineKey, result.machineKey)).limit(1);
    const node = rows[0];
    // Already gone is a success: logging out twice is not an error.
    if (!node) return c.json({ ok: true });

    await db.delete(nodes).where(eq(nodes.id, node.id));
    await bumpNetmapVersion(node.waveId);
    await hub?.broadcast(node.waveId);
    return c.json({ ok: true });
  });

  // --- browser approval ----------------------------------------------------

  /**
   * Opening the link the CLI printed shows what it would do; the POST below
   * does it.
   *
   * This used to be the approval itself, on the argument that the request id
   * is unguessable and came out of the user's own terminal. That argument
   * points the wrong way. The id is unguessable *to a third party*, but it is
   * not the user's secret -- an attacker gets one by running `wave login`
   * against this server, which needs neither an account nor an invitation.
   * They then only have to get a signed-in member to follow the link, and
   * `SameSite=Lax` sends the session cookie along on a top-level GET
   * navigation, unlike on the cross-site POST the wave forms rely on. A device
   * nobody chose would be in the wave, with an address and a place in every
   * netmap. Reproduced on 23.09.2026; the regression test sits in
   * test/machine-approval.test.ts.
   *
   * So the state change lives on the POST, where Lax already protects it, and
   * the one click this used to save is the thing that makes it safe.
   */
  app.get("/machine/authorize", async (c) => {
    const user = c.get("user");
    const requestId = c.req.query("request") ?? "";
    if (!user) {
      const next = encodeURIComponent(`/machine/authorize?request=${requestId}`);
      return c.redirect(config.webUrl ? `/login?next=${next}` : `/?next=${next}`);
    }

    const request = await loadPendingRequest(db, requestId);
    if (!request) {
      if (config.webUrl) return c.redirect("/devices/expired");
      const m = pageMessages(localeOf(c));
      return c.html(html`<h1>${m.requestExpired}</h1><p>${raw(m.runUpAgainHtml)}</p>`, 410);
    }

    const candidates = await waveCandidates(db, user.id);
    // An account can reach this before it has a network: signing in does not
    // make one any more. The form is where it comes from, and the device link
    // rides along so the approval finishes by itself afterwards.
    if (candidates.length === 0) return c.redirect(toWaveForm(request.id));
    return askForWave(c, request, candidates);
  });

  /**
   * Where the wave chooser posts, and what a client that posts the form hits.
   * Same effect as opening the link, with the picked wave alongside.
   */
  app.post("/machine/authorize", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    const form = await c.req.formData();
    const request = await loadPendingRequest(db, String(form.get("request") ?? ""));
    if (!request) return c.json({ error: "request expired" }, 410);

    const picked = String(form.get("wave") ?? "") || undefined;
    const approved = await approveRequest(db, user.id, request, picked);
    if (approved.kind === "none") return c.redirect(toWaveForm(request.id), 303);
    if (approved.kind === "choose") return askForWave(c, request, approved.waves);
    if (approved.kind === "suspended") {
      // A page in the plain style, with the web app in front too: this is
      // where the browser lands, and the request stays pending for later.
      const m = pageMessages(localeOf(c));
      return c.html(html`<h1>${m.waveSuspended}</h1><p>${m.waveSuspendedBody(approved.waveName)}</p>`, 403);
    }
    await audit(db, approved.waveId, userActor(user), {
      action: "device.approve",
      target: request.hostname,
      detail: { ipv4: approved.ipv4 },
    });
    await hub?.broadcast(approved.waveId);

    if (config.webUrl) {
      const query = new URLSearchParams({
        host: request.hostname,
        wave: approved.waveName,
        ip: approved.ipv4,
      });
      return c.redirect(`/devices/connected?${query}`, 303);
    }
    // The only success page there is, now that the GET above just asks. It
    // names the address because that is what the person goes on to use.
    const m = pageMessages(localeOf(c));
    return c.html(html`<h1>${m.connected(request.hostname)}</h1>
      <p>${raw(m.joinedAsHtml(approved.waveName, approved.ipv4))}</p>
      <p>${m.closeTab}</p>`);
  });

  /**
   * What the frontend's chooser needs to name the device and the waves. The
   * request id came out of the user's own terminal, but it is not a credential
   * for anyone else, so this is behind the session like the rest of /api.
   */
  app.get("/api/machine/requests/:id", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    const request = await loadPendingRequest(db, c.req.param("id"));
    if (!request) return c.json({ error: "gone" }, 410);

    const membership = await db
      .select({ id: waves.id, name: waves.name, dnsSuffix: waves.dnsSuffix })
      .from(waveMembers)
      .innerJoin(waves, eq(waves.id, waveMembers.waveId))
      .where(eq(waveMembers.userId, user.id))
      .orderBy(asc(waveMembers.createdAt), asc(waves.name));

    return c.json({
      request: { id: request.id, hostname: request.hostname, os: request.os },
      waves: membership,
    });
  });

  /**
   * The confirmation, and with several waves also the choice.
   *
   * One page for both, because the single-wave case is not a lesser version of
   * the other: it is the same decision with one option, and it is the case
   * that must not happen by itself. Splitting them would leave the ordinary
   * path -- one wave, one click -- as the one nobody looks at.
   */
  function askForWave(
    c: Context<{ Variables: Vars }>,
    request: typeof authRequests.$inferSelect,
    candidates: { id: string; name: string }[],
  ) {
    if (config.webUrl) {
      return c.redirect(`/devices/choose?request=${encodeURIComponent(request.id)}`, 303);
    }
    const m = pageMessages(localeOf(c));
    const only = candidates.length === 1 ? candidates[0] : undefined;
    const body = only
      ? html`<input type="hidden" name="wave" value="${only.id}" />
          <p>${raw(m.willJoinHtml(only.name))}</p>`
      : html`${candidates.map(
          (wave, index) => html`<label>
            <input type="radio" name="wave" value="${wave.id}" ${index === 0 ? raw("checked") : ""} />
            ${wave.name}
          </label><br />`,
        )}`;
    const title = only
      ? html`<h1>${m.addToWave(request.hostname)}</h1>`
      : html`<h1>${m.whichWave(request.hostname)}</h1>`;
    return c.html(html`${title}
      <form method="post" action="/machine/authorize">
        <input type="hidden" name="request" value="${request.id}" />
        ${body}
        <button type="submit">${m.addDevice}</button>
      </form>`);
  }

  return app;
}

/** The create form, with this device's link to come back to. */
const toWaveForm = (requestId: string): string =>
  `/waves/new?next=${encodeURIComponent(`/machine/authorize?request=${requestId}`)}`;

async function loadPendingRequest(db: Database, requestId: string) {
  if (!requestId) return null;
  const rows = await db
    .select()
    .from(authRequests)
    .where(and(eq(authRequests.id, requestId), eq(authRequests.status, "pending")))
    .limit(1);
  const request = rows[0];
  if (!request || request.expiresAt.getTime() < Date.now()) return null;
  return request;
}

export type Approval =
  | { kind: "approved"; waveId: string; waveName: string; ipv4: string }
  /** The user is in several waves, so the device cannot be placed for them. */
  | { kind: "choose"; waves: { id: string; name: string }[] }
  | { kind: "none" }
  /** The wave is paused for billing; nobody new comes in until it is live again. */
  | { kind: "suspended"; waveName: string };

/**
 * Creates the node in the wave the user picked and marks the request authorized.
 *
 * With one membership there is nothing to pick and nothing is asked -- that is
 * the ordinary case and what the end-to-end tests walk through. With several,
 * guessing is not an option: the wave decides the addresses, the DNS suffix and
 * who sees the device, and the browser is where the human is who knows.
 */
/**
 * The waves a device could go into: the ones its approver is in.
 *
 * Separate from approving because the page that asks has to list them without
 * changing anything -- that separation is the whole point of the GET/POST
 * split above.
 */
async function waveCandidates(db: Database, userId: string) {
  const membership = await db
    .select({ wave: waves })
    .from(waveMembers)
    .innerJoin(waves, eq(waves.id, waveMembers.waveId))
    .where(eq(waveMembers.userId, userId))
    .orderBy(asc(waveMembers.createdAt), asc(waves.name));
  return membership.map((row) => row.wave);
}

async function approveRequest(
  db: Database,
  userId: string,
  request: typeof authRequests.$inferSelect,
  waveId?: string,
): Promise<Approval> {
  const candidates = await waveCandidates(db, userId);
  if (candidates.length === 0) return { kind: "none" };

  const wave = waveId
    ? candidates.find((candidate) => candidate.id === waveId)
    : candidates.length === 1
      ? candidates[0]
      : undefined;
  // An unknown id is asked again rather than answered with the first wave: a
  // stale form must not put the device somewhere nobody chose.
  if (!wave) return { kind: "choose", waves: candidates.map((c) => ({ id: c.id, name: c.name })) };
  // Before an address is drawn: a device added to a paused wave would sit in
  // it with a place and no peers, and come alive on its own the day the
  // subscription does -- an approval nobody gave for that day.
  if (await isSuspended(db, wave.id)) return { kind: "suspended", waveName: wave.name };

  const nodeId = await createNode(db, { wave, userId, device: request });
  await db.update(authRequests).set({ status: "authorized", nodeId }).where(eq(authRequests.id, request.id));

  const rows = await db.select({ ipv4: nodes.ipv4 }).from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  return { kind: "approved", waveId: wave.id, waveName: wave.name, ipv4: rows[0]?.ipv4 ?? "" };
}

/** What a device is, whichever way it got approved. */
interface DeviceFacts {
  machineKey: string;
  nodeKey: string;
  discoKey: string;
  hostname: string;
  os: "linux" | "darwin" | "windows" | "other";
}

/**
 * Gives a device its place in the wave: one free address, one free name.
 *
 * Both are drawn against the devices *and* the services, because the two share
 * one numbering and one namespace -- `syncServices()` allocates the same way
 * from the other side. A device handed an address a service already answers for
 * would land in some connector's `allowedIps` as well, and the route for it
 * would collide with the host route the device puts on its own interface: a
 * tunnel that comes up everywhere except for that one address.
 *
 * The wave row is locked for the same reason it is locked there: two
 * registrations at once would otherwise read the same free address. The unique
 * index on (wave, ipv4) would catch that pair, but nothing catches a device and
 * a service racing across the two tables.
 */
async function createNode(
  db: Database,
  input: {
    wave: typeof waves.$inferSelect;
    userId: string;
    device: DeviceFacts;
  },
): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.select().from(waves).where(eq(waves.id, input.wave.id)).limit(1).for("update");

    const siblings = await tx
      .select({ ipv4: nodes.ipv4, hostname: nodes.hostname })
      .from(nodes)
      .where(eq(nodes.waveId, input.wave.id));
    const services = await tx
      .select({ ipv4: waveServices.ipv4, name: waveServices.name })
      .from(waveServices)
      .where(eq(waveServices.waveId, input.wave.id));

    const ipv4 = allocateIpv4(input.wave.ipv4Prefix, [
      ...siblings.map((s) => s.ipv4),
      ...services.map((s) => s.ipv4),
    ]);
    const hostname = uniqueHostname(input.device.hostname, [
      ...siblings.map((s) => s.hostname),
      ...services.map((s) => s.name),
    ]);
    const nodeId = newId("n");

    await tx.insert(nodes).values({
      id: nodeId,
      waveId: input.wave.id,
      userId: input.userId,
      machineKey: input.device.machineKey,
      nodeKey: input.device.nodeKey,
      discoKey: input.device.discoKey,
      hostname,
      os: input.device.os,
      ipv4,
      ipv6: ipv6ForIpv4(input.wave.ipv6Prefix, input.wave.ipv4Prefix, ipv4),
      keyExpiresAt: new Date(Date.now() + NODE_KEY_TTL_MS),
    });
    await tx
      .update(waves)
      .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
      .where(eq(waves.id, input.wave.id));
    return nodeId;
  });
}
