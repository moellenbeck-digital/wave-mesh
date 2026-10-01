import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, signRelease } from "@wave/crypto";
import type { SignedRelease, UpdateChannel } from "@wave/proto";
import type { UpdateOffer } from "../src/control-socket.ts";
import {
  loadProfiles,
  loadUpdateSettings,
  type Profile,
  saveProfiles,
  updateUpdateSettings,
} from "../src/state.ts";
import {
  chooseUpdate,
  dropOld,
  receiveArchive,
  restore,
  swapIn,
  Updater,
  updateBlocker,
  updateFiles,
} from "../src/update.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0)) fn();
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "wave-update-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const releaseKey = generateKeyPair("ed25519");
const trusted = [releaseKey.publicKey];

function signed(
  version: string,
  options: { channel?: UpdateChannel; key?: ReturnType<typeof generateKeyPair>; archive?: Buffer } = {},
): SignedRelease {
  const content = options.archive ?? Buffer.from(`wave ${version}`);
  const manifest = {
    version,
    channel: options.channel ?? "stable",
    archives: [
      {
        name: "wave-linux-amd64.tar.gz",
        platform: "linux-amd64",
        sha256: createHash("sha256").update(content).digest("hex"),
        size: content.length,
      },
    ],
  };
  return { manifest, ...signRelease(manifest, (options.key ?? releaseKey).privateKey) };
}

const offer = (release: SignedRelease | null, channel: UpdateChannel = "stable"): UpdateOffer => ({
  channel,
  channels: [channel],
  offer: release,
});

const context = { version: "0.1.0", platform: "linux-amd64", broken: [] as string[], trusted };

describe("choosing an update", () => {
  test("takes the newest valid offer across every server", () => {
    const { choice, rejected } = chooseUpdate(
      [
        ["https://a", offer(signed("0.2.0"))],
        ["https://b", offer(signed("0.3.0"))],
        ["https://c", offer(null)],
      ],
      context,
    );
    expect(choice?.signed.manifest.version).toBe("0.3.0");
    expect(choice?.sources).toEqual(["https://b"]);
    expect(rejected).toEqual([]);
  });

  test("remembers every server that offers the same archive, for a failed download", () => {
    const release = signed("0.2.0");
    const { choice } = chooseUpdate(
      [
        ["https://a", offer(release)],
        ["https://b", offer(release)],
      ],
      context,
    );
    expect(choice?.sources).toEqual(["https://a", "https://b"]);
  });

  test("refuses a release signed by a key this build does not carry", () => {
    const { choice, rejected } = chooseUpdate(
      [["https://a", offer(signed("0.9.0", { key: generateKeyPair("ed25519") }))]],
      context,
    );
    expect(choice).toBeNull();
    expect(rejected[0]?.reason).toMatch(/not signed/);
  });

  test("refuses a release from a channel less stable than the one assigned", () => {
    // A server that offers only stable handing out a develop build as stable.
    const { choice, rejected } = chooseUpdate(
      [["https://a", offer(signed("0.2.0-develop.1", { channel: "develop" }), "stable")]],
      context,
    );
    expect(choice).toBeNull();
    expect(rejected[0]?.reason).toBe("a develop release, offered on stable");
  });

  test("never goes back, and says nothing about an offer that is merely not newer", () => {
    const { choice, rejected } = chooseUpdate(
      [
        ["https://a", offer(signed("0.0.9"))],
        ["https://b", offer(signed("0.1.0"))],
      ],
      context,
    );
    expect(choice).toBeNull();
    expect(rejected).toEqual([]);
  });

  test("refuses a version that was rolled back here once", () => {
    const { choice } = chooseUpdate([["https://a", offer(signed("0.2.0"))]], {
      ...context,
      broken: ["0.2.0"],
    });
    expect(choice).toBeNull();
  });

  test("refuses a release without an archive for this machine", () => {
    const { choice, rejected } = chooseUpdate([["https://a", offer(signed("0.2.0"))]], {
      ...context,
      platform: "darwin-arm64",
    });
    expect(choice).toBeNull();
    expect(rejected[0]?.reason).toBe("no archive for darwin-arm64");
  });
});

