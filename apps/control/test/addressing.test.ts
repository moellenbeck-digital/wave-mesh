import { describe, expect, test } from "bun:test";
import {
  allocateIpv4,
  intToIpv4,
  ipv4ToInt,
  ipv6ForIpv4,
  isWithin,
  parseIpv4Cidr,
  RESOLVER_OFFSET,
  resolverAddressFor,
  uniqueHostname,
} from "../src/net/addressing.ts";

describe("ipv4 conversion", () => {
  test("round-trips", () => {
    for (const ip of ["0.0.0.0", "100.64.0.1", "192.168.178.66", "255.255.255.255"]) {
      expect(intToIpv4(ipv4ToInt(ip))).toBe(ip);
    }
  });

  test("rejects malformed input", () => {
    expect(() => ipv4ToInt("100.64.0")).toThrow();
    expect(() => ipv4ToInt("100.64.0.300")).toThrow();
  });

  test("masks the prefix down to its network address", () => {
    expect(parseIpv4Cidr("100.127.3.9/10").base).toBe(ipv4ToInt("100.64.0.0"));
    expect(parseIpv4Cidr("100.64.0.0/10").size).toBe(2 ** 22);
  });
});

describe("allocateIpv4", () => {
  test("starts at the first host address", () => {
    expect(allocateIpv4("100.64.0.0/10", [])).toBe("100.64.0.1");
  });

  test("skips addresses already in use", () => {
    expect(allocateIpv4("100.64.0.0/10", ["100.64.0.1", "100.64.0.2"])).toBe("100.64.0.3");
  });

  test("reuses a gap left by a removed node", () => {
    expect(allocateIpv4("100.64.0.0/10", ["100.64.0.1", "100.64.0.3"])).toBe("100.64.0.2");
  });

  test("throws when the prefix is exhausted", () => {
    expect(() => allocateIpv4("10.0.0.0/30", ["10.0.0.1", "10.0.0.2"])).toThrow(/no free address/);
  });

  // The resolver's address belongs to the wave rather than to any node in it:
  // a resolver without a socket of its own is reached by routing its address
  // into the tunnel, and an address a device holds is answered locally instead.
  test("never hands out the resolver's address", () => {
    const taken: string[] = [];
    for (let i = 0; i < RESOLVER_OFFSET + 5; i++) taken.push(allocateIpv4("10.64.0.0/16", taken));
    expect(taken).not.toContain("10.64.0.53");
    expect(taken).toContain("10.64.0.52");
    expect(taken).toContain("10.64.0.54");
  });
});

describe("the resolver's reserved address", () => {
  test("sits at a fixed offset in the wave's block", () => {
    expect(resolverAddressFor("10.64.0.0/16")).toBe("10.64.0.53");
    expect(resolverAddressFor("10.96.0.0/16")).toBe("10.96.0.53");
  });

  test("is derived from the block, not from where it was written", () => {
    expect(resolverAddressFor("10.64.9.9/16")).toBe("10.64.0.53");
  });

  test("a block too small to spare one says so", () => {
    expect(() => resolverAddressFor("10.0.0.0/28")).toThrow(/too small/);
  });
});

describe("ipv6ForIpv4", () => {
  test("mirrors the IPv4 host part", () => {
    expect(ipv6ForIpv4("fd7a:1234:5678::/48", "100.64.0.0/10", "100.64.0.1")).toBe("fd7a:1234:5678::1");
    expect(ipv6ForIpv4("fd7a:1234:5678::/48", "100.64.0.0/10", "100.64.0.16")).toBe("fd7a:1234:5678::10");
  });
});

describe("uniqueHostname", () => {
  test("normalises to DNS-safe labels", () => {
    expect(uniqueHostname("Robins MacBook Pro", [])).toBe("robins-macbook-pro");
  });

  test("appends a counter on collision", () => {
    expect(uniqueHostname("laptop", ["laptop"])).toBe("laptop-2");
    expect(uniqueHostname("laptop", ["laptop", "laptop-2"])).toBe("laptop-3");
  });

  test("falls back when nothing usable is left", () => {
    expect(uniqueHostname("///", [])).toBe("node");
  });
});

describe("isWithin", () => {
  test("matches an address inside the range", () => {
    expect(isWithin("100.67.11.62", ["100.64.0.0/10"])).toBe(true);
    expect(isWithin("192.168.1.5", ["10.0.0.0/8", "192.168.0.0/16"])).toBe(true);
  });

  test("rejects an address outside every range", () => {
    expect(isWithin("8.8.8.8", ["100.64.0.0/10"])).toBe(false);
    expect(isWithin("100.128.0.1", ["100.64.0.0/10"])).toBe(false);
  });

  test("rejects what it cannot parse rather than letting it through", () => {
    expect(isWithin("::1", ["100.64.0.0/10"])).toBe(false);
    expect(isWithin("nonsense", ["100.64.0.0/10"])).toBe(false);
    expect(isWithin("10.0.0.1", ["not-a-cidr"])).toBe(false);
  });

  test("an empty list matches nothing", () => {
    expect(isWithin("10.0.0.1", [])).toBe(false);
  });
});
