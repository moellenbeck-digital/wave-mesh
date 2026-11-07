import { describe, expect, test } from "bun:test";
import { cloudflareProvider } from "../src/dns/cloudflare.ts";
import { hetznerProvider } from "../src/dns/hetzner.ts";
import { type Clock, inwxProvider } from "../src/dns/inwx.ts";
import { ionosProvider } from "../src/dns/ionos.ts";
import { addressRecordType, type DnsProvider } from "../src/dns/provider.ts";

/**
 * The public address of a name (D12): one A or AAAA record at a time.
 *
 * Four providers, one scenario. What is held to is the contract the pier relies
 * on -- `setAddress` leaves exactly one record of its type at the name, saying
 * the same twice changes nothing, and `removeAddress` takes one type away
 * without touching the other or a neighbour's records.
 */

const NAME = "app.wave.example.com";
const NEIGHBOUR = "other.wave.example.com";

interface Stored {
  type: string;
  name: string;
  content: string;
}

interface Fake {
  provider: DnsProvider;
  /** `TYPE content`, sorted, for the records at one name. */
  at(name: string): string[];
  /** A record somebody else owns, put there before the provider is touched. */
  seed(record: Stored): void;
  creates(): number;
}

function cloudflareFake(): Fake {
  const records = new Map<string, Stored>();
  let next = 0;
  let created = 0;
  const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/client/v4/zones") {
      return ok(url.searchParams.get("name") === "wave.example.com" ? [{ id: "z1" }] : []);
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Stored & { ttl: number };
      expect(body.ttl).toBe(300);
      records.set(`r${++next}`, body);
      created++;
      return ok({ id: `r${next}` });
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records") {
      const [type, name] = [url.searchParams.get("type"), url.searchParams.get("name")];
      return ok(
        [...records].filter(([, r]) => r.type === type && r.name === name).map(([id, r]) => ({ id, ...r })),
      );
    }
    if (init?.method === "DELETE") {
      records.delete(url.pathname.split("/").pop() ?? "");
      return ok({});
    }
    return new Response("unexpected", { status: 500 });
  }) as typeof fetch;
  return {
    provider: cloudflareProvider("token", fetchImpl),
    at: (name) => lines(records, name),
    seed: (record) => void records.set(`s${++next}`, record),
    creates: () => created,
  };
}

function hetznerFake(): Fake {
  const records = new Map<string, Stored & { value: string }>();
  let next = 0;
  let created = 0;
  const relative = (name: string) => name.replace(".wave.example.com", "");
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/api/v1/zones")
      return Response.json({ zones: [{ id: "z9", name: "wave.example.com" }] });
    if (url.pathname === "/api/v1/records" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        type: string;
        name: string;
        value: string;
        ttl: number;
      };
      expect(body.ttl).toBe(300);
      records.set(`r${++next}`, { type: body.type, name: body.name, content: body.value, value: body.value });
      created++;
      return Response.json({ record: { id: `r${next}` } });
    }
    if (url.pathname === "/api/v1/records") {
      return Response.json({ records: [...records].map(([id, r]) => ({ id, ...r })) });
    }
    if (init?.method === "DELETE") {
      records.delete(url.pathname.split("/").pop() ?? "");
      return new Response(null, { status: 200 });
    }
    return new Response("unexpected", { status: 400 });
  }) as typeof fetch;
  return {
    provider: hetznerProvider("token", fetchImpl),
    // Stored relative to the zone, the way Hetzner keeps them.
    at: (name) =>
      [...records.values()]
        .filter((r) => r.name === relative(name))
        .map((r) => `${r.type} ${r.content}`)
        .sort(),
    seed: (record) =>
      void records.set(`s${++next}`, { ...record, name: relative(record.name), value: record.content }),
    creates: () => created,
  };
}

function ionosFake(): Fake {
  const records = new Map<string, Stored>();
  let next = 0;
  let created = 0;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/dns/v1/zones") return Response.json([{ id: "z1", name: "wave.example.com" }]);
    if (url.pathname === "/dns/v1/zones/z1/records" && init?.method === "POST") {
      for (const record of JSON.parse(String(init.body)) as Stored[]) {
        records.set(`r${++next}`, record);
        created++;
      }
      return new Response(null, { status: 201 });
    }
    if (url.pathname === "/dns/v1/zones/z1") {
      const [name, type] = [url.searchParams.get("recordName"), url.searchParams.get("recordType")];
      return Response.json({
        records: [...records]
          .filter(([, r]) => r.name === name && r.type === type)
          .map(([id, r]) => ({ id, ...r })),
      });
    }
    if (init?.method === "DELETE") {
      records.delete(url.pathname.split("/").pop() ?? "");
      return new Response(null, { status: 200 });
    }
    return new Response("unexpected", { status: 400 });
  }) as typeof fetch;
  return {
    provider: ionosProvider("prefix.secret", fetchImpl),
    at: (name) => lines(records, name),
    seed: (record) => void records.set(`s${++next}`, record),
    creates: () => created,
  };
}

