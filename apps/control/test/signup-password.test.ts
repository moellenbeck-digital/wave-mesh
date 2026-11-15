import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { LoginThrottle, setPassword } from "../src/auth/password.ts";
import { createProviders, type OAuthProvider } from "../src/auth/providers.ts";
import { confirm, register, SIGNUP_TTL_MS } from "../src/auth/signup-password.ts";
import { identities, signupVerifications, users } from "../src/db/schema.ts";
import { loadConfig } from "../src/env.ts";
import { newId } from "../src/ids.ts";
import { createSmtpMailer } from "../src/mail.ts";
import { defaultSignupThrottles, type SignupThrottles } from "../src/routes/signup.ts";
import { CookieJar, createTestDb, createWaveAs, type TestDb, testConfig, testSigningKey } from "./helpers.ts";
import { MailSink, startSmtpSink } from "./mail-sink.ts";

/**
 * Registration with email and password (ticket #150). The mail goes into an
 * in-process sink; nothing here talks to a real server.
 *
 * What these tests pin down: an address that was not confirmed has no account
 * and so no login and no wave; the link is good once and for a day; a taken
 * address gets the same answer as a free one (and a mail that says so), and is
 * never merged; and the whole registration is not there without the switch or
 * without a mail server.
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

const PASSWORD = "correct horse battery staple";
const EMAIL = "robin@example.com";

/** A provider that never signs anybody in; the page only lists it. */
const oidcStub: OAuthProvider = {
  id: "oidc",
  label: "Pocket ID",
  usesPkce: true,
  createAuthorizationURL: () => new URL("https://id.example.test/authorize"),
  fetchClaims: async () => {
    throw new Error("not used");
  },
};

interface Setup {
  env?: Record<string, string>;
  /** `null`: no mail server at all. */
  mailer?: MailSink | null;
  providers?: Map<string, OAuthProvider>;
  throttles?: SignupThrottles;
}

async function setup(options: Setup = {}) {
  await testDb.reset();
  const sink = options.mailer === null ? undefined : (options.mailer ?? new MailSink());
  const config = testConfig({ WAVE_SIGNUP_ENABLED: "true", ...options.env });
  const app = createApp({
    db: testDb.db,
    config,
    providers: options.providers ?? new Map([...createProviders(config), ["oidc", oidcStub]]),
    signingKey: testSigningKey(),
    ...(sink ? { mailer: sink } : {}),
    // Roomy by default: the tests that look at the limits bring their own.
    signupThrottles: options.throttles ?? {
      perAddressAndSource: new LoginThrottle(1000),
      perAddress: new LoginThrottle(1000),
      perSource: new LoginThrottle(1000),
    },
  });
  return { app, sink, config };
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  body: new URLSearchParams(fields),
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
});

type App = Awaited<ReturnType<typeof setup>>["app"];

const signUp = (app: App, email: string, password = PASSWORD, headers: Record<string, string> = {}) =>
  app.request("/auth/signup", form({ email, password }, headers));

const confirmWith = (app: App, token: string) => app.request("/auth/signup/confirm", form({ token }));

const logIn = (app: App, email: string, password: string, next = "/waves/new") =>
  app.request("/auth/password/login", form({ email, password, next }));

/** What the browser would show for an answer: status, where it goes and what it says. */
const shape = async (res: Response) => ({
  status: res.status,
  location: res.headers.get("location"),
  body: await res.text(),
});

const userRows = (email: string) => testDb.db.select().from(users).where(eq(users.email, email));
const allUsers = () => testDb.db.select().from(users);
const allRegistrations = () => testDb.db.select().from(signupVerifications);

