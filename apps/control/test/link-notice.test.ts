import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { buildAuthorizationHeader, generateKeyPair } from "@wave/crypto";
import { createApp } from "../src/app.ts";
import type { ProviderClaims } from "../src/auth/identity.ts";
import { createProviders, type OAuthProvider } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { pageMessages } from "../src/routes/messages.ts";
import { CookieJar, createTestDb, createWaveAs, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The notice a split-off account (an address no provider vouched for) gets where
 * it is about to make a wave or add a device -- on the plain pages of a control
 * server running without the web app. It is only said, never enforced: the form
 * and the approval stay as they were, and no other account sees it.
 */

const OIDC = "oidc:https://idp.example";
const EMAIL = "robin@example.com";

class FakeProvider implements OAuthProvider {
  readonly id = "oidc";
  readonly label = "Pocket ID";
  readonly usesPkce = false;
  createAuthorizationURL(state: string): URL {
    const url = new URL("https://idp.example/oidc");
    url.searchParams.set("state", state);
    return url;
  }
  async fetchClaims(code: string): Promise<ProviderClaims> {
    return JSON.parse(code) as ProviderClaims;
  }
}

let db: Database;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeAll(async () => {
  ({ db, close, reset } = await createTestDb());
});
afterAll(() => close());

function makeApp(overrides: Record<string, string> = {}) {
  const config = testConfig(overrides);
  const providers = createProviders(config);
  providers.set("oidc", new FakeProvider());
  app = createApp({ db, config, providers, signingKey: testSigningKey() });
}

beforeEach(async () => {
  await reset();
  makeApp();
});

const request = (path: string, jar: CookieJar, headers: Record<string, string> = {}) =>
  app.request(path, { headers: { cookie: jar.header(), ...headers } });

/** A sign-in as a browser does it: start, then the callback with these claims. */
async function login(providerId: string, code: string): Promise<CookieJar> {
  const jar = new CookieJar();
  const start = await app.request(`/auth/${providerId}/start`);
  jar.absorb(start);
  const state = new URL(start.headers.get("location") ?? "").searchParams.get("state");
  const cb = await app.request(
    `/auth/${providerId}/callback?code=${encodeURIComponent(code)}&state=${state}`,
    {
      headers: { cookie: jar.header() },
    },
  );
  jar.absorb(cb);
  expect(jar.get("wave_session")).toBeTruthy();
  return jar;
}

/** Split off: the provider does not vouch for the address. */
const splitOff = (options: { wave?: boolean } = {}) =>
  login(
    "oidc",
    JSON.stringify({
      provider: OIDC,
      subject: "b-sub",
      email: EMAIL,
      emailVerified: false,
      name: "Robin",
      avatarUrl: null,
    } satisfies ProviderClaims),
  ).then(async (jar) => {
    if (options.wave) await createWaveAs((path, init) => app.request(path, init), jar, "b@example.com");
    return jar;
  });

/** An ordinary account, address vouched for by the dev sign-in. */
const ordinary = async (options: { wave?: boolean } = {}) => {
  const jar = await login("dev", EMAIL);
  if (options.wave) await createWaveAs((path, init) => app.request(path, init), jar, EMAIL);
  return jar;
};

/** A device asking to join, as `wave up` registers it; the id is what the link carries. */
async function askToJoin(hostname: string): Promise<string> {
  const machine = generateKeyPair("ed25519");
  const body = JSON.stringify({
    machineKey: machine.publicKey,
    nodeKey: generateKeyPair("x25519").publicKey,
    discoKey: generateKeyPair("x25519").publicKey,
    hostname,
    os: "linux" as const,
  });
  const res = await app.request("/v1/machine/register", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      authorization: buildAuthorizationHeader({
        machineKey: machine.publicKey,
        machinePrivateKey: machine.privateKey,
        method: "POST",
        path: "/v1/machine/register",
        body,
      }),
    },
  });
  const pending = (await res.json()) as { authUrl: string };
  return new URL(pending.authUrl).searchParams.get("request") ?? "";
}

