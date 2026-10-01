import { createHash, createPublicKey, createVerify } from "node:crypto";
import { generateCertificateKey, readCsr, selfSignedCertificate, toPem } from "@wave/crypto";

/**
 * A CA and a DNS provider, both fake, both strict.
 *
 * Strict is the point: this one verifies every JWS signature, consumes every
 * nonce, and validates a challenge only when the TXT record really is in the
 * fake zone with the right value. A flow that passes here is one where the
 * signing, the thumbprint and the record value are all right -- which is
 * exactly what cannot be tried against the real Let's Encrypt from a test.
 */

export interface FakeZone {
  /** name -> values, as a nameserver would hold it. */
  records: Map<string, Set<string>>;
}

interface Account {
  id: string;
  jwk: Record<string, string>;
}

interface Challenge {
  id: string;
  token: string;
  triggered: boolean;
}

interface Authorization {
  id: string;
  /** Always the bare name: an authorization for a wildcard is one for its zone. */
  identifier: string;
  wildcard: boolean;
  challenge: Challenge;
}

interface Order {
  id: string;
  names: string[];
  authorizations: Authorization[];
  certificate?: string;
  finalized: boolean;
}

export interface FakeCaOptions {
  /** Leave the renewal-info endpoint out of the directory, as an older CA does. */
  withoutAri?: boolean;
  /** The lifetime the fake CA issues for; 90 days unless a test wants otherwise. */
  lifetimeMs?: number;
}

export interface FakeCa {
  fetch: typeof fetch;
  zone: FakeZone;
  directoryUrl: string;
  /** Every certificate this CA has issued, newest last. */
  issued: { names: string[] }[];
  /** Requests that reached the CA, for asserting on what was and was not asked. */
  calls: string[];
}

const CA = "https://ca.test";
const DNS = "https://api.cloudflare.com";
const DAY = 24 * 60 * 60 * 1000;

