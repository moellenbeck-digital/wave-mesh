import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, leafOf } from "@wave/crypto";
import { certPaths, dueCertificates, issueCertificate } from "../src/certs.ts";
import { loadProfiles, type Profile, saveProfiles } from "../src/state.ts";
import { type FakeControl, fakeControl } from "./fake-control.ts";

/**
 * The node's half of D7: a key that stays here, a request that goes out, and
 * two files that end up where a service can be pointed at them.
 */

const statePath = async (): Promise<string> =>
  join(await mkdtemp(join(tmpdir(), "wave-certs-")), "state.json");

function profileFor(controlUrl: string): Profile {
  return {
    autoStart: true,
    controlUrl,
    machineKey: generateKeyPair("ed25519"),
    nodeKey: generateKeyPair("x25519"),
    discoKey: generateKeyPair("x25519"),
    nodeId: "n_1",
    netmapPublicKey: null,
    id: null,
    label: null,
    interfaceName: "wave0",
    listenPort: 41641,
    certs: [],
  };
}

let running: FakeControl | undefined;
afterEach(() => {
  running?.stop();
  running = undefined;
});

describe("where a certificate lands", () => {
  test("beside the state file, one directory per name", () => {
    const paths = certPaths("/var/lib/wave/state.json", "laptop.wave.example.com");
    expect(paths.keyPath).toBe("/var/lib/wave/certs/laptop.wave.example.com/key.pem");
    expect(paths.chainPath).toBe("/var/lib/wave/certs/laptop.wave.example.com/fullchain.pem");
  });
});

