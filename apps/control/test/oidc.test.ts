import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, type KeyObject, sign } from "node:crypto";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { OidcProvider } from "../src/auth/oidc.ts";
import type { OAuthProvider } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import { type OidcConfig, parseOidc } from "../src/env.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * Sign-in through an OpenID Connect provider, against one built here: a
 * discovery document, a key set and a token endpoint that checks the PKCE
 * verifier the way Pocket ID does. What matters is what gets refused.
 */

const ISSUER = "https://id.example.com";
const CLIENT = "wave-client";
const SECRET = "s3cret";
const REDIRECT = "http://localhost:8080/auth/oidc/callback";
const config: OidcConfig = { issuer: ISSUER, clientId: CLIENT, clientSecret: SECRET, name: "Pocket ID" };

type Alg = "RS256" | "ES256";

function keyPair(alg: Alg, kid: string) {
  const pair =
    alg === "RS256"
      ? generateKeyPairSync("rsa", { modulusLength: 2048 })
      : generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    alg,
    kid,
    privateKey: pair.privateKey,
    jwk: { ...pair.publicKey.export({ format: "jwk" }), kid, alg },
  };
}

function jwt(
  header: Record<string, unknown>,
  payload: Record<string, unknown>,
  key: KeyObject | null,
): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const data = `${enc(header)}.${enc(payload)}`;
  if (!key) return `${data}.`;
  const signature =
    header.alg === "ES256"
      ? sign("sha256", Buffer.from(data), { key, dsaEncoding: "ieee-p1363" })
      : sign("sha256", Buffer.from(data), key);
  return `${data}.${signature.toString("base64url")}`;
}

/** A provider with one code it will exchange, and an ID token it says it issued. */
function fakeProvider(options: { discoveryIssuer?: string } = {}) {
  const state = {
    keys: [keyPair("RS256", "k1")],
    challenge: "",
    token: "",
    fetches: [] as string[],
    tokenRequests: [] as { auth: string | null; body: URLSearchParams }[],
  };
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    state.fetches.push(url);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: options.discoveryIssuer ?? ISSUER,
        authorization_endpoint: `${ISSUER}/authorize`,
        token_endpoint: `${ISSUER}/api/oidc/token`,
        jwks_uri: `${ISSUER}/.well-known/jwks.json`,
      });
    }
    if (url === `${ISSUER}/.well-known/jwks.json`)
      return Response.json({ keys: state.keys.map((k) => k.jwk) });
    if (url === `${ISSUER}/api/oidc/token`) {
      const body = new URLSearchParams(String(init?.body));
      const auth = new Headers(init?.headers).get("authorization");
      state.tokenRequests.push({ auth, body });
      const verifier = body.get("code_verifier") ?? "";
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      if (body.get("code") !== "the-code" || challenge !== state.challenge) {
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      }
      return Response.json({ access_token: "at", token_type: "Bearer", id_token: state.token });
    }
    return new Response("not found", { status: 404 });
  };
  const now = Math.floor(Date.now() / 1000);
  const claims = (extra: Record<string, unknown> = {}) => ({
    iss: ISSUER,
    sub: "user-42",
    aud: CLIENT,
    exp: now + 300,
    iat: now,
    email: "Robin@Example.com",
    email_verified: true,
    name: "Robin",
    ...extra,
  });
  const issue = (extra: Record<string, unknown> = {}, key = state.keys[0]) => {
    if (!key) throw new Error("no key");
    state.token = jwt({ alg: key.alg, kid: key.kid, typ: "JWT" }, claims(extra), key.privateKey);
  };
  return { state, fetcher, issue, claims };
}

/** Starts a flow and pretends the person signed in at the provider. */
async function authorize(provider: OidcProvider, fake: ReturnType<typeof fakeProvider>): Promise<string> {
  const verifier = "v".repeat(43);
  const url = await provider.createAuthorizationURL("st", verifier);
  fake.state.challenge = url.searchParams.get("code_challenge") ?? "";
  return verifier;
}

