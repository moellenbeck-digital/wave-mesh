import { describe, expect, test } from "bun:test";
import { dnsFingerprint, planDns } from "../src/dns-plan.ts";

const records = (...names: string[]) => names.map((name) => ({ name, ipv4: "10.77.0.2" }));
const reverse = ["77.10.in-addr.arpa"];

describe("planDns", () => {
  test("a .internal zone is routed whole and searched, as before", () => {
    const plan = planDns({
      zone: "rl.wave.internal",
      records: records("laptop.rl.wave.internal"),
      routes: [{ suffix: "corp.example.com" }],
      reverse,
    });

    expect(plan).toEqual({
      suffixes: ["rl.wave.internal", "corp.example.com", "77.10.in-addr.arpa"],
      names: [],
      search: "rl.wave.internal",
    });
  });

  test("a domain the user owns gets its wave names only, and no search domain", () => {
    const plan = planDns({
      zone: "rolenz-digital.de",
      records: records(
        "nas.rolenz-digital.de",
        "laptop.rolenz-digital.de",
        "grafana.rolenz-digital.de",
        "app.pier.rolenz-digital.de",
      ),
      routes: [{ suffix: "corp.example.com" }],
      reverse,
    });

    // Not the zone, so neither the apex nor www is sent to the wave; the
    // delegated suffix and the reverse zone stay as they were.
    expect(plan.suffixes).toEqual(["corp.example.com", "77.10.in-addr.arpa"]);
    expect(plan.names).toEqual([
      "app.pier.rolenz-digital.de",
      "grafana.rolenz-digital.de",
      "laptop.rolenz-digital.de",
      "nas.rolenz-digital.de",
    ]);
    expect(plan.names).not.toContain("rolenz-digital.de");
    expect(plan.names).not.toContain("www.rolenz-digital.de");
    expect(plan.search).toBeUndefined();
  });

  test("the zone's own name is never one of the wave's, even if a record says so", () => {
    const plan = planDns({
      zone: "rolenz-digital.de",
      records: records("rolenz-digital.de", "Nas.Rolenz-Digital.de."),
      routes: [],
      reverse: [],
    });
    expect(plan.names).toEqual(["nas.rolenz-digital.de"]);
  });

  test("lists a name once, and leaves out one a delegated suffix already routes whole", () => {
    const plan = planDns({
      zone: "rolenz-digital.de",
      records: records("nas.rolenz-digital.de", "NAS.rolenz-digital.de", "db.corp.example.com"),
      routes: [{ suffix: "db.corp.example.com" }],
      reverse: [],
    });
    expect(plan.names).toEqual(["nas.rolenz-digital.de"]);
  });

  test("leaves out a name that is not a plain host name", () => {
    // These become file names and script text on the client.
    const plan = planDns({
      zone: "rolenz-digital.de",
      records: records(
        "../etc/passwd",
        "a b.rolenz-digital.de",
        "x'; calc.rolenz-digital.de",
        "ok.rolenz-digital.de",
      ),
      routes: [],
      reverse: [],
    });
    expect(plan.names).toEqual(["ok.rolenz-digital.de"]);
  });
});

describe("dnsFingerprint", () => {
  const plan = (...names: string[]) =>
    planDns({ zone: "rolenz-digital.de", records: records(...names), routes: [], reverse });

  test("is the same for the same names, whatever order they arrive in", () => {
    expect(dnsFingerprint(plan("b.rolenz-digital.de", "a.rolenz-digital.de"), "10.77.0.1", 53)).toBe(
      dnsFingerprint(plan("a.rolenz-digital.de", "b.rolenz-digital.de"), "10.77.0.1", 53),
    );
  });

  test("changes when a name comes or goes, or is renamed", () => {
    const base = dnsFingerprint(plan("a.rolenz-digital.de"), "10.77.0.1", 53);
    expect(dnsFingerprint(plan("a.rolenz-digital.de", "b.rolenz-digital.de"), "10.77.0.1", 53)).not.toBe(
      base,
    );
    expect(dnsFingerprint(plan("c.rolenz-digital.de"), "10.77.0.1", 53)).not.toBe(base);
    expect(dnsFingerprint(plan(), "10.77.0.1", 53)).not.toBe(base);
  });

  test("changes when the resolver moves", () => {
    const a = plan("a.rolenz-digital.de");
    expect(dnsFingerprint(a, "127.0.0.1", 5354)).not.toBe(dnsFingerprint(a, "127.0.0.1", 5355));
  });

  test("does not change for a name that was only re-addressed", () => {
    const first = planDns({
      zone: "rolenz-digital.de",
      records: [{ name: "a.rolenz-digital.de", ipv4: "10.77.0.2" }],
      routes: [],
      reverse,
    });
    const second = planDns({
      zone: "rolenz-digital.de",
      records: [{ name: "a.rolenz-digital.de", ipv4: "10.77.0.9" }],
      routes: [],
      reverse,
    });
    expect(dnsFingerprint(first, "10.77.0.1", 53)).toBe(dnsFingerprint(second, "10.77.0.1", 53));
  });

  test("tells a whole zone from the same name routed alone", () => {
    const whole = planDns({ zone: "wave.internal", records: [], routes: [], reverse: [] });
    const single = { suffixes: [], names: ["wave.internal"], search: undefined };
    expect(dnsFingerprint(whole, "10.77.0.1", 53)).not.toBe(dnsFingerprint(single, "10.77.0.1", 53));
  });
});
