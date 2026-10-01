import { open, sharedKey } from "@wave/disco";
import { decodeFrame, encodeFrame, RelayHandshake } from "./relay-frame.ts";

export interface RelayClientOptions {
  /** e.g. wss://relay.example.com/relay */
  url: string;
  discoPublicKey: string;
  discoPrivateKey: string;
  onPacket: (senderDiscoKey: string, payload: Uint8Array) => void;
  log?: (message: string) => void;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** How often the relay is asked to echo; one missing answer is a dead socket. */
  heartbeatMs?: number;
}

/**
 * What an echo carries. The relay stamps every frame with its authenticated
 * sender, so a frame from our own key can only be the echo -- the byte just has
 * to be there, a frame without payload does not decode.
 */
const ECHO = new Uint8Array([0]);

/**
 * Connection to a relay, used for peers no direct path reaches.
 *
 * Authentication is a challenge sealed to our disco key: only its owner can
 * read it back, which is enough for the relay to route by that key without
 * knowing anything about waves or users.
 */
export class RelayClient {
  private socket?: WebSocket;
  private closed = false;
  private ready = false;
  private backoff: number;
  private timer?: ReturnType<typeof setTimeout>;
  private heartbeat?: ReturnType<typeof setInterval>;
  private awaitingEcho = false;

  constructor(private readonly options: RelayClientOptions) {
    this.backoff = options.minBackoffMs ?? 500;
  }

  private get log() {
    return this.options.log ?? (() => {});
  }

  get connected(): boolean {
    return this.ready && this.socket?.readyState === WebSocket.OPEN;
  }

  connect(): void {
    if (this.closed) return;
    const socket = new WebSocket(this.options.url);
    socket.binaryType = "arraybuffer";
    this.socket = socket;
    this.ready = false;

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ t: "hello", discoKey: this.options.discoPublicKey }));
    });

    socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        const frame = decodeFrame(new Uint8Array(event.data as ArrayBuffer));
        if (!frame) return;
        // Any frame proves the relay still routes to this socket, not just the
        // echo: it only delivers to the session registered for our key.
        this.awaitingEcho = false;
        if (frame.discoKey === this.options.discoPublicKey) return;
        this.options.onPacket(frame.discoKey, frame.payload);
        return;
      }
      this.onHandshake(String(event.data));
    });

    socket.addEventListener("close", () => {
      this.stopHeartbeat();
      this.ready = false;
      if (this.closed) return;
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000);
    });

    socket.addEventListener("error", () => {
      // Reconnecting is handled by the close event.
    });
  }

  private onHandshake(raw: string): void {
    const parsed = RelayHandshake.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.t === "challenge") {
      const token = open(
        sharedKey(this.options.discoPrivateKey, message.relayKey),
        Buffer.from(message.nonce, "base64"),
        Buffer.from(message.box, "base64"),
      );
      if (!token) {
        this.log("relay challenge could not be opened");
        this.socket?.close();
        return;
      }
      this.socket?.send(JSON.stringify({ t: "proof", token: new TextDecoder().decode(token) }));
      return;
    }
    if (message.t === "ready") {
      this.ready = true;
      this.backoff = this.options.minBackoffMs ?? 500;
      this.log(`relay ${this.options.url} ready`);
      this.startHeartbeat();
      return;
    }
    this.log(`relay refused the connection: ${message.message}`);
  }

  /**
   * A relay connection can die without either side saying so. After a laptop
   * sleeps through the relay's idle timeout, the relay has long closed its end
   * while ours still reads as open; no close event ever comes, `connected`
   * stays true, and every peer that only the relay reaches goes quiet --
   * measured on 28.09.2026 after half an hour of suspend, while the control
   * connection next to it had noticed within a minute. So the relay is asked
   * to echo a frame to our own key: it answers only if it still routes that
   * key to this very socket, which is exactly the property that matters.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.awaitingEcho = false;
    this.heartbeat = setInterval(() => {
      if (this.awaitingEcho) {
        this.log(`relay ${this.options.url} stopped answering — reconnecting`);
        this.socket?.close();
        return;
      }
      this.awaitingEcho = true;
      this.socket?.send(encodeFrame(this.options.discoPublicKey, ECHO));
    }, this.options.heartbeatMs ?? 15_000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  /** Returns false when the relay is unavailable, so the caller can fall back. */
  send(toDiscoKey: string, payload: Uint8Array): boolean {
    if (!this.connected) return false;
    this.socket?.send(encodeFrame(toDiscoKey, payload));
    return true;
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}