describe("the mail server setting", () => {
  const parse = (env: Record<string, string>) => loadConfig({ WAVE_ENV: "test", ...env }).smtp;

  test("unset and empty mean no mail", () => {
    expect(parse({})).toBeUndefined();
    expect(parse({ WAVE_SMTP_URL: "", WAVE_MAIL_FROM: "" })).toBeUndefined();
    expect(parse({ WAVE_SMTP_URL: "  " })).toBeUndefined();
    // A sender without a server sends nothing either.
    expect(parse({ WAVE_MAIL_FROM: "wave@example.com" })).toBeUndefined();
  });

  test("a server needs a sender, and has to be smtp:// or smtps://", () => {
    expect(
      parse({ WAVE_SMTP_URL: "smtp://user:pw@mail.example.com:587", WAVE_MAIL_FROM: "wave@example.com" }),
    ).toEqual({ url: "smtp://user:pw@mail.example.com:587", from: "wave@example.com" });
    expect(
      parse({ WAVE_SMTP_URL: "smtps://mail.example.com", WAVE_MAIL_FROM: "wave-mesh <w@example.com>" })?.from,
    ).toBe("wave-mesh <w@example.com>");
    expect(() => parse({ WAVE_SMTP_URL: "smtp://mail.example.com" })).toThrow("WAVE_MAIL_FROM");
    expect(() => parse({ WAVE_SMTP_URL: "https://mail.example.com", WAVE_MAIL_FROM: "a@b.c" })).toThrow(
      "smtp://",
    );
    expect(() => parse({ WAVE_SMTP_URL: "not a url", WAVE_MAIL_FROM: "a@b.c" })).toThrow("not a URL");
  });

  test("the app builds its mailer from it", async () => {
    await testDb.reset();
    const config = testConfig({
      WAVE_SIGNUP_ENABLED: "true",
      WAVE_SMTP_URL: "smtp://127.0.0.1:1",
      WAVE_MAIL_FROM: "wave@example.com",
    });
    const app = createApp({
      db: testDb.db,
      config,
      providers: createProviders(config),
      signingKey: testSigningKey(),
    });
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer.passwordSignup).toBe(true);
  });
});

describe("the SMTP transport", () => {
  test("hands a mail to the server with the configured sender", async () => {
    const smtp = await startSmtpSink();
    cleanup.push(() => smtp.close());
    const mailer = createSmtpMailer({
      url: `smtp://127.0.0.1:${smtp.port}`,
      from: "wave-mesh <noreply@example.com>",
    });
    await mailer.send({
      to: EMAIL,
      subject: "Hello",
      text: "Open https://wave.example/signup/confirm?token=abc\n",
    });

    expect(smtp.messages).toHaveLength(1);
    const message = smtp.messages[0];
    expect(message?.from).toBe("noreply@example.com");
    expect(message?.to).toEqual([EMAIL]);
    expect(message?.data).toContain("Subject: Hello");
    expect(message?.data).toContain("signup/confirm?token=abc");
  });

  test("rejects when nobody listens, so a registration never counts as sent", async () => {
    const mailer = createSmtpMailer({ url: "smtp://127.0.0.1:1", from: "noreply@example.com" });
    await expect(mailer.send({ to: EMAIL, subject: "x", text: "x" })).rejects.toBeDefined();
  });
});

describe("password rules and the address", () => {
  test("a password that is too short is refused: no mail, no registration, no account", async () => {
    const { app, sink } = await setup();
    const res = await signUp(app, EMAIL, "elevenchars");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('data-error="password-too-short"');
    expect(body).toContain("at least 12 characters");
    expect(sink?.sent).toHaveLength(0);
    expect(await allRegistrations()).toHaveLength(0);
    expect(await allUsers()).toHaveLength(0);
  });

  test("twelve characters are enough", async () => {
    const { app, sink } = await setup();
    expect((await signUp(app, EMAIL, "twelve-chars")).status).toBe(303);
    expect(sink?.sent).toHaveLength(1);
  });

  test("a password beyond a sane length is refused", async () => {
    const { app, sink } = await setup();
    const res = await signUp(app, EMAIL, "x".repeat(2000));
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('data-error="password-too-long"');
    expect(sink?.sent).toHaveLength(0);
  });

  test("something that is not an address is refused", async () => {
    const { app, sink } = await setup();
    for (const bad of [
      "",
      "robin",
      "robin@",
      "@example.com",
      "a b@example.com",
      "a@b@example.com",
      "a@example",
    ]) {
      const res = await signUp(app, bad);
      expect(res.status).toBe(400);
      expect(await res.text()).toContain('data-error="invalid-email"');
    }
    expect(sink?.sent).toHaveLength(0);
  });

  test("the address is lowercased and trimmed, like every other", async () => {
    const { app, sink } = await setup();
    await signUp(app, "  Robin@Example.COM ");
    expect(sink?.to(EMAIL)).toHaveLength(1);
    expect((await allRegistrations())[0]?.email).toBe(EMAIL);
  });

  test("the password is stored as an Argon2id hash and the token only as its hash", async () => {
    const { app, sink } = await setup();
    await signUp(app, EMAIL);
    const token = MailSink.tokenOf(sink?.to(EMAIL)[0]);
    const row = (await allRegistrations())[0];
    expect(row?.passwordHash).toStartWith("$argon2id$");
    expect(row?.passwordHash).not.toContain(PASSWORD);
    expect(row?.tokenHash).not.toBe(token);
    expect(JSON.stringify(row)).not.toContain(token);
  });
});

