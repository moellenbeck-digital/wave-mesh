import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { FilterRule } from "@wave/proto";
import { spawnWithInputFile, unenforcedFilter } from "../src/link.ts";
import { DarwinLink } from "../src/link-darwin.ts";
import { LinuxLink } from "../src/link-linux.ts";
import { WindowsLink } from "../src/link-windows.ts";
import {
  complementAddresses,
  complementPorts,
  nftFilterRuleset,
  pfAnchorName,
  pfAnchorRules,
  windowsFirewallScript,
} from "../src/packet-filter.ts";

/**
 * The port half of a wave's policy on Linux. The document is checked as text
 * here; that nft really takes it was checked against a real nft in a user
 * namespace, and the e2e test drives it end to end.
 */

const nas: FilterRule = {
  src: ["10.64.0.1/32", "fd7a::1/128"],
  dst: ["10.64.0.3/32", "fd7a::3/128"],
  ports: [
    { proto: "tcp", from: 445, to: 445 },
    { proto: "any", from: 5000, to: 5001 },
  ],
};

describe("the nftables document", () => {
  test("lets in what a rule names, per family and protocol, and drops the rest", () => {
    const text = nftFilterRuleset("wave0", [nas]);
    expect(text).toContain(
      "ip saddr { 10.64.0.1/32 } ip daddr { 10.64.0.3/32 } tcp dport { 445, 5000-5001 } accept",
    );
    // `any` opens UDP too; tcp:445 does not.
    expect(text).toContain(
      "ip saddr { 10.64.0.1/32 } ip daddr { 10.64.0.3/32 } udp dport { 5000-5001 } accept",
    );
    expect(text).toContain(
      "ip6 saddr { fd7a::1/128 } ip6 daddr { fd7a::3/128 } tcp dport { 445, 5000-5001 } accept",
    );
    expect(text.trim().split("\n").at(-3)?.trim()).toBe("drop");
  });

  test("only on its own interface, before the connector's dstnat", () => {
    const text = nftFilterRuleset("wave1", []);
    expect(text).toContain('iifname "wave1" jump rules');
    expect(text).toContain("type filter hook prerouting priority -150; policy accept;");
  });

  test("an empty policy still lets replies and ICMP through", () => {
    const text = nftFilterRuleset("wave0", []);
    expect(text).toContain("ct state established,related accept");
    expect(text).toContain("meta l4proto { icmp, ipv6-icmp } accept");
    expect(text).not.toContain("dport");
  });

  test("no policy only takes away what an earlier one left", () => {
    expect(nftFilterRuleset("wave0", null)).toBe(
      "table inet wave-acl-wave0 {}\ndelete table inet wave-acl-wave0\n",
    );
  });

  test("starts by replacing itself, so applying twice is applying once", () => {
    const [first, second] = nftFilterRuleset("wave0", [nas]).split("\n");
    expect(first).toBe("table inet wave-acl-wave0 {}");
    expect(second).toBe("delete table inet wave-acl-wave0");
  });
});

describe("installing it", () => {
  const ok = async () => ({ code: 0, stdout: "", stderr: "" });

  test("hands the document to nft on stdin", async () => {
    const seen: { args: string[]; input: string }[] = [];
    const link = new LinuxLink(ok, ok, async (args, input) => {
      seen.push({ args, input });
      return { code: 0, stdout: "", stderr: "" };
    });
    expect(await link.syncFilter("wave0", [nas])).toEqual({ enforced: true });
    expect(seen[0]?.args).toEqual(["-f", "-"]);
    expect(seen[0]?.input).toBe(nftFilterRuleset("wave0", [nas]));
  });

  test("says why when it cannot, and does not throw", async () => {
    const missing = new LinuxLink(ok, ok, async () => ({ code: 127, stdout: "", stderr: "not found" }));
    expect(await missing.syncFilter("wave0", [nas])).toEqual({
      enforced: false,
      reason: "nft is not installed",
    });
    // Without a policy there is nothing missing.
    expect(await missing.syncFilter("wave0", null)).toEqual({ enforced: true });

    const refused = new LinuxLink(ok, ok, async () => ({
      code: 1,
      stdout: "",
      stderr: "Error: Operation not permitted\nmore",
    }));
    const result = await refused.syncFilter("wave0", [nas]);
    expect(result.enforced).toBe(false);
    expect(result.reason).toBe("nft refused the rules: Error: Operation not permitted");
  });

  test("a platform without a filter says so, but only when there is a policy", () => {
    expect(unenforcedFilter("Plan 9", null)).toEqual({ enforced: true });
    expect(unenforcedFilter("Plan 9", [])).toEqual({
      enforced: false,
      reason: "ports are not enforced on Plan 9 yet",
    });
  });
});

