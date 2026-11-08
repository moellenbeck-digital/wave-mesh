import { generateCodeVerifier, generateState } from "arctic";
import type { Context } from "hono";
import { setCookie } from "hono/cookie";
import type { Config } from "../env.ts";
import type { OAuthProvider } from "./providers.ts";

export const STATE_COOKIE = "wave_oauth_state";
export const NEXT_COOKIE = "wave_oauth_next";
export const VERIFIER_COOKIE = "wave_oauth_verifier";
/**
 * What the redirect that comes back is for. Absent means a plain sign-in; the
 * two guided-link kinds are set only by the link routes, from a signed-in
 * session, and cleared again by every plain start -- a stale one must never
 * turn an ordinary login into a proof.
 */
export const FLOW_COOKIE = "wave_oauth_flow";
export const FLOW_TTL_SECONDS = 600;

export type LinkFlow = "link-address" | "link-control";
export const isLinkFlow = (value: string | undefined): value is LinkFlow =>
  value === "link-address" || value === "link-control";

/**
 * Sets the cookies the callback checks and returns where to send the browser.
 * Throws when the provider cannot say (down, misconfigured): the caller
 * decides how to tell the person.
 */
export async function beginProviderFlow(
  c: Context,
  config: Config,
  provider: OAuthProvider,
  options: { next?: string | undefined; fresh?: boolean; flow?: LinkFlow } = {},
): Promise<URL> {
  const state = generateState();
  const verifier = generateCodeVerifier();
  const cookieOptions = {
    httpOnly: true,
    secure: config.secureCookies,
    sameSite: "Lax",
    path: "/auth",
    maxAge: FLOW_TTL_SECONDS,
  } as const;
  setCookie(c, STATE_COOKIE, state, cookieOptions);
  if (options.flow) setCookie(c, FLOW_COOKIE, options.flow, cookieOptions);
  else setCookie(c, FLOW_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  if (options.next) setCookie(c, NEXT_COOKIE, options.next, { ...cookieOptions, path: "/" });
  if (provider.usesPkce) setCookie(c, VERIFIER_COOKIE, verifier, cookieOptions);
  return provider.createAuthorizationURL(state, verifier, options.fresh ? { fresh: true } : undefined);
}
