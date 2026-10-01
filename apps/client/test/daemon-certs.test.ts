import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair } from "@wave/crypto";
import { Daemon } from "../src/daemon.ts";
import { loadProfiles, type Profile, saveProfiles } from "../src/state.ts";
import { type FakeControl, fakeControl } from "./fake-control.ts";

/**
 * Renewal is the half of D7 nobody runs: a service that stops serving HTTPS
 * after ninety days because no one typed anything is the failure the first
 * issuance being a command is meant to be traded against.
 */

let control: FakeControl | undefined;
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
  control?.stop();
  control = undefined;
});

const YESTERDAY = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
const NEXT_MONTH = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

async function daemonWith(certs: Profile["certs"], log: (message: string) => void = () => {}) {
  control = fakeControl();
  const dir = await mkdtemp(join(tmpdir(), "wave-daemon-certs-"));
  const statePath = join(dir, "state.json");
  await saveProfiles(statePath, [
    {
      autoStart: true,
      controlUrl: control.url,
      machineKey: generateKeyPair("ed25519"),
      nodeKey: generateKeyPair("x25519"),
      discoKey: generateKeyPair("x25519"),
      nodeId: "n_1",
      netmapPublicKey: null,
      interfaceName: "wave0",
      listenPort: 41641,
      certs,
    },
  ]);
  const daemon = new Daemon({ statePath, log });
  cleanup.push(() => daemon.stop());
  return { daemon, statePath, control };
}

describe("renewing on its own", () => {
  test("a certificate past its date is renewed and the date moves on", async () => {
    const {
      daemon,
      statePath,
      control: server,
    } = await daemonWith([
      { name: "laptop.wave.example.com", names: [], renewAt: YESTERDAY, notAfter: YESTERDAY, hook: null },
    ]);

    await daemon.renewDue();

    expect(server.ordered).toEqual([["laptop.wave.example.com"]]);
    const renewed = (await loadProfiles(statePath))[0]?.certs[0];
    expect(Date.parse(renewed?.renewAt ?? "")).toBeGreaterThan(Date.now());
  });

  test("one that is not due yet is left alone", async () => {
    const { daemon, control: server } = await daemonWith([
      { name: "laptop.wave.example.com", names: [], renewAt: NEXT_MONTH, notAfter: NEXT_MONTH, hook: null },
    ]);

    await daemon.renewDue();
    expect(server.ordered).toEqual([]);
  });

  // The date stays in the past when it fails, so the next round tries again --
  // and the failure must not take the daemon or the other waves with it.
  test("a refusal is survived and tried again next time", async () => {
    const {
      daemon,
      statePath,
      control: server,
    } = await daemonWith([
      { name: "laptop.wave.example.com", names: [], renewAt: YESTERDAY, notAfter: YESTERDAY, hook: null },
    ]);
    server.failWith = "the wave has no DNS credential";

    await daemon.renewDue();
    expect((await loadProfiles(statePath))[0]?.certs[0]?.renewAt).toBe(YESTERDAY);

    server.failWith = undefined;
    await daemon.renewDue();
    expect(Date.parse((await loadProfiles(statePath))[0]?.certs[0]?.renewAt ?? "")).toBeGreaterThan(
      Date.now(),
    );
  });
});

describe("asking for one through the daemon", () => {
  test("issues it and reports where the files are", async () => {
    const { daemon, statePath } = await daemonWith([]);
    const result = await daemon.cert(undefined, ["laptop.wave.example.com"], "true");
    if (typeof result === "string") throw new Error(result);
    if ("waiting" in result) throw new Error("the fake server does not ask for a record");

    expect(result[0]?.name).toBe("laptop.wave.example.com");
    expect(result[0]?.chainPath).toBe(
      join(statePath, "..", "certs", "laptop.wave.example.com", "fullchain.pem"),
    );
    expect(await daemon.certs()).toHaveLength(1);
  });

  // Unattended renewal cannot wait for a person, so it says what is needed and
  // leaves the date where it is -- the next round asks again.
  test("a record that has to be made by hand is reported, not waited on", async () => {
    const lines: string[] = [];
    const {
      daemon,
      statePath,
      control: server,
    } = await daemonWith(
      [{ name: "laptop.wave.example.com", names: [], renewAt: YESTERDAY, notAfter: YESTERDAY, hook: null }],
      (message) => lines.push(message),
    );
    server.waitingFor = { name: "_acme-challenge.laptop.wave.example.com", value: "the-value" };

    await daemon.renewDue();

    expect(lines.join("\n")).toContain("_acme-challenge.laptop.wave.example.com = the-value");
    expect((await loadProfiles(statePath))[0]?.certs[0]?.renewAt).toBe(YESTERDAY);
  });

  // The wildcard sends no names -- they come from the netmap -- so an empty
  // list must not turn into an empty sentence when something goes wrong.
  test("a refusal says what was asked for, even when nothing was named", async () => {
    const { daemon } = await daemonWith([]);

    // Whatever goes wrong -- a refusal from the server, a wave that has never
    // been up -- the sentence has to name its subject. It used to read
    // "no certificate for : ..." because an empty list is not a missing one.
    const result = await daemon.cert(undefined, undefined, undefined, true);
    expect(result).toStartWith("no certificate for the wave's wildcard: ");
  });

  test("a wave this device is not in is named, not guessed", async () => {
    const { daemon } = await daemonWith([]);
    const result = await daemon.cert("nowhere.example", ["laptop.wave.example.com"]);
    expect(result).toContain("not in a wave at nowhere.example");
  });
});