function inwxFake(): Fake {
  const records = new Map<string, Stored>();
  let next = 0;
  let created = 0;
  const frozen: Clock = { now: () => 1_234_567_890_000, sleep: async () => {} };
  const answer = (code: number, resData?: unknown, headers?: Record<string, string>) =>
    Response.json({ code, msg: "x", resData }, { headers });
  const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
    if (body.method === "account.login") {
      return answer(1000, { tfa: "0" }, { "set-cookie": "domrobot=s1; path=/" });
    }
    if (body.method === "nameserver.info") {
      if (body.params.domain !== "wave.example.com") return answer(2303);
      const record = [...records]
        .filter(([, r]) => r.name === body.params.name && r.type === body.params.type)
        .map(([id, r]) => ({ id, ...r }));
      return answer(1000, { record });
    }
    if (body.method === "nameserver.createRecord") {
      expect(Number(body.params.ttl)).toBe(300);
      records.set(`r${++next}`, {
        type: body.params.type ?? "",
        name: body.params.name ?? "",
        content: body.params.content ?? "",
      });
      created++;
      return answer(1000, { id: `r${next}` });
    }
    if (body.method === "nameserver.deleteRecord") {
      records.delete(String(body.params.id));
      return answer(1000);
    }
    return answer(2303);
  }) as typeof fetch;
  return {
    provider: inwxProvider(JSON.stringify({ user: "robin", password: "secret" }), fetchImpl, frozen),
    at: (name) => lines(records, name),
    seed: (record) => void records.set(`s${++next}`, record),
    creates: () => created,
  };
}

const lines = (records: Map<string, Stored>, name: string): string[] =>
  [...records.values()]
    .filter((r) => r.name === name)
    .map((r) => `${r.type} ${r.content}`)
    .sort();

const providers: [string, () => Fake][] = [
  ["cloudflare", cloudflareFake],
  ["hetzner", hetznerFake],
  ["ionos", ionosFake],
  ["inwx", inwxFake],
];

describe("which record carries an address", () => {
  test("IPv4 is an A record and IPv6 an AAAA record", () => {
    expect(addressRecordType("203.0.113.10")).toBe("A");
    expect(addressRecordType("2001:db8::10")).toBe("AAAA");
    expect(addressRecordType("::ffff:203.0.113.10")).toBe("AAAA");
  });
});

for (const [kind, build] of providers) {
  describe(`${kind}: the public address of a name`, () => {
    test("writes an A record and an AAAA record side by side", async () => {
      const fake = build();
      await fake.provider.setAddress(NAME, "203.0.113.10");
      await fake.provider.setAddress(NAME, "2001:db8::10");
      expect(fake.at(NAME)).toEqual(["A 203.0.113.10", "AAAA 2001:db8::10"]);
    });

    test("saying the same address again writes nothing", async () => {
      const fake = build();
      await fake.provider.setAddress(NAME, "203.0.113.10");
      await fake.provider.setAddress(NAME, "203.0.113.10");
      expect(fake.at(NAME)).toEqual(["A 203.0.113.10"]);
      expect(fake.creates()).toBe(1);
    });

    test("a new address replaces the old one instead of joining it", async () => {
      const fake = build();
      await fake.provider.setAddress(NAME, "203.0.113.10");
      await fake.provider.setAddress(NAME, "198.51.100.7");
      expect(fake.at(NAME)).toEqual(["A 198.51.100.7"]);
    });

    test("removing one type leaves the other, and a neighbour's records alone", async () => {
      const fake = build();
      fake.seed({ type: "A", name: NEIGHBOUR, content: "192.0.2.1" });
      fake.seed({ type: "TXT", name: NAME, content: "v=spf1 -all" });
      await fake.provider.setAddress(NAME, "203.0.113.10");
      await fake.provider.setAddress(NAME, "2001:db8::10");

      await fake.provider.removeAddress(NAME, "A");
      expect(fake.at(NAME)).toEqual(["AAAA 2001:db8::10", "TXT v=spf1 -all"]);
      expect(fake.at(NEIGHBOUR)).toEqual(["A 192.0.2.1"]);

      await fake.provider.removeAddress(NAME, "AAAA");
      expect(fake.at(NAME)).toEqual(["TXT v=spf1 -all"]);
    });

    test("removing what is not there is not an error", async () => {
      const fake = build();
      await fake.provider.removeAddress(NAME, "AAAA");
      expect(fake.at(NAME)).toEqual([]);
    });
  });
}
