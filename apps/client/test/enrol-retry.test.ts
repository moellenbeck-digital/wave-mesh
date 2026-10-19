import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@wave/crypto";
import { enrol } from "../src/engine.ts";
import { isAbort } from "../src/retry.ts";
import { ensureProfile, type Profile, updateProfile } from "../src/state.ts";
import { signedNetmap } from "./fake-control.ts";

/**
 * Enrolment against a control server that is not there yet. The rule for which
 * errors are waited out is in retry.test.ts; what is checked here is that
 * `enrol` applies it to registering and to polling, and can be stopped.
 */
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

const netmapKey = generateKeyPair("ed25519");
const fast = { minBackoffMs: 5, maxBackoffMs: 20, pollMs: 5 };

type Handler = (path: string) => Response | Promise<Response>;

/** A port nobody listens on yet, and a way to start the server there later. */
function lateServer(handler: Handler) {
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  const requests: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  cleanup.push(() => server?.stop(true));
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    start: () => {
      server = Bun.serve({
        port,
        hostname: "127.0.0.1",
        fetch: (request) => {
          const path = new URL(request.url).pathname;
          requests.push(path);
          return handler(path);
        },
      });
    },
  };
}

const authorized = () => ({
  status: "authorized",
  nodeId: "n_1",
  netmap: signedNetmap(netmapKey),
  netmapPublicKey: netmapKey.publicKey,
});
const pending = () => ({
  status: "pending",
  authUrl: "https://control.example/authorize",
  pollSecret: "s3cret",
});

async function profileFor(
  controlUrl: string,
  known = false,
): Promise<{ profile: Profile; statePath: string }> {
  const statePath = join(await mkdtemp(join(tmpdir(), "wave-enrol-")), "state.json");
  let profile = await ensureProfile(statePath, controlUrl);
  if (known) {
    profile = { ...profile, netmapPublicKey: netmapKey.publicKey };
    await updateProfile(statePath, controlUrl, { netmapPublicKey: netmapKey.publicKey });
  }
  return { profile, statePath };
}

describe("the first connect", () => {
  test("a server that is not up yet is waited for, and the wait is in the log", async () => {
    const server = lateServer(() => Response.json(authorized()));
    const { profile, statePath } = await profileFor(server.url);
    const lines: string[] = [];
    const waits: Array<{ reason: string; delayMs: number } | null> = [];
    setTimeout(server.start, 100);

    const { netmap } = await enrol(profile, statePath, (line) => lines.push(line), undefined, undefined, {
      ...fast,
      onControlWait: (wait) => waits.push(wait),
    });

    expect(netmap.self.hostname).toBe("laptop");
    // One line per failed attempt: why, and when the next one is.
    const said = lines.filter((line) => line.startsWith("control server not reachable"));
    expect(said.length).toBeGreaterThan(0);
    expect(said[0]).toMatch(/\(.+\) — retrying in \d+ms$/);
    // The daemon is told of each wait, and once more when the server is back.
    expect(waits.length).toBe(said.length + 1);
    expect(waits.at(-1)).toBeNull();
    expect(waits[0]?.delayMs).toBe(5);
  });

  test("a poll that cannot reach the server is waited out, and approval still comes", async () => {
    let polls = 0;
    const server = lateServer((path) => {
      if (path === "/v1/machine/register") return Response.json(pending());
      polls++;
      if (polls <= 2) return new Response("starting", { status: 503 });
      return Response.json(authorized());
    });
    server.start();
    const { profile, statePath } = await profileFor(server.url);
    const lines: string[] = [];
    const links: string[] = [];

    await enrol(
      profile,
      statePath,
      (line) => lines.push(line),
      (url) => links.push(url),
      undefined,
      fast,
    );

    expect(links).toEqual(["https://control.example/authorize"]);
    expect(polls).toBe(3);
    expect(lines.filter((line) => line.startsWith("control server not reachable")).length).toBe(2);
  });

  test("an answer that is a refusal ends it at once, not after a wait", async () => {
    const server = lateServer(() => new Response("no", { status: 403 }));
    server.start();
    const { profile, statePath } = await profileFor(server.url, true);

    await expect(enrol(profile, statePath, () => {}, undefined, undefined, fast)).rejects.toThrow("403");
    expect(server.requests).toEqual(["/v1/machine/register"]);
  });

  test("an expired request is reported at once, not polled again", async () => {
    const server = lateServer((path) =>
      path === "/v1/machine/register" ? Response.json(pending()) : Response.json({ status: "expired" }),
    );
    server.start();
    const { profile, statePath } = await profileFor(server.url, true);

    await expect(enrol(profile, statePath, () => {}, undefined, undefined, fast)).rejects.toThrow("expired");
    expect(server.requests).toEqual(["/v1/machine/register", "/v1/machine/poll"]);
  });

  test("a netmap signed by another key than the pinned one is reported, not waited out", async () => {
    const server = lateServer(() => Response.json(authorized()));
    server.start();
    const { profile, statePath } = await profileFor(server.url);
    const other = { ...profile, netmapPublicKey: generateKeyPair("ed25519").publicKey };

    await expect(enrol(other, statePath, () => {}, undefined, undefined, fast)).rejects.toThrow(
      "different netmap signing key",
    );
    expect(server.requests).toEqual(["/v1/machine/register"]);
  });
});

describe("a name that does not resolve", () => {
  // The resolver says it cannot find this whether or not it has a network.
  const nowhere = "http://no-such-host.invalid";

  test("is reported at once for a login a person has just typed", async () => {
    const { profile, statePath } = await profileFor(nowhere, false);
    const lines: string[] = [];

    await expect(
      enrol(profile, statePath, (line) => lines.push(line), undefined, undefined, fast),
    ).rejects.toThrow();
    expect(lines.filter((line) => line.startsWith("control server not reachable"))).toEqual([]);
  });

  test("is waited out for an enrolment that was approved there before", async () => {
    const { profile, statePath } = await profileFor(nowhere, true);
    const controller = new AbortController();
    const lines: string[] = [];

    const running = enrol(profile, statePath, (line) => lines.push(line), undefined, undefined, {
      ...fast,
      signal: controller.signal,
    });
    await Bun.sleep(150);
    controller.abort();

    expect(isAbort(await running.catch((e) => e))).toBe(true);
    expect(lines.filter((line) => line.startsWith("control server not reachable")).length).toBeGreaterThan(1);
  });
});

describe("stopping", () => {
  test("the signal ends the wait for a server that never comes, without a timer left behind", async () => {
    const server = lateServer(() => Response.json(authorized()));
    const { profile, statePath } = await profileFor(server.url);
    const controller = new AbortController();
    const started = Date.now();

    // A minute between tries: only the abort can end this in time.
    const running = enrol(profile, statePath, () => {}, undefined, undefined, {
      minBackoffMs: 60_000,
      maxBackoffMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    expect(isAbort(await running.catch((e) => e))).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("the signal also ends the wait for approval", async () => {
    const server = lateServer((path) =>
      path === "/v1/machine/register" ? Response.json(pending()) : Response.json({ status: "pending" }),
    );
    server.start();
    const { profile, statePath } = await profileFor(server.url);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 60);

    const error = await enrol(profile, statePath, () => {}, undefined, undefined, {
      ...fast,
      signal: controller.signal,
    }).catch((e) => e);

    expect(isAbort(error)).toBe(true);
  });
});