describe("signing in through an OIDC provider", () => {
  test("asks with PKCE and the right scopes, and reads the verified claims", async () => {
    const fake = fakeProvider();
    const provider = new OidcProvider(config, REDIRECT, fake.fetcher);
    const verifier = "v".repeat(43);
    const url = await provider.createAuthorizationURL("the-state", verifier);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("client_id")).toBe(CLIENT);
    expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(url.searchParams.get("scope")).toBe("openid profile email");
    expect(url.searchParams.get("state")).toBe("the-state");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");

    fake.state.challenge = url.searchParams.get("code_challenge") ?? "";
    fake.issue();
    const claims = await provider.fetchClaims("the-code", verifier);
    expect(claims).toEqual({
      provider: `oidc:${ISSUER}`,
      subject: "user-42",
      email: "Robin@Example.com",
      emailVerified: true,
      name: "Robin",
      avatarUrl: null,
    });
    // client_secret_basic, and no secret in the body.
    const request = fake.state.tokenRequests[0];
    expect(request?.auth).toBe(`Basic ${Buffer.from(`${CLIENT}:${SECRET}`).toString("base64")}`);
    expect(request?.body.get("client_secret")).toBeNull();
  });

  test("a public client sends its id in the body and rests on PKCE", async () => {
    const fake = fakeProvider();
    const provider = new OidcProvider({ ...config, clientSecret: undefined }, REDIRECT, fake.fetcher);
    const verifier = await authorize(provider, fake);
    fake.issue();
    await provider.fetchClaims("the-code", verifier);
    expect(fake.state.tokenRequests[0]?.auth).toBeNull();
    expect(fake.state.tokenRequests[0]?.body.get("client_id")).toBe(CLIENT);
  });

  test("ECDSA tokens verify too, signed the JWS way (r‖s)", async () => {
    const fake = fakeProvider();
    fake.state.keys = [keyPair("ES256", "ec1")];
    const provider = new OidcProvider(config, REDIRECT, fake.fetcher);
    const verifier = await authorize(provider, fake);
    fake.issue();
    expect((await provider.fetchClaims("the-code", verifier)).subject).toBe("user-42");
  });

  test("an address the provider does not vouch for is not verified here either", async () => {
    for (const value of [false, "false", undefined]) {
      const fake = fakeProvider();
      const provider = new OidcProvider(config, REDIRECT, fake.fetcher);
      const verifier = await authorize(provider, fake);
      fake.issue({ email_verified: value });
      expect((await provider.fetchClaims("the-code", verifier)).emailVerified).toBe(false);
    }
  });

  test("a rotated key is fetched once more before a token is called forged", async () => {
    const fake = fakeProvider();
    const provider = new OidcProvider(config, REDIRECT, fake.fetcher);
    let verifier = await authorize(provider, fake);
    fake.issue();
    await provider.fetchClaims("the-code", verifier);

    const rotated = keyPair("RS256", "k2");
    fake.state.keys = [rotated];
    verifier = await authorize(provider, fake);
    fake.issue({}, rotated);
    await provider.fetchClaims("the-code", verifier);
    expect(fake.state.fetches.filter((url) => url.endsWith("jwks.json"))).toHaveLength(2);
  });

  test("refuses what is not this provider's token for this client, now", async () => {
    const stranger = keyPair("RS256", "k1");
    const cases: [string, (fake: ReturnType<typeof fakeProvider>) => void, RegExp][] = [
      ["another issuer", (f) => f.issue({ iss: "https://evil.example.com" }), /issued by/],
      ["another client", (f) => f.issue({ aud: "someone-else" }), /another client/],
      ["several audiences, handed elsewhere", (f) => f.issue({ aud: [CLIENT, "x"], azp: "x" }), /handed/],
      ["expired", (f) => f.issue({ exp: Math.floor(Date.now() / 1000) - 3600 }), /expired/],
      ["from the future", (f) => f.issue({ iat: Math.floor(Date.now() / 1000) + 3600 }), /future/],
      ["signed by a stranger", (f) => f.issue({}, stranger), /does not verify/],
      [
        "alg none",
        (f) => {
          f.state.token = jwt({ alg: "none" }, f.claims(), null);
        },
        /not accepted/,
      ],
      [
        "HS256 with the public key as secret",
        (f) => {
          f.state.token = jwt({ alg: "HS256", kid: "k1" }, f.claims(), null);
        },
        /not accepted/,
      ],
    ];
    for (const [name, forge, error] of cases) {
      const fake = fakeProvider();
      const provider = new OidcProvider(config, REDIRECT, fake.fetcher);
      const verifier = await authorize(provider, fake);
      forge(fake);
      await expect(provider.fetchClaims("the-code", verifier), name).rejects.toThrow(error);
    }
  });

  test("a wrong verifier is the provider's to refuse, and it does", async () => {
    const fake = fakeProvider();
    const provider = new OidcProvider(config, REDIRECT, fake.fetcher);
    await authorize(provider, fake);
    fake.issue();
    await expect(provider.fetchClaims("the-code", "w".repeat(43))).rejects.toThrow(/400/);
  });

  test("a discovery document that names another issuer is not used", async () => {
    const fake = fakeProvider({ discoveryIssuer: "https://elsewhere.example.com" });
    const provider = new OidcProvider(config, REDIRECT, fake.fetcher);
    await expect(provider.createAuthorizationURL("s", "v".repeat(43))).rejects.toThrow(/calls itself/);
  });
});

