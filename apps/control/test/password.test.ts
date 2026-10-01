import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { LoginThrottle, setPassword, verifyLogin } from "../src/auth/password.ts";
import { createProviders } from "../src/auth/providers.ts";
import type { Database } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

let db: Database;
let close: () => Promise<void>;
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  if (close) await close();
  ({ db, close } = await createTestDb());
  const config = testConfig();
  app = createApp({ db, config, providers: createProviders(config), signingKey: testSigningKey() });
});

const PASSWORD = "correct horse battery staple";

const submit = (body: Record<string, string>, jar?: CookieJar) =>
  app.request("/auth/password/login", {
    method: "POST",
    body: new URLSearchParams(body),
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      ...(jar ? { cookie: jar.header() } : {}),
    },
  });

describe("passwords", () => {
  test("are stored hashed, never in the clear", async () => {
    await setPassword(db, "robin@example.com", PASSWORD);
    const rows = await db.select().from(users).where(eq(users.email, "robin@example.com"));
    expect(rows[0]?.passwordHash).toStartWith("$argon2id$");
    expect(rows[0]?.passwordHash).not.toContain(PASSWORD);
  });

  test("accept the right one and reject anything else", async () => {
    const { userId } = await setPassword(db, "robin@example.com", PASSWORD);
    expect(await verifyLogin(db, "robin@example.com", PASSWORD)).toEqual({ userId });
    expect(await verifyLogin(db, "robin@example.com", "wrong")).toBeNull();
    expect(await verifyLogin(db, "nobody@example.com", PASSWORD)).toBeNull();
  });

  test("ignore case and surrounding space in the address", async () => {
    const { userId } = await setPassword(db, "Robin@Example.com ", PASSWORD);
    expect(await verifyLogin(db, "robin@example.com", PASSWORD)).toEqual({ userId });
  });

  test("setting one again replaces it", async () => {
    const first = await setPassword(db, "robin@example.com", PASSWORD);
    const second = await setPassword(db, "robin@example.com", "an entirely different one");
    expect(second).toEqual({ userId: first.userId, created: false });
    expect(await verifyLogin(db, "robin@example.com", PASSWORD)).toBeNull();
    expect(await verifyLogin(db, "robin@example.com", "an entirely different one")).not.toBeNull();
  });

  test("an account without a password cannot be signed into", async () => {
    await db.insert(users).values({ id: "u_x", email: "nopass@example.com", emailVerified: true });
    expect(await verifyLogin(db, "nopass@example.com", "")).toBeNull();
  });
});

describe("login form", () => {
  test("signs in and lands on the requested page", async () => {
    await setPassword(db, "robin@example.com", PASSWORD);
    const res = await submit({
      email: "robin@example.com",
      password: PASSWORD,
      next: "/machine/authorize?request=x",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/machine/authorize?request=x");

    const jar = new CookieJar();
    jar.absorb(res);
    const me = await app.request("/api/me", { headers: { cookie: jar.header() } });
    expect(me.status).toBe(200);
  });

  test("refuses to bounce the user to another site", async () => {
    await setPassword(db, "robin@example.com", PASSWORD);
    const res = await submit({
      email: "robin@example.com",
      password: PASSWORD,
      next: "https://evil.example/",
    });
    expect(res.headers.get("location")).toBe("/");
  });

  test("says the same thing for a wrong password and an unknown address", async () => {
    await setPassword(db, "robin@example.com", PASSWORD);
    const wrong = await submit({ email: "robin@example.com", password: "nope" });
    const unknown = await submit({ email: "nobody@example.com", password: "nope" });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toContain("Wrong email or password");
    expect(await unknown.text()).toContain("Wrong email or password");
  });

  test("hands out no session on a failed attempt", async () => {
    await setPassword(db, "robin@example.com", PASSWORD);
    const res = await submit({ email: "robin@example.com", password: "nope" });
    expect(res.headers.getSetCookie().some((c) => c.startsWith("wave_session="))).toBe(false);
  });

  test("is offered on the landing page", async () => {
    expect(await (await app.request("/")).text()).toContain("/auth/password/login");
  });
});

describe("throttle", () => {
  test("blocks after too many failures and forgets them later", () => {
    let now = 0;
    const throttle = new LoginThrottle(3, 1000, () => now);
    for (let i = 0; i < 3; i++) throttle.fail("a@b.c", "1.2.3.4");
    expect(throttle.blocked("a@b.c", "1.2.3.4")).toBe(true);

    now = 1001;
    expect(throttle.blocked("a@b.c", "1.2.3.4")).toBe(false);
  });

  test("counts per address and source, not globally", () => {
    const throttle = new LoginThrottle(2, 1000, () => 0);
    throttle.fail("a@b.c", "1.2.3.4");
    throttle.fail("a@b.c", "1.2.3.4");
    expect(throttle.blocked("a@b.c", "1.2.3.4")).toBe(true);
    expect(throttle.blocked("a@b.c", "5.6.7.8")).toBe(false);
    expect(throttle.blocked("other@b.c", "1.2.3.4")).toBe(false);
  });

  test("a successful login clears the count", () => {
    const throttle = new LoginThrottle(1, 1000, () => 0);
    throttle.fail("a@b.c", "1.2.3.4");
    throttle.succeed("a@b.c", "1.2.3.4");
    expect(throttle.blocked("a@b.c", "1.2.3.4")).toBe(false);
  });
});
