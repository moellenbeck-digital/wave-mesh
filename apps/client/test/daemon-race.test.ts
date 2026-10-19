import { describe, expect, mock, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Enrolment waits for a human at a browser, so `up` stays in flight for as
 * long as it takes someone to click approve. This stand-in blocks the same
 * way, which is what makes the race reachable from a test at all.
 */
const attempts: string[] = [];
let release: (() => void) | null = null;
/** What a test makes the next `up` do instead of waiting for approval. */
let script: ((options: UpOptions) => Promise<void>) | null = null;

interface UpOptions {
  controlUrl: string;
  signal?: AbortSignal;
  onControlWait?: (wait: { reason: string; delayMs: number } | null) => void;
}

/**
 * The real module first, because `mock.module` replaces it for the *whole test
 * process* and not just for this file: a stand-in that carries only `up` takes
 * every other export away from whoever imports the engine next. That is what
 * `bun test` tripped over -- engine.test.ts, running in the same process,
 * suddenly could not find `ensureTunDevice`, but only when both files ran
 * together. So only `up` is replaced, and everything else is passed through.
 */
const engine = await import("../src/engine.ts");

mock.module("../src/engine.ts", () => ({
  ...engine,
  up: async (options: UpOptions) => {
    attempts.push(options.controlUrl);
    if (script) await script(options);
    else {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return {
      state: { controlUrl: options.controlUrl },
      linkName: "wave0",
      currentNetmap: () => undefined,
      snapshot: async () => undefined,
      stop: async () => {},
    };
  },
}));

const { Daemon } = await import("../src/daemon.ts");
const { ensureProfile } = await import("../src/state.ts");

describe("two callers wanting the same wave up", () => {
  test("enrol once, and the loser does not overwrite the winner", async () => {
    const statePath = join(await mkdtemp(join(tmpdir(), "wave-race-")), "state.json");
    await ensureProfile(statePath, "http://c.example");

    // Never allowed to touch a real interface: the link is a stub.
    const daemon = new Daemon({
      statePath,
      log: () => {},
      link: { remove: async () => {} } as never,
    });

    const first = daemon.up();
    while (attempts.length === 0) await Bun.sleep(5);
    // Arrives while the first attempt is still waiting for approval -- the
    // window in which `runtime.tunnel` is not set yet.
    const second = daemon.login("http://c.example");
    await Bun.sleep(30);

    release?.();
    await Promise.all([first, second]);

    expect(attempts).toEqual(["http://c.example"]);
    const status = await daemon.status();
    expect(status.profiles[0]?.state).toBe("up");
    // The second caller's timeout used to land here and call a live wave failed.
    expect(status.profiles[0]?.message).toBeNull();
  });
});

/**
 * A control server that is down is not this wave's failure. The engine says it
 * is waiting (`onControlWait`) and keeps trying; what the daemon owes is to
 * show that, to stay "starting", and to end the wait when told to.
 */
describe("a control server that cannot be reached", () => {
  const neverEnds = (options: UpOptions) =>
    new Promise<void>((_, reject) => {
      options.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    });

  async function daemonWith(...urls: string[]) {
    const statePath = join(await mkdtemp(join(tmpdir(), "wave-wait-")), "state.json");
    for (const url of urls) await ensureProfile(statePath, url);
    const daemon = new Daemon({ statePath, log: () => {}, link: { remove: async () => {} } as never });
    return daemon;
  }

  test("stays starting, with the English sentence and the code, and not failed", async () => {
    const daemon = await daemonWith("http://down.example");
    let report: UpOptions["onControlWait"];
    script = async (options) => {
      report = options.onControlWait;
      options.onControlWait?.({ reason: "connection refused", delayMs: 500 });
      await neverEnds(options);
    };
    try {
      await daemon.up();

      const waiting = (await daemon.status()).profiles[0];
      expect(waiting?.state).toBe("starting");
      // An older client reads only `message`, and the journal gets the same words.
      expect(waiting?.message).toBe("waiting for the control server … (connection refused)");
      expect(waiting?.notice).toEqual({
        code: "waiting-for-control",
        params: { reason: "connection refused" },
      });

      // The server is back: the line goes, and the wave is not failed by it.
      report?.(null);
      const back = (await daemon.status()).profiles[0];
      expect(back?.state).toBe("starting");
      expect(back?.message).toBeNull();
      expect(back?.notice ?? null).toBeNull();
    } finally {
      await daemon.down();
      script = null;
    }
  });

  test("`down` ends the wait: the signal fires and the wave is stopped, not failed", async () => {
    const daemon = await daemonWith("http://down.example");
    let signal: AbortSignal | undefined;
    script = async (options) => {
      signal = options.signal;
      options.onControlWait?.({ reason: "connection refused", delayMs: 500 });
      await neverEnds(options);
    };
    try {
      await daemon.up();
      expect(signal?.aborted).toBe(false);

      await daemon.down();
      await Bun.sleep(20);

      expect(signal?.aborted).toBe(true);
      const stopped = (await daemon.status()).profiles[0];
      expect(stopped?.state).toBe("stopped");
      expect(stopped?.message).toBeNull();
      expect(stopped?.notice ?? null).toBeNull();
    } finally {
      script = null;
    }
  });

  test("stopping the daemon ends it too, so no timer keeps the process alive", async () => {
    const daemon = await daemonWith("http://down.example");
    let signal: AbortSignal | undefined;
    script = async (options) => {
      signal = options.signal;
      options.onControlWait?.({ reason: "connection refused", delayMs: 500 });
      await neverEnds(options);
    };
    try {
      await daemon.up();
      await daemon.stop();
      expect(signal?.aborted).toBe(true);
    } finally {
      script = null;
    }
  });

  test("does not hold up the waves at servers that are up", async () => {
    const daemon = await daemonWith("http://down.example", "http://fine.example");
    script = async (options) => {
      if (options.controlUrl === "http://down.example") {
        options.onControlWait?.({ reason: "connection refused", delayMs: 500 });
        await neverEnds(options);
      }
    };
    try {
      // Returns although the first wave is still waiting for its server.
      await daemon.up();

      const states = Object.fromEntries(
        (await daemon.status()).profiles.map((profile) => [profile.controlUrl, profile.state]),
      );
      expect(states).toEqual({ "http://down.example": "starting", "http://fine.example": "up" });
    } finally {
      await daemon.down();
      script = null;
    }
  });

  test("a failure that is not a connection problem after the wait still fails the wave", async () => {
    const daemon = await daemonWith("http://down.example");
    script = async (options) => {
      options.onControlWait?.({ reason: "connection refused", delayMs: 500 });
      throw new Error("POST /v1/machine/register failed: 403 no");
    };
    try {
      await daemon.up();
      await Bun.sleep(20);

      const failed = (await daemon.status()).profiles[0];
      expect(failed?.state).toBe("failed");
      expect(failed?.message).toContain("403");
      // The waiting line is over: what is left is the reason it failed.
      expect(failed?.notice ?? null).toBeNull();
    } finally {
      script = null;
    }
  });
});
