import { afterEach, expect, test } from "bun:test";
import { generateKeyPair } from "@wave/crypto";
import { PLATFORM, VERSION } from "@wave/ipc";
import { ControlSocket, type UpdateOffer } from "../src/control-socket.ts";
import type { NodeState } from "../src/state.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

/** A control server that writes down what it hears and says what it is told to. */
function fakeServer(reply: unknown) {
  const heard: unknown[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request, srv) => (srv.upgrade(request) ? undefined : new Response("no", { status: 400 })),
    websocket: {
      open: (ws) => void ws.send(JSON.stringify(reply)),
      message: (_ws, message) => void heard.push(JSON.parse(String(message))),
    },
  });
  cleanup.push(() => server.stop(true));
  return { url: `http://127.0.0.1:${server.port}`, heard };
}

const state = (controlUrl: string): NodeState => ({
  controlUrl,
  machineKey: generateKeyPair("ed25519"),
  nodeKey: generateKeyPair("x25519"),
  discoKey: generateKeyPair("x25519"),
  nodeId: "n_1",
  netmapPublicKey: null,
  interfaceName: "wave0",
  listenPort: 41641,
});

const waitFor = async <T>(predicate: () => T | undefined | false, timeoutMs = 3000): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await Bun.sleep(10);
  }
};

const update = { type: "update", channel: "stable", channels: ["stable"], offer: null };

test("says hello first, with this build's version, and hands an offer on", async () => {
  const server = fakeServer(update);
  const offers: UpdateOffer[] = [];
  let connected = 0;
  const socket = new ControlSocket({
    state: state(server.url),
    onNetmap: () => {},
    onDiscoHint: () => {},
    onUpdate: (offer) => offers.push(offer),
    onConnected: () => connected++,
  });
  cleanup.push(() => socket.close());
  socket.connect();

  await waitFor(() => server.heard.length > 0);
  // Without an updater the device still says which build it is: an operator
  // wants to know that whether or not this process can update itself.
  expect(server.heard[0]).toEqual({ type: "hello", version: VERSION, platform: PLATFORM });
  await waitFor(() => offers.length > 0);
  expect(offers[0]).toEqual({ channel: "stable", channels: ["stable"], offer: null });
  expect(connected).toBe(1);
});

test("asks for the hello on every connect, so a changed wish goes out", async () => {
  const server = fakeServer(update);
  let channel: "stable" | "insiders" = "stable";
  const socket = new ControlSocket({
    state: state(server.url),
    onNetmap: () => {},
    onDiscoHint: () => {},
    hello: () => ({ version: "0.1.0", platform: "linux-amd64", channel, autoUpdate: true }),
  });
  cleanup.push(() => socket.close());
  socket.connect();
  await waitFor(() => server.heard.length > 0);

  channel = "insiders";
  socket.hello();
  await waitFor(() => server.heard.length > 1);
  expect(server.heard[1]).toMatchObject({ type: "hello", channel: "insiders" });
});
