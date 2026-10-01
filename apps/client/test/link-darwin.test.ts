import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandResult, CommandRunner } from "../src/link.ts";
import { DarwinLink, expandDestination, parseAddresses, parseRoutes } from "../src/link-darwin.ts";

/** A real `ifconfig utun6` on a machine where another VPN is up. */
const IFCONFIG_OUTPUT = `utun6: flags=8051<UP,POINTOPOINT,RUNNING,MULTICAST> mtu 1280
	options=6460<TSO4,TSO6,CHANNEL_IO,PARTIAL_CSUM,ZEROINVERT_CSUM>
	inet6 fe80::5450:b0d8:388:4144%utun6 prefixlen 64 scopeid 0x1f
	inet 100.98.70.23 --> 100.98.70.23 netmask 0xffffffff
	inet6 fd7a:115c:a1e0::ca01:4619 prefixlen 48
	nd6 options=201<PERFORMNUD,DAD>`;

/** A real `netstat -rn -f inet`, trimmed to one interface. */
const NETSTAT_INET = `Routing tables

Internet:
Destination        Gateway            Flags               Netif Expire
default            link#31            UCSIg               utun6
100.64/10          link#31            UCS                 utun6
100.98.70.23       100.98.70.23       UH                  utun6
100.100.100.100/32 link#31            UCS                 utun6
100.120.71.42      link#31            UHWIi               utun6
224.0.0/4          link#31            UmCSI               utun6
255.255.255.255/32 link#31            UCSI                utun6
10.0.0.0/24        link#4             UCS                 en0`;

const NETSTAT_INET6 = `Routing tables

Internet6:
Destination                             Gateway                        Flags     Netif Expire
fd7a:115c:a1e0::/48                     fe80::5450:b0d8:388:4144%utun6 Uc        utun6
fd7a:115c:a1e0::53/128                  link#31                        UCS       utun6
fe80::%utun6/64                         fe80::5450:b0d8:388:4144%utun6 UcI       utun6`;

function fake(results: Record<string, CommandResult | string> = {}): {
  run: CommandRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  const run: CommandRunner = async (args) => {
    calls.push(args);
    const result = results[args.join(" ")];
    if (typeof result === "string") return { code: 0, stdout: result, stderr: "" };
    return result ?? { code: 0, stdout: "", stderr: "" };
  };
  return { run, calls };
}

describe("parseAddresses", () => {
  test("turns the hex netmask into a prefix and drops the scope suffix", () => {
    expect(parseAddresses(IFCONFIG_OUTPUT)).toEqual([
      "fe80::5450:b0d8:388:4144/64",
      "100.98.70.23/32",
      "fd7a:115c:a1e0::ca01:4619/48",
    ]);
  });

  test("reads a prefix shorter than a host route", () => {
    expect(parseAddresses("\tinet 10.0.0.1 --> 10.0.0.1 netmask 0xffffff00")).toEqual(["10.0.0.1/24"]);
  });
});

describe("expandDestination", () => {
  test("fills in the octets netstat left out", () => {
    expect(expandDestination("100.64/10")).toBe("100.64.0.0/10");
    expect(expandDestination("100.64.0.2")).toBe("100.64.0.2");
    expect(expandDestination("fd7a::2/128")).toBe("fd7a::2/128");
  });
});

describe("parseRoutes", () => {
  test("keeps only the static routes on our interface", () => {
    // The kernel's own entries -- the host route to ourselves (UH), the cloned
    // neighbour (UHWIi), multicast (UmCSI), broadcast (UCSI) -- must survive.
    expect(parseRoutes(NETSTAT_INET, "utun6")).toEqual(["100.64.0.0/10", "100.100.100.100/32"]);
  });

  test("ignores another interface's routes", () => {
    expect(parseRoutes(NETSTAT_INET, "en0")).toEqual(["10.0.0.0/24"]);
  });

  test("leaves the address's own network and link-local alone", () => {
    expect(parseRoutes(NETSTAT_INET6, "utun6")).toEqual(["fd7a:115c:a1e0::53/128"]);
  });
});

