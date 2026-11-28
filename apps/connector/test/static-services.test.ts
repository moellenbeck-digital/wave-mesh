import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureProfile, updateProfile } from "@wave/client/state";
import { ServiceSyncRequest } from "@wave/proto";
import { runStaticServices, staticServicesFromEnv } from "../src/static-services.ts";

/** A connector without an operator: the names come from the environment. */

describe("reading the list", () => {
  test("off unless names are given -- an empty set is never declared", () => {
    expect(staticServicesFromEnv({})).toBeUndefined();
    expect(staticServicesFromEnv({ WAVE_SERVICES: " , " })).toBeUndefined();
  });

  test("served over TLS unless listed otherwise", () => {
    expect(
      staticServicesFromEnv({
        WAVE_SERVICES: "ha, Paperless ,openclaw,ha",
        WAVE_SERVICES_NO_TLS: "paperless",
      }),
    ).toEqual({
      names: ["ha", "paperless", "openclaw"],
      secure: ["ha", "openclaw"],
      intervalMs: 60_000,
    });
  });

  test("takes full names as well as labels", () => {
    expect(staticServicesFromEnv({ WAVE_SERVICES: "ha.wave.example.com." })?.names).toEqual([
      "ha.wave.example.com",
    ]);
  });

  test("a mistake is said at start, not published", () => {
    expect(() => staticServicesFromEnv({ WAVE_SERVICES: "home assistant" })).toThrow("not a service name");
    expect(() => staticServicesFromEnv({ WAVE_SERVICES: "ha", WAVE_SERVICES_NO_TLS: "hs" })).toThrow(
      "not listed in WAVE_SERVICES",
    );
    expect(() => staticServicesFromEnv({ WAVE_SERVICES_NO_TLS: "ha" })).toThrow("not listed");
    expect(() => staticServicesFromEnv({ WAVE_SERVICES: "ha", WAVE_SYNC_INTERVAL_MS: "10s" })).toThrow(
      "WAVE_SYNC_INTERVAL_MS",
    );
  });
});

describe("declaring it", () => {
  const cleanups: (() => unknown)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function fixture(failures: number) {
    const requests: { path: string; authorization: string | null; body: unknown }[] = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get("authorization"),
          body: await request.json(),
        });
        if (requests.length <= failures) return new Response("down for a moment", { status: 503 });
        return Response.json({ services: [{ name: "ha", ipv4: "100.64.0.7", ipv6: "fd7a::7" }] });
      },
    });
    const dir = await mkdtemp(join(tmpdir(), "wave-static-"));
    cleanups.push(
      () => server.stop(true),
      () => rm(dir, { recursive: true, force: true }),
    );
    return { requests, statePath: join(dir, "state.json"), controlUrl: `http://127.0.0.1:${server.port}` };
  }

  const services = { names: ["ha", "paperless"], secure: ["ha"], intervalMs: 30_000 };

  test("the whole set, signed, at start and again every interval", async () => {
    const { requests, statePath, controlUrl } = await fixture(0);
    await ensureProfile(statePath, controlUrl);
    await updateProfile(statePath, controlUrl, { nodeId: "node_1" });
    const waits: number[] = [];
    const said: string[] = [];
    await runStaticServices({
      services,
      statePath,
      controlUrl: `${controlUrl}/`,
      log: (line) => said.push(line),
      sleep: async (ms) => {
        waits.push(ms);
      },
      until: () => waits.length >= 3,
    });
    expect(requests).toHaveLength(3);
    expect(requests[0]?.path).toBe("/v1/services");
    expect(requests[0]?.authorization).toBeTruthy();
    expect(ServiceSyncRequest.parse(requests[0]?.body)).toEqual({
      names: ["ha", "paperless"],
      secure: ["ha"],
    });
    expect(waits).toEqual([30_000, 30_000, 30_000]);
    // Said when it changes, not every round.
    expect(said).toEqual(["services: ha 100.64.0.7"]);
  });

  test("retries with growing waits and goes on after a failure", async () => {
    const { requests, statePath, controlUrl } = await fixture(5);
    await ensureProfile(statePath, controlUrl);
    await updateProfile(statePath, controlUrl, { nodeId: "node_1" });
    const waits: number[] = [];
    const said: string[] = [];
    await runStaticServices({
      services,
      statePath,
      controlUrl,
      log: (line) => said.push(line),
      sleep: async (ms) => {
        waits.push(ms);
      },
      until: () => waits.length >= 6,
    });
    expect(waits).toEqual([2000, 4000, 8000, 16_000, 30_000, 30_000]);
    expect(requests).toHaveLength(6);
    expect(said[0]).toContain("503");
    expect(said.at(-1)).toBe("services: ha 100.64.0.7");
  });

  test("waits for the enrolment instead of crashing", async () => {
    const { requests, statePath, controlUrl } = await fixture(0);
    const said: string[] = [];
    let rounds = 0;
    await runStaticServices({
      services,
      statePath,
      controlUrl,
      log: (line) => said.push(line),
      sleep: async () => {
        // The daemon enrols between the first round and the second.
        if (rounds++ === 0) {
          await ensureProfile(statePath, controlUrl);
          await updateProfile(statePath, controlUrl, { nodeId: "node_1" });
        }
      },
      until: () => rounds >= 2,
    });
    expect(said[0]).toContain("not enrolled yet");
    expect(requests).toHaveLength(1);
  });
});
