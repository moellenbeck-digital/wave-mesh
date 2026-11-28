import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { FilterRule } from "@wave/proto";
import { spawnWithInputFile, unenforcedFilter } from "../src/link.ts";
import { DarwinLink } from "../src/link-darwin.ts";
import { LinuxLink } from "../src/link-linux.ts";
import { WindowsLink } from "../src/link-windows.ts";
import type { IptablesNetfilter, IptablesTool, Netfilter } from "../src/netfilter.ts";
import {
  complementAddresses,
  complementPorts,
  iptablesFilterChain,
  iptablesFilterRules,
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
  const nft = async () => ({ kind: "nft" as const });

  test("hands the document to nft on stdin", async () => {
    const seen: { args: string[]; input: string }[] = [];
    const link = new LinuxLink(
      ok,
      ok,
      async (args, input) => {
        seen.push({ args, input });
        return { code: 0, stdout: "", stderr: "" };
      },
      undefined,
      nft,
    );
    expect(await link.syncFilter("wave0", [nas])).toEqual({ enforced: true });
    expect(seen[0]?.args).toEqual(["-f", "-"]);
    expect(seen[0]?.input).toBe(nftFilterRuleset("wave0", [nas]));
  });

  test("says why when it cannot, and does not throw", async () => {
    const missing = new LinuxLink(
      ok,
      ok,
      async () => ({ code: 127, stdout: "", stderr: "not found" }),
      undefined,
      nft,
    );
    expect(await missing.syncFilter("wave0", [nas])).toEqual({
      enforced: false,
      reason: "nft is not installed",
    });
    // Without a policy there is nothing missing.
    expect(await missing.syncFilter("wave0", null)).toEqual({ enforced: true });

    const refused = new LinuxLink(
      ok,
      ok,
      async () => ({ code: 1, stdout: "", stderr: "Error: Operation not permitted\nmore" }),
      undefined,
      nft,
    );
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

describe("the iptables chain, where there is no nft", () => {
  test("lets in what a rule names, per family and protocol, and drops the rest", () => {
    expect(iptablesFilterRules([nas], "ip", "mangle")).toEqual([
      "-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
      "-p icmp -j RETURN",
      "-s 10.64.0.1/32 -d 10.64.0.3/32 -p tcp -m tcp --dport 445 -j RETURN",
      "-s 10.64.0.1/32 -d 10.64.0.3/32 -p tcp -m tcp --dport 5000:5001 -j RETURN",
      // `any` opens UDP too; tcp:445 does not.
      "-s 10.64.0.1/32 -d 10.64.0.3/32 -p udp -m udp --dport 5000:5001 -j RETURN",
      "-j DROP",
    ]);
    const v6 = iptablesFilterRules([nas], "ip6", "mangle");
    expect(v6[1]).toBe("-p ipv6-icmp -j RETURN");
    expect(v6).toContain("-s fd7a::1/128 -d fd7a::3/128 -p tcp -m tcp --dport 445 -j RETURN");
    expect(v6.join()).not.toContain("10.64.0.1");
  });

  // An accept would overrule the machine's own firewall further down.
  test("never accepts, only returns", () => {
    expect(iptablesFilterRules([nas], "ip", "mangle").join("\n")).not.toContain("ACCEPT");
  });

  test("an empty policy still lets replies and ICMP through, and nothing else", () => {
    expect(iptablesFilterRules([], "ip", "mangle")).toEqual([
      "-m conntrack --ctstate RELATED,ESTABLISHED -j RETURN",
      "-p icmp -j RETURN",
      "-j DROP",
    ]);
  });

  test("in mangle, before the DNAT; in filter, by where the packet was sent", () => {
    expect(iptablesFilterChain("wave0", [nas], "ip", "mangle").hooks).toEqual([
      { from: "PREROUTING", match: "-i wave0" },
    ]);
    const chain = iptablesFilterChain("wave0", [nas], "ip", "filter");
    expect(chain.chain).toBe("WAVE-ACL-wave0");
    expect(chain.hooks).toEqual([
      { from: "INPUT", match: "-i wave0" },
      { from: "FORWARD", match: "-i wave0" },
    ]);
    expect(chain.rules).toContain(
      "-s 10.64.0.1/32 -p tcp -m conntrack --ctorigdst 10.64.0.3/32 --ctorigdstport 445 -j RETURN",
    );
  });

  test("nothing but addresses and interface names reaches the document", () => {
    expect(() =>
      iptablesFilterRules([{ ...nas, src: ["10.0.0.1/32\n-A INPUT -j ACCEPT"] }], "ip", "mangle"),
    ).toThrow("not an address");
    expect(() => iptablesFilterChain("wave0 -j ACCEPT", [], "ip", "mangle")).toThrow("interface name");
  });
});

describe("installing it with iptables", () => {
  const ok = async () => ({ code: 0, stdout: "", stderr: "" });

  /** A tool that remembers each table it was asked to write. */
  const fake = (name: string, options: { noMangle?: boolean; refuse?: string; listing?: string } = {}) => {
    const written: string[] = [];
    const tool: IptablesTool = {
      name,
      run: async (args) =>
        options.noMangle && args.includes("mangle")
          ? { code: 3, stdout: "", stderr: "can't initialize iptables table `mangle': Table does not exist" }
          : { code: 0, stdout: options.listing ?? "", stderr: "" },
      restore: async (_args, input) => {
        written.push(input);
        return options.refuse
          ? { code: 2, stdout: "", stderr: `${options.refuse}\nmore` }
          : { code: 0, stdout: "", stderr: "" };
      },
    };
    return { tool, written };
  };

  const linkWith = (netfilter: Netfilter, ipv6 = true) =>
    new LinuxLink(
      ok,
      ok,
      async () => {
        throw new Error("nft must not run here");
      },
      undefined,
      async () => netfilter,
      () => ipv6,
    );

  const both = (v4: IptablesTool, v6: IptablesTool | null): IptablesNetfilter => ({
    kind: "iptables",
    v4,
    v6,
    ...(v6 ? {} : { v6Problem: "ip6tables is not usable (ip6tables: not installed)" }),
  });

  test("writes both families into mangle and calls it enforced", async () => {
    const v4 = fake("iptables-legacy");
    const v6 = fake("ip6tables-legacy");
    expect(await linkWith(both(v4.tool, v6.tool)).syncFilter("wave0", [nas])).toEqual({ enforced: true });
    expect(v4.written).toHaveLength(1);
    expect(v4.written[0]).toStartWith("*mangle\n");
    expect(v4.written[0]).toContain("-I PREROUTING 1 -i wave0 -j WAVE-ACL-wave0");
    expect(v6.written[0]).toContain("fd7a::3/128");
  });

  test("takes the filter table where there is no mangle", async () => {
    const v4 = fake("iptables-legacy", { noMangle: true });
    const v6 = fake("ip6tables-legacy", { noMangle: true });
    expect(await linkWith(both(v4.tool, v6.tool)).syncFilter("wave0", [nas])).toEqual({ enforced: true });
    expect(v4.written[0]).toStartWith("*filter\n");
    expect(v4.written[0]).toContain("-I FORWARD 1 -i wave0 -j WAVE-ACL-wave0");
  });

  test("IPv6 that cannot be filtered is not an enforced policy", async () => {
    const v4 = fake("iptables-legacy");
    const result = await linkWith(both(v4.tool, null)).syncFilter("wave0", [nas]);
    expect(result).toEqual({
      enforced: false,
      reason: "IPv6 is not filtered: ip6tables is not usable (ip6tables: not installed)",
    });
    // What can be closed is closed anyway.
    expect(v4.written[0]).toContain("-j DROP");
    // Without an IPv6 stack there is nothing to leave open.
    expect(await linkWith(both(v4.tool, null), false).syncFilter("wave0", [nas])).toEqual({ enforced: true });
    expect(await linkWith(both(v4.tool, null)).syncFilter("wave0", null)).toEqual({ enforced: true });
  });

  test("says which family was refused, and does not throw", async () => {
    const v4 = fake("iptables-legacy", { refuse: "iptables-restore: line 4 failed" });
    const v6 = fake("ip6tables-legacy");
    const result = await linkWith(both(v4.tool, v6.tool)).syncFilter("wave0", [nas]);
    expect(result.enforced).toBe(false);
    expect(result.reason).toBe(
      "IPv4 is not filtered: iptables-legacy-restore refused the mangle rules: iptables-restore: line 4 failed",
    );
  });

  test("no policy removes the chain it finds", async () => {
    const listing = "-N WAVE-ACL-wave0\n-A PREROUTING -i wave0 -j WAVE-ACL-wave0\n";
    const v4 = fake("iptables-legacy", { listing });
    expect(await linkWith(both(v4.tool, null), false).syncFilter("wave0", null)).toEqual({ enforced: true });
    expect(v4.written[0]).toContain("-X WAVE-ACL-wave0");
  });

  test("only with no backend at all is the policy not enforced for lack of one", async () => {
    const none = linkWith({ kind: "none", reason: "neither nft nor iptables is usable" });
    expect(await none.syncFilter("wave0", [nas])).toEqual({
      enforced: false,
      reason: "neither nft nor iptables is usable",
    });
    expect(await none.syncFilter("wave0", null)).toEqual({ enforced: true });
  });

  test("a WAVE_NETFILTER nobody understands keeps the tunnel and says so", async () => {
    const link = new LinuxLink(ok, ok, undefined, undefined, async () => {
      throw new Error("WAVE_NETFILTER must be auto, nft or iptables");
    });
    expect(await link.syncFilter("wave0", [nas])).toEqual({
      enforced: false,
      reason: "WAVE_NETFILTER must be auto, nft or iptables",
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