describe("configuring it", () => {
  test("issuer and client id together, https unless on loopback, named after its host", () => {
    expect(parseOidc({})).toBeUndefined();
    expect(() => parseOidc({ WAVE_OIDC_ISSUER: ISSUER })).toThrow(/go together/);
    expect(() => parseOidc({ WAVE_OIDC_ISSUER: "http://id.example.com", WAVE_OIDC_CLIENT_ID: "c" })).toThrow(
      /https/,
    );
    expect(parseOidc({ WAVE_OIDC_ISSUER: "http://localhost:1411", WAVE_OIDC_CLIENT_ID: "c" })?.name).toBe(
      "localhost:1411",
    );
    expect(
      parseOidc({ WAVE_OIDC_ISSUER: `${ISSUER}/`, WAVE_OIDC_CLIENT_ID: "c", WAVE_OIDC_NAME: "Pocket ID" }),
    ).toEqual({ issuer: ISSUER, clientId: "c", clientSecret: undefined, name: "Pocket ID" });
  });
});

describe("through the server", () => {
  let db: Database;
  let close: () => Promise<void>;
  let reset: () => Promise<void>;
  let fake: ReturnType<typeof fakeProvider>;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    ({ db, close, reset } = await createTestDb());
  });

  afterAll(() => close());

  beforeEach(async () => {
    await reset();
    fake = fakeProvider();
    const appConfig = testConfig();
    const providers = new Map<string, OAuthProvider>([
      ["oidc", new OidcProvider(config, `${appConfig.baseUrl}/auth/oidc/callback`, fake.fetcher)],
    ]);
    app = createApp({ db, config: appConfig, providers, signingKey: testSigningKey() });
  });

  test("the button is named, and a first sign-in makes a verified account", async () => {
    const listed = await (await app.request("/api/auth/providers")).json();
    expect(listed).toEqual({ providers: ["oidc"], labels: { oidc: "Pocket ID" } });

    const jar = new CookieJar();
    const start = await app.request("/auth/oidc/start");
    jar.absorb(start);
    const location = new URL(start.headers.get("location") ?? "");
    fake.state.challenge = location.searchParams.get("code_challenge") ?? "";
    fake.issue();

    const callback = await app.request(
      `/auth/oidc/callback?code=the-code&state=${location.searchParams.get("state")}`,
      { headers: { cookie: jar.header() } },
    );
    expect(callback.status).toBe(302);
    // A fresh account has no wave yet, so it lands on the form.
    expect(callback.headers.get("location")).toBe("/waves/new");

    const [user] = await db.select().from(users).where(eq(users.email, "robin@example.com"));
    expect(user?.emailVerified).toBe(true);
    expect(user?.name).toBe("Robin");
  });

  test("a provider that cannot be reached says so instead of redirecting into nowhere", async () => {
    const appConfig = testConfig();
    const broken = new OidcProvider(config, `${appConfig.baseUrl}/auth/oidc/callback`, async () => {
      throw new Error("ECONNREFUSED");
    });
    const brokenApp = createApp({
      db,
      config: appConfig,
      providers: new Map<string, OAuthProvider>([["oidc", broken]]),
      signingKey: testSigningKey(),
    });
    expect((await brokenApp.request("/auth/oidc/start")).status).toBe(502);
  });
});