describe("who may update", () => {
  test("only the installed copy of a release build", () => {
    const dir = tempDir();
    const installed = join(dir, "wave");
    writeFileSync(installed, "");
    const base = {
      version: "0.1.0",
      compiled: true,
      execPath: installed,
      os: "linux" as const,
      installedPath: installed,
    };
    expect(updateBlocker(base)).toBeNull();
    expect(updateBlocker({ ...base, compiled: false })).toMatch(/development build/);
    expect(updateBlocker({ ...base, version: "0.0.0-dev" })).toMatch(/development build/);
    expect(updateBlocker({ ...base, execPath: join(dir, "elsewhere") })).toMatch(/not the installed copy/);
    expect(updateBlocker({ ...base, execPath: "/usr/bin/wave" })).toMatch(/package manager/);
  });
});

describe("swapping the files", () => {
  function install(dir: string, files: Record<string, string>) {
    for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  }

  test("renames the old ones aside and brings them back on restore", () => {
    const dir = tempDir();
    const staged = join(dir, "staged");
    mkdirSync(staged);
    install(dir, { wave: "old wave", "wireguard-go": "old wg" });
    install(staged, { wave: "new wave", "wireguard-go": "new wg" });

    swapIn(dir, staged, updateFiles("linux"), "linux");
    expect(readFileSync(join(dir, "wave"), "utf8")).toBe("new wave");
    expect(readFileSync(join(dir, "wave.old"), "utf8")).toBe("old wave");

    restore(dir, updateFiles("linux"));
    expect(readFileSync(join(dir, "wave"), "utf8")).toBe("old wave");
    expect(readFileSync(join(dir, "wireguard-go"), "utf8")).toBe("old wg");
    expect(existsSync(join(dir, "wave.old"))).toBe(false);
    expect(existsSync(join(dir, "wave.failed"))).toBe(false);
  });

  test("touches nothing when the archive lacks a file", () => {
    const dir = tempDir();
    const staged = join(dir, "staged");
    mkdirSync(staged);
    install(dir, { wave: "old wave", "wireguard-go": "old wg" });
    install(staged, { wave: "new wave" });
    expect(() => swapIn(dir, staged, updateFiles("linux"), "linux")).toThrow(/wireguard-go/);
    expect(readFileSync(join(dir, "wave"), "utf8")).toBe("old wave");
  });

  test("clears what is left once the update holds", () => {
    const dir = tempDir();
    install(dir, { wave: "new", "wave.old": "old", "wireguard-go.old": "old" });
    dropOld(dir, updateFiles("linux"));
    expect(existsSync(join(dir, "wave.old"))).toBe(false);
    expect(existsSync(join(dir, "wireguard-go.old"))).toBe(false);
    expect(existsSync(join(dir, "wave"))).toBe(true);
  });
});

describe("receiving an archive", () => {
  const archive = (content: string) => ({
    name: "wave-linux-amd64.tar.gz",
    platform: "linux-amd64",
    sha256: createHash("sha256").update(content).digest("hex"),
    size: content.length,
  });

  test("keeps what matches the manifest", async () => {
    const dest = join(tempDir(), "a.tar.gz");
    await receiveArchive(new Response("the bytes"), dest, archive("the bytes"));
    expect(readFileSync(dest, "utf8")).toBe("the bytes");
  });

  test("throws away what does not", async () => {
    const dest = join(tempDir(), "a.tar.gz");
    await expect(receiveArchive(new Response("the bytez"), dest, archive("the bytes"))).rejects.toThrow(
      /does not match/,
    );
    expect(existsSync(dest)).toBe(false);
  });

  test("stops as soon as there is more than the manifest names", async () => {
    const dest = join(tempDir(), "a.tar.gz");
    await expect(receiveArchive(new Response("x".repeat(100)), dest, archive("short"))).rejects.toThrow(
      /more than/,
    );
    expect(existsSync(dest)).toBe(false);
  });
});

describe("the update settings in the state file", () => {
  test("survive every write of the enrolments, and leave them alone in turn", async () => {
    const path = join(tempDir(), "state.json");
    await updateUpdateSettings(path, { channel: "insiders", autoUpdate: false });
    await saveProfiles(path, [profile("https://a")]);
    expect(await loadUpdateSettings(path)).toMatchObject({ channel: "insiders", autoUpdate: false });
    await updateUpdateSettings(path, { broken: ["0.2.0"] });
    expect((await loadProfiles(path)).map((p) => p.controlUrl)).toEqual(["https://a"]);
  });

  test("default to on and to whatever the servers say", async () => {
    const settings = await loadUpdateSettings(join(tempDir(), "missing.json"));
    expect(settings).toEqual({ channel: null, autoUpdate: true, pending: null, broken: [] });
  });
});

