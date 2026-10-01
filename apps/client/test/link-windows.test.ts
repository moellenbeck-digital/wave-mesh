import { describe, expect, test } from "bun:test";
import type { CommandResult, CommandRunner } from "../src/link.ts";
import {
  parseAddresses,
  parseRouteDestinations,
  parseRoutes,
  psQuote,
  WindowsLink,
} from "../src/link-windows.ts";

/** A real `Get-NetIPAddress ... | ConvertTo-Json -Compress` on a live tunnel. */
const ADDRESSES =
  `[{"IPAddress":"fe80::e42a:1c7d:9b3f:2a01%14","PrefixLength":64},` +
  `{"IPAddress":"fd7a:1:2::2","PrefixLength":48},{"IPAddress":"10.77.0.2","PrefixLength":16}]`;

/**
 * A real `Get-NetRoute ... | ConvertTo-Json -Compress`. Windows derives most of
 * these from the addresses themselves and marks them Local; only NetMgmt ones
 * were put there by us.
 */
const ROUTES =
  `[{"DestinationPrefix":"10.77.0.0/16","Protocol":"NetMgmt"},` +
  `{"DestinationPrefix":"10.77.0.2/32","Protocol":"Local"},` +
  `{"DestinationPrefix":"255.255.255.255/32","Protocol":"Local"},` +
  `{"DestinationPrefix":"fd7a:1:2::/48","Protocol":"NetMgmt"},` +
  `{"DestinationPrefix":"ff00::/8","Protocol":"Local"}]`;

