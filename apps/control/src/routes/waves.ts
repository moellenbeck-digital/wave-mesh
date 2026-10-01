import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { describeReach, enforcementText } from "../acl/describe.ts";
import { compilePolicy } from "../acl/evaluate.ts";
import { aclSubjects, getPolicy, invalidTags, removePolicy, setPolicy, setTags } from "../acl/store.ts";
import { checkPolicy } from "../acl/validate.ts";
import { audit, listAudit, userActor } from "../audit.ts";
import { setPassword } from "../auth/password.ts";
import type { SessionUser } from "../auth/session.ts";
import { createSession, setSessionCookie } from "../auth/session.ts";
import type { Database } from "../db/client.ts";
import { users, waves } from "../db/schema.ts";
import type { Config } from "../env.ts";
import {
  acceptInvite,
  createInvite,
  listInvites,
  loadInvite,
  looksLikeEmail,
  normaliseEmail,
  revokeInvite,
} from "../waves/invites.ts";
import { canManage, listMembers, removeMember, roleOf } from "../waves/members.ts";
import { removeNode } from "../waves/nodes.ts";
import {
  createWave,
  deleteWave,
  normaliseDnsSuffix,
  normaliseWaveName,
  renameWave,
  setWaveDomain,
  suggestWave,
  waveSetup,
} from "../waves/provision.ts";
import type { NetmapHub } from "./control-ws.ts";
import { safeNext } from "./next.ts";

/** Same floor as `admin.ts set-password`; an invite is not a weaker door. */
const MIN_PASSWORD_LENGTH = 12;

export interface WaveRouteDeps {
  db: Database;
  config: Config;
  hub?: NetmapHub;
}

type Vars = { user: SessionUser | null };

/**
 * Members, devices, invitations and the redemption of an invitation.
 *
 * The browser-facing halves are plain form posts that answer with a redirect,
 * like the login form: the frontend needs no JavaScript for them, and the same
 * routes work on a server running without one.
 *
 * What protects them is the session cookie being `SameSite=Lax`, which a
 * browser does not attach to a cross-site POST -- a forged form from another
 * origin arrives unauthenticated and is refused as such.
 */
