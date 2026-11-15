import type { OAuthProvider } from "./providers.ts";

/** Where the first login lands: the form for the first wave (ticket #147). */
export const SIGNUP_NEXT = "/waves/new";

/**
 * The providers `/signup` offers: the configured OIDC logins (Google and the
 * generic provider). The development login is not a registration -- it trusts
 * any typed address -- and password accounts are only ever made by a setup or
 * invitation link, so neither is listed.
 */
export function signupProviders(providers: Map<string, OAuthProvider>): OAuthProvider[] {
  return [...providers.values()].filter((p) => p.id !== "dev");
}
