import { beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import {
  buildAuthorizationHeader,
  createCsr,
  der,
  generateCertificateKey,
  generateKeyPair,
  leafOf,
} from "@wave/crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { createProviders } from "../src/auth/providers.ts";
import { CertificateService } from "../src/certs/issue.ts";
import type { Database } from "../src/db/client.ts";
import { certificateOrders, nodes } from "../src/db/schema.ts";
import { storeDnsCredential } from "../src/dns/credentials.ts";
import type { Config } from "../src/env.ts";
import { type FakeCa, fakeCa } from "./fake-ca.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The certificate flow end to end, against a CA that checks everything a real
 * one checks -- signatures, nonces and the TXT record itself.
 *
 * What it cannot cover is Let's Encrypt itself; what it does cover is every
 * step this project is responsible for between a node's key and the chain.
 */

const DNS_SECRET = randomBytes(32).toString("base64");
const DAY = 24 * 60 * 60 * 1000;

let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;
let ca: FakeCa;
let config: Config;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  ca = fakeCa();
  app = build();
});

function build(options: { ca?: FakeCa } = {}) {
  const used = options.ca ?? ca;
  config = testConfig({ WAVE_ACME_DIRECTORY: used.directoryUrl, WAVE_DNS_SECRET: DNS_SECRET });
  const certs = new CertificateService({
    db,
    config,
    fetch: used.fetch,
    // The zone is a Map here, so asking it is asking the same thing the fake
    // CA looks at -- which is what makes the manual mode testable at all.
    lookupTxt: async (name) => [...(used.zone.records.get(name) ?? [])],
    // Nothing here sleeps: there is nothing to propagate and nothing to wait
    // for, and no reason to make a waiting order sit out its interval.
    sleep: async () => {},
    propagationMs: 0,
    checkIntervalMs: 0,
    log: () => {},
  });
  return createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey(), certs });
}

function makeMachine(hostname: string) {
  const machine = generateKeyPair("ed25519");
  return {
    hostname,
    machine,
    registerBody: {
      machineKey: machine.publicKey,
      nodeKey: generateKeyPair("x25519").publicKey,
      discoKey: generateKeyPair("x25519").publicKey,
      hostname,
      os: "linux" as const,
    },
  };
}

type Machine = ReturnType<typeof makeMachine>;

const signedRequest = (machine: Machine, method: string, path: string, body?: unknown) => {
  const payload = body === undefined ? "" : JSON.stringify(body);
  return app.request(path, {
    method,
    body: method === "GET" ? undefined : payload,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.machine.publicKey,
        machinePrivateKey: machine.machine.privateKey,
        method,
        path,
        body: payload,
      }),
    },
  });
};

async function login(email: string, suffix: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request("/auth/dev/start");
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const cb = await app.request(`/auth/dev/callback?code=${encodeURIComponent(email)}&state=${state}`, {
    headers: { cookie: jar.header() },
  });
  jar.absorb(cb);
  await createWaveAs((path, init) => app.request(path, init), jar, email, { suffix });
  return jar;
}

async function enrol(machine: Machine, jar: CookieJar) {
  const res = await signedRequest(machine, "POST", "/v1/machine/register", machine.registerBody);
  const pending = (await res.json()) as { authUrl: string };
  const form = new FormData();
  form.set("request", new URL(pending.authUrl).searchParams.get("request") ?? "");
  await app.request("/machine/authorize", { method: "POST", body: form, headers: { cookie: jar.header() } });
}

/** A device in a wave whose domain is real, with a working DNS credential. */
async function setUp(options: { suffix?: string; credential?: boolean | "manual" } = {}) {
  const suffix = options.suffix ?? "wave.example.com";
  const jar = await login("robin@example.com", suffix);
  const machine = makeMachine("laptop");
  await enrol(machine, jar);

  const [node] = await db.select().from(nodes).limit(1);
  if (!node) throw new Error("the device did not get into the wave");
  if (options.credential === "manual") {
    await storeDnsCredential(db, { waveId: node.waveId, provider: "manual" });
  } else if (options.credential !== false) {
    await storeDnsCredential(db, {
      waveId: node.waveId,
      provider: "cloudflare",
      token: "cf-token",
      key: Buffer.from(DNS_SECRET, "base64"),
    });
  }
  return { machine, node, name: `${node.hostname}.${suffix}` };
}

