import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { LoginThrottle, setPassword } from "../src/auth/password.ts";
import { redeemReset, requestReset, resetUrl } from "../src/auth/password-reset.ts";
import { createProviders } from "../src/auth/providers.ts";
import { identities, passwordResets, sessions, users } from "../src/db/schema.ts";
import { newId } from "../src/ids.ts";
import type { ResetThrottles } from "../src/routes/password-reset.ts";
import { CookieJar, createTestDb, type TestDb, testConfig, testSigningKey } from "./helpers.ts";
import { MailSink } from "./mail-sink.ts";

/**
 * "Forgot password" (ticket #159). The mail goes into an in-process sink.
 *
 * What these tests pin down: the request answers the same for an account and
 * for nobody; the link is good once, for an hour, and a newer one withdraws the
 * older; spending it ends every session and starts none; and without a mail
 * server none of it exists.
 */

let testDb: TestDb;
beforeAll(async () => {
  testDb = await createTestDb();
});
afterAll(() => testDb.close());

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const OLD = "correct horse battery staple";
const NEW = "a brand new passphrase";
const EMAIL = "robin@example.com";

interface Setup {
  env?: Record<string, string>;
  /** `null`: no mail server at all. */
  mailer?: MailSink | null;
  throttles?: ResetThrottles;
  minDurationMs?: number;
}

async function setup(options: Setup = {}) {
  await testDb.reset();
  const sink = options.mailer === null ? undefined : (options.mailer ?? new MailSink());
  const config = testConfig(options.env ?? {});
  const app = createApp({
    db: testDb.db,
    config,
    providers: createProviders(config),
    signingKey: testSigningKey(),
    ...(sink ? { mailer: sink } : {}),
    resetThrottles: options.throttles ?? {
      perAddressAndSource: new LoginThrottle(1000),
      perAddress: new LoginThrottle(1000),
      perSource: new LoginThrottle(1000),
    },
    resetMinDurationMs: options.minDurationMs ?? 0,
  });
  return { app, sink, config };
}

type App = Awaited<ReturnType<typeof setup>>["app"];

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  body: new URLSearchParams(fields),
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
});

const forgot = (app: App, email: string, headers: Record<string, string> = {}) =>
  app.request("/auth/password/forgot", form({ email }, headers));
const reset = (app: App, token: string, password = NEW, headers: Record<string, string> = {}) =>
  app.request("/auth/password/reset", form({ token, password }, headers));
const logIn = (app: App, email: string, password: string) =>
  app.request("/auth/password/login", form({ email, password, next: "/" }));

const shape = async (res: Response) => ({
  status: res.status,
  location: res.headers.get("location"),
  body: await res.text(),
});

const account = (email = EMAIL, password = OLD) => setPassword(testDb.db, email, password);
const rows = () => testDb.db.select().from(passwordResets);

describe("without a mail server", () => {
  test("the providers answer says passwordReset: false, and every endpoint is a 404", async () => {
    const { app } = await setup({ mailer: null });
    await account();
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer.passwordReset).toBe(false);

    expect((await forgot(app, EMAIL)).status).toBe(404);
    expect((await reset(app, "x")).status).toBe(404);
    expect((await app.request("/api/auth/password-reset/check?token=x")).status).toBe(404);
    for (const path of ["/password/forgot", "/password/forgot/sent", "/password/reset?token=x"]) {
      expect((await app.request(path)).status).toBe(404);
    }
    expect(await rows()).toHaveLength(0);
  });

  test("the sign-in page has no 'forgot password' link; with a switch on it still has none", async () => {
    const { app } = await setup({ mailer: null, env: { WAVE_SIGNUP_ENABLED: "true" } });
    const page = await (await app.request("/auth/password/login")).text();
    expect(page).not.toContain("/password/forgot");
    expect(page).not.toContain('data-field="forgot-link"');
  });

  test("a self-hosted server without SMTP is as before: config without SMTP gives no mailer", async () => {
    await testDb.reset();
    const config = testConfig({});
    const app = createApp({
      db: testDb.db,
      config,
      providers: createProviders(config),
      signingKey: testSigningKey(),
    });
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer.passwordReset).toBe(false);
  });
});

