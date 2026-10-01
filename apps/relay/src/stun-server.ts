import { buildBindingResponse, isBindingRequest } from "@wave/magicsock";

export interface StunServerOptions {
  port: number;
  hostname?: string;
  log?: (message: string) => void;
}

export interface StunServer {
  port: number;
  requests: () => number;
  /** Socket errors survived, almost always a client that went away. */
  failures: () => number;
  close: () => void;
}

/**
 * Minimal STUN responder: it tells a client the address its packet arrived
 * from. That is the whole job -- everything else a node needs for hole
 * punching comes from the control server.
 *
 * Running our own removes the dependency on Google's and Cloudflare's servers,
 * which would otherwise learn when each node comes online.
 */
/**
 * The ICMP error a vanished client causes is delivered to the *next* send on
 * the socket, so one unreachable client would otherwise swallow the answer to
 * the following one. Retrying once gets past the queued error.
 */
function send(socket: Bun.udp.Socket<"buffer">, data: Uint8Array, port: number, address: string): void {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      socket.send(data, port, address);
      return;
    } catch {
      // Try once more; a queued error is consumed by the failed attempt.
    }
  }
}

export async function startStunServer(options: StunServerOptions): Promise<StunServer> {
  let requests = 0;
  let failures = 0;
  const log = options.log ?? (() => {});

  const socket = await Bun.udpSocket({
    hostname: options.hostname ?? "0.0.0.0",
    port: options.port,
    socket: {
      data(socket, data, port, address) {
        if (!isBindingRequest(data)) return;
        requests++;
        send(socket, buildBindingResponse(data, { ip: address, port }), port, address);
      },
      // A client that asked and then went away leaves its NAT mapping closed,
      // so our answer draws an ICMP error. That is routine, and it must not
      // take the server down.
      error: (_socket, error) => {
        failures++;
        log(`socket error (ignored): ${error instanceof Error ? error.message : String(error ?? "unknown")}`);
      },
    },
  });

  log(`STUN listening on ${options.hostname ?? "0.0.0.0"}:${socket.port}/udp`);
  return {
    port: socket.port,
    requests: () => requests,
    failures: () => failures,
    close: () => socket.close(),
  };
}
