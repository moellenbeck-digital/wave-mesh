import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { html } from "hono/html";
import { audit } from "../audit.ts";
import {
  type AddressProof,
  type ControlProof,
  cancelLink,
  controlWays,
  describeMerge,
  type Link,
  mergeAccounts,
  openLink,
  proveAddress,
  proveControlWithCode,
  proveControlWithPassword,
  proveControlWithProvider,
  stageOf,
  startLink,
} from "../auth/account-link.ts";
import { beginProviderFlow, type LinkFlow } from "../auth/flow.ts";
import type { ProviderClaims } from "../auth/identity.ts";
import type { LoginThrottle } from "../auth/password.ts";
import type { OAuthProvider } from "../auth/providers.ts";
import { createSession, type SessionUser, setSessionCookie } from "../auth/session.ts";
import type { Database } from "../db/client.ts";
import { identities } from "../db/schema.ts";
import type { Config } from "../env.ts";
import { type Locale, localeOf } from "../i18n.ts";
import { peerAddress } from "../net/peer.ts";
import type { NetmapHub } from "./control-ws.ts";
import { pageMessages } from "./messages.ts";

type Vars = { user: SessionUser | null };

/** The request's own token. Not a session: it opens nothing but the link's own steps. */
export const LINK_COOKIE = "wave_link";

export interface AccountLinkDeps {
  db: Database;
  config: Config;
  providers: Map<string, OAuthProvider>;
  hub?: NetmapHub | undefined;
  /** The password login's throttles, shared: a guess is a guess wherever it is made. */
  throttle: LoginThrottle;
  codeThrottle: LoginThrottle;
}

/** What went wrong, as the codes the pages turn into sentences. */
export type LinkError =
  | "expired"
  | "changed"
  | "unverified"
  | "foreign-identity"
  | "stale"
  | "no-target"
  | "ambiguous"
  | "wrong-password"
  | "wrong-code"
  | "throttled"
  | "password-needed"
  | "not-target"
  | "no-provider"
  | "provider-unavailable"
  | "no-way";

const belongsTo = (identityProvider: string, providerId: string): boolean =>
  identityProvider === providerId || identityProvider.startsWith(`${providerId}:`);

/** Which provider a stored identity came through, named as the operator named it. */
export const identityLabel = (
  providers: Map<string, OAuthProvider>,
  provider: string,
): { provider: string; label: string | null } => {
  for (const p of providers.values()) if (belongsTo(provider, p.id)) return { provider, label: p.label };
  return { provider, label: null };
};

/**
 * What the pages need to say who is signed in and whether the guided link is
 * on offer. Offered to an account whose address no provider vouched for -- the
 * only kind that can have been split off. It does not say whether another
 * account holds the address: that is for the first step, after the provider
 * has vouched for it now, and not for whoever typed it into a sloppy provider.
 */
export async function accountView(db: Database, user: SessionUser, providers: Map<string, OAuthProvider>) {
  const own = await db
    .select({ provider: identities.provider })
    .from(identities)
    .where(eq(identities.userId, user.id));
  const viaProvider = [...providers.values()].some((p) => own.some((i) => belongsTo(i.provider, p.id)));
  return {
    identities: own.map((i) => identityLabel(providers, i.provider)),
    linkable: !user.emailVerified && user.email !== null && viaProvider,
  };
}

/** The same state for the JSON API and the plain pages, so a page and its API cannot disagree. */
async function linkState(
  db: Database,
  providers: Map<string, OAuthProvider>,
  user: SessionUser,
  link: Link | null,
  now: Date,
) {
  const view = await accountView(db, user, providers);
  const account = {
    email: user.email,
    name: user.name,
    emailVerified: user.emailVerified,
    identities: view.identities,
  };
  if (!link) {
    const own = await db
      .select({ provider: identities.provider })
      .from(identities)
      .where(eq(identities.userId, user.id));
    const starting = [...providers.values()]
      .filter((p) => own.some((i) => belongsTo(i.provider, p.id)))
      .map((p) => ({ id: p.id, label: p.label }));
    return { state: "none" as const, account, linkable: view.linkable, providers: starting };
  }

  const stage = stageOf(link);
  if (stage === "address") {
    return { state: "address" as const, account, expiresAt: link.expiresAt.toISOString() };
  }
  const ways = await controlWays(db, link, providers);
  const base = {
    account,
    address: link.email,
    expiresAt: link.expiresAt.toISOString(),
    provider: providers.get(link.authProvider)?.label ?? link.authProvider,
  };
  if (stage === "control") {
    return {
      state: "control" as const,
      ...base,
      control: { password: ways.password, providers: ways.providers, needsCode: link.passwordAt !== null },
    };
  }
  const summary = await describeMerge(db, link, now);
  return {
    state: "confirm" as const,
    ...base,
    summary: {
      ...summary,
      identities: summary.identities.map((p) => identityLabel(providers, p)),
    },
  };
}

