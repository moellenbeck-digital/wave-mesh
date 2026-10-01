import { existsSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import {
  DEFAULT_SOCKET_PATH,
  encodeMessage,
  LineReader,
  type Request,
  Response,
  type Status,
} from "./protocol.ts";

/**
 * Talks to the privileged daemon; needs no privileges of its own.
 *
 * node:net rather than a Bun-specific client, so the same code reaches a unix
 * socket on Linux and macOS and a named pipe on Windows.
 */
/** Why the daemon could not be reached, so the caller can say something useful. */
export type ConnectFailure = "no-daemon" | "denied" | "unreachable";

export type ConnectResult = { ok: true; client: DaemonClient } | { ok: false; reason: ConnectFailure };

export class DaemonClient {
  private readonly pending: Array<(response: Response) => void> = [];
  private watcher?: (status: Status) => void;
  private readonly reader = new LineReader();

  private constructor(private readonly socket: Socket) {}

  /**
   * Distinguishes "no daemon" from "not allowed to talk to it". Falling back
   * to doing the work here would otherwise hide a permission problem behind a
   * confusing error about whatever default the fallback happens to use.
   */
  static async open(path = DEFAULT_SOCKET_PATH): Promise<ConnectResult> {
    // A named pipe does not show up in the filesystem, so only check a path
    // that is supposed to be one.
    if (!path.startsWith("\\\\") && !existsSync(path)) return { ok: false, reason: "no-daemon" };

    return new Promise((resolve) => {
      const socket = createConnection(path);
      socket.setEncoding("utf8");
      const client = new DaemonClient(socket);

      socket.once("connect", () => {
        socket.on("data", (chunk: string) => client.onData(chunk));
        socket.on("close", () => client.fail(new Error("the daemon closed the connection")));
        resolve({ ok: true, client });
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        const reason: ConnectFailure = error.code === "EACCES" ? "denied" : "unreachable";
        resolve({ ok: false, reason });
      });
    });
  }

  /** Convenience for callers that only care whether they got a client. */
  static async connect(path = DEFAULT_SOCKET_PATH): Promise<DaemonClient | null> {
    const result = await DaemonClient.open(path);
    return result.ok ? result.client : null;
  }

  private onData(chunk: string): void {
    for (const line of this.reader.push(chunk)) {
      const parsed = Response.safeParse(JSON.parse(line));
      if (!parsed.success) continue;
      if (parsed.data.type === "status" && this.watcher) this.watcher(parsed.data.status);
      this.pending.shift()?.(parsed.data);
    }
  }

  private fail(error: Error): void {
    while (this.pending.length > 0) {
      this.pending.shift()?.({ type: "error", message: error.message });
    }
  }

  request(request: Request, timeoutMs = 20_000): Promise<Response> {
    return new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ type: "error", message: "the daemon did not answer" }),
        timeoutMs,
      );
      this.pending.push((response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.socket.write(encodeMessage(request));
    });
  }

  /** Subscribes to status updates; they arrive until {@link close}. */
  async watch(onStatus: (status: Status) => void): Promise<void> {
    this.watcher = onStatus;
    this.socket.write(encodeMessage({ command: "watch" }));
  }

  close(): void {
    this.watcher = undefined;
    this.socket.end();
  }
}