describe("DarwinLink.syncAddresses", () => {
  test("spells out the peer address, because utun is point-to-point", async () => {
    const ifconfig = fake();
    const link = new DarwinLink({ ifconfig: ifconfig.run });
    const result = await link.syncAddresses("utun7", ["100.64.0.1/32", "fd7a:1:2::1/128"]);

    expect(result.added).toEqual(["100.64.0.1/32", "fd7a:1:2::1/128"]);
    expect(ifconfig.calls).toContainEqual(["utun7", "inet", "100.64.0.1/32", "100.64.0.1", "alias"]);
    expect(ifconfig.calls).toContainEqual(["utun7", "inet6", "fd7a:1:2::1/128", "alias"]);
  });

  test("leaves the link-local address alone and removes what the netmap dropped", async () => {
    const ifconfig = fake({ utun7: IFCONFIG_OUTPUT });
    const result = await new DarwinLink({ ifconfig: ifconfig.run }).syncAddresses("utun7", []);

    expect(result.removed).toEqual(["100.98.70.23/32", "fd7a:115c:a1e0::ca01:4619/48"]);
    expect(ifconfig.calls).toContainEqual(["utun7", "inet", "100.98.70.23", "-alias"]);
    expect(ifconfig.calls).not.toContainEqual(["utun7", "inet6", "fe80::5450:b0d8:388:4144", "-alias"]);
  });
});

describe("DarwinLink.syncRoutes", () => {
  test("adds a route per family", async () => {
    const route = fake();
    const link = new DarwinLink({ route: route.run, netstat: fake().run });
    const result = await link.syncRoutes("utun7", ["100.64.0.2/32", "fd7a:1:2::2/128"]);

    expect(result.added).toEqual(["100.64.0.2/32", "fd7a:1:2::2/128"]);
    expect(route.calls).toContainEqual(["-q", "-n", "add", "-inet", "100.64.0.2/32", "-interface", "utun7"]);
    expect(route.calls).toContainEqual([
      "-q",
      "-n",
      "add",
      "-inet6",
      "fd7a:1:2::2/128",
      "-interface",
      "utun7",
    ]);
  });

  test("repoints a route another interface already holds", async () => {
    const route = fake({
      "-q -n add -inet 100.64.0.2/32 -interface utun7": {
        code: 1,
        stdout: "",
        stderr: "route: writing to routing socket: File exists",
      },
    });
    const link = new DarwinLink({ route: route.run, netstat: fake().run });
    const result = await link.syncRoutes("utun7", ["100.64.0.2/32"]);

    expect(result.added).toEqual([]);
    expect(route.calls).toContainEqual([
      "-q",
      "-n",
      "change",
      "-inet",
      "100.64.0.2/32",
      "-interface",
      "utun7",
    ]);
  });

  test("removes a route the netmap no longer asks for, but nothing the kernel owns", async () => {
    const route = fake();
    const netstat = fake({ "-rn -f inet": NETSTAT_INET, "-rn -f inet6": NETSTAT_INET6 });
    const link = new DarwinLink({ route: route.run, netstat: netstat.run });
    const result = await link.syncRoutes("utun6", ["100.100.100.100/32"]);

    expect(result.removed).toEqual(["100.64.0.0/10", "fd7a:115c:a1e0::53/128"]);
    expect(route.calls).toContainEqual([
      "-q",
      "-n",
      "delete",
      "-inet",
      "100.64.0.0/10",
      "-interface",
      "utun6",
    ]);
    expect(route.calls.some((call) => call.includes("100.98.70.23"))).toBe(false);
    expect(route.calls.some((call) => call.includes("224.0.0/4"))).toBe(false);
  });

  test("reports a route that failed for any other reason", async () => {
    const route = fake({
      "-q -n add -inet 100.64.0.2/32 -interface utun7": {
        code: 1,
        stdout: "",
        stderr: "route: writing to routing socket: Network is unreachable",
      },
    });
    const link = new DarwinLink({ route: route.run, netstat: fake().run });
    expect(link.syncRoutes("utun7", ["100.64.0.2/32"])).rejects.toThrow(/Network is unreachable/);
  });
});

describe("DarwinLink.remove", () => {
  test("signals the wireguard-go process that owns the interface", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-pid-"));
    writeFileSync(join(dir, "utun7.pid"), "4242\n");
    const killed: number[] = [];
    const link = new DarwinLink({ kill: (pid) => killed.push(pid), pidFile: () => join(dir, "utun7.pid") });

    await link.remove("utun7");
    expect(killed).toEqual([4242]);
  });

  test("takes the pid file with it, so a recycled pid is never signalled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-pid-"));
    const path = join(dir, "utun7.pid");
    writeFileSync(path, "4242\n");
    const link = new DarwinLink({ kill: () => {}, pidFile: () => path });

    await link.remove("utun7");
    expect(existsSync(path)).toBe(false);
  });

  test("does nothing when no process of ours is running", async () => {
    const dir = mkdtempSync(join(tmpdir(), "wave-pid-"));
    const killed: number[] = [];
    const link = new DarwinLink({ kill: (pid) => killed.push(pid), pidFile: () => join(dir, "missing.pid") });

    await link.remove("utun7");
    expect(killed).toEqual([]);
  });
});
