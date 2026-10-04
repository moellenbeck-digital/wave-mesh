import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createApp } from "../src/app.ts";
import { setPassword } from "../src/auth/password.ts";
import { base32Decode, base32Encode, TOTP_STEP_MS, totp, verifyTotp } from "../src/auth/totp.ts";
import { disableTwoFactor, hasTwoFactor } from "../src/auth/two-factor.ts";
import type { Database } from "../src/db/client.ts";
import { users } from "../src/db/schema.ts";
import { CookieJar, createTestDb, testConfig, testSigningKey } from "./helpers.ts";

/**
 * The second factor of the password login. What matters is what it refuses:
 * a password alone, a code twice, a guess too many, a switch-off without a code.
 */

describe("the codes themselves (RFC 6238)", () => {
  // The RFC's SHA-1 key, "12345678901234567890", in base32.
  const rfc = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

  test("match the RFC's vectors, and base32 goes both ways", () => {
    expect(totp(rfc, 59_000)).toBe("287082");
    expect(totp(rfc, 1_111_111_109_000)).toBe("081804");
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect([...base32Decode(base32Encode(bytes))]).toEqual([...bytes]);
  });

  test("one step either side counts, an old step never again", () => {
    const now = 1_700_000_000_000;
    const step = Math.floor(now / TOTP_STEP_MS);
    expect(verifyTotp(rfc, totp(rfc, now), now)).toBe(step);
    expect(verifyTotp(rfc, totp(rfc, now - TOTP_STEP_MS), now)).toBe(step - 1);
    expect(verifyTotp(rfc, totp(rfc, now + TOTP_STEP_MS), now)).toBe(step + 1);
    expect(verifyTotp(rfc, totp(rfc, now - 2 * TOTP_STEP_MS), now)).toBeNull();
    // Seen once, the step is spent.
    expect(verifyTotp(rfc, totp(rfc, now), now, step)).toBeNull();
    expect(verifyTotp(rfc, "12345", now)).toBeNull();
  });
});