export function fakeCa(options: FakeCaOptions = {}): FakeCa {
  const zone: FakeZone = { records: new Map() };
  const nonces = new Set<string>();
  const accounts = new Map<string, Account>();
  const orders = new Map<string, Order>();
  const certificates = new Map<string, string>();
  const issued: { names: string[] }[] = [];
  const calls: string[] = [];
  const issuerKey = generateCertificateKey();
  let counter = 0;
  const next = (prefix: string) => `${prefix}-${++counter}`;

  const mint = (): string => {
    const nonce = `n${++counter}`;
    nonces.add(nonce);
    return nonce;
  };

  const json = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json", "replay-nonce": mint(), ...init.headers },
    });

  const problem = (type: string, detail: string, status = 400): Response =>
    json({ type: `urn:ietf:params:acme:error:${type}`, detail }, { status });

  /** Unwraps a JWS the way a CA does: signature first, then everything else. */
  const unwrap = (url: string, body: string): { payload: unknown; account?: Account } => {
    const jws = JSON.parse(body) as { protected: string; payload: string; signature: string };
    const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as {
      alg: string;
      url: string;
      nonce: string;
      kid?: string;
      jwk?: Record<string, string>;
    };
    if (header.alg !== "ES256") throw new Error(`unexpected algorithm ${header.alg}`);
    if (header.url !== url) throw new Error(`signed for ${header.url}, sent to ${url}`);
    if (!nonces.delete(header.nonce)) throw new Error("bad nonce");

    const account = header.kid ? accounts.get(header.kid) : undefined;
    const jwk = header.jwk ?? account?.jwk;
    if (!jwk) throw new Error("neither a known account nor a key");

    const verified = createVerify("sha256")
      .update(`${jws.protected}.${jws.payload}`)
      .verify(
        { key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" },
        Buffer.from(jws.signature, "base64url"),
      );
    if (!verified) throw new Error("signature does not verify");

    return {
      payload: jws.payload ? JSON.parse(Buffer.from(jws.payload, "base64url").toString()) : "",
      account,
    };
  };

  const thumbprintOf = (jwk: Record<string, string>): string =>
    createHash("sha256")
      .update(`{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`)
      .digest("base64url");

  const authorizationState = (authorization: Authorization, account: Account | undefined): string => {
    if (!authorization.challenge.triggered || !account) return "pending";
    const expected = createHash("sha256")
      .update(`${authorization.challenge.token}.${thumbprintOf(account.jwk)}`)
      .digest("base64url");
    const values = zone.records.get(`_acme-challenge.${authorization.identifier}`);
    return values?.has(expected) ? "valid" : "invalid";
  };

  const orderBody = (order: Order, account: Account | undefined) => {
    const states = order.authorizations.map((a) => authorizationState(a, account));
    const status = states.includes("invalid")
      ? "invalid"
      : states.every((state) => state === "valid")
        ? order.finalized
          ? "valid"
          : "ready"
        : "pending";
    return {
      status,
      authorizations: order.authorizations.map((a) => `${CA}/authz/${a.id}`),
      finalize: `${CA}/finalize/${order.id}`,
      ...(status === "valid" ? { certificate: `${CA}/cert/${order.id}` } : {}),
    };
  };

  const ca = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    const path = url.pathname;

    if (path === "/directory") {
      return json({
        newNonce: `${CA}/nonce`,
        newAccount: `${CA}/new-account`,
        newOrder: `${CA}/new-order`,
        ...(options.withoutAri ? {} : { renewalInfo: `${CA}/renewal-info` }),
        meta: { termsOfService: `${CA}/terms` },
      });
    }
    if (path === "/nonce") return new Response(null, { status: 200, headers: { "replay-nonce": mint() } });

    if (path.startsWith("/renewal-info/")) {
      // Deliberately far from two thirds of the lifetime, so a test can see
      // which of the two decided the answer.
      const start = new Date(Date.now() + 10 * DAY);
      return json({
        suggestedWindow: { start: start.toISOString(), end: new Date(start.getTime() + DAY).toISOString() },
      });
    }

    let unwrapped: { payload: unknown; account?: Account };
    try {
      unwrapped = unwrap(url.href, String(init?.body ?? ""));
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      return problem(detail === "bad nonce" ? "badNonce" : "malformed", detail);
    }
    const { payload, account } = unwrapped;

    if (path === "/new-account") {
      const jws = JSON.parse(String(init?.body)) as { protected: string };
      const header = JSON.parse(Buffer.from(jws.protected, "base64url").toString()) as {
        jwk: Record<string, string>;
      };
      const id = `${CA}/account/${next("acct")}`;
      accounts.set(id, { id, jwk: header.jwk });
      return json({ status: "valid" }, { status: 201, headers: { location: id } });
    }

    if (path === "/new-order") {
      const body = payload as { identifiers: { value: string }[] };
      const id = next("order");
      const order: Order = {
        id,
        names: body.identifiers.map((identifier) => identifier.value),
        authorizations: body.identifiers.map((identifier) => ({
          id: next("authz"),
          // Like a real CA: the `*.` comes off, and the record therefore lives
          // at the zone's own name rather than under a literal asterisk.
          identifier: identifier.value.replace(/^\*\./, ""),
          wildcard: identifier.value.startsWith("*."),
          challenge: { id: next("chall"), token: next("token"), triggered: false },
        })),
        finalized: false,
      };
      orders.set(id, order);
      return json(orderBody(order, account), { status: 201, headers: { location: `${CA}/order/${id}` } });
    }

    if (path.startsWith("/authz/")) {
      const id = path.slice("/authz/".length);
      for (const order of orders.values()) {
        const authorization = order.authorizations.find((a) => a.id === id);
        if (!authorization) continue;
        return json({
          status: authorizationState(authorization, account),
          identifier: { type: "dns", value: authorization.identifier },
          ...(authorization.wildcard ? { wildcard: true } : {}),
          challenges: [
            {
              type: "dns-01",
              url: `${CA}/chall/${authorization.challenge.id}`,
              token: authorization.challenge.token,
              status: authorizationState(authorization, account),
            },
            { type: "http-01", url: `${CA}/chall/http`, token: "unused", status: "pending" },
          ],
        });
      }
      return problem("malformed", "no such authorization", 404);
    }

    if (path.startsWith("/chall/")) {
      const id = path.slice("/chall/".length);
      for (const order of orders.values()) {
        const authorization = order.authorizations.find((a) => a.challenge.id === id);
        if (!authorization) continue;
        authorization.challenge.triggered = true;
        return json({
          type: "dns-01",
          url: `${CA}/chall/${id}`,
          token: authorization.challenge.token,
          status: "processing",
        });
      }
      return problem("malformed", "no such challenge", 404);
    }

    if (path.startsWith("/order/")) {
      const order = orders.get(path.slice("/order/".length));
      if (!order) return problem("malformed", "no such order", 404);
      return json(orderBody(order, account));
    }

    if (path.startsWith("/finalize/")) {
      const order = orders.get(path.slice("/finalize/".length));
      if (!order) return problem("malformed", "no such order", 404);
      const body = payload as { csr: string };
      const csr = readCsr(Buffer.from(body.csr, "base64url"));
      // A real CA refuses a request that asks for something the order did not.
      if ([...csr.names].sort().join(",") !== [...order.names].sort().join(",")) {
        return problem("badCSR", `the request asks for ${csr.names.join(", ")}`);
      }

      const now = Date.now();
      const leaf = selfSignedCertificate({
        privateKeyPem: issuerKey.privateKeyPem,
        names: csr.names,
        notBefore: new Date(now),
        notAfter: new Date(now + (options.lifetimeMs ?? 90 * DAY)),
        serial: Buffer.from([0x11, 0x22, counter & 0xff]),
      });
      certificates.set(order.id, toPem("CERTIFICATE", leaf));
      issued.push({ names: csr.names });
      order.finalized = true;
      return json(orderBody(order, account));
    }

    if (path.startsWith("/cert/")) {
      const chain = certificates.get(path.slice("/cert/".length));
      if (!chain) return problem("malformed", "no such certificate", 404);
      return new Response(chain, {
        headers: { "content-type": "application/pem-certificate-chain", "replay-nonce": mint() },
      });
    }

    return problem("malformed", `unexpected ${path}`, 404);
  };

  /** The zone side: Cloudflare's API, enough of it to answer dns-01. */
  const dns = async (url: URL, init: RequestInit | undefined): Promise<Response> => {
    const ok = (result: unknown) => Response.json({ success: true, errors: [], result });
    const path = url.pathname;

    if (path === "/client/v4/zones") {
      const name = url.searchParams.get("name");
      // Only the wave's own zone exists, so a candidate above it finds nothing
      // -- which is what makes the walk up the labels worth testing.
      return ok(name === "wave.example.com" ? [{ id: "zone1", name }] : []);
    }
    if (path === "/client/v4/zones/zone1/dns_records" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { name: string; content: string };
      const values = zone.records.get(body.name) ?? new Set<string>();
      values.add(body.content);
      zone.records.set(body.name, values);
      return ok({ id: `rec-${body.name}-${body.content.slice(0, 8)}` });
    }
    if (path === "/client/v4/zones/zone1/dns_records") {
      const name = url.searchParams.get("name") ?? "";
      const values = [...(zone.records.get(name) ?? [])];
      return ok(values.map((content) => ({ id: `rec-${name}-${content.slice(0, 8)}`, name, content })));
    }
    if (path.startsWith("/client/v4/zones/zone1/dns_records/") && init?.method === "DELETE") {
      const id = path.slice("/client/v4/zones/zone1/dns_records/".length);
      for (const [name, values] of zone.records) {
        for (const value of values) {
          if (`rec-${name}-${value.slice(0, 8)}` !== id) continue;
          values.delete(value);
          if (values.size === 0) zone.records.delete(name);
          return ok({ id });
        }
      }
      return Response.json(
        { success: false, errors: [{ code: 81044, message: "record not found" }] },
        { status: 404 },
      );
    }
    return Response.json(
      { success: false, errors: [{ code: 7000, message: `unexpected ${path}` }] },
      { status: 400 },
    );
  };

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.origin === CA) return ca(url, init);
    if (url.origin === DNS) return dns(url, init);
    throw new Error(`the test reached ${url.origin}, which nothing should`);
  }) as typeof fetch;

  return { fetch: fetchImpl, zone, directoryUrl: `${CA}/directory`, issued, calls };
}