/** Matches on a fragment of the script, because the scripts are long. */
function fake(replies: Array<[string, CommandResult | string]> = []): {
  powershell: CommandRunner;
  scripts: string[];
} {
  const scripts: string[] = [];
  const powershell: CommandRunner = async (args) => {
    const script = args.join(" ");
    scripts.push(script);
    for (const [fragment, reply] of replies) {
      if (!script.includes(fragment)) continue;
      return typeof reply === "string" ? { code: 0, stdout: reply, stderr: "" } : reply;
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { powershell, scripts };
}

const HAS_NRPT: [string, string] = ["Get-Command Add-DnsClientNrptRule", "yes"];

describe("parseAddresses", () => {
  test("joins address and prefix, and drops the zone the kernel appends", () => {
    expect(parseAddresses(ADDRESSES)).toEqual([
      "fe80::e42a:1c7d:9b3f:2a01/64",
      "fd7a:1:2::2/48",
      "10.77.0.2/16",
    ]);
  });

  test("copes with the single result ConvertTo-Json does not wrap in an array", () => {
    expect(parseAddresses(`{"IPAddress":"10.77.0.2","PrefixLength":16}`)).toEqual(["10.77.0.2/16"]);
  });

  test("reads an interface with no addresses as none, not as a failure", () => {
    expect(parseAddresses("")).toEqual([]);
    expect(parseAddresses("null")).toEqual([]);
  });
});

describe("parseRoutes", () => {
  test("keeps only what we could have added", () => {
    // Deleting the on-link, host and multicast routes would break the adapter.
    expect(parseRoutes(ROUTES)).toEqual(["10.77.0.0/16", "fd7a:1:2::/48"]);
  });

  test("accepts the protocol as the number the CIM enum serialises to", () => {
    expect(parseRoutes(`[{"DestinationPrefix":"10.0.0.0/8","Protocol":3}]`)).toEqual(["10.0.0.0/8"]);
    expect(parseRoutes(`[{"DestinationPrefix":"10.0.0.0/8","Protocol":2}]`)).toEqual([]);
  });
});

describe("parseRouteDestinations", () => {
  test("keeps what the kernel derived too, because it still routes", () => {
    expect(parseRouteDestinations(ROUTES)).toEqual([
      "10.77.0.0/16",
      "10.77.0.2/32",
      "255.255.255.255/32",
      "fd7a:1:2::/48",
      "ff00::/8",
    ]);
  });
});

describe("psQuote", () => {
  test("doubles a quote rather than letting it end the string", () => {
    expect(psQuote("wave0")).toBe("'wave0'");
    expect(psQuote("it's")).toBe("'it''s'");
  });
});

describe("WindowsLink.syncAddresses", () => {
  test("adds what is missing and removes what is not wanted", async () => {
    const { powershell, scripts } = fake([["Get-NetIPAddress", ADDRESSES]]);
    const link = new WindowsLink({ powershell });

    const result = await link.syncAddresses("wave0", ["10.77.0.2/16", "fd7a:1:2::9/48"]);

    expect(result.added).toEqual(["fd7a:1:2::9/48"]);
    expect(result.removed).toEqual(["fd7a:1:2::2/48"]);
    expect(scripts.some((s) => s.includes("New-NetIPAddress") && s.includes("'fd7a:1:2::9'"))).toBe(true);
    expect(scripts.some((s) => s.includes("Remove-NetIPAddress") && s.includes("'fd7a:1:2::2'"))).toBe(true);
  });

  test("leaves the kernel's link-local address alone", async () => {
    const { powershell } = fake([["Get-NetIPAddress", ADDRESSES]]);
    const link = new WindowsLink({ powershell });

    const result = await link.syncAddresses("wave0", ["10.77.0.2/16", "fd7a:1:2::2/48"]);

    expect(result.removed).toEqual([]);
  });
});

describe("WindowsLink.syncRoutes", () => {
  test("adds a route on link, because a tunnel has no gateway", async () => {
    const { powershell, scripts } = fake([["Get-NetRoute", ROUTES]]);
    const link = new WindowsLink({ powershell });

    const result = await link.syncRoutes("wave0", ["10.77.0.0/16", "fd7a:1:2::/48", "10.88.0.0/16"]);

    expect(result.added).toEqual(["10.88.0.0/16"]);
    const added = scripts.find((s) => s.includes("New-NetRoute"));
    expect(added).toContain("'10.88.0.0/16'");
    expect(added).toContain("-NextHop '0.0.0.0'");
  });

  test("uses the unspecified v6 address as the next hop for a v6 route", async () => {
    const { powershell, scripts } = fake([["Get-NetRoute", "[]"]]);
    const link = new WindowsLink({ powershell });

    await link.syncRoutes("wave0", ["fd7a:1:2::/48"]);

    expect(scripts.find((s) => s.includes("New-NetRoute"))).toContain("-NextHop '::'");
  });

  test("adds nothing for a prefix the kernel already routes here", async () => {
    // New-NetRoute answers "Instance MSFT_NetRoute already exists" (Windows
    // system error 87) and -ErrorAction Stop turns that into a failed bring-up.
    // The host route Windows derives from our own address is such a prefix.
    const { powershell, scripts } = fake([["Get-NetRoute", ROUTES]]);
    const link = new WindowsLink({ powershell });

    const result = await link.syncRoutes("wave0", ["10.77.0.2/32"]);

    expect(result.added).toEqual([]);
    expect(scripts.some((s) => s.includes("New-NetRoute"))).toBe(false);
  });

  test("asks once for a prefix two peers name", async () => {
    const { powershell, scripts } = fake([["Get-NetRoute", "[]"]]);
    const link = new WindowsLink({ powershell });

    const result = await link.syncRoutes("wave0", ["10.88.0.0/16", "10.88.0.0/16"]);

    expect(result.added).toEqual(["10.88.0.0/16"]);
    expect(scripts.filter((s) => s.includes("New-NetRoute"))).toHaveLength(1);
  });

  test("guards the creation in the script, not only against the listing", async () => {
    // The listing and the creation run a moment apart; a route that appears in
    // between must not end the bring-up over a state we wanted anyway.
    const { powershell, scripts } = fake([["Get-NetRoute -InterfaceAlias 'wave0' -PolicyStore", "[]"]]);
    const link = new WindowsLink({ powershell });

    await link.syncRoutes("wave0", ["10.88.0.0/16"]);

    const added = scripts.find((s) => s.includes("New-NetRoute"));
    expect(added).toContain("if (-not (Get-NetRoute");
    expect(added).toContain(
      "-DestinationPrefix '10.88.0.0/16' -PolicyStore ActiveStore -ErrorAction SilentlyContinue",
    );
  });

  test("removes ours and never the kernel's", async () => {
    const { powershell, scripts } = fake([["Get-NetRoute", ROUTES]]);
    const link = new WindowsLink({ powershell });

    const result = await link.syncRoutes("wave0", ["10.77.0.0/16"]);

    expect(result.removed).toEqual(["fd7a:1:2::/48"]);
    const removals = scripts.filter((s) => s.includes("Remove-NetRoute"));
    expect(removals).toHaveLength(1);
    expect(removals[0]).toContain("'fd7a:1:2::/48'");
  });

  test("keeps every change out of the persistent store", async () => {
    // A route that survived a reboot would point at an adapter that does not
    // exist yet, and blackhole the wave until the tunnel came up.
    const { powershell, scripts } = fake([["Get-NetRoute", "[]"]]);
    const link = new WindowsLink({ powershell });

    await link.syncRoutes("wave0", ["10.77.0.0/16"]);

    expect(scripts.every((s) => s.includes("-PolicyStore ActiveStore"))).toBe(true);
  });
});

describe("WindowsLink.configureDns", () => {
  const settings = {
    resolver: "10.77.0.2",
    suffixes: ["rl.wave.internal", "corp.example.com"],
    search: "rl.wave.internal",
  };

  test("sends each suffix to our resolver and nothing else", async () => {
    const { powershell, scripts } = fake([HAS_NRPT]);
    const link = new WindowsLink({ powershell });

    const result = await link.configureDns("wave0", settings);

    expect(result).toEqual({ routed: true, searched: true });
    const rules = scripts.filter((s) => s.includes("Add-DnsClientNrptRule -Namespace"));
    expect(rules).toHaveLength(2);
    // The leading dot is what makes a namespace mean "and everything under it".
    expect(rules[0]).toContain("-Namespace '.rl.wave.internal'");
    expect(rules[1]).toContain("-Namespace '.corp.example.com'");
  });

  test("makes the wave's own zone a search domain, and only that one", async () => {
    const { powershell, scripts } = fake([HAS_NRPT]);
    const link = new WindowsLink({ powershell });

    await link.configureDns("wave0", settings);

    const suffix = scripts.filter((s) => s.includes("Set-DnsClient "));
    expect(suffix).toHaveLength(1);
    expect(suffix[0]).toContain("-ConnectionSpecificSuffix 'rl.wave.internal'");
    // Never the global list: that would change how bare names resolve outside.
    expect(scripts.every((s) => !s.includes("Set-DnsClientGlobalSetting"))).toBe(true);
  });

  test("declines rather than taking over the resolver when NRPT is missing", async () => {
    const { powershell, scripts } = fake();
    const link = new WindowsLink({ powershell });

    const result = await link.configureDns("wave0", settings);

    expect(result).toEqual({ routed: false, searched: false });
    expect(scripts.some((s) => s.includes("Add-DnsClientNrptRule -Namespace"))).toBe(false);
  });

  test("says routed but not searched when there is no zone of our own", async () => {
    const { powershell } = fake([HAS_NRPT]);
    const link = new WindowsLink({ powershell });

    const result = await link.configureDns("wave0", { ...settings, search: undefined });

    expect(result).toEqual({ routed: true, searched: false });
  });

  test("asks for nothing when nothing was asked of it", async () => {
    const { powershell, scripts } = fake([HAS_NRPT]);
    const link = new WindowsLink({ powershell });

    expect(await link.configureDns("wave0", { resolver: "10.77.0.2", suffixes: [] })).toEqual({
      routed: true,
      searched: true,
    });
    expect(scripts).toEqual([]);
  });
});

describe("WindowsLink.revertDns", () => {
  test("removes this interface's rules by the comment it wrote", async () => {
    const { powershell, scripts } = fake();
    const link = new WindowsLink({ powershell });

    await link.revertDns("wave0");

    // A second wave's rules carry a different comment and must survive.
    expect(scripts[0]).toContain("$_.Comment -eq 'wave:wave0'");
    expect(scripts[1]).toContain("-ConnectionSpecificSuffix ''");
  });
});

describe("WindowsLink.remove", () => {
  test("signals the process that owns the adapter, then drops the pid file", async () => {
    const killed: number[] = [];
    const removed: string[] = [];
    const link = new WindowsLink({
      powershell: fake().powershell,
      readPid: () => "4242",
      pidFile: () => "C:\\ProgramData\\wave\\run\\wave0.pid",
      kill: (pid) => killed.push(pid),
      removeFile: async (path) => {
        removed.push(path);
      },
    });

    await link.remove("wave0");

    expect(killed).toEqual([4242]);
    expect(removed).toEqual(["C:\\ProgramData\\wave\\run\\wave0.pid"]);
  });

  test("does nothing when no run of ours left a pid behind", async () => {
    const killed: number[] = [];
    const link = new WindowsLink({
      powershell: fake().powershell,
      readPid: () => null,
      kill: (pid) => killed.push(pid),
    });

    await link.remove("wave0");

    expect(killed).toEqual([]);
  });

  test("drops the pid file even when the process is already gone", async () => {
    // Windows reuses process ids, so one kept past the kill would eventually
    // name a stranger's process.
    const removed: string[] = [];
    const link = new WindowsLink({
      powershell: fake().powershell,
      readPid: () => "4242",
      pidFile: () => "run/wave0.pid",
      kill: () => {
        const error = new Error("no such process") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      },
      removeFile: async (path) => {
        removed.push(path);
      },
    });

    await link.remove("wave0");

    expect(removed).toEqual(["run/wave0.pid"]);
  });
});

describe("WindowsLink.resolverEndpoint", () => {
  test("puts the resolver on the tunnel address at 53", () => {
    // An NRPT rule names a server but has no field for a port, so a resolver
    // anywhere else would simply never be asked.
    const link = new WindowsLink({ powershell: fake().powershell });
    expect(link.resolverEndpoint("10.77.0.2", 0)).toEqual({ address: "10.77.0.2", port: 53 });
    expect(link.resolverEndpoint("10.88.0.2", 1)).toEqual({ address: "10.88.0.2", port: 53 });
  });
});
