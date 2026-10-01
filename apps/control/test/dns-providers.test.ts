import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { cloudflareProvider } from "../src/dns/cloudflare.ts";
import { buildProvider, openSecret, sealSecret, verifyZoneAccess } from "../src/dns/credentials.ts";
import { hetznerProvider } from "../src/dns/hetzner.ts";
import { type Clock, inwxProvider, parseInwxAccount, totp } from "../src/dns/inwx.ts";
import { ionosProvider } from "../src/dns/ionos.ts";
import { relativeName, zoneCandidates } from "../src/dns/provider.ts";

/**
 * The zone side of D7. Four providers exist so that the interface is one: what
 * is checked here is that each of them finds the right zone and removes what it
 * wrote, because a challenge record left behind sits in a stranger's domain.
 */

describe("finding the zone", () => {
  test("tries the longest zone first, so a delegated subzone wins", () => {
    expect(zoneCandidates("_acme-challenge.laptop.wave.example.com")).toEqual([
      "laptop.wave.example.com",
      "wave.example.com",
      "example.com",
    ]);
  });

  test("a bare label is never a zone", () => {
    expect(zoneCandidates("localhost")).toEqual([]);
  });

  test("a record is named relative to its zone where an API wants that", () => {
    expect(relativeName("_acme-challenge.laptop.wave.example.com", "wave.example.com")).toBe(
      "_acme-challenge.laptop",
    );
    expect(relativeName("example.com", "example.com")).toBe("@");
  });
});

/** A provider API reduced to what a TXT record needs: put one there, take it away. */
function fakeApi(handler: (url: URL, init: RequestInit | undefined) => Response): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
    return handler(url, init);
  }) as typeof fetch;
  return { fetch: fetchImpl, calls };
}

describe("cloudflare", () => {
  const records = new Map<string, string>();
  const api = fakeApi((url, init) => {
    if (url.pathname === "/client/v4/zones") {
      const name = url.searchParams.get("name");
      return Response.json({
        success: true,
        errors: [],
        result: name === "wave.example.com" ? [{ id: "z1", name }] : [],
      });
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; content: string; ttl: number };
      expect(body.ttl).toBe(60);
      records.set("r1", `${body.name}=${body.content}`);
      return Response.json({ success: true, errors: [], result: { id: "r1" } });
    }
    if (url.pathname === "/client/v4/zones/z1/dns_records") {
      const name = url.searchParams.get("name") ?? "";
      const entries = [...records].filter(([, value]) => value.startsWith(`${name}=`));
      return Response.json({
        success: true,
        errors: [],
        result: entries.map(([id, value]) => ({ id, name, content: value.split("=")[1] })),
      });
    }
    if (init?.method === "DELETE") {
      records.delete(url.pathname.split("/").pop() ?? "");
      return Response.json({ success: true, errors: [], result: {} });
    }
    return Response.json({ success: false, errors: [{ code: 1, message: "unexpected" }] }, { status: 400 });
  });

  test("writes and removes a challenge record in the zone it belongs to", async () => {
    const provider = cloudflareProvider("token", api.fetch);
    await provider.setTxt("_acme-challenge.laptop.wave.example.com", "value");
    expect([...records.values()]).toEqual(["_acme-challenge.laptop.wave.example.com=value"]);

    await provider.removeTxt("_acme-challenge.laptop.wave.example.com", "value");
    expect([...records.values()]).toEqual([]);
    // The zone above the record does not exist, so it was asked for first.
    expect(api.calls[0]).toContain("name=laptop.wave.example.com");
  });

  test("says which name it could not place rather than failing silently", async () => {
    const provider = cloudflareProvider("token", api.fetch);
    await expect(provider.setTxt("_acme-challenge.host.elsewhere.test", "v")).rejects.toThrow(
      /no zone of this account/,
    );
  });
});

describe("hetzner", () => {
  test("names the record relative to its zone and deletes the one it wrote", async () => {
    const records = new Map<string, { name: string; value: string; type: string }>();
    const api = fakeApi((url, init) => {
      if (url.pathname === "/api/v1/zones") {
        return Response.json({ zones: [{ id: "z9", name: "wave.example.com" }] });
      }
      if (url.pathname === "/api/v1/records" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { name: string; value: string };
        records.set("r9", { ...body, type: "TXT" });
        return Response.json({ record: { id: "r9" } });
      }
      if (url.pathname === "/api/v1/records") {
        return Response.json({ records: [...records].map(([id, record]) => ({ id, ...record })) });
      }
      if (init?.method === "DELETE") {
        records.delete(url.pathname.split("/").pop() ?? "");
        // Hetzner answers a delete with no body at all.
        return new Response(null, { status: 200 });
      }
      return new Response("unexpected", { status: 400 });
    });

    const provider = hetznerProvider("token", api.fetch);
    await provider.setTxt("_acme-challenge.laptop.wave.example.com", "value");
    expect(records.get("r9")?.name).toBe("_acme-challenge.laptop");

    await provider.removeTxt("_acme-challenge.laptop.wave.example.com", "value");
    expect(records.size).toBe(0);
  });
});