export function waveRoutes({ db, config, hub }: WaveRouteDeps) {
  const app = new Hono<{ Variables: Vars }>();

  const page = (title: string, body: string, status: 400 | 401 | 403 | 404 | 409 | 410) =>
    new Response(`<h1>${Bun.escapeHTML(title)}</h1><p>${Bun.escapeHTML(body)}</p>`, {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    });

  /** The wave and the caller's standing in it, or the refusal to hand out. */
  async function authorize(
    c: Context<{ Variables: Vars }>,
    waveId: string,
    need: "member" | "manage",
  ): Promise<{ user: SessionUser; role: Awaited<ReturnType<typeof roleOf>> } | Response> {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const role = await roleOf(db, waveId, user.id);
    // A wave the caller is not in is indistinguishable from one that does not
    // exist -- who is a member of what is not public.
    if (!role) return c.json({ error: "unknown wave" }, 404);
    if (need === "manage" && !canManage(role)) return c.json({ error: "not allowed" }, 403);
    return { user, role };
  }

  /**
   * Where a wave is made, by the person who will own it.
   *
   * The DNS suffix is asked for here rather than assigned, because it is the
   * one property that cannot be changed cheaply afterwards: every node name in
   * the wave hangs under it, and a certificate can only ever be issued for a
   * domain that is publicly registered (D6/D7). Whoever has no domain keeps
   * the suggested one under `wave.internal`, which is honest about never
   * carrying a certificate rather than pretending to be a real zone.
   *
   * With a frontend this page belongs to it and the proxy takes the request
   * there; this plain one is what a server running alone answers with.
   */
  if (!config.webUrl) {
    app.get("/waves/new", async (c) => {
      const user = c.get("user");
      if (!user) return c.redirect(`/?next=${encodeURIComponent("/waves/new")}`);

      const setup = await waveSetup(db, user.id, user.email);
      const suggestion = suggestWave(user.email ?? user.name);
      const next = safeNext(c.req.query("next"));
      const waiting =
        setup.state === "invited"
          ? html`<p>
              An invitation into <strong>${setup.wave}</strong> is waiting for you. Opening that link
              puts your devices in there — make a wave of your own only if you want a second network.
            </p>`
          : "";

      return c.html(html`<h1>Create your wave</h1>
        ${waiting}
        <form method="post" action="/waves">
          ${next ? raw(`<input type="hidden" name="next" value="${Bun.escapeHTML(next)}" />`) : ""}
          <label for="name">Name</label>
          <input id="name" name="name" value="${suggestion.name}" required />
          <label for="suffix">Domain</label>
          <input id="suffix" name="suffix" value="${suggestion.dnsSuffix}" required />
          <p>Devices will be called <code>&lt;host&gt;.${suggestion.dnsSuffix}</code>.</p>
          <p>
            Keep the suggestion if you have no domain of your own. A public certificate needs one you
            own — you can change this later, which renames every device in the wave.
          </p>
          <button type="submit">Create wave</button>
        </form>`);
    });
  }

  app.post("/waves", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);

    const form = await c.req.formData();
    let name: string;
    let dnsSuffix: string;
    try {
      name = normaliseWaveName(String(form.get("name") ?? ""));
      dnsSuffix = normaliseDnsSuffix(String(form.get("suffix") ?? ""));
    } catch (err) {
      return page("That will not work as a name", err instanceof Error ? err.message : "Invalid.", 400);
    }

    const created = await createWave(db, {
      userId: user.id,
      name,
      dnsSuffix,
      container: config.ipv4Container,
    });
    // Two waves under one zone would answer for the same names, and a device in
    // both could not tell whose `laptop` it reached.
    if ("conflict" in created) {
      return page("That domain is taken", `Another wave already answers for ${dnsSuffix}.`, 409);
    }

    return c.redirect(safeNext(String(form.get("next") ?? "")) ?? "/", 303);
  });

  /**
   * Renames a wave, which is the cheap half of what looks like one setting.
   *
   * No broadcast and no version bump: the name is in no netmap, so no device
   * has it and none has to be told. That is the whole difference to the domain
   * below, where every device carries the old suffix until it is pushed.
   */
  app.post("/waves/:id/name", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    const form = await c.req.formData();
    let result: Awaited<ReturnType<typeof renameWave>>;
    try {
      result = await renameWave(db, waveId, String(form.get("name") ?? ""));
    } catch (err) {
      return page("That is not a wave name", err instanceof Error ? err.message : "Invalid.", 400);
    }
    // Found by id a moment ago, so neither can happen here.
    if (!result || "ambiguous" in result) return page("Unknown wave", "Nothing to change.", 404);

    await audit(db, waveId, userActor(auth.user), {
      action: "wave.rename",
      target: String(form.get("name") ?? ""),
    });
    return c.redirect("/", 303);
  });

  /**
   * Moves a wave onto another domain -- the step from the placeholder to one
   * whose names a certificate can be issued for.
   *
   * Every device holds a netmap naming the old suffix, so the push is not
   * cosmetic: without it a node keeps answering for a zone the wave has left,
   * and its resolver keeps routing that zone to itself.
   */
  app.post("/waves/:id/domain", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    const form = await c.req.formData();
    const domain = String(form.get("domain") ?? "");
    let result: Awaited<ReturnType<typeof setWaveDomain>>;
    try {
      result = await setWaveDomain(db, waveId, domain);
    } catch (err) {
      return page("That is not a domain", err instanceof Error ? err.message : "Invalid.", 400);
    }
    // The wave was found by id a moment ago, so neither can happen here.
    if (!result || "ambiguous" in result) return page("Unknown wave", "Nothing to change.", 404);
    if ("conflict" in result) {
      return page("That domain is taken", `Another wave already answers for ${domain}.`, 409);
    }

    await audit(db, waveId, userActor(auth.user), { action: "wave.domain", target: domain });
    await hub?.broadcast(waveId);
    return c.redirect("/", 303);
  });

  app.get("/api/waves/:id/members", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "member");
    if (auth instanceof Response) return auth;

    return c.json({
      role: auth.role,
      members: await listMembers(db, waveId),
      // Who has been asked and not answered is a manager's business.
      invites: canManage(auth.role ?? "member") ? await listInvites(db, waveId) : [],
    });
  });

  app.post("/waves/:id/invites", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    const form = await c.req.formData();
    const email = normaliseEmail(String(form.get("email") ?? ""));
    const role = String(form.get("role") ?? "member") === "admin" ? "admin" : "member";
    if (!looksLikeEmail(email)) {
      return page("That is not an email address", `Cannot invite ${email || "an empty address"}.`, 400);
    }

    const rows = await db.select({ name: waves.name }).from(waves).where(eq(waves.id, waveId)).limit(1);
    const waveName = rows[0]?.name ?? waveId;
    const invite = await createInvite(db, {
      waveId,
      waveName,
      email,
      role,
      invitedByUserId: auth.user.id,
      baseUrl: config.baseUrl,
    });
    await audit(db, waveId, userActor(auth.user), {
      action: "invite.create",
      target: email,
      detail: { role },
    });

    // The link is shown once, because only its hash is kept. With a frontend
    // that is a page of its own; without one, this plain answer is the page.
    if (config.webUrl) {
      const query = new URLSearchParams({ token: invite.token, email, role, wave: waveName });
      return c.redirect(`/waves/${encodeURIComponent(waveId)}/invited?${query}`, 303);
    }
    return c.html(html`<h1>${email} is invited to ${waveName}</h1>
      <p>Send them this link. It works once and expires ${invite.expiresAt.toISOString()}.</p>
      <p><code>${invite.url}</code></p>
      <p><a href="/">Back</a></p>`);
  });

  app.post("/waves/:id/invites/:inviteId/revoke", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    // Already gone is the state that was asked for, so it is not an error.
    await revokeInvite(db, waveId, { id: c.req.param("inviteId") });
    await audit(db, waveId, userActor(auth.user), {
      action: "invite.revoke",
      target: c.req.param("inviteId"),
    });
    return c.redirect("/", 303);
  });

  app.post("/waves/:id/members/:userId/remove", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    const result = await removeMember(db, waveId, auth.role ?? "member", c.req.param("userId"));
    if (result === "not-a-member") return page("Not a member", "Nothing to remove.", 404);
    if (result === "owner") {
      return page(
        "The owner stays",
        "A wave without its owner could not be administered. Hand ownership over first.",
        403,
      );
    }
    if (result === "forbidden") {
      return page("Not allowed", "Only the owner can remove another administrator.", 403);
    }

    await audit(db, waveId, userActor(auth.user), { action: "member.remove", target: c.req.param("userId") });
    // Their devices are gone from the database; the ones still up learn it
    // with this push, which is what drops them from everyone's netmap.
    await hub?.broadcast(waveId);
    return c.redirect("/", 303);
  });

  /**
   * Takes one device out of the wave, from the browser.
   *
   * This is for the machine nobody can run `wave logout` on any more -- one
   * that was lost, sold or left running somewhere. Whoever may remove a member
   * may remove a single device of theirs too; it is the smaller cut of the two.
   */
  app.post("/waves/:id/nodes/:nodeId/remove", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    const removed = await removeNode(db, waveId, c.req.param("nodeId"));
    // Already gone, or never in this wave -- the same answer either way, for
    // the same reason a wave one is not in looks like one that does not exist.
    if (!removed) return page("No such device", "It is not in this wave.", 404);

    // Cut first, push second: the device learns it is out, and the ones that
    // stay lose it from their netmap -- that is what drops the peer entry from
    // everyone's WireGuard interface.
    await audit(db, waveId, userActor(auth.user), { action: "device.remove", target: removed.hostname });
    hub?.disconnect(waveId, removed.id, "node-removed");
    await hub?.broadcast(waveId);
    return c.redirect("/", 303);
  });

  /**
   * The wave's policy (M7), for whoever may manage the wave.
   *
   * JSON in and out, unlike the form posts around it: a policy is a document,
   * not a field. What guards these is what guards the forms -- the session
   * cookie is `SameSite=Lax` and does not travel with a cross-site PUT or
   * DELETE -- plus the content type: a foreign page can only send JSON after
   * a CORS preflight, which this server never answers.
   */
  const isJson = (c: Context<{ Variables: Vars }>) =>
    (c.req.header("content-type") ?? "").split(";")[0]?.trim() === "application/json";

  async function reachOf(waveId: string) {
    const stored = await getPolicy(db, waveId);
    const subjects = await aclSubjects(db, waveId);
    // Always, policy or not: tags are set before the policy that uses them.
    const devices = [...subjects.nodes]
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((node) => ({
        id: node.id,
        hostname: node.hostname,
        tags: node.tags,
        // Only meaningful under a policy; without one there is nothing to hold.
        ports: stored ? enforcementText(node) : null,
        enforced: node.filterEnforced === true,
      }));
    if (!stored) return { policy: null, version: 0, updatedAt: null, reach: [] as string[], devices };
    return {
      policy: stored.document,
      version: stored.version,
      updatedAt: stored.updatedAt.toISOString(),
      reach: describeReach(compilePolicy(stored.document, subjects.nodes, subjects.services), subjects.nodes),
      devices,
    };
  }

  app.get("/api/waves/:id/acl", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    return c.json(await reachOf(waveId));
  });

  app.put("/api/waves/:id/acl", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    if (!isJson(c)) return c.json({ error: "expected application/json" }, 415);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "not JSON" }, 400);
    }
    const check = checkPolicy(raw, await aclSubjects(db, waveId));
    if (!check.policy) return c.json({ errors: check.errors, warnings: check.warnings }, 400);

    const version = await setPolicy(db, waveId, check.policy, auth.user.id);
    // The whole document, not a diff: which rule changed is read by comparing
    // two entries, and a diff of JSON is not what anyone reviews.
    await audit(db, waveId, userActor(auth.user), {
      action: "acl.set",
      target: `version ${version}`,
      detail: { policy: check.policy },
    });
    // Pushed, not left to the heartbeat: whoever just took access away expects
    // it gone now, not within thirty seconds.
    await hub?.broadcast(waveId);
    return c.json({ ...(await reachOf(waveId)), warnings: check.warnings });
  });

  app.delete("/api/waves/:id/acl", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    if (!(await removePolicy(db, waveId))) return c.json({ error: "no policy" }, 404);
    await audit(db, waveId, userActor(auth.user), { action: "acl.remove" });
    await hub?.broadcast(waveId);
    return c.json({ policy: null });
  });

  app.get("/api/waves/:id/audit", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 500);
    return c.json({ entries: await listAudit(db, waveId, limit) });
  });

  app.put("/api/waves/:id/nodes/:nodeId/tags", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    if (!isJson(c)) return c.json({ error: "expected application/json" }, 415);

    const body = (await c.req.json().catch(() => null)) as { tags?: unknown } | null;
    const tags = Array.isArray(body?.tags) ? body.tags.map(String) : null;
    if (!tags) return c.json({ error: "expected { tags: [...] }" }, 400);
    const bad = invalidTags(tags);
    if (bad.length > 0) return c.json({ error: `not a tag: ${bad.join(", ")}` }, 400);

    const updated = await setTags(db, waveId, c.req.param("nodeId"), tags);
    if (!updated) return c.json({ error: "no such device" }, 404);
    await audit(db, waveId, userActor(auth.user), {
      action: "device.tags",
      target: updated.hostname,
      detail: { tags: updated.tags },
    });
    await hub?.broadcast(waveId);
    return c.json(updated);
  });

  /**
   * Takes the whole wave away, at its owner's word.
   *
   * The owner alone, not everyone who may manage it: an administrator removes
   * people and devices, which is undone by letting them back in. This is not
   * undoable at all -- every device loses its enrolment, the addresses are
   * released, and the DNS suffix goes back into circulation for someone else
   * to claim.
   *
   * Which is why the name has to be typed. A button that deletes a network on
   * one click is one misplaced click away from an evening of re-enrolling
   * every machine, and the wave's own name is the one confirmation that cannot
   * be given by accident.
   */
  app.post("/waves/:id/delete", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    if (auth.role !== "owner") {
      return page("Not allowed", "Only the wave's owner can delete it.", 403);
    }

    const rows = await db.select({ name: waves.name }).from(waves).where(eq(waves.id, waveId)).limit(1);
    const wave = rows[0];
    // Gone already is the state that was asked for, but the name below has
    // nothing to compare against -- so it is the same 404 as an unknown wave.
    if (!wave) return page("Unknown wave", "Nothing to delete.", 404);

    const form = await c.req.formData();
    if (String(form.get("name") ?? "").trim() !== wave.name) {
      return page("That is not its name", `Type ${wave.name} to confirm. Nothing was deleted.`, 400);
    }

    const deleted = await deleteWave(db, waveId);
    if (!deleted) return page("Unknown wave", "Nothing to delete.", 404);

    // Cut every device, and no broadcast afterwards: a netmap belongs to a
    // wave, and there is no longer one to build. A socket left open would go
    // on answering heartbeats for a network that does not exist.
    for (const nodeId of deleted.nodeIds) hub?.disconnect(waveId, nodeId, "node-removed");
    return c.redirect("/", 303);
  });

  // --- redeeming an invitation --------------------------------------------

  /**
   * What the invited person is being asked, before they are signed in.
   *
   * Unauthenticated on purpose: the token in the link is the credential, the
   * same way the device approval link is. It says whether an account for the
   * address exists, so the page knows whether to offer a password at all.
   */
  app.get("/api/invites/:token", async (c) => {
    const invite = await loadInvite(db, c.req.param("token"));
    if (!invite) return c.json({ error: "gone" }, 410);

    const account = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invite.email))
      .limit(1);

    return c.json({
      wave: invite.waveName,
      email: invite.email,
      role: invite.role,
      invitedBy: invite.invitedBy,
      expiresAt: invite.expiresAt,
      hasAccount: account.length > 0,
    });
  });

  app.get("/invite/:token", async (c) => {
    const token = c.req.param("token");
    const invite = await loadInvite(db, token);
    if (!invite) {
      if (config.webUrl) return c.redirect("/join/gone");
      return page("This invitation is gone", "It was used, withdrawn or has expired.", 410);
    }

    const user = c.get("user");
    if (!user) {
      // The page that offers the ways in lives in the frontend when there is
      // one; this route keeps the token, so signing in can come back to it.
      if (config.webUrl) return c.redirect(`/join/${encodeURIComponent(token)}`);
      const next = encodeURIComponent(`/invite/${token}`);
      return c.html(html`<h1>Join ${invite.waveName}</h1>
        <p>You were invited as <code>${invite.email}</code>. Sign in with that address to accept.</p>
        <ul>
          <li><a href="/auth/password/login?next=${next}">Sign in with email and password</a></li>
        </ul>`);
    }

    return finishAccept(c, token, invite.waveName);
  });

  /**
   * Sets a password for the invited address and accepts in one step.
   *
   * Only for an address that has no account yet. Letting it set the password of
   * an existing one would mean whoever may invite could take over any account
   * by inviting its address -- the token proves possession of the link, not of
   * the mailbox.
   */
  app.post("/invite/:token/claim", async (c) => {
    const token = c.req.param("token");
    const invite = await loadInvite(db, token);
    if (!invite) return page("This invitation is gone", "It was used, withdrawn or has expired.", 410);

    const form = await c.req.formData();
    const password = String(form.get("password") ?? "");
    if (password.length < MIN_PASSWORD_LENGTH) {
      return page("Password too short", `Use at least ${MIN_PASSWORD_LENGTH} characters.`, 400);
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invite.email))
      .limit(1);
    if (existing[0]) {
      return page("There is already an account", `Sign in as ${invite.email} and open the link again.`, 409);
    }

    // The address counts as verified because a manager of the wave vouched for
    // it by inviting it -- the same standing `admin.ts set-password` gives an
    // address the operator types.
    const { userId } = await setPassword(db, invite.email, password);
    const { token: sessionToken, expiresAt } = await createSession(db, userId, {
      userAgent: c.req.header("user-agent") ?? null,
      ip: c.req.header("x-forwarded-for") ?? null,
    });
    setSessionCookie(c, config, sessionToken, expiresAt);

    const user = await db.select().from(users).where(eq(users.id, userId)).limit(1);
    const joined = user[0] ? await acceptInvite(db, token, user[0]) : "gone";
    if (typeof joined === "string") return refusal(c, token, joined);
    if (user[0]) {
      await audit(db, joined.waveId, userActor(user[0]), {
        action: "member.join",
        detail: { role: joined.role },
      });
    }
    return c.redirect(config.webUrl ? `/?joined=${encodeURIComponent(joined.waveName)}` : "/", 303);
  });

  async function finishAccept(c: Context<{ Variables: Vars }>, token: string, waveName: string) {
    const user = c.get("user");
    if (!user) return c.redirect("/", 303);

    const joined = await acceptInvite(db, token, user);
    if (typeof joined === "string") return refusal(c, token, joined);
    await audit(db, joined.waveId, userActor(user), { action: "member.join", detail: { role: joined.role } });

    if (config.webUrl) return c.redirect(`/?joined=${encodeURIComponent(joined.waveName)}`);
    return c.html(html`<h1>You are in ${waveName}</h1>
      <p>Run <code>wave login ${config.baseUrl}</code> to bring a device into it.</p>`);
  }

  function refusal(c: Context<{ Variables: Vars }>, token: string, reason: string) {
    if (config.webUrl) {
      return c.redirect(`/join/${encodeURIComponent(token)}?error=${encodeURIComponent(reason)}`);
    }
    if (reason === "wrong-address") {
      return page(
        "This invitation is for another address",
        "Sign out and sign in with the address it was sent to.",
        403,
      );
    }
    if (reason === "unverified-address") {
      return page(
        "Your address is not verified",
        "The provider you signed in with does not vouch for it, so it cannot claim an invitation.",
        403,
      );
    }
    return page("This invitation is gone", "It was used, withdrawn or has expired.", 410);
  }

  return app;
}
