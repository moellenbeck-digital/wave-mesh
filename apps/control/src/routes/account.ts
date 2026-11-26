import { type Context, Hono } from "hono";
import { deleteAccount, describeDeletion, orphanLogLines } from "../auth/delete-account.ts";
import { LoginThrottle } from "../auth/password.ts";
import { clearSessionCookie, type SessionUser } from "../auth/session.ts";
import {
  beginSetup,
  confirmSetup,
  disableTwoFactor,
  regenerateRecoveryCodes,
  twoFactorStatus,
  verifySecondFactor,
} from "../auth/two-factor.ts";
import type { Database } from "../db/client.ts";
import type { Config } from "../env.ts";
import { unpublishLeavingPier } from "../waves/pier-dns.ts";
import type { NetmapHub } from "./control-ws.ts";

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
export function accountRoutes({
  db,
  codeThrottle,
  hub,
  config,
  dnsFetch,
}: {
  db: Database;
  codeThrottle?: LoginThrottle;
  /** To cut the devices of a deleted account and tell the waves that stay. */
  hub?: NetmapHub;
  /** For the DNS secret of a pier that goes with the account. */
  config?: Pick<Config, "dnsSecret" | "sharedPier">;
  dnsFetch?: typeof fetch;
}) {
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

  /** The word that stands for the address when the account has none (Instagram never hands one out). */
  const DELETE_WORD = "DELETE";

  /**
   * What deleting the account would do, before anyone confirms: the waves it
   * takes along, the ones it hands over, the ones that stop it (the user is
   * their last administrator), and the billed ones whose subscription has to
   * be cancelled in the customer portal. Reads only.
   */
  app.get("/api/me/delete-preview", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({
      // What has to be typed to confirm: the address, or the word DELETE without one.
      confirmation: user.email ? "email" : "word",
      word: user.email ? null : DELETE_WORD,
      twoFactor: Boolean(user.totpEnabledAt),
      ...(await describeDeletion(db, user.id)),
    });
  });

  /**
   * Deletes the signed-in account with its data.
   *
   * Body `{ email, code? }`: `email` is the account's own address (case does
   * not matter); an account without one confirms with the word `DELETE` in the
   * same field. With the second factor on, `code` (an app code or a recovery
   * code, each good once) is required, checked and throttled like the
   * switch-off above -- a stolen session must not be able to erase the account
   * either. A wave whose last administrator the user is, with others in it,
   * refuses the deletion (409 `last-admin`, the waves named) before the code is
   * spent; billing never refuses.
   */
  app.post("/api/me/delete", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    if (!isJson(c)) return c.json({ error: "expected application/json" }, 415);
    const twoFactor = Boolean(user.totpEnabledAt);
    if (twoFactor && limiter.blocked(user.id, "account")) return c.json({ error: "throttled" }, 429);

    const body = (await c.req.json().catch(() => null)) as { email?: unknown; code?: unknown } | null;
    const typed = typeof body?.email === "string" ? body.email.trim() : "";
    const confirmed = user.email ? typed.toLowerCase() === user.email.toLowerCase() : typed === DELETE_WORD;
    if (!confirmed) return c.json({ error: "confirmation-mismatch" }, 400);

    const refuse = (waves: { id: string; name: string }[]) =>
      c.json(
        {
          error: "last-admin",
          waves,
          message: `You are the last administrator of ${waves.map((w) => `"${w.name}"`).join(", ")}, and others are in it. Hand it over or delete it first.`,
        },
        409,
      );
    const before = await describeDeletion(db, user.id);
    if (before.blockers.length > 0) return refuse(before.blockers);

    if (twoFactor) {
      const code = typeof body?.code === "string" ? body.code : "";
      if (!code) return c.json({ error: "code-required" }, 400);
      if (!(await verifySecondFactor(db, user.id, code))) return wrong(c, user.id);
    }

    const result = await deleteAccount(db, user.id);
    if (result.kind === "gone") return c.json({ error: "unauthenticated" }, 401);
    if (result.kind === "blocked") return refuse(result.waves);
    limiter.succeed(user.id, "account");

    // After the commit: cut the devices, take a pier's wildcard out of the zone, tell the waves that stay.
    for (const { waveId, nodeId } of result.nodes) hub?.disconnect(waveId, nodeId, "node-removed");
    for (const pier of result.piers) {
      await unpublishLeavingPier(
        { db, dnsSecret: config?.dnsSecret, sharedPier: config?.sharedPier, http: dnsFetch },
        pier,
      );
    }
    for (const waveId of result.changedWaves) await hub?.broadcast(waveId);
    for (const line of orphanLogLines(result.orphans)) console.log(line);
    console.log(
      `account-delete: account deleted (${result.deletedWaves.length} waves removed, ${result.changedWaves.length} kept, ${result.nodes.length} devices)`,
    );
    clearSessionCookie(c);
    return c.json({ ok: true });
  });

  return app;
}
