"use client";

import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { useLocale } from "@/components/locale-provider";
import { NodeList } from "@/components/node-list";
import { appMessages } from "@/i18n/app";
import type { Node, Wave } from "@/lib/control";

/**
 * Keeps the device lists on this page current.
 *
 * One socket for the whole page, not one per wave: the control server pushes
 * the devices of every wave this account is in, and which ones those are it
 * decides itself from the session -- the same single place that answers who
 * may see what for the JSON API next to it.
 *
 * What arrives is always the whole list of a wave, never a delta. A missed
 * delta would leave a page showing a device that is gone with nothing to
 * notice it by, and a list is small enough that there is nothing to save.
 */
type Devices = Record<string, Node[]>;

const DevicesContext = createContext<Devices | null>(null);

/** Server → browser. The browser only ever says `ping`. */
type FeedMessage = { type: "devices"; waveId: string; nodes: Node[] } | { type: "pong" };

/** Long enough to stay out of the way, short enough for any idle timeout. */
const KEEPALIVE_MS = 30_000;
const RETRY_MAX_MS = 15_000;

export function DeviceFeed({ children }: { children: ReactNode }) {
  const [devices, setDevices] = useState<Devices>({});
  // Starts true so a page that is still connecting says nothing. Only a socket
  // that was closed makes a claim about the list being stale.
  const [live, setLive] = useState(true);
  const t = appMessages(useLocale());

  useEffect(() => {
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let attempt = 0;
    let stopped = false;

    const open = () => {
      // Same origin: in production the control server serves these pages, in
      // development `next dev` proxies the upgrade to it. Either way the
      // session cookie rides along and nothing has to know an address.
      const url = new URL("/api/events", window.location.href);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(url);
      socket = ws;

      ws.addEventListener("open", () => {
        attempt = 0;
        setLive(true);
        keepalive = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
        }, KEEPALIVE_MS);
      });

      ws.addEventListener("message", (event) => {
        let message: FeedMessage;
        try {
          message = JSON.parse(String(event.data)) as FeedMessage;
        } catch {
          return;
        }
        if (message.type === "devices") {
          setDevices((current) => ({ ...current, [message.waveId]: message.nodes }));
        }
      });

      ws.addEventListener("close", () => {
        clearInterval(keepalive);
        if (stopped) return;
        setLive(false);
        // Backing off, because the usual reason for a closed socket is a
        // control server that is restarting -- and every open page would
        // otherwise come back at it at once.
        retry = setTimeout(open, Math.min(1000 * 2 ** attempt++, RETRY_MAX_MS));
      });
    };

    /**
     * A background tab gets its socket frozen or dropped, so coming back is
     * the moment to try again rather than to sit out the rest of the backoff.
     */
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      if (socket && socket.readyState !== WebSocket.CLOSED) return;
      clearTimeout(retry);
      attempt = 0;
      open();
    };

    open();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(keepalive);
      document.removeEventListener("visibilitychange", onVisible);
      socket?.close();
    };
  }, []);

  return (
    <DevicesContext.Provider value={devices}>
      {live ? null : (
        <p className="mb-6 text-caption text-slate" role="status">
          {t.feedOffline}
        </p>
      )}
      {children}
    </DevicesContext.Provider>
  );
}

/**
 * What the server last pushed for this wave, or what the page was rendered
 * with. The fallback is what makes the card work before the socket is up --
 * and without a provider at all, which is how the card renders on the server.
 */
function useDevices(waveId: string, initial: Node[]): Node[] {
  return useContext(DevicesContext)?.[waveId] ?? initial;
}

export function LiveNodeList({
  wave,
  initial,
  mayRemove,
  meId,
}: {
  wave: Wave;
  initial: Node[];
  mayRemove: boolean;
  meId: string;
}) {
  const nodes = useDevices(wave.id, initial);
  return <NodeList nodes={nodes} wave={wave} mayRemove={mayRemove} meId={meId} />;
}

/** "3 of 5 devices connected", the line in the card's header. */
export function LiveConnectedCount({ wave, initial }: { wave: Wave; initial: Node[] }) {
  const nodes = useDevices(wave.id, initial);
  const online = nodes.filter((node) => node.online).length;
  return <span>{appMessages(useLocale()).connectedCount(online, nodes.length)}</span>;
}

/** What deleting the wave would take with it, counted the same way. */
export function LiveDeviceCount({ wave, initial }: { wave: Wave; initial: Node[] }) {
  const count = useDevices(wave.id, initial).length;
  return <>{appMessages(useLocale()).devices(count)}</>;
}