describe("with a mail server", () => {
  test("the providers answer says passwordReset: true, independent of the sign-up switch", async () => {
    const { app } = await setup();
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer.passwordReset).toBe(true);
    expect(answer.signup).toBe(false);
  });

  test("the sign-in page links to it, in both languages", async () => {
    const { app } = await setup();
    const en = await (
      await app.request("/auth/password/login", { headers: { "accept-language": "en" } })
    ).text();
    expect(en).toContain('href="/password/forgot"');
    expect(en).toContain("Forgot password");
    const de = await (
      await app.request("/auth/password/login", { headers: { "accept-language": "de" } })
    ).text();
    expect(de).toContain('href="/password/forgot"');
    expect(de).toContain("Passwort vergessen");
  });

  test("the request page is a form for an address", async () => {
    const { app } = await setup();
    const page = await (await app.request("/password/forgot")).text();
    expect(page).toContain('action="/auth/password/forgot"');
    expect(page).toContain('name="email"');
  });
});

describe("the request is the same for every address", () => {
  test("an account with a password and an unknown address end on the same page with the same text", async () => {
    const { app, sink } = await setup();
    await account();

    const known = await forgot(app, EMAIL);
    const unknown = await forgot(app, "nobody@example.com");
    expect(known.status).toBe(303);
    expect(await shape(known)).toEqual(await shape(unknown));
    expect(known.headers.get("location")).toBe("/password/forgot/sent");

    const sent = await shape(
      await app.request("/password/forgot/sent", { headers: { "accept-language": "en" } }),
    );
    expect(sent.body).toContain('data-reset="sent"');
    expect(sent.body).toContain("If there is an account for this address");

    // The difference is in the mailbox only.
    expect(sink?.sent).toHaveLength(1);
    expect(sink?.sent[0]?.to).toBe(EMAIL);
  });

  test("an account without a password gets no link, an address nobody owns gets nothing", async () => {
    const { app, sink } = await setup();
    // Signs in through a provider only.
    const userId = newId("u");
    await testDb.db.insert(users).values({ id: userId, email: "pat@example.com", emailVerified: true });
    await testDb.db
      .insert(identities)
      .values({ id: newId("i"), userId, provider: "oidc", subject: "p1", email: "pat@example.com" });
    // A placeholder a payment made: no password, no login.
    await testDb.db.insert(users).values({ id: newId("u"), email: "paid@example.com", emailVerified: false });

    const a = await shape(await forgot(app, "pat@example.com"));
    const b = await shape(await forgot(app, "paid@example.com"));
    const c = await shape(await forgot(app, "nobody@example.com"));
    expect(a).toEqual(b);
    expect(b).toEqual(c);

    expect(await rows()).toHaveLength(0);
    // The one hint mail has no reset link.
    expect(sink?.to("paid@example.com")).toHaveLength(0);
    expect(sink?.to("nobody@example.com")).toHaveLength(0);
    expect(sink?.to("pat@example.com")).toHaveLength(1);
    expect(sink?.to("pat@example.com")[0]?.text).not.toContain("/password/reset");
    expect(() => MailSink.resetTokenOf(sink?.to("pat@example.com")[0])).toThrow();
  });

  test("a mail that cannot be sent changes nothing the person sees", async () => {
    const sink = new MailSink();
    const { app } = await setup({ mailer: sink });
    await account();
    sink.failing = true;
    const known = await shape(await forgot(app, EMAIL));
    const unknown = await shape(await forgot(app, "nobody@example.com"));
    expect(known).toEqual(unknown);
    expect(known.status).toBe(303);
  });

  test("a mail that cannot be sent is logged without the address the transport quotes", async () => {
    const sink = new MailSink();
    const { app } = await setup({ mailer: sink });
    await account();
    sink.failing = true;
    sink.failure = `550 5.1.1 <${EMAIL}>: recipient rejected for ${EMAIL.toUpperCase()}`;
    const errors = spyOn(console, "error").mockImplementation(() => {});
    cleanup.push(() => errors.mockRestore());
    errors.mockClear();
    expect((await forgot(app, EMAIL)).status).toBe(303);
    await Bun.sleep(20);
    const lines = errors.mock.calls.map((call) => String(call[0]));
    expect(
      lines.some(
        (l) => l.includes("password reset: mail could not be sent") && l.includes("recipient rejected"),
      ),
    ).toBe(true);
    expect(lines.join("\n").toLowerCase()).not.toContain(EMAIL);
  });

  test("it takes at least as long as the floor, for an account and for nobody", async () => {
    const { app } = await setup({ minDurationMs: 150 });
    await account();
    for (const address of [EMAIL, "nobody@example.com"]) {
      const started = performance.now();
      await forgot(app, address);
      expect(performance.now() - started).toBeGreaterThanOrEqual(140);
    }
  });

  test("something that is not an address is refused, and sends nothing", async () => {
    const { app, sink } = await setup();
    const res = await forgot(app, "robin");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('data-error="invalid-email"');
    expect(sink?.sent).toHaveLength(0);
  });

  test("the address is lowercased and trimmed", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, "  Robin@Example.COM ");
    expect(sink?.to(EMAIL)).toHaveLength(1);
  });
});

