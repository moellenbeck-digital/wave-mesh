import { connect } from "node:net";
import { keyToHex } from "@wave/crypto";

/**
 * Client for WireGuard's UAPI: a line protocol spoken by wireguard-go and
 * boringtun alike. Keys are hex here, base64 everywhere else.
 *
 * The transport is `node:net` rather than `Bun.connect` for the same reason the
 * control channel uses it: one call shape gives a unix socket on Linux and
 * macOS and a named pipe on Windows, where wireguard-go serves the UAPI on a
 * pipe and there is no socket file to open.
 *
 * See https://www.wireguard.com/xplatform/ for the protocol.
 */

export interface WgPeerState {
  publicKey: string;
  endpoint?: string;
  allowedIps: string[];
  persistentKeepalive: number;
  lastHandshakeSeconds: number;
  rxBytes: number;
  txBytes: number;
}

export interface WgDeviceState {
  /** Base64, or undefined when the device has no key yet. */
  privateKey?: string;
  listenPort: number;
  peers: WgPeerState[];
}

export interface DesiredPeer {
  publicKey: string;
  endpoint?: string | undefined;
  allowedIps: string[];
  persistentKeepalive: number;
}

/**
 * Where wireguard-go listens for a given interface.
 *
 * Windows has no socket file: the pipe sits under a prefix whose ACL admits
 * administrators only, which is the same name wireguard-windows uses and the
 * reason nothing else has to guard it.
 */
export const defaultSocketPath = (
  interfaceName: string,
  platform: NodeJS.Platform = process.platform,
): string =>
  platform === "win32"
    ? `\\\\.\\pipe\\ProtectedPrefix\\Administrators\\WireGuard\\${interfaceName}`
    : `/var/run/wireguard/${interfaceName}.sock`;

/** One request/response exchange. The response ends with a blank line. */
export async function uapiExchange(socketPath: string, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      fn();
    };

    const socket = connect({ path: socketPath });
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.endsWith("\n\n")) {
        socket.end();
        finish(() => resolve(buffer));
      }
    });
    socket.on("error", (error) => finish(() => reject(error)));
    socket.on("close", () =>
      finish(() => (buffer ? resolve(buffer) : reject(new Error("UAPI closed without a response")))),
    );
  });
}

/**
 * Whether wireguard-go is listening yet.
 *
 * On Linux and macOS the socket file appearing would answer this, but a named
 * pipe never shows up in the filesystem -- so the only portable question is
 * whether a connection succeeds.
 */
export async function uapiReady(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ path: socketPath });
    const settle = (ready: boolean) => {
      socket.destroy();
      resolve(ready);
    };
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
  });
}

export function parseDeviceState(response: string): WgDeviceState {
  const device: WgDeviceState = { listenPort: 0, peers: [] };
  let peer: WgPeerState | null = null;

  for (const line of response.split("\n")) {
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq);
    const value = line.slice(eq + 1);

    switch (key) {
      case "private_key":
        // All-zero means "unset"; wireguard-go reports it that way.
        if (!/^0+$/.test(value)) device.privateKey = Buffer.from(value, "hex").toString("base64");
        break;
      case "listen_port":
        device.listenPort = Number(value);
        break;
      case "public_key":
        peer = {
          publicKey: Buffer.from(value, "hex").toString("base64"),
          allowedIps: [],
          persistentKeepalive: 0,
          lastHandshakeSeconds: 0,
          rxBytes: 0,
          txBytes: 0,
        };
        device.peers.push(peer);
        break;
      case "endpoint":
        if (peer) peer.endpoint = value;
        break;
      case "allowed_ip":
        peer?.allowedIps.push(value);
        break;
      case "persistent_keepalive_interval":
        if (peer) peer.persistentKeepalive = Number(value);
        break;
      case "last_handshake_time_sec":
        if (peer) peer.lastHandshakeSeconds = Number(value);
        break;
      case "rx_bytes":
        if (peer) peer.rxBytes = Number(value);
        break;
      case "tx_bytes":
        if (peer) peer.txBytes = Number(value);
        break;
      default:
        break;
    }
  }
  return device;
}

export interface SetDeviceRequest {
  privateKey?: string;
  listenPort?: number;
  /** Peers to create or update. */
  upsert: DesiredPeer[];
  /** Public keys (base64) to drop. */
  remove: string[];
}

export function buildSetRequest(request: SetDeviceRequest): string {
  const lines = ["set=1"];
  if (request.privateKey) lines.push(`private_key=${keyToHex(request.privateKey)}`);
  if (request.listenPort !== undefined) lines.push(`listen_port=${request.listenPort}`);

  for (const publicKey of request.remove) {
    lines.push(`public_key=${keyToHex(publicKey)}`, "remove=true");
  }
  for (const peer of request.upsert) {
    lines.push(`public_key=${keyToHex(peer.publicKey)}`);
    if (peer.endpoint) lines.push(`endpoint=${peer.endpoint}`);
    lines.push(`persistent_keepalive_interval=${peer.persistentKeepalive}`);
    // Replace rather than append: allowed IPs are authoritative in the netmap,
    // and appending would leave stale routes behind after a renumbering.
    lines.push("replace_allowed_ips=true");
    for (const cidr of peer.allowedIps) lines.push(`allowed_ip=${cidr}`);
  }
  return `${lines.join("\n")}\n\n`;
}

export function parseErrno(response: string): number {
  const match = /(?:^|\n)errno=(-?\d+)/.exec(response);
  return match?.[1] ? Number(match[1]) : -1;
}

export class WgControl {
  constructor(private readonly socketPath: string) {}

  async getDevice(): Promise<WgDeviceState> {
    const response = await uapiExchange(this.socketPath, "get=1\n\n");
    const errno = parseErrno(response);
    if (errno !== 0) throw new Error(`UAPI get failed with errno ${errno}`);
    return parseDeviceState(response);
  }

  async setDevice(request: SetDeviceRequest): Promise<void> {
    if (
      !request.privateKey &&
      request.listenPort === undefined &&
      !request.upsert.length &&
      !request.remove.length
    ) {
      return;
    }
    const response = await uapiExchange(this.socketPath, buildSetRequest(request));
    const errno = parseErrno(response);
    if (errno !== 0) throw new Error(`UAPI set failed with errno ${errno}`);
  }
}