describe("ionos", () => {
  interface IonosRecord {
    name: string;
    type: string;
    content: string;
    ttl?: number;
    prio?: number;
    disabled?: boolean;
  }

  /** The API as it behaves where it matters: absolute names, and TXT read back quoted. */
  function fakeIonos(): { fetch: typeof fetch; calls: string[]; records: Map<string, IonosRecord> } {
    const records = new Map<string, IonosRecord>();
    let issued = 0;
    const api = fakeApi((url, init) => {
      if (url.pathname === "/dns/v1/zones") {
        // Deliberately not longest-first: the candidates decide, not this order.
        return Response.json([
          { id: "z-parent", name: "example.com" },
          { id: "z-wave", name: "wave.example.com" },
        ]);
      }
      if (url.pathname === "/dns/v1/zones/z-wave/records" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as IonosRecord[];
        for (const record of body) records.set(`r${++issued}`, record);
        return new Response(null, { status: 201 });
      }
      if (url.pathname === "/dns/v1/zones/z-wave") {
        const name = url.searchParams.get("recordName") ?? "";
        const matching = [...records].filter(([, record]) => record.name === name);
        return Response.json({
          id: "z-wave",
          name: "wave.example.com",
          // Quoted on the way out, which is how IONOS stores a TXT value.
          records: matching.map(([id, record]) => ({ id, ...record, content: `"${record.content}"` })),
        });
      }
      if (init?.method === "DELETE") {
        records.delete(url.pathname.split("/").pop() ?? "");
        return new Response(null, { status: 200 });
      }
      return new Response("unexpected", { status: 400 });
    });
    return { ...api, records };
  }

  test("names the record absolutely and puts it in the longest matching zone", async () => {
    const api = fakeIonos();
    const provider = ionosProvider("prefix.secret", api.fetch);
    await provider.setTxt("_acme-challenge.laptop.wave.example.com", "value");

    expect([...api.records.values()]).toEqual([
      {
        name: "_acme-challenge.laptop.wave.example.com",
        type: "TXT",
        content: "value",
        ttl: 300,
        prio: 0,
        disabled: false,
      },
    ]);
    expect(api.calls).toContain("POST /dns/v1/zones/z-wave/records");
  });

  /**
   * The case this provider exists to survive: a wildcard order and an apex
   * order put two values at one name, and each has to leave the other alone.
   */
  test("adds beside an existing record and removes only its own value", async () => {
    const api = fakeIonos();
    const provider = ionosProvider("prefix.secret", api.fetch);
    const name = "_acme-challenge.wave.example.com";

    await provider.setTxt(name, "wildcard");
    await provider.setTxt(name, "apex");
    expect(api.records.size).toBe(2);

    await provider.removeTxt(name, "wildcard");
    expect([...api.records.values()].map((record) => record.content)).toEqual(["apex"]);
  });

  test("says which name it could not place rather than failing silently", async () => {
    const api = fakeIonos();
    const provider = ionosProvider("prefix.secret", api.fetch);
    await expect(provider.setTxt("_acme-challenge.host.elsewhere.test", "v")).rejects.toThrow(
      /no zone of this account/,
    );
  });

  test("an API that refuses says so with its own words", async () => {
    const refuse = (async () => new Response("invalid api key", { status: 401 })) as unknown as typeof fetch;
    await expect(
      ionosProvider("nope", refuse).setTxt("_acme-challenge.wave.example.com", "v"),
    ).rejects.toThrow(/ionos: 401 invalid api key/);
  });
});