describe("the mail", () => {
  test("one link, an hour, in the language of the request", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL, { "accept-language": "en" });
    await forgot(app, EMAIL, { "accept-language": "de" });
    const [en, de] = sink?.sent ?? [];
    expect(en?.subject).toBe("Reset your wave-mesh password");
    expect(en?.text).toContain("http://localhost:8080/password/reset?token=");
    expect(en?.text).toContain("for 1 hour");
    expect(de?.subject).toBe("Setze dein wave-mesh-Passwort zurück");
    expect(de?.text).toContain("1 Stunde");
    expect(en?.text.match(/https?:\/\//g)).toHaveLength(1);
    expect(de?.text.match(/https?:\/\//g)).toHaveLength(1);
  });

  test("the token is stored only as its hash", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);
    const [row] = await rows();
    expect(row?.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
    expect(row && row.expiresAt.getTime() - row.createdAt.getTime()).toBeGreaterThan(59 * 60_000);
    expect(row && row.expiresAt.getTime() - row.createdAt.getTime()).toBeLessThanOrEqual(61 * 60_000);
  });
});

describe("the whole way", () => {
  test("request, page, new password, sign-in -- and no session from the link", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);

    // Opening the link only shows the form; it spends nothing.
    for (let i = 0; i < 2; i++) {
      const page = await app.request(`/password/reset?token=${token}`, {
        headers: { "accept-language": "en" },
      });
      expect(page.status).toBe(200);
      expect(page.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await page.text();
      expect(html).toContain('action="/auth/password/reset"');
      expect(html).toContain('name="password"');
      expect(html).toContain('minlength="12"');
    }

    const done = await reset(app, token);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/auth/password/login?notice=password-changed");
    // Not signed in by it.
    expect(done.headers.get("set-cookie")).toBeNull();
    const login = await (
      await app.request("/auth/password/login?notice=password-changed", {
        headers: { "accept-language": "en" },
      })
    ).text();
    expect(login).toContain("Password changed");

    expect((await logIn(app, EMAIL, OLD)).status).toBe(401);
    const ok = await logIn(app, EMAIL, NEW);
    expect(ok.status).toBe(302);
    expect(ok.headers.get("set-cookie")).toContain("wave_session=");
  });

  test("the link works once", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);

    expect((await reset(app, token)).status).toBe(303);
    const second = await reset(app, token, "yet another passphrase");
    expect(second.status).toBe(410);
    expect(await second.text()).toContain('data-reset="gone"');
    expect((await app.request(`/password/reset?token=${token}`)).status).toBe(410);
    // The first password stands.
    expect((await logIn(app, EMAIL, NEW)).status).toBe(302);
    expect((await logIn(app, EMAIL, "yet another passphrase")).status).toBe(401);
  });

  test("two uses at the same moment: one changes the password, the other finds it spent", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);
    const results = await Promise.all([
      reset(app, token, "first passphrase!"),
      reset(app, token, "second passphrase"),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([303, 410]);
  });

  test("a link that never was is the 'gone' page", async () => {
    const { app } = await setup();
    const res = await app.request("/password/reset?token=nonsense");
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('data-reset="gone"');
    expect((await reset(app, "nonsense")).status).toBe(410);
    expect((await app.request("/password/reset")).status).toBe(410);
  });

  test("a password that is too short or too long is refused and the link stays good", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);

    const short = await reset(app, token, "elevenchars", { "accept-language": "en" });
    expect(short.status).toBe(400);
    const html = await short.text();
    expect(html).toContain('data-error="password-too-short"');
    expect(html).toContain('name="token"');
    const long = await reset(app, token, "x".repeat(2000));
    expect(long.status).toBe(400);
    expect(await long.text()).toContain('data-error="password-too-long"');

    expect((await logIn(app, EMAIL, OLD)).status).toBe(302);
    expect((await reset(app, token, "twelve-chars")).status).toBe(303);
  });

  test("the form is refused from another origin, and nothing changes", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);

    expect((await reset(app, token, NEW, { origin: "https://evil.example" })).status).toBe(403);
    expect((await reset(app, token, NEW, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await reset(app, token, NEW, { origin: "null" })).status).toBe(403);
    expect((await logIn(app, EMAIL, OLD)).status).toBe(302);
    expect((await reset(app, token, NEW, { origin: "http://localhost:8080" })).status).toBe(303);
  });
});

