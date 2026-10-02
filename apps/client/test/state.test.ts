import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { englishText } from "@wave/ipc";
import {
  ambiguity,
  defaultStatePath,
  ensureProfile,
  loadProfiles,
  matchProfiles,
  normaliseControlUrl,
  saveProfiles,
} from "../src/state.ts";

const statePath = async () => join(await mkdtemp(join(tmpdir(), "wave-state-")), "state.json");

describe("node state", () => {
  test("creates three key pairs on first use", async () => {
    const path = await statePath();
    const state = await ensureProfile(path, "http://control.example");
    expect(state.machineKey.publicKey).toHaveLength(44);
    expect(state.nodeKey.privateKey).not.toBe(state.discoKey.privateKey);
    expect(state.nodeId).toBeNull();
  });

  test("keeps the keys on later runs", async () => {
    const path = await statePath();
    const first = await ensureProfile(path, "http://control.example");
    const second = await ensureProfile(path, "http://control.example");
    expect(second.machineKey.privateKey).toBe(first.machineKey.privateKey);
  });

  test("is written so that only its owner can read it", async () => {
    const path = await statePath();
    await ensureProfile(path, "http://control.example");
    expect((await Bun.file(path).stat()).mode & 0o777).toBe(0o600);
  });

  test("a different address is a different wave, not the same one moved", async () => {
    const path = await statePath();
    const first = await ensureProfile(path, "http://100.64.0.1:8080");
    const second = await ensureProfile(path, "http://203.0.113.9:8080");

    // The control server is what tells two enrolments apart. There is no
    // second name, so nothing can claim one address is "really" the other.
    expect(second.controlUrl).not.toBe(first.controlUrl);
    expect(second.machineKey.privateKey).not.toBe(first.machineKey.privateKey);
    // Separate interfaces and ports, or the second tunnel would take the first's.
    expect(second.interfaceName).not.toBe(first.interfaceName);
    expect(second.listenPort).not.toBe(first.listenPort);
    expect(await loadProfiles(path)).toHaveLength(2);
  });

  test("logging in again with the same URL finds the enrolment that is there", async () => {
    const path = await statePath();
    const first = await ensureProfile(path, "http://100.64.0.1:8080");
    const again = await ensureProfile(path, "http://100.64.0.1:8080");

    expect(again.controlUrl).toBe(first.controlUrl);
    expect(again.machineKey.privateKey).toBe(first.machineKey.privateKey);
    expect(await loadProfiles(path)).toHaveLength(1);
  });

  test("a bare host becomes a URL rather than an enrolment that can never come up", async () => {
    // What `wave profiles` prints is the bare host, so that is what gets typed
    // back into `wave login`. Stored verbatim it took an interface slot and
    // failed with "Invalid URL" for good.
    expect(normaliseControlUrl("wave-mesh-1.robin-lenz.de")).toBe("https://wave-mesh-1.robin-lenz.de");
    expect(normaliseControlUrl("control.example:8080")).toBe("https://control.example:8080");
    expect(normaliseControlUrl("http://localhost:8080")).toBe("http://localhost:8080");
    // The control server strips the trailing slash too, so one server typed
    // two ways stays one enrolment.
    expect(normaliseControlUrl("https://c.example/")).toBe("https://c.example");
  });

  test("refuses what is not an address at all", async () => {
    expect(normaliseControlUrl("")).toBeNull();
    expect(normaliseControlUrl("   ")).toBeNull();
    expect(normaliseControlUrl("ftp://c.example")).toBeNull();
    expect(normaliseControlUrl("http://")).toBeNull();
  });

  test("takes the short label that `wave profiles` prints, not just the full URL", async () => {
    const path = await statePath();
    await ensureProfile(path, "https://wave-mesh-2.robin-lenz.de");
    const profiles = await loadProfiles(path);

    // Rejecting the very string we just printed would be its own kind of bug.
    expect(matchProfiles(profiles, "wave-mesh-2.robin-lenz.de")).toHaveLength(1);
    expect(matchProfiles(profiles, "https://wave-mesh-2.robin-lenz.de")).toHaveLength(1);
    expect(matchProfiles(profiles, "nowhere.example")).toHaveLength(0);
  });

  test("refuses to guess between two waves on the same host", async () => {
    const path = await statePath();
    await ensureProfile(path, "http://control.example:8080");
    await ensureProfile(path, "http://control.example:9090");
    const profiles = await loadProfiles(path);

    // The bare host fits both -- picking one would tear down the wrong tunnel.
    expect(matchProfiles(profiles, "control.example")).toHaveLength(2);
    expect(englishText(ambiguity("control.example", profiles))).toContain("name the full address");
    // With the port it is unambiguous again.
    expect(matchProfiles(profiles, "control.example:9090")).toEqual([
      expect.objectContaining({ controlUrl: "http://control.example:9090" }),
    ]);
  });

  test("never writes a private key into the file in the clear twice over", async () => {
    const path = await statePath();
    const state = await ensureProfile(path, "http://control.example");
    const raw = await readFile(path, "utf8");
    expect(raw.split(state.machineKey.privateKey)).toHaveLength(2);
  });
});