const EN = pageMessages("en");
const DE = pageMessages("de");
const hasNotice = (page: string, m: typeof EN) =>
  page.includes('id="link-notice-title"') &&
  page.includes('href="/account/link"') &&
  page.includes(Bun.escapeHTML(m.linkActive(EMAIL))) &&
  page.includes(Bun.escapeHTML(m.linkWhyMissing));

describe("the notice on the create form", () => {
  test("a split-off account reads who is active and why a wave can be missing, in English and German", async () => {
    const jar = await splitOff();

    const en = await request("/waves/new", jar);
    expect(en.status).toBe(200);
    const english = await en.text();
    expect(hasNotice(english, EN)).toBe(true);
    // The form is still there, and so is the next step of the device link.
    expect(english).toContain('<form method="post" action="/waves">');

    const de = await (await request("/waves/new", jar, { "accept-language": "de" })).text();
    expect(hasNotice(de, DE)).toBe(true);
    expect(de).not.toContain(EN.linkWhyMissing);
  });

  test("it also stands on the page that says waves come with a subscription", async () => {
    makeApp({ WAVE_BILLING_TOKEN: "x".repeat(32) });
    const jar = await splitOff();

    const closed = await (await request("/waves/new", jar)).text();
    expect(closed).toContain(EN.noWaveCreation);
    expect(hasNotice(closed, EN)).toBe(true);
  });

  test("an ordinary account sees neither the notice nor any change", async () => {
    const jar = await ordinary();
    const page = await (await request("/waves/new", jar)).text();
    expect(page).toContain('<form method="post" action="/waves">');
    expect(page).not.toContain("link-notice-title");
    expect(page).not.toContain("/account/link");

    makeApp({ WAVE_BILLING_TOKEN: "x".repeat(32) });
    const closed = await ordinary();
    const closedPage = await (await request("/waves/new", closed)).text();
    expect(closedPage).toContain(EN.noWaveCreation);
    expect(closedPage).not.toContain("link-notice-title");
  });

  test("a split-off account can still make a wave: nothing is blocked", async () => {
    const jar = await splitOff();
    const res = await createWaveAs((path, init) => app.request(path, init), jar, "robin@example.com");
    expect(res.status).toBe(303);
  });
});

describe("the notice on the device approval", () => {
  test("a split-off account with no wave of its own meets it on the create form the link leads to", async () => {
    const jar = await splitOff();
    const id = await askToJoin("laptop");

    const authorize = await request(`/machine/authorize?request=${id}`, jar);
    expect(authorize.status).toBe(302);
    const target = authorize.headers.get("location") ?? "";
    expect(target).toStartWith("/waves/new?next=");

    const page = await (await request(target, jar)).text();
    expect(hasNotice(page, EN)).toBe(true);
    expect(page).toContain('name="next"');
  });

  test("a split-off account with a wave meets it before the one click that approves", async () => {
    const jar = await splitOff({ wave: true });
    const id = await askToJoin("laptop");

    const res = await request(`/machine/authorize?request=${id}`, jar);
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(hasNotice(page, EN)).toBe(true);
    // The approval itself is untouched.
    expect(page).toContain('action="/machine/authorize"');
    expect(page).toContain(`name="request" value="${id}"`);

    const de = await (
      await request(`/machine/authorize?request=${id}`, jar, { "accept-language": "de" })
    ).text();
    expect(hasNotice(de, DE)).toBe(true);
  });

  test("an ordinary account sees the approval as before", async () => {
    const jar = await ordinary({ wave: true });
    const id = await askToJoin("laptop");

    const page = await (await request(`/machine/authorize?request=${id}`, jar)).text();
    expect(page).toContain('action="/machine/authorize"');
    expect(page).not.toContain("link-notice-title");
    expect(page).not.toContain("/account/link");
  });

  test("the approval still works for a split-off account", async () => {
    const jar = await splitOff({ wave: true });
    const id = await askToJoin("laptop");
    const res = await app.request("/machine/authorize", {
      method: "POST",
      body: new URLSearchParams({ request: id }),
      headers: { cookie: jar.header() },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(EN.connected("laptop"));
  });
});