describe("registration, mail, link, login", () => {
  test("the whole way ends on /waves/new, and then a wave can be made", async () => {
    const { app, sink } = await setup();

    const sent = await signUp(app, EMAIL);
    expect(sent.status).toBe(303);
    expect(sent.headers.get("location")).toBe("/signup/sent");
    const notice = await app.request("/signup/sent", { headers: { "accept-language": "en" } });
    expect(await notice.text()).toContain('data-signup="sent"');

    expect(sink?.sent).toHaveLength(1);
    const mail = sink?.sent[0];
    expect(mail?.to).toBe(EMAIL);
    expect(mail?.text).toContain("http://localhost:8080/signup/confirm?token=");
    const token = MailSink.tokenOf(mail);

    // Nothing exists yet: no account, so nothing to sign in to.
    expect(await allUsers()).toHaveLength(0);

    // Opening the link only shows the button; the account is made by the POST.
    const page = await app.request(`/signup/confirm?token=${token}`, {
      headers: { "accept-language": "en" },
    });
    expect(page.status).toBe(200);
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain('data-action="signup-confirm"');
    expect(html).toContain('action="/auth/signup/confirm"');
    expect(await allUsers()).toHaveLength(0);

    const confirmed = await confirmWith(app, token);
    expect(confirmed.status).toBe(303);
    expect(confirmed.headers.get("location")).toBe("/signup/confirm?state=done");
    const done = await (await app.request("/signup/confirm?state=done")).text();
    expect(done).toContain('data-signup="confirmed"');
    expect(done).toContain('href="/auth/password/login?next=%2Fwaves%2Fnew"');

    const [user] = await userRows(EMAIL);
    expect(user?.emailVerified).toBe(true);
    expect(user?.passwordHash).toStartWith("$argon2id$");
    const [identity] = await testDb.db
      .select()
      .from(identities)
      .where(eq(identities.userId, user?.id ?? ""));
    expect(identity).toMatchObject({ provider: "password", subject: EMAIL });

    // Not signed in by the link: that is a login of its own.
    const jar = new CookieJar();
    const login = await logIn(app, EMAIL, PASSWORD);
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("/waves/new");
    jar.absorb(login);
    const me = (await (await app.request("/api/me", { headers: { cookie: jar.header() } })).json()) as {
      user: { email: string; emailVerified: boolean };
      canCreateWave: boolean;
      waves: unknown[];
    };
    expect(me.user).toMatchObject({ email: EMAIL, emailVerified: true });
    expect(me.waves).toHaveLength(0);
    expect(me.canCreateWave).toBe(true);
    expect((await createWaveAs((p, i) => app.request(p, i), jar, EMAIL)).status).toBe(303);
  });

  test("the mail is German on request", async () => {
    const { app, sink } = await setup();
    await signUp(app, EMAIL, PASSWORD, { "accept-language": "de" });
    expect(sink?.sent[0]?.subject).toBe("Bestätige dein wave-mesh-Konto");
    expect(sink?.sent[0]?.text).toContain("Der Link gilt einmal und 24 Stunden");
  });

  test("without confirmation there is no login, no session and no wave", async () => {
    const { app } = await setup();
    await signUp(app, EMAIL);

    // The password chosen is right, and still opens nothing.
    const login = await logIn(app, EMAIL, PASSWORD);
    expect(login.status).toBe(401);
    expect(login.headers.get("set-cookie")).toBeNull();

    expect((await app.request("/api/me")).status).toBe(401);
    expect((await app.request("/waves", form({ name: "robin", suffix: "robin.example.com" }))).status).toBe(
      401,
    );
    expect(await allUsers()).toHaveLength(0);
  });

  test("a page for a link that never was is the 'gone' page", async () => {
    const { app } = await setup();
    const res = await app.request("/signup/confirm?token=nonsense");
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('data-signup="gone"');
    const post = await confirmWith(app, "nonsense");
    expect(post.headers.get("location")).toBe("/signup/confirm?state=gone");
    expect(await allUsers()).toHaveLength(0);
  });
});