const orderFor = async (machine: Machine, names: string[]) => {
  const key = generateCertificateKey();
  const csr = der.toPem("CERTIFICATE REQUEST", createCsr({ privateKeyPem: key.privateKeyPem, names }));
  const res = await signedRequest(machine, "POST", "/v1/cert/order", { csr, names });
  return { res, body: (await res.json()) as Record<string, string> };
};

/** Polls the way the node does, because the route answers before the CA does. */
async function awaitOrder(machine: Machine, orderId: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const res = await signedRequest(machine, "GET", `/v1/cert/order/${orderId}`);
    const body = (await res.json()) as Record<string, string>;
    if (body.status !== "pending") return body;
    await Bun.sleep(1);
  }
  throw new Error("the order never left pending");
}

describe("ordering a certificate", () => {
  test("issues a chain for the device's own name", async () => {
    const { machine, name } = await setUp();

    const { res, body } = await orderFor(machine, [name]);
    expect(res.status).toBe(202);
    expect(body.orderId).toBeTruthy();

    const finished = await awaitOrder(machine, body.orderId as string);
    expect(finished.status).toBe("issued");
    expect(leafOf(finished.chainPem as string).names).toEqual([name]);
    expect(ca.issued).toEqual([{ names: [name] }]);
  });

  // The record is what the CA looks at, so it has to be gone afterwards --
  // otherwise every renewal leaves one behind in a zone we do not own.
  test("the challenge record is removed again", async () => {
    const { machine, name } = await setUp();
    const { body } = await orderFor(machine, [name]);
    await awaitOrder(machine, body.orderId as string);
    expect([...ca.zone.records.keys()]).toEqual([]);
  });

  test("the renewal date comes from the CA's suggestion when there is one", async () => {
    const { machine, name } = await setUp();
    const { body } = await orderFor(machine, [name]);
    const finished = await awaitOrder(machine, body.orderId as string);

    const renewAt = Date.parse(finished.renewAt as string) - Date.now();
    expect(renewAt).toBeGreaterThan(9 * DAY);
    expect(renewAt).toBeLessThan(12 * DAY);
  });

  test("without renewal information it falls back to two thirds of the lifetime", async () => {
    ca = fakeCa({ withoutAri: true });
    app = build();
    const { machine, name } = await setUp();

    const { body } = await orderFor(machine, [name]);
    const finished = await awaitOrder(machine, body.orderId as string);

    const renewAt = Date.parse(finished.renewAt as string) - Date.now();
    expect(renewAt).toBeGreaterThan(59 * DAY);
    expect(renewAt).toBeLessThan(61 * DAY);
  });

  test("a second device gets its own certificate, on the same account", async () => {
    const { machine, name } = await setUp();
    await awaitOrder(machine, (await orderFor(machine, [name])).body.orderId as string);
    expect(ca.calls.filter((call) => call.endsWith("/new-account"))).toHaveLength(1);
  });
});

