import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { loadProfiles } from "../src/state.ts";
import { type Fixture, freePort, service as startService, setUp as startUp } from "./expose-fixture.ts";

/**
 * `wave expose` and `wave pier status` as a person types them: the real CLI as
 * a process, a real daemon on a socket, a fake tunnel and a fake server. What
 * is held here is the arguments, the words and the exit codes -- and that a
 * refused call leaves nothing behind.
 */

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

const fixture: Fixture = { cleanup: [] };
afterEach(async () => {
  for (const fn of fixture.cleanup.splice(0)) await fn();
  fixture.control?.stop();
  fixture.control = undefined;
});

async function wave(
  socket: string | null,
  args: string[],
  lang = "en",
): Promise<{ out: string; err: string; code: number }> {
  const child = Bun.spawn(["bun", CLI, ...(socket ? ["--daemon", socket] : ["--no-daemon"]), ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, WAVE_LANG: lang },
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { out, err, code: await child.exited };
}

async function ready() {
  const up = await startUp(fixture, {}, [], true);
  return { ...up, socket: up.socketPath as string };
}

describe("the arguments", () => {
  test("without the service there is nothing to ask", async () => {
    const { err, code } = await wave(null, ["expose", "app", "http://localhost:3000"]);
    expect(code).toBe(1);
    expect(err).toContain("needs the service");
  });

  test("a missing URL, too many arguments, a bad port: usage, and nothing is asked", async () => {
    const { socket, control } = await ready();
    for (const args of [
      ["expose"],
      ["expose", "app"],
      ["expose", "app", "http://localhost:3000", "extra"],
      ["expose", "--remove", "app", "extra"],
      ["pier"],
      ["pier", "list"],
    ]) {
      const { err, code } = await wave(socket, args);
      expect(code).toBe(1);
      expect(err).toContain("usage:");
    }
    for (const bad of ["abc", "0", "70000", "44.5"]) {
      const { err, code } = await wave(socket, [
        "expose",
        "app",
        "http://localhost:3000",
        "--listen-port",
        bad,
      ]);
      expect(code).toBe(1);
      expect(err).toContain("--listen-port takes a port");
    }
    expect(control.pierCalls).toEqual([]);
  });

  test("a name or URL that is not valid is said so and changes nothing", async () => {
    const { socket, control, statePath } = await ready();
    const name = await wave(socket, ["expose", "app.example.org", "http://localhost:3000"]);
    expect(name.code).toBe(1);
    expect(name.err).toContain("is not a name under pier.wave.example.com");
    const url = await wave(socket, ["expose", "app", "http://localhost"]);
    expect(url.code).toBe(1);
    expect(url.err).toContain("is not a local address");
    expect(control.pierCalls).toEqual([]);
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([]);
  });
});

describe("putting a name out", () => {
  test("without the operator's allow-pier: the next step, in both languages", async () => {
    const { socket, control } = await ready();
    control.pierAllowed = false;
    const en = await wave(socket, ["expose", "app", "http://localhost:3000"]);
    expect(en.code).toBe(1);
    expect(en.err).toContain("has not allowed the pier for laptop");
    expect(en.err).toContain("admin.ts allow-pier");
    const de = await wave(socket, ["expose", "app", "http://localhost:3000"], "de");
    expect(de.code).toBe(1);
    expect(de.err).toContain("hat den Pier für laptop nicht erlaubt");
    expect(de.err).toContain("admin.ts allow-pier");
  });

  test("the first call has no certificate yet and says what to do", async () => {
    const svc = await startService(fixture);
    const { socket, control } = await ready();
    const port = await freePort();
    const result = await wave(socket, [
      "expose",
      "app",
      `http://127.0.0.1:${svc.port}`,
      "--listen-port",
      String(port),
    ]);
    expect(result.code).toBe(0);
    expect(result.out).toContain(`app.pier.wave.example.com  port ${port}  ->  http://127.0.0.1:${svc.port}`);
    expect(result.out).toContain(
      "no certificate for app.pier.wave.example.com, next step: `wave cert app.pier.wave.example.com`",
    );
    expect(control.piers.get("app")).toBe(port);

    const german = await wave(
      socket,
      ["expose", "app", `http://127.0.0.1:${svc.port}`, "--listen-port", String(port)],
      "de",
    );
    expect(german.out).toContain("kein Zertifikat für app.pier.wave.example.com, nächster Schritt:");
  });

  test("--list and pier status say the same thing, and --remove takes the name out", async () => {
    const svc = await startService(fixture);
    const { socket, control, statePath } = await ready();
    const port = await freePort();
    await wave(socket, ["expose", "app", `http://127.0.0.1:${svc.port}`, "--listen-port", String(port)]);

    const list = await wave(socket, ["expose", "--list"]);
    expect(list.code).toBe(0);
    expect(list.out).toContain("the operator has allowed it for this device");
    expect(list.out).toContain("pier address: 203.0.113.10, for *.pier.wave.example.com");
    expect(list.out).toContain("app.pier.wave.example.com");
    expect(list.out).toContain("no certificate for app.pier.wave.example.com");

    const status = await wave(socket, ["pier", "status"]);
    expect(status.code).toBe(0);
    expect(status.out).toContain("app.pier.wave.example.com  own");
    expect(status.out).toContain("no certificate for app.pier.wave.example.com");

    const removed = await wave(socket, ["expose", "--remove", "app"]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("app.pier.wave.example.com is out of the open network");
    expect(control.piers.size).toBe(0);
    expect((await loadProfiles(statePath))[0]?.exposed).toEqual([]);

    const again = await wave(socket, ["expose", "--remove", "app"]);
    expect(again.code).toBe(1);
    expect(again.err).toContain("is not one of this device's names");
    expect((await wave(socket, ["pier", "status"])).out).toContain("no pier names here");
  });
});
