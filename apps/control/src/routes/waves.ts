import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { html, raw } from "hono/html";
import { describeReach, enforcementText } from "../acl/describe.ts";
import { compilePolicy } from "../acl/evaluate.ts";
import { aclMessages } from "../acl/messages.ts";
import { previewPolicy } from "../acl/preview.ts";
import { aclSubjects, getPolicy, invalidTags, removePolicy, setPolicy, setTags } from "../acl/store.ts";
import { checkPolicy } from "../acl/validate.ts";
import { audit, listAudit, userActor } from "../audit.ts";
import { setPassword } from "../auth/password.ts";
import type { SessionUser } from "../auth/session.ts";
import { createSession, setSessionCookie } from "../auth/session.ts";
import { SeatLimitError } from "../billing/seats.ts";
import { billingStateOf } from "../billing/subscriptions.ts";
import type { Database } from "../db/client.ts";
import { users, waves } from "../db/schema.ts";
import type { Config } from "../env.ts";
import { type Locale, localeOf } from "../i18n.ts";
import {
  acceptInvite,
  createInvite,
  listInvites,
  loadInvite,
  looksLikeEmail,
  normaliseEmail,
  revokeInvite,
} from "../waves/invites.ts";
import { canManage, changeRole, listMembers, removeMember, roleOf } from "../waves/members.ts";
import { ownerOfNode, removeNode, renameNode } from "../waves/nodes.ts";
import {
  createWave,
  deleteWave,
  InvalidInputError,
  mayCreateWaves,
  normaliseDnsSuffix,
  normaliseWaveName,
  renameWave,
  setWaveDomain,
  suggestWave,
  waveSetup,
} from "../waves/provision.ts";
import type { NetmapHub } from "./control-ws.ts";
import { type PageMessages, pageMessages } from "./messages.ts";
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
  const canCreate = mayCreateWaves(config);

  /** The words of this request's language, for pages and JSON errors alike. */
  const say = (c: Context) => pageMessages(localeOf(c));

  /**
   * A refusal as a page. Shown to browsers even with the web app in front:
   * its forms post straight here, so this is the page a person lands on.
   */
  const page = (
    c: Context,
    words: (m: PageMessages) => [title: string, body: string],
    status: 400 | 401 | 403 | 404 | 409 | 410,
  ) => {
    const locale = localeOf(c);
    const [title, body] = words(pageMessages(locale));
    return new Response(
      `<!doctype html><html lang="${locale}"><h1>${Bun.escapeHTML(title)}</h1><p>${Bun.escapeHTML(body)}</p>`,
      { status, headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };

  /** What a name or domain that cannot be stored is called, in the reader's language. */
  const invalidText = (m: PageMessages, err: unknown): string =>
    err instanceof InvalidInputError
      ? m.invalidInput(err.kind, err.input)
      : err instanceof Error
        ? err.message
        : m.invalid;

  /** The wave and the caller's standing in it, or the refusal to hand out. */
  async function authorize(
    c: Context<{ Variables: Vars }>,
    waveId: string,
    need: "member" | "manage",
  ): Promise<{ user: SessionUser; role: Awaited<ReturnType<typeof roleOf>> } | Response> {
    const user = c.get("user");
    if (!user) return c.json({ error: say(c).apiUnauthenticated }, 401);
    const role = await roleOf(db, waveId, user.id);
    // A wave the caller is not in is indistinguishable from one that does not
    // exist -- who is a member of what is not public.
    if (!role) return c.json({ error: say(c).apiUnknownWave }, 404);
    if (need === "manage" && !canManage(role)) return c.json({ error: say(c).apiNotAllowed }, 403);
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

      const setup = await waveSetup(db, user.id, user.email, canCreate);
      const m = say(c);
      if (!canCreate) {
        const waiting =
          setup.state === "invited" ? html`<p>${raw(m.invitationOnlyHtml(setup.wave))}</p>` : "";
        return c.html(html`<h1>${m.noWaveCreation}</h1>
          ${waiting}
          <p>${m.noWaveCreationBody}</p>`);
      }
      const suggestion = suggestWave(user.email ?? user.name);
      const next = safeNext(c.req.query("next"));
      const waiting =
        setup.state === "invited"
          ? html`<p>
              ${raw(m.invitationWaitingHtml(setup.wave))}
            </p>`
          : "";

      return c.html(html`<h1>${m.createYourWave}</h1>
        ${waiting}
        <form method="post" action="/waves">
          ${next ? raw(`<input type="hidden" name="next" value="${Bun.escapeHTML(next)}" />`) : ""}
          <label for="name">${m.name}</label>
          <input id="name" name="name" value="${suggestion.name}" required />
          <label for="suffix">${m.domain}</label>
          <input id="suffix" name="suffix" value="${suggestion.dnsSuffix}" required />
          <p>${raw(m.devicesCalledHtml(suggestion.dnsSuffix))}</p>
          <p>
            ${m.keepSuggestion}
          </p>
          <button type="submit">${m.createWave}</button>
        </form>`);
    });
  }

  app.post("/waves", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: say(c).apiUnauthenticated }, 401);
    // The form is not offered here, but a POST needs no form.
    if (!canCreate) return page(c, (m) => [m.noWaveCreation, m.noWaveCreationBody], 403);

    const form = await c.req.formData();
    let name: string;
    let dnsSuffix: string;
    try {
      name = normaliseWaveName(String(form.get("name") ?? ""));
      dnsSuffix = normaliseDnsSuffix(String(form.get("suffix") ?? ""));
    } catch (err) {
      return page(c, (m) => [m.notWorkingAsName, invalidText(m, err)], 400);
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
      return page(c, (m) => [m.domainTaken, m.domainTakenBody(dnsSuffix)], 409);
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
      return page(c, (m) => [m.notAWaveName, invalidText(m, err)], 400);
    }
    // Found by id a moment ago, so neither can happen here.
    if (!result || "ambiguous" in result) return page(c, (m) => [m.unknownWave, m.nothingToChange], 404);

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
      return page(c, (m) => [m.notADomain, invalidText(m, err)], 400);
    }
    // The wave was found by id a moment ago, so neither can happen here.
    if (!result || "ambiguous" in result) return page(c, (m) => [m.unknownWave, m.nothingToChange], 404);
    if ("conflict" in result) {
      return page(c, (m) => [m.domainTaken, m.domainTakenBody(domain)], 409);
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
      // Whose row is the viewer's own: nobody changes their own role.
      userId: auth.user.id,
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
      return page(c, (m) => [m.notAnEmail, m.cannotInvite(email)], 400);
    }

    const rows = await db.select({ name: waves.name }).from(waves).where(eq(waves.id, waveId)).limit(1);
    const waveName = rows[0]?.name ?? waveId;
    let invite: Awaited<ReturnType<typeof createInvite>>;
    try {
      invite = await createInvite(db, {
        waveId,
        waveName,
        email,
        role,
        invitedByUserId: auth.user.id,
        baseUrl: config.baseUrl,
      });
    } catch (error) {
      if (error instanceof SeatLimitError) {
        return page(c, (m) => [m.noSeatLeft, m.noSeatLeftBody(error.seats)], 409);
      }
      throw error;
    }
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
    const m = say(c);
    return c.html(html`<h1>${m.invited(email, waveName)}</h1>
      <p>${m.sendLink(invite.expiresAt.toISOString())}</p>
      <p><code>${invite.url}</code></p>
      <p><a href="/">${m.back}</a></p>`);
  });

  app.post("/waves/:id/invites/:inviteId/revoke", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    // Already gone is the state that was asked for, so it is not an error --
    // but it is no entry in the log either: an id that names nothing here (gone,
    // or another wave's) would otherwise read as a withdrawal that never was.
    if (await revokeInvite(db, waveId, { id: c.req.param("inviteId") })) {
      await audit(db, waveId, userActor(auth.user), {
        action: "invite.revoke",
        target: c.req.param("inviteId"),
      });
    }
    return c.redirect("/", 303);
  });

  app.post("/waves/:id/members/:userId/remove", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    const result = await removeMember(db, waveId, auth.role ?? "member", c.req.param("userId"));
    if (result === "not-a-member") return page(c, (m) => [m.notAMember, m.nothingToRemove], 404);
    if (result === "owner") {
      return page(c, (m) => [m.ownerStays, m.ownerStaysBody], 403);
    }
    if (result === "forbidden") {
      return page(c, (m) => [m.notAllowed, m.onlyOwnerRemovesAdmins], 403);
    }

    await audit(db, waveId, userActor(auth.user), { action: "member.remove", target: c.req.param("userId") });
    // Their devices are gone from the database; the ones still up learn it
    // with this push, which is what drops them from everyone's netmap.
    await hub?.broadcast(waveId);
    return c.redirect("/", 303);
  });

  /**
   * Makes a member an administrator or a plain member, from the browser.
   * `owner` is not a value this takes: ownership is handed over in a step of
   * its own.
   */
  app.post("/waves/:id/members/:userId/role", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;

    const role = String((await c.req.formData()).get("role") ?? "");
    if (role !== "admin" && role !== "member") return page(c, (m) => [m.invalidRole, m.invalidRoleBody], 400);

    const userId = c.req.param("userId");
    const result = await changeRole(db, waveId, auth.user.id, userId, role);
    if (result === "not-a-member") return page(c, (m) => [m.notAMember, m.nothingToChange], 404);
    if (result === "self") return page(c, (m) => [m.notAllowed, m.ownRoleStays], 403);
    if (result === "owner") return page(c, (m) => [m.ownerStays, m.ownerRoleFixed], 403);

    if (result.changed) {
      await audit(db, waveId, userActor(auth.user), {
        action: "member.role",
        target: userId,
        detail: { from: result.from, to: result.to },
      });
      // `role:` in the policy follows the role, so the nodes get a new netmap.
      await hub?.broadcast(waveId);
    }
    return c.redirect("/", 303);
  });

  /**
   * Gives a device another name, from the browser.
   *
   * Whoever brought the device in may, and whoever manages the wave: it is
   * their device's name in a zone they share. The phones can only ask for a
   * name at enrolment -- since iOS 16 the system gives an app nothing better
   * than "iPhone" -- so this is how one becomes "max-iphone" afterwards.
   */
  app.post("/waves/:id/nodes/:nodeId/name", async (c) => {
    const waveId = c.req.param("id");
    const nodeId = c.req.param("nodeId");
    const auth = await authorize(c, waveId, "member");
    if (auth instanceof Response) return auth;

    const owner = await ownerOfNode(db, waveId, nodeId);
    if (!owner) return page(c, (m) => [m.noSuchDevice, m.notInThisWave], 404);
    if (owner !== auth.user.id && !canManage(auth.role ?? "member")) {
      return page(c, (m) => [m.notAllowed, m.renameOwnOnly], 403);
    }
    const form = await c.req.parseBody();
    const requested = String(form.name ?? "").trim();
    if (!requested) return c.redirect("/", 303);

    const renamed = await renameNode(db, waveId, nodeId, requested);
    if (!renamed) return page(c, (m) => [m.noSuchDevice, m.notInThisWave], 404);
    if (renamed.hostname !== renamed.previous) {
      await audit(db, waveId, userActor(auth.user), {
        action: "device.rename",
        target: `${renamed.previous} -> ${renamed.hostname}`,
      });
      await hub?.broadcast(waveId);
    }
    return c.redirect("/", 303);
  });

  /**
   * A member leaves a wave, with their devices.
   *
   * Until now only a manager could take somebody out, so a member who wanted
   * to go had to ask. The owner cannot: the wave hangs off their account.
   */
  app.post("/waves/:id/leave", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "member");
    if (auth instanceof Response) return auth;
    if (auth.role === "owner") return page(c, (m) => [m.ownerStays, m.ownerCannotLeave], 403);

    // As the owner would: leaving is always one's own business.
    const result = await removeMember(db, waveId, "owner", auth.user.id);
    if (typeof result === "string") return page(c, (m) => [m.notAMember, m.nothingToRemove], 404);
    await audit(db, waveId, userActor(auth.user), { action: "member.leave", target: auth.user.id });
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
    if (!removed) return page(c, (m) => [m.noSuchDevice, m.notInThisWave], 404);

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

  async function reachOf(waveId: string, locale: Locale) {
    const stored = await getPolicy(db, waveId);
    const subjects = await aclSubjects(db, waveId);
    // Always, policy or not: tags are set before the policy that uses them.
    const devices = [...subjects.nodes]
      .sort((a, b) => a.hostname.localeCompare(b.hostname))
      .map((node) => ({
        id: node.id,
        hostname: node.hostname,
        ipv4: node.ipv4,
        // Whose it is and in which role: what `user:` and `role:` match, as
        // long as the device wears no tag.
        email: node.email,
        role: node.role,
        tags: node.tags,
        // Only meaningful under a policy; without one there is nothing to hold.
        ports: stored ? enforcementText(node, locale) : null,
        enforced: node.filterEnforced === true,
      }));
    // Members too, not only the owners of devices: a rule for someone whose
    // laptop is not enrolled yet is written all the same.
    const members = (await listMembers(db, waveId))
      .filter((member) => member.email !== null)
      .map((member) => ({ email: member.email as string, role: member.role }));
    const services = subjects.services
      .map((service) => ({ name: service.name, ipv4: service.ipv4 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const base = { devices, members, services };
    if (!stored) return { policy: null, version: 0, updatedAt: null, reach: [] as string[], ...base };
    return {
      policy: stored.document,
      version: stored.version,
      updatedAt: stored.updatedAt.toISOString(),
      reach: describeReach(
        compilePolicy(stored.document, subjects.nodes, subjects.services),
        subjects.nodes,
        locale,
      ),
      ...base,
    };
  }

  app.get("/api/waves/:id/acl", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    return c.json(await reachOf(waveId, localeOf(c)));
  });

  app.put("/api/waves/:id/acl", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    if (!isJson(c)) return c.json({ error: say(c).apiExpectedJson }, 415);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: say(c).apiNotJson }, 400);
    }
    const check = checkPolicy(raw, await aclSubjects(db, waveId), localeOf(c));
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
    return c.json({ ...(await reachOf(waveId, localeOf(c))), warnings: check.warnings });
  });

  /**
   * A draft, judged without saving it: the policy (or null for the full mesh),
   * the devices' tags as the page would set them, and the selectors it draws.
   * A POST because it carries a body, not because it changes anything -- and
   * guarded like the PUT beside it, because the answer says who is in the wave.
   */
  app.post("/api/waves/:id/acl/preview", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    if (!isJson(c)) return c.json({ error: say(c).apiExpectedJson }, 415);

    const body = (await c.req.json().catch(() => undefined)) as
      | { policy?: unknown; tags?: unknown; selectors?: unknown }
      | undefined;
    if (!body || typeof body !== "object") return c.json({ error: say(c).apiNotJson }, 400);
    const tags: Record<string, string[]> = {};
    if (body.tags && typeof body.tags === "object") {
      for (const [id, list] of Object.entries(body.tags as Record<string, unknown>)) {
        if (Array.isArray(list)) tags[id] = list.map(String);
      }
    }
    const selectors = Array.isArray(body.selectors) ? body.selectors.map(String) : [];
    return c.json(
      previewPolicy(body.policy ?? null, await aclSubjects(db, waveId), tags, selectors, localeOf(c)),
    );
  });

  app.delete("/api/waves/:id/acl", async (c) => {
    const waveId = c.req.param("id");
    const auth = await authorize(c, waveId, "manage");
    if (auth instanceof Response) return auth;
    if (!(await removePolicy(db, waveId))) return c.json({ error: say(c).apiNoPolicy }, 404);
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
    if (!isJson(c)) return c.json({ error: say(c).apiExpectedJson }, 415);

    const body = (await c.req.json().catch(() => null)) as { tags?: unknown } | null;
    const tags = Array.isArray(body?.tags) ? body.tags.map(String) : null;
    if (!tags) return c.json({ error: say(c).apiExpectedTags }, 400);
    const bad = invalidTags(tags);
    if (bad.length > 0) return c.json({ error: aclMessages(localeOf(c)).notATag(bad) }, 400);

    const updated = await setTags(db, waveId, c.req.param("nodeId"), tags);
    if (!updated) return c.json({ error: say(c).apiNoSuchDevice }, 404);
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
      return page(c, (m) => [m.notAllowed, m.onlyOwnerDeletes], 403);
    }

    const rows = await db.select({ name: waves.name }).from(waves).where(eq(waves.id, waveId)).limit(1);
    const wave = rows[0];
    // Gone already is the state that was asked for, but the name below has
    // nothing to compare against -- so it is the same 404 as an unknown wave.
    if (!wave) return page(c, (m) => [m.unknownWave, m.nothingToDelete], 404);

    const form = await c.req.formData();
    if (String(form.get("name") ?? "").trim() !== wave.name) {
      return page(c, (m) => [m.notItsName, m.typeToConfirm(wave.name)], 400);
    }

    // A booked wave goes when its subscription does: deleted here, Stripe
    // would go on charging for a wave that is gone, and the site would never
    // hear of it again. Cancelling ends it, and the sweep deletes it after.
    const billed = await billingStateOf(db, waveId);
    if (billed && billed !== "ended")
      return page(
        c,
        (m) => [m.billedNotDeletable, m.billedNotDeletableBody(config.billing?.retentionDays ?? 30)],
        409,
      );

    const deleted = await deleteWave(db, waveId);
    if (!deleted) return page(c, (m) => [m.unknownWave, m.nothingToDelete], 404);

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
      return page(c, (m) => [m.invitationGone, m.invitationGoneBody], 410);
    }

    const user = c.get("user");
    if (!user) {
      // The page that offers the ways in lives in the frontend when there is
      // one; this route keeps the token, so signing in can come back to it.
      if (config.webUrl) return c.redirect(`/join/${encodeURIComponent(token)}`);
      const next = encodeURIComponent(`/invite/${token}`);
      const m = say(c);
      return c.html(html`<h1>${m.join(invite.waveName)}</h1>
        <p>${raw(m.invitedAsHtml(invite.email))}</p>
        <ul>
          <li><a href="/auth/password/login?next=${next}">${m.signInWithPassword}</a></li>
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
    if (!invite) return page(c, (m) => [m.invitationGone, m.invitationGoneBody], 410);

    const form = await c.req.formData();
    const password = String(form.get("password") ?? "");
    if (password.length < MIN_PASSWORD_LENGTH) {
      return page(c, (m) => [m.passwordTooShort, m.useAtLeast(MIN_PASSWORD_LENGTH)], 400);
    }

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, invite.email))
      .limit(1);
    if (existing[0]) {
      return page(c, (m) => [m.accountExists, m.signInAsAndReopen(invite.email)], 409);
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
    const m = say(c);
    return c.html(html`<h1>${m.youAreIn(waveName)}</h1>
      <p>${raw(m.bringDeviceHtml(config.baseUrl))}</p>`);
  }

  function refusal(c: Context<{ Variables: Vars }>, token: string, reason: string) {
    if (config.webUrl) {
      return c.redirect(`/join/${encodeURIComponent(token)}?error=${encodeURIComponent(reason)}`);
    }
    if (reason === "wrong-address") {
      return page(c, (m) => [m.otherAddress, m.otherAddressBody], 403);
    }
    if (reason === "unverified-address") {
      return page(c, (m) => [m.unverifiedAddress, m.unverifiedAddressBody], 403);
    }
    return page(c, (m) => [m.invitationGone, m.invitationGoneBody], 410);
  }

  return app;
}