describe("several enrolments side by side", () => {
  test("each gets its own keys, interface and port", async () => {
    const path = await statePath();
    const first = await ensureProfile(path, "http://a.example");
    const second = await ensureProfile(path, "http://b.example");

    expect(second.machineKey.privateKey).not.toBe(first.machineKey.privateKey);
    expect([first.interfaceName, second.interfaceName]).toEqual(["wave0", "wave1"]);
    // One UDP port each: two waves cannot share a socket.
    expect([first.listenPort, second.listenPort]).toEqual([41641, 41642]);
  });

  test("the same host on two ports is two waves", async () => {
    const path = await statePath();
    const a = await ensureProfile(path, "http://control.example:8080");
    const b = await ensureProfile(path, "http://control.example:9090");

    // The whole URL is the identity, not the host it happens to display as.
    expect(b.machineKey.privateKey).not.toBe(a.machineKey.privateKey);
    expect(await loadProfiles(path)).toHaveLength(2);
  });

  test("each enrolment is found again by its own server", async () => {
    const path = await statePath();
    const a = await ensureProfile(path, "http://a.example");
    const b = await ensureProfile(path, "http://b.example");

    expect((await ensureProfile(path, "http://a.example")).machineKey.privateKey).toBe(
      a.machineKey.privateKey,
    );
    expect((await ensureProfile(path, "http://b.example")).machineKey.privateKey).toBe(
      b.machineKey.privateKey,
    );
    expect(await loadProfiles(path)).toHaveLength(2);
  });

  test("reads the single-enrolment file that came before", async () => {
    const path = await statePath();
    const legacy = {
      controlUrl: "http://old.example",
      machineKey: { publicKey: "mpub", privateKey: "mpriv" },
      nodeKey: { publicKey: "npub", privateKey: "npriv" },
      discoKey: { publicKey: "dpub", privateKey: "dpriv" },
      nodeId: "n_1",
      netmapPublicKey: "pinned",
      interfaceName: "wave0",
      listenPort: 41641,
    };
    await Bun.write(path, JSON.stringify(legacy));

    const profiles = await loadProfiles(path);
    expect(profiles).toHaveLength(1);
    // The keys survive, so an existing device does not have to enrol again.
    expect(profiles[0]?.machineKey.privateKey).toBe("mpriv");
    expect(profiles[0]?.nodeId).toBe("n_1");
    expect(profiles[0]?.controlUrl).toBe("http://old.example");
  });

  test("the next profile does not take an interface the old file already holds", async () => {
    const path = await statePath();
    await saveProfiles(path, [
      {
        autoStart: true,
        controlUrl: "http://old.example",
        machineKey: { publicKey: "a", privateKey: "b" },
        nodeKey: { publicKey: "c", privateKey: "d" },
        discoKey: { publicKey: "e", privateKey: "f" },
        nodeId: null,
        netmapPublicKey: null,
        interfaceName: "wave0",
        listenPort: 41641,
        certs: [],
      },
    ]);
    const next = await ensureProfile(path, "http://new.example");
    expect(next.interfaceName).toBe("wave1");
    expect(next.listenPort).toBe(41642);
  });
});

describe("where the state lives", () => {
  test("uses a system-wide place when running privileged", () => {
    expect(defaultStatePath("linux", {}, true)).toBe("/var/lib/wave/state.json");
    expect(defaultStatePath("darwin", {}, true)).toBe("/Library/Application Support/wave/state.json");
    expect(defaultStatePath("win32", { PROGRAMDATA: "C:\\ProgramData" }, true)).toBe(
      ["C:\\ProgramData", "wave", "state.json"].join(sep),
    );
  });

  test("keeps out of the way when running as a user", () => {
    expect(defaultStatePath("linux", { XDG_STATE_HOME: "/home/x/.local/state" }, false)).toBe(
      "/home/x/.local/state/wave/state.json",
    );
  });
});
