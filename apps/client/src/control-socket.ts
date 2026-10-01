import { buildAuthorizationHeader } from "@wave/crypto";
import { type Candidate, type ClientMessage, type Netmap, ServerMessage } from "@wave/proto";
import { verifyNetmap } from "./api.ts";
import type { NodeState } from "./state.ts";

export interface ControlSocketOptions {
  state: NodeState;
  onNetmap: (netmap: Netmap) => void | Promise<void>;
  onDiscoHint: (nodeId: string, candidates: Candidate[]) => void;
  log?: (message: string) => void;
  /** Reconnect backoff bounds, exposed for tests. */
  minBackoffMs?: number;
  maxBackoffMs?: number;
  /** Heartbeat interval; a missing answer means the connection is gone. */
  heartbeatMs?: number;
}

/**
 * Long-lived connection to the control server. It carries netmap updates and,
 * more importantly, the signal to start punching: both peers must send at the
 * same moment, which is something only the server can coordinate.
 */
export class ControlSocket {
  private socket?: WebSocket;
  private lastEndpoints?: Candidate[];
  private lastFilter?: { enforced: boolean; reason?: string };
  private heartbeat?: ReturnType<typeof setInterval>;
  private awaitingPong = false;
  private closed = false;
  private backoff: number;
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: ControlSocketOptions) {
    this.backoff = options.minBackoffMs ?? 500;
  }

  private get log() {
    return this.options.log ?? (() => {});
  }

  connect(): void {
    if (this.closed) return;
    const { state } = this.options;
    const url = new URL("/v1/control", state.controlUrl);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";

    const socket = new WebSocket(url, {
      headers: {
        authorization: buildAuthorizationHeader({
          machineKey: state.machineKey.publicKey,
          machinePrivateKey: state.machineKey.privateKey,
          method: "GET",
          path: "/v1/control",
        }),
      },
    } as never);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.backoff = this.options.minBackoffMs ?? 500;
      this.log("control connected");
      // Candidates are published before the socket is necessarily open, and
      // after a reconnect the server needs them again, so re-send what we have.
      if (this.lastEndpoints) this.send({ type: "endpoints", candidates: this.lastEndpoints });
      // The server keeps it per device, but a reconnect may be to a server
      // that restarted from a dump, or to one that just learned the field.
      if (this.lastFilter) this.send({ type: "filter", ...this.lastFilter });
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => void this.onMessage(String(event.data)));

    socket.addEventListener("close", (event) => {
      this.stopHeartbeat();
      if (this.closed) return;
      this.log(`control disconnected (${event.code}) — retrying in ${this.backoff}ms`);
      this.timer = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.options.maxBackoffMs ?? 30_000);
    });

    socket.addEventListener("error", () => {
      // The close handler takes care of retrying; nothing to add here.
    });
  }

  /**
   * A control connection can die without either side noticing -- a NAT drops
   * the idle flow, or the server goes away mid-flight. Without a heartbeat the
   * client keeps a tunnel running against a netmap that silently stops being
   * updated, which is indistinguishable from everything being fine.
   */
  private startHeartbeat(): void {
    this.stopHeartbeat();
    const interval = this.options.heartbeatMs ?? 30_000;
    this.awaitingPong = false;
    this.heartbeat = setInterval(() => {
      if (this.awaitingPong) {
        this.log("control connection stopped answering — reconnecting");
        this.socket?.close();
        return;
      }
      this.awaitingPong = true;
      this.send({ type: "ping" });
    }, interval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }

  private async onMessage(raw: string): Promise<void> {
    const parsed = ServerMessage.safeParse(JSON.parse(raw));
    if (!parsed.success) return;
    const message = parsed.data;

    if (message.type === "pong") {
      this.awaitingPong = false;
      return;
    }

    if (message.type === "netmap") {
      const pinned = this.options.state.netmapPublicKey;
      if (!pinned) return;

      let netmap: Netmap;
      try {
        netmap = verifyNetmap(message.netmap, pinned);
      } catch (error) {
        // A netmap that does not verify is the one case worth shouting about.
        this.log(`rejected netmap: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      try {
        await this.options.onNetmap(netmap);
      } catch (error) {
        this.log(`failed to apply netmap: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }
    if (message.type === "disco-hint") {
      this.options.onDiscoHint(message.nodeId, message.candidates);
      return;
    }
    if (message.type === "logout") {
      this.log(`control asked this node to re-authenticate: ${message.reason}`);
    }
  }

  send(message: ClientMessage): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
  }

  /** Says whether this device enforces its wave's ports; kept for a reconnect. */
  reportFilter(report: { enforced: boolean; reason?: string }): void {
    this.lastFilter = report;
    this.send({ type: "filter", ...report });
  }

  publishEndpoints(candidates: Candidate[]): void {
    this.lastEndpoints = candidates;
    this.send({ type: "endpoints", candidates });
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    if (this.timer) clearTimeout(this.timer);
    this.socket?.close();
  }
}
