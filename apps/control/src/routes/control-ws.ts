import { createMemoryNonceStore, type NonceStore, verifySignedRequest } from "@wave/crypto";
import type { Candidate, Relay, ServerMessage, UpdateChannel } from "@wave/proto";
import { ClientMessage } from "@wave/proto";
import { eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { mayMeet } from "../acl/evaluate.ts";
import { compiledPolicyFor } from "../acl/store.ts";
import type { Database } from "../db/client.ts";
import { nodes, waves } from "../db/schema.ts";
import { buildNetmap, type SigningKey, signNetmap } from "../netmap/build.ts";
import { boundCandidates } from "../netmap/candidates.ts";
import type { ReleaseFeed } from "../updates/releases.ts";
import { upgradeWebSocket } from "./ws.ts";

interface Connection {
  nodeId: string;
  waveId: string;
  send: (message: ServerMessage) => void;
  close: (code: number, reason: string) => void;
  /** The netmap version this connection was last sent; see the heartbeat. */
  sentVersion?: number;
  /**
   * Set once the device has said `hello` (D13), with the channel it would
   * like. A client from before self-updates never says it, and is never sent
   * an offer it could not read anyway.
   */
  update?: { wish: UpdateChannel | null };
}

/**
 * Close code for a node that no longer exists. 4000-4999 is the range an
 * application may define for itself; 4401 is already taken by an upgrade that
 * did not authenticate, and this is a different thing: the signature was good,
 * the device is gone.
 */
const NODE_GONE = 4404;

/**
 * Keeps track of the nodes currently connected and pushes netmaps to them.
 *
 * State lives in this process, so a multi-instance deployment needs a shared
 * bus (or sticky routing) before it can scale out.
 */
export class NetmapHub {
  private readonly byWave = new Map<string, Set<Connection>>();
  private listener?: (waveId: string) => void;

  constructor(
    private readonly db: Database,
    private readonly signingKey: SigningKey,
    private readonly relays: Relay[] = [],
  ) {}

  /**
   * Told whenever a wave's devices may look different to a human.
   *
   * The browser feed hangs here and not on the call sites, because everything
   * that changes a device list already goes through this hub: a device is
   * added, removed or approved, and the wave gets a new netmap. Hanging it off
   * each caller instead would mean the next one forgets, and a page that never
   * updates is not something anybody notices being broken.
   */
  onChange(listener: (waveId: string) => void): void {
    this.listener = listener;
  }

  add(connection: Connection): void {
    const set = this.byWave.get(connection.waveId) ?? new Set();
    set.add(connection);
    this.byWave.set(connection.waveId, set);
    // Online is a held connection, so this is the only place it can change.
    this.listener?.(connection.waveId);
  }

  remove(connection: Connection): void {
    const set = this.byWave.get(connection.waveId);
    set?.delete(connection);
    if (set?.size === 0) this.byWave.delete(connection.waveId);
    this.listener?.(connection.waveId);
  }

  /**
   * Sends every greeted connection what it may update to (D13). Called when
   * the release feed finds something new; each device gets the offer for its
   * own channel.
   */
  offerUpdates(releases: ReleaseFeed): void {
    for (const set of this.byWave.values()) {
      for (const connection of set) {
        if (connection.update)
          connection.send({ type: "update", ...releases.offerFor(connection.update.wish) });
      }
    }
  }

  /**
   * Something a browser shows changed without a netmap to go with it -- a
   * device saying which version it runs. The feed compares what it would
   * send, so a call that changed nothing visible costs one query and no push.
   */
  touched(waveId: string): void {
    this.listener?.(waveId);
  }

  connectionCount(waveId: string): number {
    return this.byWave.get(waveId)?.size ?? 0;
  }

  /**
   * Which of a wave's nodes hold a control connection right now. That is the
   * only honest notion of "online" we have: `lastSeenAt` says when a node last
   * spoke, not whether it is still there.
   */
  onlineNodeIds(waveId: string): Set<string> {
    const ids = new Set<string>();
    for (const connection of this.byWave.get(waveId) ?? []) ids.add(connection.nodeId);
    return ids;
  }

  async sendNetmap(connection: Connection): Promise<void> {
    const netmap = await buildNetmap(this.db, connection.nodeId, this.relays);
    if (!netmap) return;
    connection.sentVersion = netmap.version;
    connection.send({ type: "netmap", netmap: signNetmap(netmap, this.signingKey) });
  }

  /** Every node sees a different netmap, so each one is built individually. */
  async broadcast(waveId: string): Promise<void> {
    for (const connection of this.byWave.get(waveId) ?? []) await this.sendNetmap(connection);
    // Whatever moved the netmap may well be visible in the browser too. What
    // is not -- a node republishing its candidates -- is filtered there, by
    // comparing the list a page would show.
    this.listener?.(waveId);
  }

  /**
   * Cuts a removed device's connection, after telling it why.
   *
   * Without this the socket stays up: the device keeps answering heartbeats,
   * still counts as online in the very list an administrator just removed it
   * from, and sits on the last netmap it was given -- while every peer has
   * already dropped it. Closing is also what makes it ask to be let in again.
   */
  disconnect(waveId: string, nodeId: string, reason: "node-removed" | "key-expired"): void {
    // A copy, because closing takes the connection out of this set.
    for (const connection of [...(this.byWave.get(waveId) ?? [])]) {
      if (connection.nodeId !== nodeId) continue;
      connection.send({ type: "logout", reason });
      connection.close(NODE_GONE, reason);
    }
  }

  /**
   * Tells the other nodes to start punching now. Both sides have to send at
   * the same time: whoever goes first hits a NAT with no state for them yet.
   */
  async hint(waveId: string, fromNodeId: string, candidates: Candidate[]): Promise<void> {
    // Only to those who may meet the sender. A hint carries its candidates,
    // which are its addresses -- the very thing a node left out of a netmap is
    // not supposed to learn.
    const policy = await compiledPolicyFor(this.db, waveId);
    for (const connection of this.byWave.get(waveId) ?? []) {
      if (connection.nodeId === fromNodeId) continue;
      if (policy && !mayMeet(policy.compiled, connection.nodeId, fromNodeId, policy.services)) continue;
      connection.send({ type: "disco-hint", nodeId: fromNodeId as never, candidates });
    }
  }
}

/** Stores a node's candidates and lets everyone else know about them. */
export async function publishEndpoints(
  db: Database,
  hub: NetmapHub | undefined,
  node: { id: string; waveId: string },
  published: Candidate[],
): Promise<void> {
  // The hint goes out bounded as well: it reaches every peer's probe loop
  // exactly like the netmap does.
  const candidates = boundCandidates(published);

  // The same set again is not news. Nodes republish on a timer -- phones
  // until build 8 every minute, desktops whenever their reflexive address is
  // refreshed -- and each publication used to bump the version and push a
  // netmap to every device in the wave: in a wave of a dozen devices one about
  // every eight seconds, each waking every phone's radio, and on the cores of
  // the time resetting their WireGuard sessions. Only the time is recorded.
  const stored = await db
    .select({ candidates: nodes.candidates })
    .from(nodes)
    .where(eq(nodes.id, node.id))
    .limit(1);
  if (sameCandidates(stored[0]?.candidates ?? [], candidates)) {
    await db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.id, node.id));
    return;
  }

  await db.update(nodes).set({ candidates, lastSeenAt: new Date() }).where(eq(nodes.id, node.id));
  await db
    .update(waves)
    .set({ netmapVersion: sql`${waves.netmapVersion} + 1` })
    .where(eq(waves.id, node.waveId));

  // Order matters: a peer that gets the punch signal before the netmap does
  // not yet know this node and would drop the hint.
  await hub?.broadcast(node.waveId);
  await hub?.hint(node.waveId, node.id, candidates);
}

