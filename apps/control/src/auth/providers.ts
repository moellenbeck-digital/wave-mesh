import { decodeIdToken, Google } from "arctic";
import { z } from "zod";
import type { Config } from "../env.ts";
import type { ProviderClaims } from "./identity.ts";

export interface OAuthProvider {
  readonly id: string;
  /** Whether the authorization flow carries a PKCE verifier. */
  readonly usesPkce: boolean;
  createAuthorizationURL(state: string, codeVerifier: string): URL;
  fetchClaims(code: string, codeVerifier: string): Promise<ProviderClaims>;
}

export const redirectUri = (config: Config, providerId: string): string =>
  `${config.baseUrl}/auth/${providerId}/callback`;

const GoogleIdToken = z.object({
  sub: z.string().min(1),
  email: z.string().optional(),
  email_verified: z.boolean().optional(),
  name: z.string().optional(),
  picture: z.string().optional(),
});

class GoogleProvider implements OAuthProvider {
  readonly id = "google";
  readonly usesPkce = true;
  private readonly client: Google;

  constructor(config: Config, credentials: { clientId: string; clientSecret: string }) {
    this.client = new Google(credentials.clientId, credentials.clientSecret, redirectUri(config, "google"));
  }

  createAuthorizationURL(state: string, codeVerifier: string): URL {
    return this.client.createAuthorizationURL(state, codeVerifier, ["openid", "profile", "email"]);
  }

  async fetchClaims(code: string, codeVerifier: string): Promise<ProviderClaims> {
    const tokens = await this.client.validateAuthorizationCode(code, codeVerifier);
    const claims = GoogleIdToken.parse(decodeIdToken(tokens.idToken()));
    return {
      provider: this.id,
      subject: claims.sub,
      email: claims.email ?? null,
      // Absent means not verified. Never default this to true.
      emailVerified: claims.email_verified === true,
      name: claims.name ?? null,
      avatarUrl: claims.picture ?? null,
    };
  }
}

/**
 * Local development and tests only: skips the identity provider and trusts the
 * address typed into the form. {@link loadConfig} refuses to enable it in
 * production, and the routes check again before using it.
 */
class DevProvider implements OAuthProvider {
  readonly id = "dev";
  readonly usesPkce = false;

  constructor(private readonly config: Config) {}

  createAuthorizationURL(state: string): URL {
    const url = new URL(`${this.config.baseUrl}/auth/dev/login`);
    url.searchParams.set("state", state);
    return url;
  }

  async fetchClaims(code: string): Promise<ProviderClaims> {
    const email = code.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) throw new Error("dev login needs an email address");
    return {
      provider: this.id,
      subject: `dev:${email}`,
      email,
      emailVerified: true,
      name: email.split("@")[0] ?? email,
      avatarUrl: null,
    };
  }
}

export function createProviders(config: Config): Map<string, OAuthProvider> {
  const providers = new Map<string, OAuthProvider>();
  if (config.google) providers.set("google", new GoogleProvider(config, config.google));
  if (config.devAuth) providers.set("dev", new DevProvider(config));
  return providers;
}
