import { generateKeyPair } from "@wave/crypto";
import { open, seal, sharedKey } from "@wave/disco";
import {
  ClientHandshake,
  decodeFrame,
  encodeFrame,
  KEY_LENGTH,
  MAX_PAYLOAD,
  type RelayHandshake,
} from "@wave/magicsock";

/**
 * Forwards packets between nodes that cannot reach each other directly.
 *
 * The relay learns nothing: it sees two public keys and an opaque payload. It
 * does not know which wave a node belongs to and cannot decrypt anything, so
 * the only trust placed in it is availability.
 */

interface Session {
  /**
   * Distinguishes two sockets holding the same disco key. A node that changes
   * network reconnects before the old socket has finished closing, so for a
   * moment both exist -- and `close` must then not take the live one down.
   */
  id: number;
  discoKey?: string;
  /** Random token the client has to decrypt to prove it holds the key. */
  expected?: string;
  claimed?: string;
  authenticated: boolean;
}

export interface RelayServerOptions {
  port: number;
  hostname?: string;
  log?: (message: string) => void;
  /** Ed25519/X25519 pair identifying this relay; generated when omitted. */
  keyPair?: { publicKey: string; privateKey: string };
}

export interface RelayServer {
  port: number;
  publicKey: string;
  connections: () => number;
  forwarded: () => number;
  stop: () => void;
}

export async function startRelayServer(options: RelayServerOptions): Promise<RelayServer> {
  const keys = options.keyPair ?? generateKeyPair("x25519");
  const log = options.log ?? (() => {});
  const clients = new Map<string, { id: number; send: (frame: Uint8Array) => void }>();
  let forwarded = 0;
  let nextSessionId = 1;

  const send = (ws: { send: (data: string) => void }, message: RelayHandshake) =>
    ws.send(JSON.stringify(message));

  const server = Bun.serve<Session>({
    port: options.port,
    hostname: options.hostname ?? "0.0.0.0",
    fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/healthz") {
        return Response.json({ ok: true, publicKey: keys.publicKey, connections: clients.size, forwarded });
      }
      if (url.pathname !== "/relay") return new Response("not found", { status: 404 });
      if (server.upgrade(request, { data: { id: nextSessionId++, authenticated: false } })) return;
      return new Response("expected a websocket upgrade", { status: 426 });
    },
    websocket: {
      maxPayloadLength: KEY_LENGTH + MAX_PAYLOAD,

      message(ws, raw) {
        if (typeof raw === "string") {
          const parsed = ClientHandshake.safeParse(JSON.parse(raw));
          if (!parsed.success) return send(ws, { t: "error", message: "malformed handshake" });

          if (parsed.data.t === "hello") {
            // Sealing the challenge to the claimed key means only its owner can
            // read it; nothing else here has to be trusted.
            const token = Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("base64");
            let boxed: { nonce: Uint8Array; ciphertext: Uint8Array };
            try {
              boxed = seal(sharedKey(keys.privateKey, parsed.data.discoKey), new TextEncoder().encode(token));
            } catch {
              return send(ws, { t: "error", message: "unusable disco key" });
            }
            ws.data.claimed = parsed.data.discoKey;
            ws.data.expected = token;
            return send(ws, {
              t: "challenge",
              relayKey: keys.publicKey,
              nonce: Buffer.from(boxed.nonce).toString("base64"),
              box: Buffer.from(boxed.ciphertext).toString("base64"),
            });
          }

          if (!ws.data.claimed || parsed.data.token !== ws.data.expected) {
            return send(ws, { t: "error", message: "challenge failed" });
          }
          ws.data.discoKey = ws.data.claimed;
          ws.data.authenticated = true;
          // Displacing an earlier socket for the same key is the intended
          // outcome of a reconnect: the newest one is where the node is now.
          clients.set(ws.data.discoKey, { id: ws.data.id, send: (frame) => ws.send(frame) });
          log(`${ws.data.discoKey.slice(0, 8)} connected (${clients.size} client(s))`);
          return send(ws, { t: "ready" });
        }

        if (!ws.data.authenticated || !ws.data.discoKey) return;
        const frame = decodeFrame(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer));
        if (!frame) return;

        const destination = clients.get(frame.discoKey);
        // Silently dropping an undeliverable frame is intended: the sender must
        // not be able to probe which keys are online.
        if (!destination) return;
        destination.send(encodeFrame(ws.data.discoKey, frame.payload));
        forwarded++;
      },

      close(ws) {
        if (!ws.data.discoKey) return;
        // Only if this socket is still the registered one. Deleting by key
        // alone meant a reconnect took itself down: the new socket registers
        // first, the old one closes second, and the entry it removed was the
        // live one. Nothing failed visibly -- the node stayed connected, the
        // relay simply dropped every frame addressed to it, which reads as a
        // peer that went quiet. Exactly the WLAN-to-LTE case D10 calls the
        // normal one.
        if (clients.get(ws.data.discoKey)?.id !== ws.data.id) return;
        clients.delete(ws.data.discoKey);
        log(`${ws.data.discoKey.slice(0, 8)} disconnected (${clients.size} client(s))`);
      },
    },
  });

  log(`relay listening on ws://${options.hostname ?? "0.0.0.0"}:${server.port}/relay`);
  return {
    port: server.port ?? options.port,
    publicKey: keys.publicKey,
    connections: () => clients.size,
    forwarded: () => forwarded,
    stop: () => server.stop(true),
  };
}

/** Helper for clients: decrypt the relay's challenge. */
export function solveChallenge(
  discoPrivateKey: string,
  challenge: { relayKey: string; nonce: string; box: string },
): string | null {
  const plaintext = open(
    sharedKey(discoPrivateKey, challenge.relayKey),
    Buffer.from(challenge.nonce, "base64"),
    Buffer.from(challenge.box, "base64"),
  );
  return plaintext ? new TextDecoder().decode(plaintext) : null;
}