describe("the link is good once, and for a day", () => {
  test("a second use finds it spent and changes nothing", async () => {
    const { app, sink } = await setup();
    await signUp(app, EMAIL);
    const token = MailSink.tokenOf(sink?.sent[0]);

    expect((await confirmWith(app, token)).headers.get("location")).toBe("/signup/confirm?state=done");
    const [first] = await userRows(EMAIL);

    expect((await confirmWith(app, token)).headers.get("location")).toBe("/signup/confirm?state=gone");
    expect((await app.request(`/signup/confirm?token=${token}`)).status).toBe(410);
    expect(await userRows(EMAIL)).toHaveLength(1);
    expect((await userRows(EMAIL))[0]?.id).toBe(first?.id);
  });

  test("an expired link makes no account", async () => {
    const { app, sink } = await setup();
    await signUp(app, EMAIL);
    const token = MailSink.tokenOf(sink?.sent[0]);

    await testDb.db.update(signupVerifications).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await app.request(`/signup/confirm?token=${token}`)).status).toBe(410);
    expect((await confirmWith(app, token)).headers.get("location")).toBe("/signup/confirm?state=gone");
    expect(await allUsers()).toHaveLength(0);
    expect((await logIn(app, EMAIL, PASSWORD)).status).toBe(401);
  });

  test("the lifetime is a day", async () => {
    await testDb.reset();
    const now = new Date("2026-11-15T10:00:00Z");
    const registration = await register(testDb.db, { email: EMAIL, password: PASSWORD, now });
    if (registration.kind !== "pending") throw new Error("expected a pending registration");
    expect(SIGNUP_TTL_MS).toBe(24 * 60 * 60 * 1000);
    const late = new Date(now.getTime() + SIGNUP_TTL_MS + 1000);
    expect(await confirm(testDb.db, registration.token, late)).toEqual({ kind: "gone" });
    const early = new Date(now.getTime() + SIGNUP_TTL_MS - 1000);
    expect((await confirm(testDb.db, registration.token, early)).kind).toBe("confirmed");
  });

  test("two clicks at the same moment make one account", async () => {
    const { app, sink } = await setup();
    await signUp(app, EMAIL);
    const token = MailSink.tokenOf(sink?.sent[0]);
    const results = await Promise.all([confirmWith(app, token), confirmWith(app, token)]);
    const locations = results.map((r) => r.headers.get("location")).sort();
    expect(locations).toEqual(["/signup/confirm?state=done", "/signup/confirm?state=gone"]);
    expect(await userRows(EMAIL)).toHaveLength(1);
  });
});