describe("links", () => {
  test("a link expires after an hour", async () => {
    const { sink } = await setup();
    await account();
    const t0 = new Date("2026-01-01T10:00:00Z");
    const request = await requestReset(testDb.db, { email: EMAIL, now: t0 });
    expect(request.kind).toBe("pending");
    const token = request.kind === "pending" ? request.token : "";
    expect(sink?.sent).toHaveLength(0);

    expect(await redeemReset(testDb.db, token, NEW, new Date(t0.getTime() + 60 * 60_000 + 1))).toEqual({
      kind: "gone",
    });
    // Within the hour it would have worked.
    expect((await redeemReset(testDb.db, token, NEW, new Date(t0.getTime() + 59 * 60_000))).kind).toBe(
      "changed",
    );
  });

  test("a new request withdraws the earlier links of the address", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    await forgot(app, EMAIL);
    const [first, second] = (sink?.sent ?? []).map((mail) => MailSink.resetTokenOf(mail));
    expect(first).not.toBe(second);

    expect((await app.request(`/password/reset?token=${first}`)).status).toBe(410);
    expect((await reset(app, first ?? "")).status).toBe(410);
    expect((await logIn(app, EMAIL, OLD)).status).toBe(302);
    expect((await app.request(`/password/reset?token=${second}`)).status).toBe(200);
    expect((await reset(app, second ?? "")).status).toBe(303);
  });

  test("the check endpoint says whether a link is good, and spends nothing", async () => {
    const { app, sink } = await setup();
    await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);
    const check = async (value: string) =>
      (
        (await (await app.request(`/api/auth/password-reset/check?token=${value}`)).json()) as {
          valid: boolean;
        }
      ).valid;
    expect(await check(token)).toBe(true);
    expect(await check(token)).toBe(true);
    expect(await check("nonsense")).toBe(false);
    await reset(app, token);
    expect(await check(token)).toBe(false);
  });

  test("an account that lost its password meanwhile is not given one by a link", async () => {
    const { app, sink } = await setup();
    const { userId } = await account();
    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);
    await testDb.db.update(users).set({ passwordHash: null }).where(eq(users.id, userId));
    expect((await reset(app, token)).status).toBe(410);
    const [user] = await testDb.db.select().from(users).where(eq(users.id, userId));
    expect(user?.passwordHash).toBeNull();
  });

  test("resetUrl puts the token in the query of the base address", () => {
    expect(resetUrl("https://wave.example/", "a b")).toBe("https://wave.example/password/reset?token=a%20b");
  });
});

describe("after the reset", () => {
  test("every session of the account ends, those of others stay", async () => {
    const { app, sink } = await setup();
    await account();
    await account("sam@example.com", OLD);

    const open = async (email: string) => {
      const jar = new CookieJar();
      jar.absorb(await logIn(app, email, OLD));
      return jar;
    };
    const robin1 = await open(EMAIL);
    const robin2 = await open(EMAIL);
    const sam = await open("sam@example.com");
    const me = async (jar: CookieJar) =>
      (await app.request("/api/me", { headers: { cookie: jar.header() } })).status;
    expect([await me(robin1), await me(robin2), await me(sam)]).toEqual([200, 200, 200]);

    await forgot(app, EMAIL);
    const token = MailSink.resetTokenOf(sink?.sent[0]);
    // A browser that is signed in may use the link, too.
    expect((await reset(app, token)).status).toBe(303);

    expect([await me(robin1), await me(robin2), await me(sam)]).toEqual([401, 401, 200]);
    const [robin] = await testDb.db.select().from(users).where(eq(users.email, EMAIL));
    expect(
      await testDb.db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, robin?.id ?? "")),
    ).toHaveLength(0);
  });

  test("the password hash is replaced by an Argon2id hash", async () => {
    const { app, sink } = await setup();
    await account();
    const [before] = await testDb.db.select().from(users).where(eq(users.email, EMAIL));
    await forgot(app, EMAIL);
    await reset(app, MailSink.resetTokenOf(sink?.sent[0]));
    const [after] = await testDb.db.select().from(users).where(eq(users.email, EMAIL));
    expect(after?.passwordHash).toStartWith("$argon2id$");
    expect(after?.passwordHash).not.toBe(before?.passwordHash);
    expect(after?.passwordHash).not.toContain(NEW);
  });
});

