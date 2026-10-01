import { Hono } from "hono";
import { lookupSession, readSessionCookie } from "../auth/session.ts";
import type { Database } from "../db/client.ts";
import { type DeviceView, listDevices } from "../waves/devices.ts";
import { roleOf, wavesOf } from "../waves/members.ts";
import { upgradeWebSocket } from "./ws.ts";

/** What the feed needs from the hub: who holds a control connection now. */
export interface OnlineSource {
  onlineNodeIds(waveId: string): Set<string>;
}

/** Everything this socket ever says. The browser only ever says `ping`. */
export type FeedMessage = { type: "devices"; waveId: string; nodes: DeviceView[] } | { type: "pong" };

interface Watcher {
  /** Whose session this is. Membership is checked against it before a push. */
  userId: string;
  /** The waves it listens for. What may be sent is decided per push. */
  waveIds: Set<string>;
  send: (message: FeedMessage) => void;
}

/**
 * Pushes a wave's device list to the browsers looking at it.
 *
 * The counterpart of the netmap hub, for the other audience: a node gets a
 * signed netmap, a browser gets the list it is rendering. The whole list every
 * time, never a delta -- "these are the devices now" is the same shape the
 * services API has for the same reason, and a missed delta would leave a page
 * showing a device that is gone with nothing to notice it by.
 */
export class DeviceFeed {
  private readonly watchers = new Set<Watcher>();
  /** The last list sent per wave, to keep a push from saying nothing new. */
  private readonly sent = new Map<string, string>();
  private readonly running = new Set<string>();
  private readonly again = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly online: OnlineSource,
  ) {}

  /** Starts watching. The current state of each wave follows right away. */
  add(watcher: Watcher): void {
    this.watchers.add(watcher);
    for (const waveId of watcher.waveIds) void this.sendTo(watcher, waveId);
  }

  remove(watcher: Watcher): void {
    this.watchers.delete(watcher);
    // A wave nobody looks at keeps no payload to compare against; the next
    // watcher gets a fresh one anyway.
    for (const waveId of watcher.waveIds) if (!this.watched(waveId)) this.sent.delete(waveId);
  }

  watcherCount(waveId: string): number {
    let count = 0;
    for (const watcher of this.watchers) if (watcher.waveIds.has(waveId)) count += 1;
    return count;
  }

  /**
   * Says that a wave's devices may have changed.
   *
   * Deliberately not awaited by anyone: removing a device must not wait on a
   * browser socket, and a list that fails to build is a page that stays as it
   * was, not an action that failed. Overlapping calls collapse into one more
   * run afterwards, because a burst -- twenty nodes publishing their endpoints
   * after a network change -- is one visible change, not twenty.
   */
  changed(waveId: string): void {
    if (!this.watched(waveId)) return;
    if (this.running.has(waveId)) {
      this.again.add(waveId);
      return;
    }
    this.running.add(waveId);
    void this.publish(waveId).finally(() => {
      this.running.delete(waveId);
      if (this.again.delete(waveId)) this.changed(waveId);
    });
  }

  private watched(waveId: string): boolean {
    for (const watcher of this.watchers) if (watcher.waveIds.has(waveId)) return true;
    return false;
  }

  private async publish(waveId: string): Promise<void> {
    try {
      const nodes = await listDevices(this.db, waveId, this.online.onlineNodeIds(waveId));
      // Most netmap pushes are about candidates, which no page shows. Comparing
      // what a browser would see keeps those off the wire entirely.
      const encoded = JSON.stringify(nodes);
      if (this.sent.get(waveId) === encoded) return;
      this.sent.set(waveId, encoded);
      for (const watcher of [...this.watchers]) {
        if (watcher.waveIds.has(waveId)) await this.deliver(watcher, waveId, nodes);
      }
    } catch (err) {
      console.error(`could not push the devices of ${waveId}:`, err);
    }
  }

  /**
   * The state one watcher is missing, without touching what the others have.
   *
   * On purpose it does not update `sent`: a change that lands between the
   * database write and its `changed()` would otherwise look like something
   * everyone already has, and the watchers that joined earlier would keep the
   * older list forever.
   */
  private async sendTo(watcher: Watcher, waveId: string): Promise<void> {
    try {
      const nodes = await listDevices(this.db, waveId, this.online.onlineNodeIds(waveId));
      if (this.watchers.has(watcher)) await this.deliver(watcher, waveId, nodes);
    } catch (err) {
      console.error(`could not send the devices of ${waveId}:`, err);
    }
  }
  /**
   * Sends one wave's devices to one watcher, if it is still theirs to see.
   *
   * The socket says which waves it listens for, the database says which ones
   * it may have: a member removed while the page was open keeps a valid
   * session, and their socket would otherwise go on receiving the list of a
   * wave they are no longer in. Checked here and not once at the upgrade,
   * because that is the only place that catches a removal from the shell too
   * -- `admin.ts` runs in another process and has no feed to tell.
   *
   * A wave that is no longer theirs is dropped from the socket, so the answer
   * costs one query and not one per push.
   */
  private async deliver(watcher: Watcher, waveId: string, nodes: DeviceView[]): Promise<void> {
    if ((await roleOf(this.db, waveId, watcher.userId)) === null) {
      watcher.waveIds.delete(waveId);
      return;
    }
    watcher.send({ type: "devices", waveId, nodes });
  }
}

/** Close code for a socket that arrived without a session. As in `/v1/control`. */
const UNAUTHENTICATED = 4401;

export function deviceFeedRoutes({ db, feed }: { db: Database; feed: DeviceFeed }) {
  const app = new Hono();

  /**
   * The live device list, for the browser.
   *
   * What authenticates it is the session cookie, exactly like the pages and
   * form posts next to it -- and what protects it is `SameSite=Lax`: a
   * WebSocket handshake is not a top-level navigation, so a page on another
   * site opening this URL arrives without a session and is closed.
   *
   * It lives here rather than in the frontend because a `fetch` proxy cannot
   * upgrade a WebSocket; `next dev` proxies it the other way round in
   * development, which is why the path sits under `/api`.
   */
  app.get(
    "/api/events",
    upgradeWebSocket(async (c) => {
      const token = readSessionCookie(c);
      const user = token ? await lookupSession(db, token) : null;
      // Fixed for the life of the connection. Being added to a wave happens in
      // a page the browser then reloads, which opens a new socket.
      const waveIds = user ? (await wavesOf(db, user.id)).map((wave) => wave.id) : [];
      let watcher: Watcher | undefined;

      return {
        onOpen(_event, ws) {
          if (!user) {
            ws.close(UNAUTHENTICATED, "unauthenticated");
            return;
          }
          watcher = {
            userId: user.id,
            waveIds: new Set(waveIds),
            send: (message) => ws.send(JSON.stringify(message)),
          };
          feed.add(watcher);
        },

        onMessage(event, ws) {
          // A browser only ever says "still here", and only to keep whatever
          // sits between it and us from dropping an idle socket.
          try {
            const message = JSON.parse(String(event.data)) as { type?: string };
            if (message.type === "ping") ws.send(JSON.stringify({ type: "pong" } satisfies FeedMessage));
          } catch {
            // Not part of this protocol. Ignored rather than answered.
          }
        },

        onClose() {
          if (watcher) feed.remove(watcher);
        },
      };
    }),
  );

  return app;
}