describe("an address that is taken", () => {
  async function oidcAccount(email: string) {
    const id = newId("u");
    await testDb.db.insert(users).values({ id, email, emailVerified: true });
    await testDb.db
      .insert(identities)
      .values({ id: newId("i"), userId: id, provider: "oidc:https://id.example.test", subject: "42", email });
    return id;
  }

  const KNOWN = {
    oidc: async (email: string) => {
      await oidcAccount(email);
    },
    password: async (email: string) => {
      await setPassword(testDb.db, email, "an existing password");
    },
    "unverified provider account": async (email: string) => {
      const id = newId("u");
      await testDb.db.insert(users).values({ id, email, emailVerified: false });
      await testDb.db
        .insert(identities)
        .values({ id: newId("i"), userId: id, provider: "google", subject: "g-1", email });
    },
  };

  for (const [name, make] of Object.entries(KNOWN)) {
    test(`${name}: the answer is the one a new address gets, and the mail says so`, async () => {
      const { app, sink } = await setup();
      const fresh = await shape(await signUp(app, "new@example.com"));

      await make(EMAIL);
      const before = await allUsers();
      const known = await shape(await signUp(app, EMAIL, "another password!"));

      expect(known).toEqual(fresh);
      expect(known.status).toBe(303);
      expect(known.location).toBe("/signup/sent");

      // The mail goes to the address, tells the owner and links to the login; no confirmation link.
      const mail = sink?.to(EMAIL)[0];
      expect(sink?.to(EMAIL)).toHaveLength(1);
      expect(mail?.subject).toBe("You already have a wave-mesh account");
      expect(mail?.text).toContain("already has an account");
      expect(mail?.text).toContain("http://localhost:8080/");
      expect(mail?.text).not.toContain("/signup/confirm");

      // Nothing merged, nothing created, nothing pending.
      const after = await allUsers();
      expect(after.map((u) => u.id).sort()).toEqual(before.map((u) => u.id).sort());
      expect((await allRegistrations()).map((r) => r.email)).toEqual(["new@example.com"]);
      expect((await userRows(EMAIL))[0]?.passwordHash ?? null).toBe(
        before.find((u) => u.email === EMAIL)?.passwordHash ?? null,
      );
    });
  }

  test("the existing password still works, the new one does not", async () => {
    const { app } = await setup();
    await setPassword(testDb.db, EMAIL, "an existing password");
    await signUp(app, EMAIL, "somebody else's try");
    expect((await logIn(app, EMAIL, "an existing password")).status).toBe(302);
    expect((await logIn(app, EMAIL, "somebody else's try")).status).toBe(401);
  });

  test("an unconfirmed registration of the same address: a new mail, the old link dead, one account", async () => {
    const { app, sink } = await setup();
    const first = await shape(await signUp(app, EMAIL, "first password 12345"));
    const second = await shape(await signUp(app, EMAIL, "second password 1234"));
    expect(second).toEqual(first);

    const mails = sink?.to(EMAIL) ?? [];
    expect(mails).toHaveLength(2);
    const [oldToken, newToken] = [MailSink.tokenOf(mails[0]), MailSink.tokenOf(mails[1])];
    expect(newToken).not.toBe(oldToken);
    // Both are confirmation mails, not "you already have one": nothing is confirmed yet.
    expect(mails[1]?.subject).toBe("Confirm your wave-mesh account");

    expect((await confirmWith(app, oldToken)).headers.get("location")).toBe("/signup/confirm?state=gone");
    expect(await allUsers()).toHaveLength(0);
    expect((await confirmWith(app, newToken)).headers.get("location")).toBe("/signup/confirm?state=done");

    expect(await userRows(EMAIL)).toHaveLength(1);
    // The password of the registration whose link was used.
    expect((await logIn(app, EMAIL, "second password 1234")).status).toBe(302);
    expect((await logIn(app, EMAIL, "first password 12345")).status).toBe(401);
  });

  test("an account made after the registration is not taken over by its link", async () => {
    const { app, sink } = await setup();
    await signUp(app, EMAIL, "the registration pw");
    const token = MailSink.tokenOf(sink?.sent[0]);

    // The owner of the address signs in with their provider first.
    const id = await oidcAccount(EMAIL);
    expect((await confirmWith(app, token)).headers.get("location")).toBe("/signup/confirm?state=gone");

    const rows = await userRows(EMAIL);
    expect(rows.map((r) => r.id)).toEqual([id]);
    expect(rows[0]?.passwordHash).toBeNull();
    expect((await logIn(app, EMAIL, "the registration pw")).status).toBe(401);
  });

  test("an account a payment made and nobody claimed is claimed by the confirmation, not duplicated", async () => {
    const { app, sink } = await setup();
    const placeholder = newId("u");
    await testDb.db.insert(users).values({ id: placeholder, email: EMAIL, emailVerified: false });

    const fresh = await shape(await signUp(app, "new@example.com"));
    expect(await shape(await signUp(app, EMAIL))).toEqual(fresh);
    const mail = sink?.to(EMAIL)[0];
    expect(mail?.subject).toBe("Confirm your wave-mesh account");

    expect((await confirmWith(app, MailSink.tokenOf(mail))).headers.get("location")).toBe(
      "/signup/confirm?state=done",
    );
    const rows = await userRows(EMAIL);
    expect(rows.map((r) => r.id)).toEqual([placeholder]);
    expect(rows[0]?.emailVerified).toBe(true);
    expect((await logIn(app, EMAIL, PASSWORD)).status).toBe(302);
  });
});