/** Whether two candidate lists name the same addresses, in any order. */
export function sameCandidates(a: readonly Candidate[], b: readonly Candidate[]): boolean {
  const key = (list: readonly Candidate[]) =>
    list
      .map((candidate) => `${candidate.kind}|${candidate.ip}|${candidate.port}`)
      .sort()
      .join(",");
  return key(a) === key(b);
}

export interface ControlWsDeps {
  db: Database;
  hub: NetmapHub;
  nonces?: NonceStore;
  /** Where update offers come from; without it a `hello` is only recorded. */
  releases?: ReleaseFeed;
}

export function controlWebsocket({ db, hub, nonces, releases }: ControlWsDeps) {
  const nonceStore = nonces ?? createMemoryNonceStore();
  const app = new Hono();

  app.get(
    "/v1/control",
    upgradeWebSocket(async (c) => {
      // The upgrade request carries the same machine-key signature as every
      // other request; there is no session or token to steal here.
      const result = verifySignedRequest({
        header: c.req.header("authorization"),
        method: "GET",
        path: new URL(c.req.url).pathname,
        body: "",
        nonces: nonceStore,
      });

      const rows = result.ok
        ? await db.select().from(nodes).where(eq(nodes.machineKey, result.machineKey)).limit(1)
        : [];
      const node = rows[0];
      let connection: Connection | undefined;

      return {
        async onOpen(_event, ws) {
          if (!node) {
            ws.close(4401, "unauthenticated");
            return;
          }
          connection = {
            nodeId: node.id,
            waveId: node.waveId,
            send: (message) => ws.send(JSON.stringify(message)),
            close: (code, reason) => ws.close(code, reason),
          };
          hub.add(connection);
          await db.update(nodes).set({ lastSeenAt: new Date() }).where(eq(nodes.id, node.id));
          await hub.sendNetmap(connection);
        },

        async onMessage(event, ws) {
          if (!connection || !node) return;
          const parsed = ClientMessage.safeParse(JSON.parse(String(event.data)));
          if (!parsed.success) return;

          if (parsed.data.type === "ping") {
            // The heartbeat is also what keeps "online" meaningful in netmaps,
            // and the one place a node removed from the shell finds out: the
            // admin command runs in another process and has no hub to cut this
            // socket with.
            const alive = await db
              .update(nodes)
              .set({ lastSeenAt: new Date() })
              .where(eq(nodes.id, node.id))
              .returning({ id: nodes.id });
            if (alive.length === 0) {
              ws.send(JSON.stringify({ type: "logout", reason: "node-removed" } satisfies ServerMessage));
              ws.close(NODE_GONE, "node-removed");
              return;
            }
            ws.send(JSON.stringify({ type: "pong" } satisfies ServerMessage));
            // The shell has no hub, so what it changes -- a policy, a tag, a
            // removed device -- only moves the version. Every connection comes
            // by here every thirty seconds; one that is behind is caught up
            // now. For a policy that takes access away, "with the next netmap
            // whenever that happens" would not be good enough.
            const current = await db
              .select({ version: waves.netmapVersion })
              .from(waves)
              .where(eq(waves.id, node.waveId))
              .limit(1);
            const version = current[0]?.version;
            if (version !== undefined && version !== connection.sentVersion) await hub.sendNetmap(connection);
            return;
          }
          if (parsed.data.type === "hello") {
            const hello = parsed.data;
            const wish = hello.channel ?? null;
            connection.update = { wish };
            // Recorded as the device said it, plus the channel it got: that
            // is what `wave-admin devices` shows, and how an operator sees
            // who is behind.
            await db
              .update(nodes)
              .set({
                clientVersion: hello.version,
                clientPlatform: hello.platform,
                updateChannel: releases?.assign(wish) ?? null,
              })
              .where(eq(nodes.id, node.id));
            // The hello comes after the connection was counted, and with it
            // after the device list was last pushed -- without this the page
            // would show the old version until something else changed.
            hub.touched(node.waveId);
            if (releases) connection.send({ type: "update", ...releases.offerFor(wish) });
            return;
          }
          if (parsed.data.type === "endpoints") {
            await publishEndpoints(db, hub, node, parsed.data.candidates);
          }
          if (parsed.data.type === "filter") {
            // What the device says about itself, and nothing more: the server
            // cannot check it, but an operator who reads "not enforced" next to
            // a Mac knows what the policy there is and is not doing.
            await db
              .update(nodes)
              .set({ filterEnforced: parsed.data.enforced, filterReason: parsed.data.reason ?? null })
              .where(eq(nodes.id, node.id));
          }
        },

        onClose() {
          if (connection) hub.remove(connection);
        },
      };
    }),
  );

  return app;
}