describe("throttling", () => {
  test("every request counts: past the limit the answer is 429, whatever the account", async () => {
    const throttles: ResetThrottles = {
      perAddressAndSource: new LoginThrottle(2),
      perAddress: new LoginThrottle(1000),
      perSource: new LoginThrottle(1000),
    };
    const { app, sink } = await setup({ throttles });
    await account();

    for (const address of [EMAIL, "nobody@example.com"]) {
      expect((await forgot(app, address)).status).toBe(303);
      expect((await forgot(app, address)).status).toBe(303);
    }
    const known = await shape(await forgot(app, EMAIL));
    const unknown = await shape(await forgot(app, "nobody@example.com"));
    expect(known.status).toBe(429);
    expect(known).toEqual(unknown);
    expect(known.body).toContain('data-error="throttled"');
    // The two that went through before the limit; nothing after it.
    expect(sink?.to(EMAIL)).toHaveLength(2);
  });

  test("per address from anywhere, and per source across addresses", async () => {
    const perAddress: ResetThrottles = {
      perAddressAndSource: new LoginThrottle(1000),
      perAddress: new LoginThrottle(2),
      perSource: new LoginThrottle(1000),
    };
    const a = await setup({ throttles: perAddress });
    await forgot(a.app, EMAIL);
    await forgot(a.app, EMAIL);
    expect((await forgot(a.app, EMAIL)).status).toBe(429);
    expect((await forgot(a.app, "other@example.com")).status).toBe(303);

    const perSource: ResetThrottles = {
      perAddressAndSource: new LoginThrottle(1000),
      perAddress: new LoginThrottle(1000),
      perSource: new LoginThrottle(2),
    };
    const b = await setup({ throttles: perSource });
    await forgot(b.app, "one@example.com");
    await forgot(b.app, "two@example.com");
    expect((await forgot(b.app, "three@example.com")).status).toBe(429);
  });

  test("a refused request has no mail and no row", async () => {
    const throttles: ResetThrottles = {
      perAddressAndSource: new LoginThrottle(1),
      perAddress: new LoginThrottle(1000),
      perSource: new LoginThrottle(1000),
    };
    const { app, sink } = await setup({ throttles });
    await account();
    await forgot(app, EMAIL);
    expect((await forgot(app, EMAIL)).status).toBe(429);
    expect(sink?.sent).toHaveLength(1);
    expect(await rows()).toHaveLength(1);
  });
});

describe("with a frontend", () => {
  const env = { WAVE_WEB_URL: "http://web.test" };

  test("the pages belong to the frontend; the POSTs answer with redirects and codes", async () => {
    const { app, sink } = await setup({ env });
    await account();

    // Control serves none of the pages itself: they go to the proxy.
    expect((await forgot(app, EMAIL)).headers.get("location")).toBe("/password/forgot/sent");
    const bad = await forgot(app, "robin");
    expect(bad.status).toBe(303);
    expect(bad.headers.get("location")).toBe("/password/forgot?error=invalid-email");

    const token = MailSink.resetTokenOf(sink?.sent[0]);
    const short = await reset(app, token, "short");
    expect(short.headers.get("location")).toBe(`/password/reset?token=${token}&error=password-too-short`);
    const done = await reset(app, token);
    expect(done.status).toBe(303);
    expect(done.headers.get("location")).toBe("/login?notice=password-changed");
    const gone = await reset(app, token);
    expect(gone.headers.get("location")).toBe("/password/reset?state=gone");
  });

  test("a refusal by the throttle is a redirect with its code", async () => {
    const throttles: ResetThrottles = {
      perAddressAndSource: new LoginThrottle(1),
      perAddress: new LoginThrottle(1000),
      perSource: new LoginThrottle(1000),
    };
    const { app } = await setup({ env, throttles });
    await forgot(app, EMAIL);
    const refused = await forgot(app, EMAIL);
    expect(refused.headers.get("location")).toBe("/password/forgot?error=throttled");
  });

  test("without a mailer the POSTs and the check are 404", async () => {
    const { app } = await setup({ env, mailer: null });
    expect((await forgot(app, EMAIL)).status).toBe(404);
    expect((await reset(app, "x")).status).toBe(404);
    expect((await app.request("/api/auth/password-reset/check?token=x")).status).toBe(404);
  });
});