describe("the same answer for every address", () => {
  test("status, target and page do not depend on the address", async () => {
    const { app } = await setup();
    await setPassword(testDb.db, EMAIL, "an existing password");
    const answers = [];
    for (const email of [EMAIL, "unknown@example.com", "other@example.org"]) {
      answers.push(await shape(await signUp(app, email)));
    }
    expect(new Set(answers.map((a) => JSON.stringify(a))).size).toBe(1);
  });

  test("a failing relay fails the same way for a taken and a free address", async () => {
    const { app, sink } = await setup();
    await setPassword(testDb.db, EMAIL, "an existing password");
    if (sink) sink.failing = true;
    const taken = await shape(await signUp(app, EMAIL));
    const free = await shape(await signUp(app, "free@example.com"));
    expect(taken.status).toBe(503);
    expect(taken).toEqual(free);
    expect(free.body).toContain('data-error="mail-failed"');
  });

  test("a mail that could not be sent never leaves a way in", async () => {
    const { app, sink } = await setup();
    if (sink) sink.failing = true;
    await signUp(app, EMAIL);
    expect(await allUsers()).toHaveLength(0);
    expect((await logIn(app, EMAIL, PASSWORD)).status).toBe(401);
  });
});

describe("the throttle", () => {
  const throttles = (over: Partial<Record<keyof SignupThrottles, LoginThrottle>> = {}): SignupThrottles => ({
    ...defaultSignupThrottles(),
    ...over,
  });

  test("the defaults let a person who mistypes through and stop a loop", () => {
    const limits = defaultSignupThrottles();
    for (let i = 0; i < 5; i++) {
      expect(limits.perAddressAndSource.blocked(EMAIL, "1.2.3.4")).toBe(false);
      limits.perAddressAndSource.hit(EMAIL, "1.2.3.4");
    }
    expect(limits.perAddressAndSource.blocked(EMAIL, "1.2.3.4")).toBe(true);
    expect(limits.perAddressAndSource.blocked("other@example.com", "1.2.3.4")).toBe(false);
  });

  test("per address and source: the third try is refused with 429", async () => {
    const { app, sink } = await setup({
      throttles: throttles({ perAddressAndSource: new LoginThrottle(2, 60_000) }),
    });
    expect((await signUp(app, EMAIL)).status).toBe(303);
    expect((await signUp(app, EMAIL)).status).toBe(303);
    const refused = await signUp(app, EMAIL);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain('data-error="throttled"');
    expect(sink?.sent).toHaveLength(2);
    // Another address is not held up by it.
    expect((await signUp(app, "other@example.com")).status).toBe(303);
  });

  test("the refusal is the same for an address that has an account", async () => {
    const { app } = await setup({
      throttles: throttles({ perAddressAndSource: new LoginThrottle(1, 60_000) }),
    });
    await setPassword(testDb.db, EMAIL, "an existing password");
    await signUp(app, EMAIL);
    await signUp(app, "free@example.com");
    const taken = await shape(await signUp(app, EMAIL));
    const free = await shape(await signUp(app, "free@example.com"));
    expect(taken.status).toBe(429);
    expect(taken).toEqual(free);
  });

  test("per address from anywhere: mails to one mailbox are bounded", async () => {
    const { app, sink } = await setup({
      throttles: throttles({ perAddress: new LoginThrottle(2, 60_000) }),
    });
    await signUp(app, EMAIL);
    await signUp(app, EMAIL);
    expect((await signUp(app, EMAIL)).status).toBe(429);
    expect(sink?.sent).toHaveLength(2);
  });

  test("per source: one machine does not walk through a list of addresses", async () => {
    const { app, sink } = await setup({
      throttles: throttles({ perSource: new LoginThrottle(3, 60_000) }),
    });
    for (const n of [1, 2, 3]) expect((await signUp(app, `user${n}@example.com`)).status).toBe(303);
    expect((await signUp(app, "user4@example.com")).status).toBe(429);
    expect(sink?.sent).toHaveLength(3);
  });

  test("a refused attempt counts too: a bad password does not buy free tries", async () => {
    const { app } = await setup({
      throttles: throttles({ perAddressAndSource: new LoginThrottle(2, 60_000) }),
    });
    expect((await signUp(app, EMAIL, "short")).status).toBe(400);
    expect((await signUp(app, EMAIL, "short")).status).toBe(400);
    expect((await signUp(app, EMAIL)).status).toBe(429);
  });
});