describe("what a device may ask for", () => {
  test("a name belonging to another device is refused", async () => {
    const { machine } = await setUp();
    const { res, body } = await orderFor(machine, ["desktop.wave.example.com"]);
    expect(res.status).toBe(403);
    expect(body.error).toContain("does not belong to this device");
    expect(ca.issued).toEqual([]);
  });

  test("the wave's wildcard needs an operator's say-so", async () => {
    const { machine } = await setUp();
    const { res, body } = await orderFor(machine, ["*.wave.example.com"]);
    expect(res.status).toBe(403);
    expect(body.error).toContain("allow-wildcard");
    expect(ca.issued).toEqual([]);
  });

  test("a wildcard below the wave is nobody's, granted or not", async () => {
    const { machine, node } = await setUp();
    await db.update(nodes).set({ wildcardAllowed: true }).where(eq(nodes.id, node.id));
    const { res, body } = await orderFor(machine, ["*.sub.wave.example.com"]);
    expect(res.status).toBe(403);
    expect(body.error).toContain("not this wave's wildcard");
  });

  test("the same name twice is refused before the CA sees it", async () => {
    const { machine, name } = await setUp();
    const { res } = await orderFor(machine, [name, name]);
    expect(res.status).toBe(400);
  });

  test("the placeholder domain is refused before anything is ordered", async () => {
    const { machine } = await setUp({ suffix: "robin.wave.internal" });
    const { res, body } = await orderFor(machine, ["laptop.robin.wave.internal"]);
    expect(res.status).toBe(400);
    expect(body.error).toContain("placeholder");
    expect(ca.calls).toEqual([]);
  });

  // The names field and the request have to agree: the check above reads the
  // field, the CA reads the request, and a certificate is what the request says.
  test("a request asking for something else than the names field is refused", async () => {
    const { machine, name } = await setUp();
    const key = generateCertificateKey();
    const csr = der.toPem(
      "CERTIFICATE REQUEST",
      createCsr({ privateKeyPem: key.privateKeyPem, names: ["desktop.wave.example.com"] }),
    );
    const res = await signedRequest(machine, "POST", "/v1/cert/order", { csr, names: [name] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Record<string, string>).error).toContain("desktop.wave.example.com");
  });

  test("an unsigned request gets nowhere", async () => {
    await setUp();
    const res = await app.request("/v1/cert/order", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
  });

  test("another device's order is not readable", async () => {
    const { machine, name } = await setUp();
    const { body } = await orderFor(machine, [name]);

    const jar = await login("mara@example.com", "mara.wave.example.com");
    const other = makeMachine("desktop");
    await enrol(other, jar);
    const res = await signedRequest(other, "GET", `/v1/cert/order/${body.orderId}`);
    expect(res.status).toBe(404);
  });

  test("one order per device at a time", async () => {
    const { machine, node, name } = await setUp();
    // Inserted rather than raced: the guard is what is being tested, not how
    // quickly the fake CA answers.
    await db.insert(certificateOrders).values({
      id: "cert_open",
      waveId: node.waveId,
      nodeId: node.id,
      names: [name],
      csr: "",
    });
    const { res, body } = await orderFor(machine, [name]);
    expect(res.status).toBe(409);
    expect(body.error).toContain("still running");
  });
});

describe("writing the record by hand", () => {
  /** Polls until the order stops being pending, as the node does. */
  const poll = async (machine: Machine, orderId: string) => {
    for (let attempt = 0; attempt < 500; attempt++) {
      const res = await signedRequest(machine, "GET", `/v1/cert/order/${orderId}`);
      const body = (await res.json()) as Record<string, string>;
      if (body.status !== "pending") return body;
      await Bun.sleep(1);
    }
    throw new Error("the order never left pending");
  };

  test("says which record to create, and waits for it", async () => {
    const { machine, name } = await setUp({ credential: "manual" });
    const { body } = await orderFor(machine, [name]);

    const waiting = (await poll(machine, body.orderId as string)) as unknown as {
      status: string;
      records: { name: string; value: string }[];
    };
    expect(waiting.status).toBe("waiting");
    expect(waiting.records[0]?.name).toBe(`_acme-challenge.${name}`);
    expect(waiting.records[0]?.value).toBeTruthy();
    // Nothing was ordered from the CA beyond the authorization itself, and
    // above all nothing was written into the zone.
    expect(ca.issued).toEqual([]);
    expect([...ca.zone.records.keys()]).toEqual([]);
  });

  test("carries on by itself once the record is there", async () => {
    const { machine, name } = await setUp({ credential: "manual" });
    const { body } = await orderFor(machine, [name]);
    const orderId = body.orderId as string;

    const waiting = (await poll(machine, orderId)) as unknown as {
      records: { name: string; value: string }[];
    };
    const record = waiting.records[0];
    if (!record) throw new Error("no record was named");

    // What a person does in their hoster's web form.
    ca.zone.records.set(record.name, new Set([record.value]));

    const finished = await poll(machine, orderId);
    expect(finished.status).toBe("issued");
    expect(leafOf(finished.chainPem as string).names).toEqual([name]);
    // Nobody removes it for them -- the server never had the means to.
    expect([...ca.zone.records.keys()]).toEqual([record.name]);
  });

  // Asking again is how somebody says "I have made it now"; a second order
  // would mean a second record to create, for nothing.
  test("asking again takes up the same order rather than starting another", async () => {
    const { machine, name } = await setUp({ credential: "manual" });
    const first = await orderFor(machine, [name]);
    await poll(machine, first.body.orderId as string);

    const second = await orderFor(machine, [name]);
    expect(second.res.status).toBe(202);
    expect(second.body.orderId).toBe(first.body.orderId as string);
    expect(ca.calls.filter((call) => call.endsWith("/new-order"))).toHaveLength(1);
  });

  test("a wrong record value leaves the order waiting", async () => {
    const { machine, name } = await setUp({ credential: "manual" });
    const { body } = await orderFor(machine, [name]);
    const waiting = (await poll(machine, body.orderId as string)) as unknown as {
      records: { name: string; value: string }[];
    };
    const record = waiting.records[0];
    if (!record) throw new Error("no record was named");

    // A typo, or the wrong zone: the CA must not be told to look at this.
    ca.zone.records.set(record.name, new Set(["not-the-value"]));
    const still = await poll(machine, body.orderId as string);
    expect(still.status).toBe("waiting");
    expect(ca.issued).toEqual([]);
  });
});

describe("the wave's wildcard", () => {
  /** What an operator does with `admin.ts allow-wildcard`. */
  const grant = (nodeId: string) =>
    db.update(nodes).set({ wildcardAllowed: true }).where(eq(nodes.id, nodeId));

  test("is issued to a device that was granted it, with the zone's own name", async () => {
    const { machine, node } = await setUp();
    await grant(node.id);

    const names = ["*.wave.example.com", "wave.example.com"];
    const { res, body } = await orderFor(machine, names);
    expect(res.status).toBe(202);

    const finished = await awaitOrder(machine, body.orderId as string);
    expect(finished.status).toBe("issued");
    expect(leafOf(finished.chainPem as string).names).toEqual(names);
  });

  // The record for a wildcard sits at the zone's own name, without the
  // asterisk -- and the two authorizations of a combined order therefore want
  // two records with the *same* name and different values.
  test("answers at the zone's own name, twice over", async () => {
    const { machine, node } = await setUp({ credential: "manual" });
    await grant(node.id);
    const { body } = await orderFor(machine, ["*.wave.example.com", "wave.example.com"]);

    let waiting: { status: string; records: { name: string; value: string }[] } | undefined;
    for (let attempt = 0; attempt < 500 && !waiting; attempt++) {
      const res = await signedRequest(machine, "GET", `/v1/cert/order/${body.orderId}`);
      const answer = (await res.json()) as { status: string; records: { name: string; value: string }[] };
      if (answer.status !== "pending") waiting = answer;
      else await Bun.sleep(1);
    }
    if (!waiting) throw new Error("the order never left pending");

    expect(waiting.status).toBe("waiting");
    expect(waiting.records).toHaveLength(2);
    expect(waiting.records.map((record) => record.name)).toEqual([
      "_acme-challenge.wave.example.com",
      "_acme-challenge.wave.example.com",
    ]);
    expect(waiting.records[0]?.value).not.toBe(waiting.records[1]?.value);
  });

  test("both records can live under that one name", async () => {
    const { machine, node } = await setUp();
    await grant(node.id);
    const { body } = await orderFor(machine, ["*.wave.example.com", "wave.example.com"]);
    await awaitOrder(machine, body.orderId as string);

    // Written one after the other and removed one by one: a provider that
    // replaced the record instead of adding would have failed the second half.
    expect(ca.issued).toEqual([{ names: ["*.wave.example.com", "wave.example.com"] }]);
    expect([...ca.zone.records.keys()]).toEqual([]);
  });

  test("taking the grant back takes the wildcard back", async () => {
    const { machine, node } = await setUp();
    await grant(node.id);
    await db.update(nodes).set({ wildcardAllowed: false }).where(eq(nodes.id, node.id));

    const { res } = await orderFor(machine, ["*.wave.example.com"]);
    expect(res.status).toBe(403);
  });
});

describe("when the zone cannot be written", () => {
  test("the order fails with something the operator can act on", async () => {
    const { machine, name } = await setUp({ credential: false });
    const { res, body } = await orderFor(machine, [name]);
    expect(res.status).toBe(202);

    const finished = await awaitOrder(machine, body.orderId as string);
    expect(finished.status).toBe("failed");
    expect(finished.error).toContain("set-dns-provider");
  });
});
