import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DaemonClient, LineReader, type Status } from "@wave/ipc";
import { Daemon, resolveGroupId } from "../src/daemon.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

async function startDaemon(options: { socketGroup?: string; log?: (m: string) => void } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "wave-daemon-"));
  const statePath = join(dir, "state.json");
  const daemon = new Daemon({
    statePath,
    controlSocketPath: join(dir, "waved.sock"),
    log: () => {},
    ...options,
  });
  const path = await daemon.listen();
  cleanup.push(() => daemon.stop());
  return { daemon, path, statePath };
}

describe("control socket", () => {
  test("reports a stopped tunnel before anything is up", async () => {
    const { path } = await startDaemon();
    const client = await DaemonClient.connect(path);
    expect(client).not.toBeNull();
    cleanup.push(() => client?.close());

    const response = await (client as DaemonClient).request({ command: "status" });
    expect(response.type).toBe("status");
    if (response.type !== "status") throw new Error("unreachable");
    // Nothing enrolled yet, so there is no wave to report on.
    expect(response.status.profiles).toEqual([]);
  });

  test("rejects a command it does not know", async () => {
    const { path } = await startDaemon();
    const answers: string[] = [];
    const socket = await Bun.connect<undefined>({
      unix: path,
      socket: { data: (_s, chunk) => void answers.push(chunk.toString()) },
    });
    cleanup.push(() => void socket.end());

    socket.write(`${JSON.stringify({ command: "take-over-the-world" })}\n`);
    await Bun.sleep(120);
    expect(answers.join("")).toContain("unknown command");
  });

  test("pushes only to connections that asked to watch", async () => {
    // What `wave login` stands on. The client hands every incoming message to
    // the watcher *and* to the oldest pending request, so a request made on a
    // watching connection is answered by the next push instead of by the
    // daemon -- which is why the CLI streams on a second connection and asks
    // on its own. That only works if a plain connection stays quiet.
    const { path } = await startDaemon();
    const watcher = (await DaemonClient.connect(path)) as DaemonClient;
    cleanup.push(() => watcher.close());
    const seen: Status[] = [];
    await watcher.watch((status: Status) => void seen.push(status));

    const asker = (await DaemonClient.connect(path)) as DaemonClient;
    cleanup.push(() => asker.close());
    // Long enough for the publish ticker to have pushed at least once.
    await Bun.sleep(1200);
    expect(seen.length).toBeGreaterThan(0);

    // A refusal, and it must be the daemon's own words rather than whatever
    // was pushed in the meantime.
    const response = await asker.request({ command: "logout", controlUrl: "https://nobody.example" });
    expect(response.type).toBe("error");
    if (response.type !== "error") throw new Error("unreachable");
    expect(response.message).toContain("not in a wave at");
  });

  test("streams status to a watcher", async () => {
    const { path } = await startDaemon();
    const client = (await DaemonClient.connect(path)) as DaemonClient;
    cleanup.push(() => client.close());

    const seen: Status[] = [];
    await client.watch((status) => seen.push(status));
    await Bun.sleep(1300);
    // One immediately, then the periodic push.
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen[0]?.profiles).toEqual([]);
  });

  test("there is nothing to connect to when no daemon runs", async () => {
    expect(await DaemonClient.connect(join(tmpdir(), "wave-does-not-exist.sock"))).toBeNull();
  });
});

describe("socket permissions", () => {
  test("stays root-only when no group is configured", async () => {
    const { path } = await startDaemon();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("stays root-only when the configured group does not exist", async () => {
    // Falling back to something more permissive would hand the tunnel to
    // every local process.
    const { path } = await startDaemon({ socketGroup: "definitely-not-a-group" });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("group lookup", () => {
  const groupFile = join(import.meta.dir, "fixtures-group");

  test("reads a name from the group database", async () => {
    await Bun.write(groupFile, "root:x:0:\nwave:x:965:pinguin\n");
    cleanup.push(() => void Bun.file(groupFile).delete());
    expect(resolveGroupId("wave", groupFile)).toBe(965);
    expect(resolveGroupId("nope", groupFile)).toBeNull();
  });

  test("takes a numeric id as it is", () => {
    expect(resolveGroupId("1000")).toBe(1000);
  });
});

describe("line framing", () => {
  test("reassembles messages split across chunks", () => {
    const reader = new LineReader();
    expect(reader.push('{"a":')).toEqual([]);
    expect(reader.push('1}\n{"b":2}\n')).toEqual(['{"a":1}', '{"b":2}']);
  });

  test("ignores blank lines", () => {
    expect(new LineReader().push("\n\n")).toEqual([]);
  });
});

describe("reaching the daemon", () => {
  test("tells a missing daemon apart from one we may not use", async () => {
    const { DaemonClient } = await import("@wave/ipc");
    const absent = await DaemonClient.open(join(tmpdir(), "wave-absent.sock"));
    expect(absent).toEqual({ ok: false, reason: "no-daemon" });

    const { path } = await startDaemon();
    const allowed = await DaemonClient.open(path);
    expect(allowed.ok).toBe(true);
    if (allowed.ok) allowed.client.close();
  });

  test("a socket nobody listens on is not mistaken for a missing one", async () => {
    const { DaemonClient } = await import("@wave/ipc");
    const dir = await mkdtemp(join(tmpdir(), "wave-stale-"));
    const stale = join(dir, "waved.sock");
    await Bun.write(stale, "");
    expect(await DaemonClient.open(stale)).toEqual({ ok: false, reason: "unreachable" });
  });
});

describe("the service is installed for the machine, not for a server", () => {
  test("`up` on a device that has joined nothing enrols nobody", async () => {
    const said: string[] = [];
    const { daemon, statePath } = await startDaemon({ log: (m) => said.push(m) });

    await daemon.up();

    // The old behaviour was to quietly enrol with whatever server the service
    // had been installed with -- the one thing that made a wave appear without
    // anyone asking for it.
    expect(existsSync(statePath)).toBe(false);
    expect(said.join("\n")).toContain("wave login");
  });

  test("a logout that removes nothing comes back as an error, not as ok", async () => {
    const { path } = await startDaemon();
    const client = (await DaemonClient.connect(path)) as DaemonClient;
    cleanup.push(() => client.close());

    // The daemon used to log its refusal and answer "ok" anyway, so the CLI
    // printed "left ..." over a wave that was still enrolled.
    const response = await client.request({
      command: "logout",
      controlUrl: "https://nowhere.example",
    });
    expect(response.type).toBe("error");
    if (response.type !== "error") throw new Error("unreachable");
    expect(response.message).toContain("not in a wave at");
  });

  test("so does a down that matches nothing", async () => {
    const { path } = await startDaemon();
    const client = (await DaemonClient.connect(path)) as DaemonClient;
    cleanup.push(() => client.close());

    const response = await client.request({ command: "down", controlUrl: "https://nowhere.example" });
    expect(response.type).toBe("error");
  });

  test("naming a server it is not enrolled with says so rather than making one", async () => {
    const said: string[] = [];
    const { daemon, statePath } = await startDaemon({ log: (m) => said.push(m) });

    await daemon.up("nowhere");

    expect(existsSync(statePath)).toBe(false);
    expect(said.join("\n")).toContain("not in a wave at nowhere");
  });
});