describe("with the switch off", () => {
  test("no page, no endpoint, no link, signup: false", async () => {
    const { app, sink } = await setup({ env: { WAVE_SIGNUP_ENABLED: "false" } });
    expect((await app.request("/signup")).status).toBe(404);
    expect((await app.request("/register")).status).toBe(404);
    expect((await app.request("/signup/confirm?token=x")).status).toBe(404);
    expect((await app.request("/signup/sent")).status).toBe(404);
    expect((await signUp(app, EMAIL)).status).toBe(404);
    expect((await confirmWith(app, "x")).status).toBe(404);

    expect(await (await app.request("/")).text()).not.toContain("/signup");
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer.signup).toBe(false);
    expect(answer.passwordSignup).toBe(false);
    expect(sink?.sent).toHaveLength(0);
    expect(await allRegistrations()).toHaveLength(0);
  });

  test("a mail server alone does not open it", async () => {
    // An empty switch is off, whatever else is configured.
    const { app, sink } = await setup({ env: { WAVE_SIGNUP_ENABLED: "" } });
    expect((await app.request("/signup")).status).toBe(404);
    expect((await signUp(app, EMAIL)).status).toBe(404);
    expect(sink?.sent).toHaveLength(0);
  });
});

describe("without a mail server", () => {
  test("/signup shows no form, the endpoints are not there, and providers say so", async () => {
    const { app } = await setup({ mailer: null });
    const res = await app.request("/signup", { headers: { "accept-language": "en" } });
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).not.toContain("<form");
    expect(body).not.toContain('type="password"');
    expect(body).not.toContain("/auth/signup");
    // The provider buttons stay.
    expect(body).toContain('data-provider="oidc"');

    expect((await signUp(app, EMAIL)).status).toBe(404);
    expect((await confirmWith(app, "x")).status).toBe(404);
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer.signup).toBe(true);
    expect(answer.passwordSignup).toBe(false);
    expect(await allRegistrations()).toHaveLength(0);
    expect(await allUsers()).toHaveLength(0);
  });

  test("without a provider either, the page says nobody can sign up yet", async () => {
    const { app } = await setup({ mailer: null, providers: new Map() });
    const body = await (await app.request("/signup", { headers: { "accept-language": "en" } })).text();
    expect(body).toContain('data-signup="no-provider"');
    expect(body).not.toContain("<form");
  });

  test("a confirmation link is not served either", async () => {
    const { app } = await setup({ mailer: null });
    expect((await app.request("/signup/confirm?token=x")).status).toBe(410);
  });
});

