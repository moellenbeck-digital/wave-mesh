import { describe, expect, test } from "bun:test";
import { ownAddressesOf } from "../src/main.ts";
import { nftRuleset } from "../src/rules.ts";

/**
 * The connector's one rule, and the reason it needs no list of services:
 * WireGuard already decided which addresses may arrive on the tunnel.
 */

const rules = {
  interfaceName: "wave0",
  ownAddresses: ["10.77.0.9/32", "fd7a:1:2::9/128"],
  backend: { ipv4: "10.43.0.80" },
  ports: [80, 443],
  mtu: 1280,
};

describe("the ruleset", () => {
  test("forwards what arrives on the tunnel and is not for us", () => {
    const ruleset = nftRuleset(rules);
    expect(ruleset).toContain('iifname "wave0" ip daddr 10.77.0.9 return');
    expect(ruleset).toContain('iifname "wave0" ip6 daddr fd7a:1:2::9 return');
    expect(ruleset).toContain('iifname "wave0" tcp dport { 80, 443 } dnat ip to 10.43.0.80');
    // No service address anywhere in it: the set of services changes all day,
    // and a rule that named them would need a reload for every `kubectl apply`.
    expect(ruleset).not.toContain("grafana");
  });

  // Applying it twice has to be the same as applying it once: a connector that
  // restarts cannot know what it left behind.
  test("replaces itself rather than stacking", () => {
    const ruleset = nftRuleset(rules);
    expect(ruleset).toContain("table inet wave-connector {}");
    expect(ruleset).toContain("delete table inet wave-connector");
  });

  test("clamps the MSS in both directions", () => {
    const ruleset = nftRuleset(rules);
    // 1280 minus 40 bytes of IPv6 and TCP header: without this the tunnel works
    // until the first large answer.
    expect(ruleset).toContain('iifname "wave0" tcp flags syn tcp option maxseg size set 1240');
    expect(ruleset).toContain('oifname "wave0" tcp flags syn tcp option maxseg size set 1240');
  });

  test("a connector is a door to services, not a way into the cluster", () => {
    const ruleset = nftRuleset(rules);
    expect(ruleset).toContain('iifname "wave0" tcp dport != { 80, 443 } drop');
    expect(ruleset).toContain('iifname "wave0" meta l4proto != tcp drop');
  });

  test("without an IPv6 backend the v6 half says so instead of hanging", () => {
    expect(nftRuleset(rules)).toContain("meta nfproto ipv6 tcp dport { 80, 443 } reject");
    expect(nftRuleset({ ...rules, backend: { ipv4: "10.43.0.80", ipv6: "fd00::80" } })).toContain(
      "dnat ip6 to fd00::80",
    );
  });

  test("other ports are carried through everywhere they matter", () => {
    const ruleset = nftRuleset({ ...rules, ports: [8443] });
    expect(ruleset).toContain("tcp dport { 8443 } dnat ip to 10.43.0.80");
    expect(ruleset).toContain("tcp dport != { 8443 } drop");
  });
});

describe("which addresses count as ours", () => {
  const up = {
    controlUrl: "https://control.example",
    state: "up" as const,
    // What the interface wears: this node, and one address per service it
    // answers for. The two are told apart by `self`, not by this list.
    addresses: ["10.77.0.9/32", "fd7a:1:2::9/128", "10.77.0.12/32", "fd7a:1:2::c/128"],
    authUrl: null,
    message: null,
    interfaceName: "wave0",
    self: {
      hostname: "connector",
      dnsName: "connector.wave.example.com",
      ipv4: "10.77.0.9",
      ipv6: "fd7a:1:2::9",
      // What this pod fronts. The rules below care about the node's own two
      // addresses, not about these -- which is the point of the assertion.
      services: [
        {
          name: "grafana",
          dnsName: "grafana.wave.example.com",
          ipv4: "10.77.0.12",
          url: "https://grafana.wave.example.com",
        },
      ],
    },
    dnsSuffix: null,
    relay: null,
    peers: [],
    events: [],
  };

  test("this node's own two, not everything on the interface", () => {
    expect(ownAddressesOf([up])).toEqual(["10.77.0.9", "fd7a:1:2::9"]);
  });

  // The regression the first real cluster found: a service address counted as
  // ours got a `return` in prerouting, so the one rule that forwards it never
  // ran and the service answered nothing.
  test("a service address is not ours", () => {
    const ruleset = nftRuleset({ ...rules, ownAddresses: ownAddressesOf([up]) });
    expect(ruleset).not.toContain("10.77.0.12 return");
    expect(ruleset).toContain("ip daddr 10.77.0.9 return");
    expect(ruleset).toContain("dnat ip to 10.43.0.80");
  });

  // Half a tunnel is no tunnel: rules written against an empty address list
  // would forward the node's own traffic to the backend.
  test("nothing while it is still coming up", () => {
    expect(ownAddressesOf([{ ...up, state: "starting", addresses: [] }])).toEqual([]);
  });

  // An older daemon says nothing about itself; without that, there is no way
  // to tell a service address from ours, and guessing would break both.
  test("nothing when the daemon does not say who it is", () => {
    expect(ownAddressesOf([{ ...up, self: null }])).toEqual([]);
  });

  test("the named wave when the pod is in several", () => {
    const other = {
      ...up,
      controlUrl: "https://other.example",
      self: { ...up.self, ipv4: "10.99.0.2", ipv6: "fd7a:9::2" },
    };
    expect(ownAddressesOf([up, other], "https://other.example")).toEqual(["10.99.0.2", "fd7a:9::2"]);
  });
});
