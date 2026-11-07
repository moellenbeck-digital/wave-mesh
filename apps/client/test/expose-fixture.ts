import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@wave/crypto";
import { Daemon } from "../src/daemon.ts";
import type { Tunnel, TunnelSnapshot } from "../src/engine.ts";
import { saveProfiles } from "../src/state.ts";
import { type FakeControl, fakeControl } from "./fake-control.ts";

/**
 * A daemon with a fake tunnel and a fake control server, for the tests of
 * `wave expose`: the daemon test calls it directly, the CLI test over its
 * socket. What is torn down afterwards is handed to the caller's `cleanup`.
 */
export interface Fixture {
  cleanup: Array<() => void | Promise<void>>;
  control?: FakeControl;
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((done) => server.close(() => done()));
  return port;
}

export async function service(fixture: Fixture): Promise<{ port: number; seen: string[] }> {
  const seen: string[] = [];
  const server = createServer((socket) => {
    socket.on("data", (chunk) => {
      seen.push(chunk.toString());
      socket.end(`service says: ${chunk.toString()}`);
    });
    socket.on("error", () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fixture.cleanup.push(() => new Promise<void>((done) => server.close(() => done())));
  const address = server.address();
  return { port: typeof address === "object" && address ? address.port : 0, seen };
}

/** A tunnel that is only what the daemon reads from one: an address, a suffix, peers. */
export function fakeTunnel(url: string, extra: Partial<TunnelSnapshot> = {}): Tunnel {
  const snapshot: TunnelSnapshot = {
    controlUrl: url,
    interfaceName: "wave0",
    addresses: ["127.0.0.1/32"],
    self: {
      hostname: "laptop",
      dnsName: "laptop.wave.example.com",
      ipv4: "127.0.0.1",
      ipv6: "",
      services: [],
    },
    dnsSuffix: "wave.example.com",
    piers: [],
    pier: { zone: "pier.wave.example.com", self: false },
    peers: [],
    ...extra,
  };
  return {
    linkName: "wave0",
    snapshot: async () => snapshot,
    currentNetmap: () => undefined,
    announce: () => {},
    stop: async () => {},
  } as unknown as Tunnel;
}

export async function setUp(
  fixture: Fixture,
  extra: Partial<TunnelSnapshot> = {},
  log: string[] = [],
  socket = false,
) {
  const control = fakeControl();
  fixture.control = control;
  const dir = await mkdtemp(join(tmpdir(), "wave-daemon-expose-"));
  const statePath = join(dir, "state.json");
  await saveProfiles(statePath, [
    {
      autoStart: true,
      controlUrl: control.url,
      machineKey: generateKeyPair("ed25519"),
      nodeKey: generateKeyPair("x25519"),
      discoKey: generateKeyPair("x25519"),
      nodeId: "n_1",
      netmapPublicKey: null,
      id: null,
      label: "wave.example.com",
      interfaceName: "wave0",
      listenPort: 41641,
      certs: [],
      exposed: [],
    },
  ]);
  const daemon = new Daemon({
    statePath,
    log: (line) => log.push(line),
    controlSocketPath: socket ? join(dir, "waved.sock") : undefined,
    link: { remove: async () => {} } as never,
    bringUp: (async (options: { controlUrl: string }) => fakeTunnel(options.controlUrl, extra)) as never,
  });
  fixture.cleanup.push(() => daemon.stop());
  const socketPath = socket ? await daemon.listen() : null;
  await daemon.up();
  return { daemon, statePath, control, dir, socketPath };
}