describe("with a mail server", () => {
  test("the form is on the page next to the provider buttons", async () => {
    const { app } = await setup();
    const body = await (await app.request("/signup", { headers: { "accept-language": "en" } })).text();
    expect(body).toContain('action="/auth/signup"');
    expect(body).toContain('data-field="email"');
    expect(body).toContain('data-field="password"');
    expect(body).toContain('data-action="signup-submit"');
    expect(body).toContain('minlength="12"');
    expect(body).toContain('data-provider="oidc"');
    expect(body).toContain("email_verified");
    // The development login is no registration.
    expect(body).not.toContain("/auth/dev/");
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ signup: true, passwordSignup: true });
  });

  test("without a provider only the form is there, and no hint that nothing is", async () => {
    const { app } = await setup({ providers: new Map() });
    const body = await (await app.request("/signup", { headers: { "accept-language": "en" } })).text();
    expect(body).toContain('data-signup="form"');
    expect(body).not.toContain("data-provider");
    expect(body).not.toContain("no-provider");
  });

  test("the page is German on request, and keeps the selectors", async () => {
    const { app } = await setup();
    const body = await (await app.request("/signup", { headers: { "accept-language": "de" } })).text();
    expect(body).toContain("Gratis starten");
    expect(body).toContain("Konto erstellen");
    expect(body).toContain('data-action="signup-submit"');
  });

  test("the old notes about no password field are gone", async () => {
    const { app } = await setup();
    const body = await (await app.request("/signup", { headers: { "accept-language": "en" } })).text();
    expect(body).not.toContain("No sign-in provider is configured");
  });
});

describe("with a frontend", () => {
  async function withFrontend() {
    const frontend = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: (req) => new Response(`next:${new URL(req.url).pathname}`),
    });
    cleanup.push(() => frontend.stop(true));
    return setup({ env: { WAVE_WEB_URL: `http://127.0.0.1:${frontend.port}` } });
  }

  test("errors go back to the page of the frontend with a code, success to its notice page", async () => {
    const { app, sink } = await withFrontend();
    const short = await signUp(app, EMAIL, "short");
    expect(short.status).toBe(303);
    expect(short.headers.get("location")).toBe("/signup?error=password-too-short");
    expect((await signUp(app, "nope")).headers.get("location")).toBe("/signup?error=invalid-email");

    const ok = await signUp(app, EMAIL);
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/signup/sent");
    expect(sink?.sent[0]?.text).toContain("/signup/confirm?token=");
  });

  test("confirmation redirects to the frontend's page; the pages themselves are the frontend's", async () => {
    const { app, sink } = await withFrontend();
    await signUp(app, EMAIL);
    const token = MailSink.tokenOf(sink?.sent[0]);
    expect(await (await app.request(`/signup/confirm?token=${token}`)).text()).toBe("next:/signup/confirm");
    expect((await confirmWith(app, token)).headers.get("location")).toBe("/signup/confirm?state=done");
    expect((await confirmWith(app, token)).headers.get("location")).toBe("/signup/confirm?state=gone");
  });

  test("the mail of a taken address links to the frontend's login", async () => {
    const { app, sink } = await withFrontend();
    await setPassword(testDb.db, EMAIL, "an existing password");
    await signUp(app, EMAIL);
    expect(sink?.sent[0]?.text).toContain("http://localhost:8080/login");
  });

  test("off: the two endpoints are 404 and are not proxied", async () => {
    const frontend = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("next") });
    cleanup.push(() => frontend.stop(true));
    const { app } = await setup({
      env: { WAVE_WEB_URL: `http://127.0.0.1:${frontend.port}`, WAVE_SIGNUP_ENABLED: "false" },
    });
    expect((await signUp(app, EMAIL)).status).toBe(404);
    expect((await confirmWith(app, "x")).status).toBe(404);
    const answer = (await (await app.request("/api/auth/providers")).json()) as Record<string, unknown>;
    expect(answer).toMatchObject({ signup: false, passwordSignup: false });
  });
});
