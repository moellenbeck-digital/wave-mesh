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
  up: async (options: { controlUrl: string }) => {
    attempts.push(options.controlUrl);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
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