describe("macOS: a pf anchor", () => {
  test("keeps state for what goes out, lets ICMP and the named ports in, and blocks the rest", () => {
    const text = pfAnchorRules("utun5", [nas]);
    const lines = text.trim().split("\n");
    expect(lines[0]).toBe("pass out quick on utun5 all keep state");
    expect(text).toContain(
      "pass in quick on utun5 inet proto tcp from { 10.64.0.1 } to { 10.64.0.3 } port { 445, 5000:5001 } keep state",
    );
    // `any` opens UDP too, and pf writes a range with a colon.
    expect(text).toContain(
      "pass in quick on utun5 inet proto udp from { 10.64.0.1 } to { 10.64.0.3 } port { 5000:5001 } keep state",
    );
    expect(text).toContain("inet6 proto tcp from { fd7a::1 } to { fd7a::3 }");
    expect(lines.at(-1)).toBe("block drop in quick on utun5 all");
  });

  test("lives under com.apple, which the system's pf.conf already evaluates", () => {
    expect(pfAnchorName("utun5")).toBe("com.apple/wave.utun5");
  });

  test("enables pf by reference and gives the reference back", async () => {
    const calls: string[][] = [];
    const pfctl = async (args: string[]) => {
      calls.push(args);
      return args[0] === "-E"
        ? { code: 0, stdout: "", stderr: "pf enabled\nToken : 1234567\n" }
        : { code: 0, stdout: "", stderr: "" };
    };
    const link = new DarwinLink({ pfctl });
    expect(await link.syncFilter("utun5", [nas])).toEqual({ enforced: true });
    // A second policy does not take a second reference.
    expect(await link.syncFilter("utun5", [])).toEqual({ enforced: true });
    expect(calls.filter((args) => args[0] === "-E")).toHaveLength(1);
    expect(calls).toContainEqual(["-a", "com.apple/wave.utun5", "-f", "-"]);

    expect(await link.syncFilter("utun5", null)).toEqual({ enforced: true });
    expect(calls).toContainEqual(["-a", "com.apple/wave.utun5", "-F", "all"]);
    expect(calls.at(-1)).toEqual(["-X", "1234567"]);
  });

  test("says why when pf will not", async () => {
    const link = new DarwinLink({
      pfctl: async (args) =>
        args[0] === "-E"
          ? { code: 0, stdout: "", stderr: "Token : 1\n" }
          : { code: 1, stdout: "", stderr: "stdin:3: syntax error\nmore" },
    });
    expect(await link.syncFilter("utun5", [nas])).toEqual({
      enforced: false,
      reason: "pf refused the rules: stdin:3: syntax error",
    });
  });
});

describe("Windows: firewall rules, inside out", () => {
  test("the ports a grant leaves out, merged", () => {
    expect(
      complementPorts([
        { from: 445, to: 445 },
        { from: 5000, to: 5001 },
      ]),
    ).toEqual([
      { from: 1, to: 444 },
      { from: 446, to: 4999 },
      { from: 5002, to: 65535 },
    ]);
    expect(complementPorts([{ from: 1, to: 65535 }])).toEqual([]);
    expect(complementPorts([])).toEqual([{ from: 1, to: 65535 }]);
  });

  test("every address but the granted hosts, as ranges", () => {
    expect(complementAddresses(["10.64.0.1/32", "10.64.0.3/32"], false)).toEqual([
      "0.0.0.0-10.64.0.0",
      "10.64.0.2-10.64.0.2",
      "10.64.0.4-255.255.255.255",
    ]);
    expect(complementAddresses(["fd7a::1/128"], true)).toEqual([
      "0:0:0:0:0:0:0:0-fd7a:0:0:0:0:0:0:0",
      "fd7a:0:0:0:0:0:0:2-ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ]);
  });

  test("only blocks, because a block beats every allow", () => {
    const script = windowsFirewallScript("wave0", [nas]);
    expect(script).not.toContain("-Action Allow");
    // Clears its own group first, so applying twice is applying once.
    expect(script.split("\n")[0]).toContain("Get-NetFirewallRule -Group 'wave-acl-wave0'");
    // Everyone the policy names nothing for.
    expect(script).toContain(
      "-RemoteAddress @('0.0.0.0-10.64.0.0','10.64.0.2-255.255.255.255') -Protocol Any",
    );
    // The granted source, on every TCP port outside 445 and 5000-5001.
    expect(script).toContain(
      "-RemoteAddress @('10.64.0.1') -Protocol TCP -LocalPort @('1-444','446-4999','5002-65535')",
    );
    // `tcp:445` opens no UDP: UDP is only open on the `any` range.
    expect(script).toContain(
      "-RemoteAddress @('10.64.0.1') -Protocol UDP -LocalPort @('1-4999','5002-65535')",
    );
  });

  test("a source granted nothing on a protocol is blocked on all of it", () => {
    const script = windowsFirewallScript("wave0", [
      { src: ["10.64.0.1/32"], dst: ["10.64.0.3/32"], ports: [{ proto: "tcp", from: 22, to: 22 }] },
    ]);
    expect(script).toContain("-RemoteAddress @('10.64.0.1') -Protocol UDP -ErrorAction Stop");
  });

  test("no policy only takes the group away", () => {
    expect(windowsFirewallScript("wave0", null).split("\n")).toHaveLength(1);
  });

  test("says so when the firewall is off, instead of reporting rules that do not bite", async () => {
    const link = new WindowsLink({
      powershell: async () => ({ code: 0, stdout: "firewall-off:Public,Private\n", stderr: "" }),
    });
    expect(await link.syncFilter("wave0", [nas])).toEqual({
      enforced: false,
      reason: "the Windows Firewall is off for Public, Private",
    });
    const on = new WindowsLink({ powershell: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(await on.syncFilter("wave0", [nas])).toEqual({ enforced: true });
  });
});

describe("handing a tool a file instead of a pipe", () => {
  test("the dash becomes the path of a file with the input, gone afterwards", async () => {
    // What nft 1.0.9 needs: `-f -` there is "Not a regular file".
    const result = await spawnWithInputFile("sh")(
      ["-c", 'test -f "$0" && cat "$0" && echo "$0"', "-"],
      "table x\n",
    );
    expect(result.code).toBe(0);
    const [content, path] = result.stdout.split("\n").filter(Boolean);
    expect(content).toBe("table x");
    expect(path && existsSync(path)).toBe(false);
  });

  test("a tool that is not there is an answer, not a crash", async () => {
    const result = await spawnWithInputFile("wave-no-such-tool")(["-f", "-"], "");
    expect(result.code).toBe(127);
  });
});