describe("inwx", () => {
  interface NsRecord {
    name: string;
    type: string;
    content: string;
  }

  /** The DomRobot API, which is a session and a code in the body rather than a status. */
  function fakeInwx(options: { tfa?: string } = {}): {
    fetch: typeof fetch;
    calls: string[];
    tans: string[];
    records: Map<string, NsRecord>;
    expire: () => void;
  } {
    const records = new Map<string, NsRecord>();
    const calls: string[] = [];
    const tans: string[] = [];
    let issued = 0;
    let session: string | undefined;
    let unlocked = false;

    const answer = <T>(code: number, msg: string, resData?: T, headers?: Record<string, string>): Response =>
      Response.json({ code, msg, resData }, { headers });

    const fetchImpl = (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: Record<string, string> };
      const cookie = (init?.headers as Record<string, string> | undefined)?.cookie;
      calls.push(body.method);

      if (body.method === "account.login") {
        if (body.params.user !== "robin" || body.params.pass !== "secret") {
          return answer(2200, "Authentication error");
        }
        session = `s${++issued}`;
        unlocked = false;
        return answer(
          1000,
          "Command completed successfully",
          { tfa: options.tfa ?? "0" },
          {
            "set-cookie": `domrobot=${session}; path=/; HttpOnly`,
          },
        );
      }

      if (!session || cookie !== `domrobot=${session}`) return answer(2200, "Authentication error");

      if (body.method === "account.unlock") {
        tans.push(body.params.tan ?? "");
        unlocked = true;
        return answer(1000, "Command completed successfully");
      }
      if (options.tfa && !unlocked) return answer(2200, "Authentication error");

      if (body.method === "nameserver.info") {
        // The one call that is also the zone lookup: a domain this account does
        // not hold is an error, not an empty answer.
        if (body.params.domain !== "wave.example.com") return answer(2303, "Object does not exist");
        const record = [...records]
          .filter(([, entry]) => entry.name === body.params.name && entry.type === body.params.type)
          .map(([id, entry]) => ({ id, ...entry }));
        return answer(1000, "Command completed successfully", { domain: body.params.domain, record });
      }
      if (body.method === "nameserver.createRecord") {
        const duplicate = [...records.values()].some(
          (entry) => entry.name === body.params.name && entry.content === body.params.content,
        );
        if (duplicate) return answer(2302, "Object exists");
        records.set(`r${++issued}`, {
          name: body.params.name ?? "",
          type: body.params.type ?? "",
          content: body.params.content ?? "",
        });
        return answer(1000, "Command completed successfully", { id: `r${issued}` });
      }
      if (body.method === "nameserver.deleteRecord") {
        records.delete(String(body.params.id));
        return answer(1000, "Command completed successfully");
      }
      return answer(2303, `unexpected ${body.method}`);
    }) as typeof fetch;

    return {
      fetch: fetchImpl,
      calls,
      tans,
      records,
      expire: () => {
        session = undefined;
      },
    };
  }

  const account = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({ user: "robin", password: "secret", ...extra });

  const frozen: Clock = { now: () => 1_234_567_890_000, sleep: async () => {} };

  test("logs in once and keeps the session for the next call", async () => {
    const api = fakeInwx();
    const provider = inwxProvider(account(), api.fetch, frozen);
    const name = "_acme-challenge.laptop.wave.example.com";

    await provider.setTxt(name, "value");
    await provider.removeTxt(name, "value");

    expect(api.records.size).toBe(0);
    expect(api.calls.filter((call) => call === "account.login")).toHaveLength(1);
  });

  test("puts the record in the zone that holds it, named absolutely", async () => {
    const api = fakeInwx();
    await inwxProvider(account(), api.fetch, frozen).setTxt(
      "_acme-challenge.laptop.wave.example.com",
      "value",
    );
    expect([...api.records.values()]).toEqual([
      { name: "_acme-challenge.laptop.wave.example.com", type: "TXT", content: "value" },
    ]);
  });

  test("leaves the other order's record where it is", async () => {
    const api = fakeInwx();
    const provider = inwxProvider(account(), api.fetch, frozen);
    const name = "_acme-challenge.wave.example.com";

    await provider.setTxt(name, "wildcard");
    await provider.setTxt(name, "apex");
    await provider.removeTxt(name, "wildcard");

    expect([...api.records.values()].map((record) => record.content)).toEqual(["apex"]);
  });

  test("a record that is already there is what was wanted, not an error", async () => {
    const api = fakeInwx();
    const provider = inwxProvider(account(), api.fetch, frozen);
    await provider.setTxt("_acme-challenge.wave.example.com", "value");
    await provider.setTxt("_acme-challenge.wave.example.com", "value");
    expect(api.records.size).toBe(1);
  });

  test("answers the second factor when the account asks for one", async () => {
    const api = fakeInwx({ tfa: "GOOGLE-AUTH" });
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    await inwxProvider(account({ totpSecret: secret }), api.fetch, frozen).setTxt(
      "_acme-challenge.wave.example.com",
      "value",
    );
    expect(api.tans).toEqual([totp(secret, frozen.now())]);
  });

  test("an account with 2FA and no stored secret says exactly that", async () => {
    const api = fakeInwx({ tfa: "GOOGLE-AUTH" });
    await expect(
      inwxProvider(account(), api.fetch, frozen).setTxt("_acme-challenge.wave.example.com", "v"),
    ).rejects.toThrow(/asks for a second factor/);
  });

  /**
   * Two certificates can be months apart, and the session will not have lived
   * that long. Failing the renewal over it would be a fault that only ever
   * shows up in production.
   */
  test("an expired session is renewed once rather than failing the order", async () => {
    const api = fakeInwx();
    const provider = inwxProvider(account(), api.fetch, frozen);
    await provider.setTxt("_acme-challenge.wave.example.com", "first");

    api.expire();
    await provider.setTxt("_acme-challenge.wave.example.com", "second");

    expect(api.calls.filter((call) => call === "account.login")).toHaveLength(2);
    expect(api.records.size).toBe(2);
  });

  test("wrong credentials fail at the login, with the API's own code", async () => {
    const api = fakeInwx();
    const wrong = JSON.stringify({ user: "robin", password: "wrong" });
    await expect(
      inwxProvider(wrong, api.fetch, frozen).setTxt("_acme-challenge.wave.example.com", "v"),
    ).rejects.toThrow(/\(2200\)/);
  });

  test("a name in nobody's zone is named, not guessed at", async () => {
    const api = fakeInwx();
    await expect(
      inwxProvider(account(), api.fetch, frozen).setTxt("_acme-challenge.host.elsewhere.test", "v"),
    ).rejects.toThrow(/no zone of this account/);
  });

  describe("the credential", () => {
    test("is JSON, because a username and a password are two things", () => {
      expect(parseInwxAccount(account({ totpSecret: "AAAA", sandbox: true }))).toEqual({
        user: "robin",
        password: "secret",
        totpSecret: "AAAA",
        sandbox: true,
      });
    });

    test("says what is missing instead of failing later against the API", () => {
      expect(() => parseInwxAccount("just-a-token")).toThrow(/not JSON/);
      expect(() => parseInwxAccount(JSON.stringify({ user: "robin" }))).toThrow(/no password/);
      expect(() => parseInwxAccount(JSON.stringify({ password: "x" }))).toThrow(/no user/);
    });
  });

  /**
   * RFC 6238's own vectors, with the SHA-1 secret the document uses. A TOTP
   * that is wrong by one step is a login that fails for no visible reason.
   */
  describe("the second factor", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

    test("matches the RFC's test vectors", () => {
      expect(totp(secret, 59_000)).toBe("287082");
      expect(totp(secret, 1_111_111_109_000)).toBe("081804");
      expect(totp(secret, 1_234_567_890_000)).toBe("005924");
    });

    test("is not offered twice in one step", async () => {
      const api = fakeInwx({ tfa: "GOOGLE-AUTH" });
      let now = 1_234_567_890_000;
      const clock: Clock = {
        now: () => now,
        // The wait is what moves the clock: without it the second login would
        // present a code INWX has already seen and refuses.
        sleep: async (ms) => {
          now += ms;
        },
      };
      const provider = inwxProvider(account({ totpSecret: secret }), api.fetch, clock);

      await provider.setTxt("_acme-challenge.wave.example.com", "first");
      api.expire();
      await provider.setTxt("_acme-challenge.wave.example.com", "second");

      expect(api.tans).toHaveLength(2);
      expect(api.tans[0]).not.toBe(api.tans[1]);
    });
  });
});