describe("asking for one", () => {
  test("writes the chain, keeps the key private and remembers the dates", async () => {
    running = fakeControl();
    const path = await statePath();
    const profile = profileFor(running.url);
    await saveProfiles(path, [profile]);

    const result = await issueCertificate({
      statePath: path,
      profile,
      names: ["laptop.wave.example.com"],
    });
    if (!("issued" in result)) throw new Error("the fake server does not ask for a record");
    const issued = result.issued;

    expect(running.ordered).toEqual([["laptop.wave.example.com"]]);
    expect(leafOf(await readFile(issued.chainPath, "utf8")).names).toEqual(["laptop.wave.example.com"]);
    // The key is the one thing here that must never be readable by anyone else.
    expect((await stat(issued.keyPath)).mode & 0o777).toBe(0o600);
    expect((await readFile(issued.keyPath, "utf8")).startsWith("-----BEGIN PRIVATE KEY-----")).toBe(true);

    const [stored] = await loadProfiles(path);
    expect(stored?.certs).toHaveLength(1);
    expect(stored?.certs[0]?.name).toBe("laptop.wave.example.com");
    expect(Date.parse(stored?.certs[0]?.renewAt ?? "")).toBeGreaterThan(Date.now());
  });

  // A renewal must not reuse the key: the point of certificates this cheap is
  // that nothing on disk has to live for years.
  test("a renewal gets a new key", async () => {
    running = fakeControl();
    const path = await statePath();
    const profile = profileFor(running.url);
    await saveProfiles(path, [profile]);

    const first = await issueCertificate({ statePath: path, profile, names: ["laptop.wave.example.com"] });
    if (!("issued" in first)) throw new Error("the fake server does not ask for a record");
    const firstKey = await readFile(first.issued.keyPath, "utf8");
    await issueCertificate({ statePath: path, profile, names: ["laptop.wave.example.com"] });

    expect(await readFile(first.issued.keyPath, "utf8")).not.toBe(firstKey);
    // Still one record, not two -- the same name was renewed, not added.
    expect((await loadProfiles(path))[0]?.certs).toHaveLength(1);
  });

  test("without a name it takes this device's own, from the netmap", async () => {
    const netmapKey = generateKeyPair("ed25519");
    running = fakeControl({ netmapKey, dnsName: "renamed-2.wave.example.com" });
    const path = await statePath();
    const profile = { ...profileFor(running.url), netmapPublicKey: netmapKey.publicKey };
    await saveProfiles(path, [profile]);

    const result = await issueCertificate({ statePath: path, profile });
    expect("issued" in result && result.issued.name).toBe("renamed-2.wave.example.com");
  });

  test("a refusal from the server comes back as an error, not a file", async () => {
    running = fakeControl();
    running.failWith = "laptop.wave.example.com does not belong to this device";
    const path = await statePath();
    const profile = profileFor(running.url);
    await saveProfiles(path, [profile]);

    await expect(
      issueCertificate({ statePath: path, profile, names: ["laptop.wave.example.com"] }),
    ).rejects.toThrow(/does not belong/);
    expect((await loadProfiles(path))[0]?.certs).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("the hook runs once the files are there", async () => {
    running = fakeControl();
    const path = await statePath();
    const profile = profileFor(running.url);
    await saveProfiles(path, [profile]);
    const marker = join(await mkdtemp(join(tmpdir(), "wave-hook-")), "reloaded");

    await issueCertificate({
      statePath: path,
      profile,
      names: ["laptop.wave.example.com"],
      // The hook is handed the paths, which is what a reload command needs.
      hook: `cp "$WAVE_CERT" ${marker}`,
    });

    expect(leafOf(await readFile(marker, "utf8")).names).toEqual(["laptop.wave.example.com"]);
    expect((await loadProfiles(path))[0]?.certs[0]?.hook).toContain("WAVE_CERT");
  });
});

describe("the wave's wildcard", () => {
  test("asks for *.<suffix> and the zone's own name, from the netmap", async () => {
    const netmapKey = generateKeyPair("ed25519");
    running = fakeControl({ netmapKey });
    const path = await statePath();
    const profile = { ...profileFor(running.url), netmapPublicKey: netmapKey.publicKey };
    await saveProfiles(path, [profile]);

    const result = await issueCertificate({ statePath: path, profile, wildcard: true });
    if (!("issued" in result)) throw new Error("the fake server does not ask for a record");

    expect(running.ordered).toEqual([["*.wave.example.com", "wave.example.com"]]);
    // An asterisk is a legal unix filename and an illegal Windows one, and a
    // directory named like a glob is a trap for everything that touches it.
    expect(result.issued.chainPath).toContain("certs/wildcard.wave.example.com/");
    expect((await loadProfiles(path))[0]?.certs[0]?.names).toEqual([
      "*.wave.example.com",
      "wave.example.com",
    ]);
  });
});

describe("when the record has to be made by hand", () => {
  const record = { name: "_acme-challenge.laptop.wave.example.com", value: "the-value" };

  test("comes back with the record instead of a certificate", async () => {
    running = fakeControl();
    running.waitingFor = record;
    const path = await statePath();
    const profile = profileFor(running.url);
    await saveProfiles(path, [profile]);

    const result = await issueCertificate({
      statePath: path,
      profile,
      names: ["laptop.wave.example.com"],
      sleep: async () => {},
    });

    expect(result).toEqual({ waiting: [record], name: "laptop.wave.example.com" });
    // Nothing is remembered and nothing is written: there is no certificate.
    expect((await loadProfiles(path))[0]?.certs).toEqual([]);
    expect(existsSync(certPaths(path, "laptop.wave.example.com").keyPath)).toBe(false);
  });

  test("asking again once it exists finishes the job", async () => {
    running = fakeControl();
    running.waitingFor = record;
    const path = await statePath();
    const profile = profileFor(running.url);
    await saveProfiles(path, [profile]);

    await issueCertificate({ statePath: path, profile, names: ["laptop.wave.example.com"] });
    running.waitingFor = undefined;
    const result = await issueCertificate({ statePath: path, profile, names: ["laptop.wave.example.com"] });

    expect("issued" in result).toBe(true);
    expect((await loadProfiles(path))[0]?.certs).toHaveLength(1);
  });
});

describe("when to renew", () => {
  const record = (renewAt: string) => ({
    name: "a.example",
    names: ["a.example"],
    renewAt,
    notAfter: renewAt,
    hook: null,
  });
  const withCerts = (certs: ReturnType<typeof record>[]): Profile => ({
    ...profileFor("http://control.example"),
    certs,
  });

  test("only what has reached its date", () => {
    const now = new Date("2026-09-18T00:00:00Z");
    const due = dueCertificates(
      withCerts([record("2026-09-17T00:00:00Z"), record("2026-09-19T00:00:00Z")]),
      now,
    );
    expect(due).toHaveLength(1);
    expect(due[0]?.renewAt).toBe("2026-09-17T00:00:00Z");
  });

  // A date nobody can read is one nobody would ever act on, so it counts as due.
  test("an unreadable date counts as due", () => {
    expect(dueCertificates(withCerts([record("whenever")]), new Date())).toHaveLength(1);
  });
});