type State = Awaited<ReturnType<typeof linkState>>;

export function accountLinkRoutes({ db, config, providers, hub, throttle, codeThrottle }: AccountLinkDeps) {
  const app = new Hono<{ Variables: Vars }>();

  /** The one page every step comes back to; with a frontend it is that frontend's. */
  const back = (c: Context, error?: LinkError) =>
    c.redirect(`/account/link${error ? `?error=${error}` : ""}`, 303);

  const toLogin = (c: Context) => c.redirect(config.webUrl ? "/login?next=/account/link" : "/", 303);

  const cookieOptions = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    path: "/",
  } as const;

  /** The signed-in account and its open request, or the answer that says why not. */
  async function current(c: Context<{ Variables: Vars }>) {
    const user = c.get("user");
    if (!user) return { user: null, link: null };
    const link = await openLink(db, getCookie(c, LINK_COOKIE), user.id);
    return { user, link };
  }

  app.get("/api/account/link", async (c) => {
    const { user, link } = await current(c);
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json(await linkState(db, providers, user, link, new Date()));
  });

  // --- step one: the provider vouches for the address, now ------------------

  app.post("/account/link/start", async (c) => {
    const user = c.get("user");
    if (!user) return toLogin(c);
    const form = await c.req.formData().catch(() => null);
    const provider = providers.get(String(form?.get("provider") ?? ""));
    if (!provider) return back(c, "no-provider");

    // Only a login B has: the proof is that the provider names B's identity.
    const own = await db
      .select({ provider: identities.provider })
      .from(identities)
      .where(eq(identities.userId, user.id));
    if (!own.some((i) => belongsTo(i.provider, provider.id))) return back(c, "no-provider");

    const { token, expiresAt } = await startLink(db, user.id, provider.id);
    setCookie(c, LINK_COOKIE, token, { ...cookieOptions, expires: expiresAt });
    return redirectToProvider(c, provider, "link-address");
  });

  async function redirectToProvider(c: Context, provider: OAuthProvider, flow: LinkFlow) {
    try {
      const target = await beginProviderFlow(c, config, provider, { fresh: true, flow });
      return c.redirect(target.toString(), 303);
    } catch (error) {
      console.error(
        `account link: ${provider.id} could not start: ${error instanceof Error ? error.message : error}`,
      );
      return back(c, "provider-unavailable");
    }
  }

  // --- step two: control of A -----------------------------------------------

  /** Why a control proof did not go through, or where to go on. */
  const controlOutcome = (c: Context, proof: ControlProof) => {
    if (proof.kind === "ok" || proof.kind === "code") return back(c);
    const error: LinkError =
      proof.kind === "wrong"
        ? "wrong-password"
        : proof.kind === "password-needed"
          ? "password-needed"
          : proof.kind === "not-target"
            ? "not-target"
            : proof.kind === "gone"
              ? "expired"
              : "changed";
    return back(c, error);
  };

  app.post("/account/link/control/password", async (c) => {
    const { user, link } = await current(c);
    if (!user) return toLogin(c);
    if (!link || stageOf(link) === "address") return back(c, "expired");
    const form = await c.req.formData().catch(() => null);
    const password = String(form?.get("password") ?? "");
    const source = peerAddress(c) ?? "unknown";
    const who = link.email ?? link.id;

    if (throttle.blocked(who, source)) return back(c, "throttled");
    const proof = await proveControlWithPassword(db, link.id, password);
    if (proof.kind === "wrong") {
      throttle.fail(who, source);
      return back(c, "wrong-password");
    }
    if (proof.kind === "ok" || proof.kind === "code") throttle.succeed(who, source);
    return controlOutcome(c, proof);
  });

  app.post("/account/link/control/code", async (c) => {
    const { user, link } = await current(c);
    if (!user) return toLogin(c);
    if (!link?.targetUserId) return back(c, "expired");
    const form = await c.req.formData().catch(() => null);
    const code = String(form?.get("code") ?? "");

    // Per account, with the sign-in's own count: the code of A is guessed
    // against the same ten tries wherever the guess is made.
    if (codeThrottle.blocked(link.targetUserId, "2fa")) return back(c, "throttled");
    const proof = await proveControlWithCode(db, link.id, code);
    if (proof.kind === "wrong") {
      codeThrottle.fail(link.targetUserId, "2fa");
      return back(c, "wrong-code");
    }
    if (proof.kind === "ok") codeThrottle.succeed(link.targetUserId, "2fa");
    return controlOutcome(c, proof);
  });

  app.post("/account/link/control/provider", async (c) => {
    const { user, link } = await current(c);
    if (!user) return toLogin(c);
    if (!link || stageOf(link) === "address") return back(c, "expired");
    const form = await c.req.formData().catch(() => null);
    const provider = providers.get(String(form?.get("provider") ?? ""));
    const ways = await controlWays(db, link, providers);
    // Only what A can actually sign in with, and never the provider being linked.
    if (!provider || !ways.providers.some((p) => p.id === provider.id)) return back(c, "not-target");
    return redirectToProvider(c, provider, "link-control");
  });

  // --- the callback of either login, handed over by the shared route --------

  /**
   * The provider's answer for a link flow. Needs the session of B *and* the
   * request's token: a callback replayed in another browser, or after the
   * request ended, finds neither and changes nothing.
   */
  async function callback(
    c: Context<{ Variables: Vars }>,
    flow: LinkFlow,
    providerId: string,
    claims: ProviderClaims,
  ) {
    const { user, link } = await current(c);
    if (!user) return toLogin(c);
    if (!link) return back(c, "expired");

    if (flow === "link-address") {
      // The login must come back from the provider the request started with.
      if (providerId !== link.authProvider) return back(c, "changed");
      const proof = await proveAddress(db, link.id, claims);
      return back(c, addressError(proof));
    }
    if (stageOf(link) === "address") return back(c, "changed");
    const proof = await proveControlWithProvider(db, link.id, providerId, claims);
    return controlOutcome(c, proof);
  }

  const addressError = (proof: AddressProof): LinkError | undefined => {
    switch (proof.kind) {
      case "ok":
        return undefined;
      case "gone":
        return "expired";
      default:
        return proof.kind;
    }
  };

  // --- step three: the summary, then the POST -------------------------------

  app.post("/account/link/confirm", async (c) => {
    const { user, link } = await current(c);
    if (!user) return toLogin(c);
    if (!link) return back(c, "expired");

    const result = await mergeAccounts(db, link.id, user.id);
    if (result.kind === "gone") return back(c, "expired");
    if (result.kind === "changed") return back(c, "changed");
    if (result.kind === "not-controlled") return back(c, stageOf(link) === "address" ? "expired" : "no-way");

    // B's sessions are gone with B. The person is A from here on, in a session
    // made now -- not carried over from anything B had.
    const session = await createSession(db, result.userId, {
      userAgent: c.req.header("user-agent") ?? null,
      ip: peerAddress(c) ?? null,
    });
    setSessionCookie(c, config, session.token, session.expiresAt);
    deleteCookie(c, LINK_COOKIE, { path: "/" });
    console.log(`account link: ${result.email} -- joined into ${result.userId}`);

    const { summary } = result;
    for (const waveId of result.waveIds) {
      await audit(
        db,
        waveId,
        { userId: result.userId, label: result.email },
        {
          action: "account.link",
          target: result.email,
          detail: {
            identities: summary.identities.length,
            ownedWaves: summary.ownedWaves.length,
            devices: summary.devices.length,
          },
        },
      );
      // Devices keep their connection; the netmap only learns who they belong to.
      await hub?.broadcast(waveId);
    }
    const query = new URLSearchParams({
      waves: String(summary.ownedWaves.length + summary.memberships.length),
      devices: String(summary.devices.length),
    });
    return c.redirect(`/account/link/done?${query}`, 303);
  });

  app.post("/account/link/cancel", async (c) => {
    const { user, link } = await current(c);
    if (!user) return toLogin(c);
    if (link) await cancelLink(db, link.id);
    deleteCookie(c, LINK_COOKIE, { path: "/" });
    return c.redirect(config.webUrl ? "/account" : "/", 303);
  });

  // --- plain pages, where there is no frontend ------------------------------

  if (!config.webUrl) {
    app.get("/account/link", async (c) => {
      const { user, link } = await current(c);
      if (!user) return toLogin(c);
      const state = await linkState(db, providers, user, link, new Date());
      return c.html(plainPage(localeOf(c), state, c.req.query("error")));
    });

    app.get("/account/link/done", (c) => {
      const m = pageMessages(localeOf(c));
      return c.html(
        html`<h1>${m.linkDoneTitle}</h1><p>${m.linkDoneBody}</p><p><a href="/">${m.back}</a></p>`,
      );
    });
  }

  return Object.assign(app, { callback });
}