describe("the token at rest", () => {
  const key = randomBytes(32);

  test("comes back out of the seal", () => {
    const sealed = sealSecret("cf-token", key);
    expect(sealed).not.toContain("cf-token");
    expect(openSecret(sealed, key)).toBe("cf-token");
  });

  test("a different key opens nothing", () => {
    expect(() => openSecret(sealSecret("cf-token", key), randomBytes(32))).toThrow();
  });

  // The tag is the point of GCM: a flipped byte has to be an error here rather
  // than a token with a flipped byte somewhere far away.
  test("a tampered seal is refused", () => {
    const sealed = sealSecret("cf-token", key);
    const parts = sealed.split(".");
    parts[3] = Buffer.from(`${Buffer.from(parts[3] ?? "", "base64url").toString("hex")}00`, "hex").toString(
      "base64url",
    );
    expect(() => openSecret(parts.join("."), key)).toThrow();
  });
});

describe("verifying a domain", () => {
  test("writes a record and takes it away again, which is the whole proof", async () => {
    const written: string[] = [];
    const removed: string[] = [];
    const provider = {
      kind: "fake",
      setTxt: async (name: string, value: string) => {
        written.push(`${name}=${value}`);
      },
      removeTxt: async (name: string, value: string) => {
        removed.push(`${name}=${value}`);
      },
    };

    await verifyZoneAccess(provider, "wave.example.com");
    expect(written[0]).toStartWith("_wave-verify.wave.example.com=");
    expect(removed).toEqual(written);
  });

  test("a token that cannot write says so", async () => {
    const refuse = (async () =>
      Response.json(
        { success: false, errors: [{ code: 6003, message: "invalid token" }] },
        { status: 403 },
      )) as unknown as typeof fetch;
    const provider = buildProvider("cloudflare", "nope", refuse);
    await expect(verifyZoneAccess(provider, "wave.example.com")).rejects.toThrow(/invalid token/);
  });
});