describe("signing in with a second factor", () => {
  let db: Database;
  let close: () => Promise<void>;
  let app: ReturnType<typeof createApp>;
  const email = "robin@example.com";
  const password = "correct horse battery staple";

  beforeEach(async () => {
    if (close) await close();
    ({ db, close } = await createTestDb());
    app = createApp({ db, config: testConfig(), providers: new Map(), signingKey: testSigningKey() });
    await setPassword(db, email, password);
  });

  const login = async (jar = new CookieJar()) => {
    const form = new URLSearchParams({ email, password });
    const res = await app.request("/auth/password/login", {
      method: "POST",
      body: form,
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    });
    jar.absorb(res);
    return { res, jar };
  };

  const sendCode = async (jar: CookieJar, code: string) => {
    const res = await app.request("/auth/password/2fa", {
      method: "POST",
      body: new URLSearchParams({ code }),
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    });
    jar.absorb(res);
    return res;
  };

  const api = (jar: CookieJar, path: string, body: unknown = {}, type = "application/json") =>
    app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": type, cookie: jar.header() },
    });

  /** Signs in with the password alone and switches the second factor on. */
  async function enable(): Promise<{ secret: string; recoveryCodes: string[] }> {
    const { res, jar } = await login();
    expect(res.status).toBe(302);
    const setup = (await (await api(jar, "/api/me/2fa/setup")).json()) as { secret: string; uri: string };
    expect(setup.uri).toStartWith("otpauth://totp/wave-mesh:robin%40example.com?secret=");
    const confirmed = await api(jar, "/api/me/2fa/confirm", { code: totp(setup.secret, Date.now()) });
    expect(confirmed.status).toBe(200);
    const { recoveryCodes } = (await confirmed.json()) as { recoveryCodes: string[] };
    return { secret: setup.secret, recoveryCodes };
  }

  /** A code from the next step: the current one was spent confirming the setup. */
  const freshCode = (secret: string) => totp(secret, Date.now() + TOTP_STEP_MS);

  test("a scanned QR code locks nobody out until a code from it is confirmed", async () => {
    const { jar } = await login();
    await api(jar, "/api/me/2fa/setup");
    const wrong = await api(jar, "/api/me/2fa/confirm", { code: "000000" });
    expect(wrong.status).toBe(400);
    expect(await hasTwoFactor(db, (await db.select().from(users))[0]?.id ?? "")).toBe(false);
    // Still a plain password login.
    expect((await login()).res.status).toBe(302);
  });

  test("once on, the password alone opens no session", async () => {
    const { secret, recoveryCodes } = await enable();
    expect(recoveryCodes).toHaveLength(10);
    expect(recoveryCodes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);

    const { res, jar } = await login();
    // The code form, not a redirect with a session.
    expect(res.status).toBe(200);
    expect(jar.header()).toContain("wave_2fa=");
    expect(jar.header()).not.toContain("wave_session=");

    expect((await sendCode(jar, "000000")).status).toBe(401);
    const right = await sendCode(jar, freshCode(secret));
    expect(right.status).toBe(302);
    expect(jar.header()).toContain("wave_session=");
  });

  test("a code works once, even within its step", async () => {
    const { secret } = await enable();
    const code = freshCode(secret);
    const first = await login();
    expect((await sendCode(first.jar, code)).status).toBe(302);
    const second = await login();
    expect((await sendCode(second.jar, code)).status).toBe(401);
  });

  test("a recovery code works once, typed any way", async () => {
    const { recoveryCodes } = await enable();
    const code = recoveryCodes[3] ?? "";
    const first = await login();
    expect((await sendCode(first.jar, ` ${code.toUpperCase().replace("-", "")} `)).status).toBe(302);
    const second = await login();
    expect((await sendCode(second.jar, code)).status).toBe(401);
  });

  test("five wrong codes end the challenge; the password has to be typed again", async () => {
    const { secret } = await enable();
    const { jar } = await login();
    for (let i = 0; i < 5; i++) await sendCode(jar, "000000");
    const late = await sendCode(jar, freshCode(secret));
    expect(late.status).toBe(401);
    expect(jar.header()).not.toContain("wave_session=");
  });

  test("no challenge, no code: the form alone signs nobody in", async () => {
    const { secret } = await enable();
    expect((await sendCode(new CookieJar(), freshCode(secret))).status).toBe(401);
  });

  test("switching it off takes a code, and only JSON", async () => {
    const { secret, recoveryCodes } = await enable();
    const { jar } = await login();
    await sendCode(jar, freshCode(secret));

    expect((await api(jar, "/api/me/2fa/disable", { code: "000000" })).status).toBe(400);
    // No form from another site can send JSON, so none can switch it off.
    expect((await api(jar, "/api/me/2fa/disable", {}, "text/plain")).status).toBe(415);
    // Every app code within reach is spent by now (setup and login), which is
    // the replay rule working; a recovery code is the other valid proof.
    const off = await api(jar, "/api/me/2fa/disable", { code: recoveryCodes[0] });
    expect(off.status).toBe(200);
    expect((await login()).res.status).toBe(302);
  });

  test("the operator can switch it off for the lost phone", async () => {
    await enable();
    const [user] = await db.select().from(users).where(eq(users.email, email));
    await disableTwoFactor(db, user?.id ?? "", "operator");
    expect((await login()).res.status).toBe(302);
  });

  test("a stolen session cannot guess its way to switching it off", async () => {
    const { secret, recoveryCodes } = await enable();
    const { jar } = await login();
    await sendCode(jar, freshCode(secret));
    for (let i = 0; i < 10; i++) await api(jar, "/api/me/2fa/disable", { code: "000000" });
    // Even a valid proof is turned away once the guesses are used up.
    const blocked = await api(jar, "/api/me/2fa/disable", { code: recoveryCodes[0] });
    expect(blocked.status).toBe(429);
    expect(await hasTwoFactor(db, (await db.select().from(users))[0]?.id ?? "")).toBe(true);
  });

  test("an account without a password has nothing to protect here", async () => {
    const status = await app.request("/api/me/2fa");
    expect(status.status).toBe(401);
    const { jar } = await login();
    const body = (await (await app.request("/api/me/2fa", { headers: { cookie: jar.header() } })).json()) as {
      available: boolean;
      enabled: boolean;
    };
    expect(body).toMatchObject({ available: true, enabled: false });
  });
});