// --- plain rendering ---------------------------------------------------------

function plainPage(locale: Locale, state: State, error: string | undefined) {
  const m = pageMessages(locale);
  const banner = error ? html`<p role="alert">${m.linkError(error)}</p>` : "";
  const cancel = html`<form method="post" action="/account/link/cancel"><button type="submit">${m.linkCancel}</button></form>`;

  if (state.state === "none" || state.state === "address") {
    const starts =
      state.state === "none" && state.providers.length > 0
        ? state.providers.map(
            (p) => html`<form method="post" action="/account/link/start">
              <input type="hidden" name="provider" value="${p.id}" />
              <button type="submit">${m.linkStartWith(p.label)}</button>
            </form>`,
          )
        : html`<p>${m.linkNoProvider}</p>`;
    return html`<h1>${m.linkTitle}</h1>
      ${banner}
      <p>${m.linkActive(state.account.email ?? state.account.name ?? "")}</p>
      <p>${m.linkWhyMissing}</p>
      <p>${m.linkIntro}</p>
      ${starts}`;
  }

  if (state.state === "control") {
    const { control } = state;
    const forms = control.needsCode
      ? html`<form method="post" action="/account/link/control/code">
          <label>${m.twoFactorCode}<input name="code" autocomplete="one-time-code" required /></label>
          <button type="submit">${m.twoFactorConfirm}</button>
        </form>`
      : html`${
          control.password
            ? html`<form method="post" action="/account/link/control/password">
              <label>${m.password}<input name="password" type="password" autocomplete="current-password" required /></label>
              <button type="submit">${m.linkProvePassword}</button>
            </form>`
            : ""
        }
        ${control.providers.map(
          (p) => html`<form method="post" action="/account/link/control/provider">
            <input type="hidden" name="provider" value="${p.id}" />
            <button type="submit">${m.linkProveWith(p.label)}</button>
          </form>`,
        )}
        ${!control.password && control.providers.length === 0 ? html`<p>${m.linkNoWay}</p>` : ""}`;
    return html`<h1>${m.linkControlTitle(state.address ?? "")}</h1>
      ${banner}
      <p>${m.linkControlIntro}</p>
      ${forms}
      ${cancel}`;
  }

  const s = state.summary;
  const into = s.into.email ?? s.into.name ?? "";
  const from = s.from.email ?? s.from.name ?? "";
  const lines: string[] = [
    m.linkSumIdentities(
      s.identities.map((i) => i.label ?? i.provider),
      into,
    ),
    ...s.ownedWaves.map((w) => m.linkSumOwned(w.name, w.billing, w.targetWasMember)),
    ...s.memberships.map((w) => m.linkSumMember(w.name, w.role, w.targetRole)),
    m.linkSumDevices(s.devices.map((d) => `${d.hostname} (${d.waveName}, ${d.ipv4})`)),
    m.linkSumSessions(s.sessions, from, into),
  ];
  if (s.from.hasPassword) lines.push(m.linkSumPassword(from));
  return html`<h1>${m.linkConfirmTitle(from, into)}</h1>
    ${banner}
    <ul>${lines.map((line) => html`<li>${line}</li>`)}</ul>
    <form method="post" action="/account/link/confirm"><button type="submit">${m.linkConfirm}</button></form>
    ${cancel}`;
}