function profile(controlUrl: string): Profile {
  return {
    controlUrl,
    machineKey: generateKeyPair("ed25519"),
    nodeKey: generateKeyPair("x25519"),
    discoKey: generateKeyPair("x25519"),
    nodeId: "n_1",
    netmapPublicKey: null,
    interfaceName: "wave0",
    listenPort: 41641,
    autoStart: true,
    certs: [],
  };
}

describe("the updater", () => {
  /** An installation with a release archive for "0.2.0" ready to be served. */
  async function setup() {
    const root = tempDir();
    const installDir = join(root, "bin");
    mkdirSync(installDir);
    writeFileSync(join(installDir, "wave"), "wave 0.1.0");
    writeFileSync(join(installDir, "wireguard-go"), "wg 0.1.0");

    const content = join(root, "content");
    mkdirSync(content);
    writeFileSync(join(content, "wave"), "wave 0.2.0");
    writeFileSync(join(content, "wireguard-go"), "wg 0.2.0");
    writeFileSync(join(content, "LICENSE"), "licence");
    const archivePath = join(root, "wave-linux-amd64.tar.gz");
    const tar = Bun.spawnSync(["tar", "-czf", archivePath, "-C", content, "wave", "wireguard-go", "LICENSE"]);
    expect(tar.exitCode).toBe(0);
    const archive = readFileSync(archivePath);

    const requests: string[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (request) => {
        const url = new URL(request.url);
        requests.push(url.pathname);
        if (
          url.pathname === "/v1/update/0.2.0/wave-linux-amd64.tar.gz" &&
          request.headers.get("authorization")
        ) {
          return new Response(archive);
        }
        return new Response("no", { status: 404 });
      },
    });
    cleanup.push(() => server.stop(true));

    const controlUrl = `http://127.0.0.1:${server.port}`;
    const statePath = join(root, "state.json");
    await saveProfiles(statePath, [profile(controlUrl)]);
    return { root, installDir, controlUrl, statePath, release: signed("0.2.0", { archive }), requests };
  }

  function updater(
    env: Awaited<ReturnType<typeof setup>>,
    overrides: Partial<ConstructorParameters<typeof Updater>[0]> = {},
  ) {
    const exits: number[] = [];
    const logs: string[] = [];
    let shutdowns = 0;
    const instance = new Updater({
      statePath: env.statePath,
      log: (message) => logs.push(message),
      profile: async (url) => (await loadProfiles(env.statePath)).find((p) => p.controlUrl === url),
      shutdown: async () => {
        shutdowns++;
      },
      exit: (code) => exits.push(code),
      version: "0.1.0",
      platform: "linux-amd64",
      os: "linux",
      execPath: join(env.installDir, "wave"),
      installedPath: join(env.installDir, "wave"),
      compiled: true,
      trusted,
      maxDelayMs: 0,
      ...overrides,
    });
    return { instance, exits, logs, shutdowns: () => shutdowns };
  }

  /** Brings 0.2.0 in the way a device does: offered, then installed. */
  async function installed(env: Awaited<ReturnType<typeof setup>>, now?: () => Date) {
    const { instance } = updater(env, now ? { now } : {});
    await instance.init();
    instance.receive(env.controlUrl, offer(env.release));
    await instance.installNow();
    instance.stop();
  }

  test("installs an offer on demand: fetched, checked, swapped, restarted", async () => {
    const env = await setup();
    const { instance, exits, shutdowns } = updater(env, { maxDelayMs: 60 * 60 * 1000 });
    await instance.init();
    instance.receive(env.controlUrl, offer(env.release));
    expect(instance.status()).toMatchObject({ available: "0.2.0", state: "scheduled" });

    await instance.installNow();
    expect(readFileSync(join(env.installDir, "wave"), "utf8")).toBe("wave 0.2.0");
    expect(readFileSync(join(env.installDir, "wireguard-go"), "utf8")).toBe("wg 0.2.0");
    expect(readFileSync(join(env.installDir, "wave.old"), "utf8")).toBe("wave 0.1.0");
    // The licence comes in the archive but is nothing the binary runs.
    expect(existsSync(join(env.installDir, "LICENSE"))).toBe(false);
    expect((await loadUpdateSettings(env.statePath)).pending).toMatchObject({
      version: "0.2.0",
      from: "0.1.0",
    });
    expect(shutdowns()).toBe(1);
    expect(exits).toEqual([0]);
    instance.stop();
  });

  test("the new build stays once it reaches a control server", async () => {
    const env = await setup();
    await installed(env);

    const { instance, exits } = updater(env, { version: "0.2.0" });
    await instance.init();
    await instance.confirm();
    expect((await loadUpdateSettings(env.statePath)).pending).toBeNull();
    expect(existsSync(join(env.installDir, "wave.old"))).toBe(false);
    expect(readFileSync(join(env.installDir, "wave"), "utf8")).toBe("wave 0.2.0");
    expect(exits).toEqual([]);
    instance.stop();
  });

  test("a new build that never gets through is rolled back on its next start, and never taken again", async () => {
    const env = await setup();
    const t0 = new Date("2026-10-01T12:00:00Z");
    await installed(env, () => t0);

    // Restarted over and over, it finds the deadline passed on the clock.
    const late = new Date(t0.getTime() + 6 * 60 * 1000);
    const { instance, exits } = updater(env, { version: "0.2.0", now: () => late });
    await instance.init();
    expect(readFileSync(join(env.installDir, "wave"), "utf8")).toBe("wave 0.1.0");
    expect(readFileSync(join(env.installDir, "wireguard-go"), "utf8")).toBe("wg 0.1.0");
    expect(exits).toEqual([0]);
    const settings = await loadUpdateSettings(env.statePath);
    expect(settings.pending).toBeNull();
    expect(settings.broken).toEqual(["0.2.0"]);

    // Back on the old build, the same offer is refused.
    const old = updater(env);
    await old.instance.init();
    old.instance.receive(env.controlUrl, offer(env.release));
    expect(old.instance.status().available).toBeNull();
    expect(old.logs.join("\n")).toMatch(/rolled back once/);
    old.instance.stop();
  });

  test("the old build back after a failed trial marks the new one broken itself", async () => {
    // A restore the new build did not live to record -- or one done by hand.
    const env = await setup();
    await updateUpdateSettings(env.statePath, {
      pending: {
        version: "0.2.0",
        from: "0.1.0",
        startedAt: new Date().toISOString(),
        files: updateFiles("linux"),
        installDir: env.installDir,
      },
    });
    const { instance } = updater(env);
    await instance.init();
    const settings = await loadUpdateSettings(env.statePath);
    expect(settings.pending).toBeNull();
    expect(settings.broken).toEqual(["0.2.0"]);
  });

  test("with auto-update off it only says an update is there", async () => {
    const env = await setup();
    await updateUpdateSettings(env.statePath, { autoUpdate: false });
    const { instance, exits } = updater(env);
    await instance.init();
    instance.receive(env.controlUrl, offer(env.release));
    await Bun.sleep(20);
    expect(instance.status()).toMatchObject({ available: "0.2.0", state: "idle", autoUpdate: false });
    expect(exits).toEqual([]);
    instance.stop();
  });

  test("a development build never installs, and says why", async () => {
    const env = await setup();
    const { instance, exits } = updater(env, { compiled: false });
    await instance.init();
    instance.receive(env.controlUrl, offer(env.release));
    expect(await instance.installNow()).toMatch(/development build/);
    expect(instance.status().state).toBe("unavailable");
    expect(exits).toEqual([]);
  });

  test("a download that does not match leaves everything as it was", async () => {
    const env = await setup();
    const { instance, exits } = updater(env);
    await instance.init();
    instance.receive(env.controlUrl, offer(signed("0.2.0", { archive: Buffer.from("not this") })));
    expect(await instance.installNow()).toMatch(/failed/);
    expect(readFileSync(join(env.installDir, "wave"), "utf8")).toBe("wave 0.1.0");
    expect((await loadUpdateSettings(env.statePath)).pending).toBeNull();
    expect(existsSync(join(env.installDir, ".wave-update-0.2.0"))).toBe(false);
    expect(exits).toEqual([]);
  });

  test("says hello with its version and the device's wish", async () => {
    const env = await setup();
    await updateUpdateSettings(env.statePath, { channel: "insiders" });
    const { instance } = updater(env);
    await instance.init();
    expect(instance.hello()).toEqual({
      version: "0.1.0",
      platform: "linux-amd64",
      channel: "insiders",
      autoUpdate: true,
    });
    await instance.configure({ channel: null });
    expect(instance.hello().channel).toBeUndefined();
  });
});
