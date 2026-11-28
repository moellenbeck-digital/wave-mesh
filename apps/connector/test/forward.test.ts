import { describe, expect, test } from "bun:test";
import type { IptablesNetfilter, IptablesTool } from "@wave/client/netfilter";
import { forwarderFor, type Ipv6State, iptablesForwarder } from "../src/forward.ts";
import { clearOnStop } from "../src/main.ts";
import { nftRuleset } from "../src/rules.ts";

/** The order and the refusals; the rules themselves are in rules.test.ts. */

const rules = {
  interfaceName: "wave0",
  ownAddresses: ["10.77.0.9", "fd7a:1:2::9"],
  backend: { ipv4: "10.43.0.80" },
  ports: [80, 443],
  mtu: 1280,
};

/** Every commit, as "tool table", with what it held. */
function setup(
  options: { v6?: boolean; refuse?: (tool: string, doc: string) => boolean; listing?: string } = {},
) {
  const commits: string[] = [];
  const documents: string[] = [];
  const tool = (name: string): IptablesTool => ({
    name,
    run: async () => ({ code: 0, stdout: options.listing ?? "", stderr: "" }),
    restore: async (_args, input) => {
      if (options.refuse?.(name, input)) return { code: 2, stdout: "", stderr: "No chain/target/match" };
      commits.push(`${name} ${input.split("\n")[0]}`);
      documents.push(input);
      return { code: 0, stdout: "", stderr: "" };
    },
  });
  const netfilter: IptablesNetfilter = {
    kind: "iptables",
    v4: tool("iptables-legacy"),
    v6: options.v6 === false ? null : tool("ip6tables-legacy"),
    v6Problem: options.v6 === false ? "ip6tables is not usable" : undefined,
  };
  return { netfilter, commits, documents };
}

const ipv6 = (forwarding: boolean): Ipv6State => ({ present: () => true, forwarding: () => forwarding });
const quiet = () => {};

describe("applying with iptables", () => {
  test("closes before it opens: filter first, nat after", async () => {
    const { netfilter, commits } = setup();
    await iptablesForwarder(netfilter, { log: quiet, ipv6: ipv6(false) }).apply("", rules);
    expect(commits).toEqual(["iptables-legacy *filter", "ip6tables-legacy *filter", "iptables-legacy *nat"]);
  });

  test("a failed filter table leaves the way shut", async () => {
    const { netfilter, commits } = setup({ refuse: (_tool, doc) => doc.startsWith("*filter") });
    const forwarder = iptablesForwarder(netfilter, { log: quiet, ipv6: ipv6(false) });
    expect(forwarder.apply("", rules)).rejects.toThrow("refused the filter rules");
    await Bun.sleep(5);
    expect(commits).toEqual([]);
  });

  test("goes without the MSS clamp where the kernel has none, and says so", async () => {
    const { netfilter, documents } = setup({ refuse: (_tool, doc) => doc.includes("TCPMSS") });
    const said: string[] = [];
    await iptablesForwarder(netfilter, { log: (line) => said.push(line), ipv6: ipv6(false) }).apply(
      "",
      rules,
    );
    expect(documents.join()).toContain("-j DNAT");
    expect(said.join()).toContain("without the MSS clamp");
  });

  test("without ip6tables, goes on only while IPv6 is not forwarded", async () => {
    const { netfilter, commits } = setup({ v6: false });
    const said: string[] = [];
    const forwarder = iptablesForwarder(netfilter, { log: (line) => said.push(line), ipv6: ipv6(false) });
    await forwarder.apply("", rules);
    await forwarder.apply("", rules);
    expect(commits).toContain("iptables-legacy *nat");
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("no IPv6 rules");
  });

  test("with IPv6 forwarded and nothing to filter it, applies nothing", async () => {
    const { netfilter, commits } = setup({ v6: false });
    const forwarder = iptablesForwarder(netfilter, { log: quiet, ipv6: ipv6(true) });
    expect(forwarder.apply("", rules)).rejects.toThrow("IPv6 forwarding is on");
    await Bun.sleep(5);
    expect(commits).not.toContain("iptables-legacy *nat");
  });

  test("the same holds when ip6tables is there and the kernel refuses", async () => {
    const { netfilter, commits } = setup({ refuse: (tool) => tool.startsWith("ip6") });
    const forwarder = iptablesForwarder(netfilter, { log: quiet, ipv6: ipv6(true) });
    expect(forwarder.apply("", rules)).rejects.toThrow("IPv6 forwarding is on");
    await Bun.sleep(5);
    expect(commits).not.toContain("iptables-legacy *nat");
  });

  test("an IPv6 backend that cannot be served is an error", async () => {
    const { netfilter } = setup({ v6: false });
    const forwarder = iptablesForwarder(netfilter, { log: quiet, ipv6: ipv6(false) });
    const backend = { ipv4: "10.43.0.80", ipv6: "fd00::80" };
    expect(forwarder.apply("", { ...rules, backend })).rejects.toThrow("an IPv6 backend is set");
  });

  test("renders every address it depends on, so a change is applied", () => {
    const forwarder = iptablesForwarder(setup().netfilter);
    expect(forwarder.render(rules)).not.toBe(forwarder.render({ ...rules, ownAddresses: ["10.77.0.10"] }));
    expect(forwarder.render(rules)).toBe(forwarder.render({ ...rules }));
  });
});

