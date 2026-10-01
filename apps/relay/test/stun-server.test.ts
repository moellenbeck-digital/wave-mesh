import { afterEach, describe, expect, test } from "bun:test";
import { buildBindingRequest, parseBindingResponse } from "@wave/magicsock";
import { startStunServer } from "../src/stun-server.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

describe("STUN server", () => {
  test("reports the address a request arrived from", async () => {
    const server = await startStunServer({ port: 0, hostname: "127.0.0.1" });
    cleanup.push(() => server.close());

    const answer = Promise.withResolvers<Uint8Array>();
    const client = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: (_s, data) => answer.resolve(new Uint8Array(data)) },
    });
    cleanup.push(() => client.close());

    const { packet, txid } = buildBindingRequest();
    client.send(packet, server.port, "127.0.0.1");

    const parsed = parseBindingResponse(await answer.promise);
    expect(parsed?.txid).toBe(txid);
    expect(parsed?.mapped).toEqual({ ip: "127.0.0.1", port: client.port });
    expect(server.requests()).toBe(1);
  });

  test("survives a client that vanishes before the answer arrives", async () => {
    const server = await startStunServer({ port: 0, hostname: "127.0.0.1" });
    cleanup.push(() => server.close());

    // Ask, then close: the reply hits a closed port and draws an ICMP error.
    const gone = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
    gone.send(buildBindingRequest().packet, server.port, "127.0.0.1");
    gone.close();
    await Bun.sleep(150);

    // The next client must still be served.
    const answer = Promise.withResolvers<Uint8Array>();
    const client = await Bun.udpSocket({
      hostname: "127.0.0.1",
      port: 0,
      socket: { data: (_s, data) => answer.resolve(new Uint8Array(data)) },
    });
    cleanup.push(() => client.close());
    client.send(buildBindingRequest().packet, server.port, "127.0.0.1");

    expect(parseBindingResponse(await answer.promise)?.mapped.port).toBe(client.port);
    expect(server.requests()).toBe(2);
  });

  test("ignores datagrams that are not binding requests", async () => {
    const server = await startStunServer({ port: 0, hostname: "127.0.0.1" });
    cleanup.push(() => server.close());

    const client = await Bun.udpSocket({ hostname: "127.0.0.1", port: 0, socket: { data: () => {} } });
    cleanup.push(() => client.close());
    client.send(new Uint8Array(40), server.port, "127.0.0.1");

    await Bun.sleep(100);
    expect(server.requests()).toBe(0);
  });
});
