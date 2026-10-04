import { type Context, Hono } from "hono";
import { LoginThrottle } from "../auth/password.ts";
import type { SessionUser } from "../auth/session.ts";
import {
  beginSetup,
  confirmSetup,
  disableTwoFactor,
  regenerateRecoveryCodes,
  twoFactorStatus,
} from "../auth/two-factor.ts";
import type { Database } from "../db/client.ts";

type Vars = { user: SessionUser | null };

/**
 * The account's own settings: for now, the second factor of its password
 * login.
 *
 * JSON in and out, guarded like the policy API next to it: the session cookie
 * is `SameSite=Lax` and does not travel with a cross-site POST, and only
 * `application/json` is taken, which no foreign form can send. Errors are
 * codes, not sentences -- the frontend says them in its reader's language.
 */
export function accountRoutes({ db, codeThrottle }: { db: Database; codeThrottle?: LoginThrottle }) {
  const app = new Hono<{ Variables: Vars }>();
  // A stolen session must not be a way to guess the code that would turn the
  // second factor off. The same ten-per-quarter-hour as at the login.
  const limiter = codeThrottle ?? new LoginThrottle(10);

  const isJson = (c: Context) =>
    (c.req.header("content-type") ?? "").split(";")[0]?.trim() === "application/json";

  /** The signed-in user and the code from the body, or the answer that says why not. */
  async function prepare(c: Context<{ Variables: Vars }>, wantsCode: boolean) {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!isJson(c)) return c.json({ error: "expected application/json" }, 415);
    if (!user.passwordHash) return c.json({ error: "no-password" }, 409);
    if (!wantsCode) return { user, code: "" };
    if (limiter.blocked(user.id, "account")) return c.json({ error: "throttled" }, 429);
    const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
    const code = typeof body?.code === "string" ? body.code : "";
    return { user, code };
  }

  /** Counts a wrong code against the account, so the throttle above means something. */
  const wrong = (c: Context, userId: string) => {
    limiter.fail(userId, "account");
    return c.json({ error: "invalid-code" }, 400);
  };

  app.get("/api/me/2fa", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json(await twoFactorStatus(db, user.id));
  });

  app.post("/api/me/2fa/setup", async (c) => {
    const ready = await prepare(c, false);
    if (ready instanceof Response) return ready;
    // The address is what the app shows under "wave-mesh", so a person with
    // two accounts can tell them apart.
    const started = await beginSetup(db, ready.user.id, ready.user.email ?? ready.user.id);
    if (!started) return c.json({ error: "already-enabled" }, 409);
    return c.json(started);
  });

  app.post("/api/me/2fa/confirm", async (c) => {
    const ready = await prepare(c, true);
    if (ready instanceof Response) return ready;
    const codes = await confirmSetup(db, ready.user.id, ready.code);
    if (!codes) return wrong(c, ready.user.id);
    limiter.succeed(ready.user.id, "account");
    console.log(`account: two-factor switched on for ${ready.user.email ?? ready.user.id}`);
    return c.json({ recoveryCodes: codes });
  });

  app.post("/api/me/2fa/recovery-codes", async (c) => {
    const ready = await prepare(c, true);
    if (ready instanceof Response) return ready;
    const codes = await regenerateRecoveryCodes(db, ready.user.id, ready.code);
    if (!codes) return wrong(c, ready.user.id);
    limiter.succeed(ready.user.id, "account");
    return c.json({ recoveryCodes: codes });
  });

  app.post("/api/me/2fa/disable", async (c) => {
    const ready = await prepare(c, true);
    if (ready instanceof Response) return ready;
    // A code, not just the session: turning the second factor off is what
    // someone holding a stolen session would want most.
    if (!(await disableTwoFactor(db, ready.user.id, { code: ready.code }))) return wrong(c, ready.user.id);
    limiter.succeed(ready.user.id, "account");
    console.log(`account: two-factor switched off for ${ready.user.email ?? ready.user.id}`);
    return c.json({ ok: true });
  });

  return app;
}