describe("taking it out again", () => {
  const listing = [
    "-N WAVE-CONN-PRE",
    "-N WAVE-CONN-POST",
    "-N WAVE-CONN-FWD",
    "-N WAVE-CONN-REJ",
    "-A PREROUTING -j WAVE-CONN-PRE",
    "-A POSTROUTING -j WAVE-CONN-POST",
    "-A FORWARD -j WAVE-CONN-FWD",
    "-A INPUT -j WAVE-CONN-REJ",
  ].join("\n");

  test("nat before filter, jumps and chains, and nothing applied afterwards", async () => {
    const { netfilter, commits, documents } = setup({ listing });
    const forwarder = iptablesForwarder(netfilter, { log: quiet, ipv6: ipv6(false) });
    await forwarder.clear?.();
    expect(commits).toEqual([
      "iptables-legacy *nat",
      "ip6tables-legacy *nat",
      "iptables-legacy *filter",
      "ip6tables-legacy *filter",
    ]);
    expect(documents[0]).toContain("-D PREROUTING -j WAVE-CONN-PRE");
    expect(documents[0]).toContain("-X WAVE-CONN-PRE");
    expect(documents[2]).toContain("-X WAVE-CONN-FWD");
    await forwarder.apply("", rules);
    expect(commits).toHaveLength(4);
  });

  test("happens on SIGTERM and SIGINT, then the process ends", async () => {
    const handlers = new Map<string, () => void>();
    const done: unknown[] = [];
    clearOnStop(
      {
        name: "iptables",
        render: () => "",
        apply: async () => {},
        clear: async () => {
          done.push("cleared");
        },
      },
      (signal, handler) => handlers.set(signal, handler),
      (code) => done.push(code),
      quiet,
    );
    expect([...handlers.keys()]).toEqual(["SIGINT", "SIGTERM"]);
    handlers.get("SIGTERM")?.();
    await Bun.sleep(5);
    expect(done).toEqual(["cleared", 0]);
  });

  test("nft keeps its table, as before", () => {
    const forwarder = forwarderFor({ kind: "nft" });
    expect(forwarder.clear).toBeUndefined();
    expect(forwarder.render(rules)).toBe(nftRuleset(rules));
    let registered = 0;
    clearOnStop(forwarder, () => registered++);
    expect(registered).toBe(0);
  });

  test("no backend is said at once", () => {
    expect(() => forwarderFor({ kind: "none", reason: "neither nft nor iptables is usable" })).toThrow(
      "neither nft nor iptables",
    );
  });
});
