import {
  constants,
  createHash,
  createPublicKey,
  type JsonWebKeyInput,
  type KeyObject,
  verify,
} from "node:crypto";
import { z } from "zod";
import type { OidcConfig } from "../env.ts";
import type { ProviderClaims } from "./identity.ts";
import type { OAuthProvider } from "./providers.ts";

/**
 * Sign-in through any OpenID Connect provider -- written for Pocket ID, which
 * is passkeys and nothing else, and therefore the one place where a wave's
 * members never type a password at all.
 *
 * Done by hand rather than through arctic: arctic knows Google by name but
 * fetches through the global `fetch`, and a provider that is only ever tested
 * against the real thing is one nobody has seen fail. Here the network is a
 * parameter, and the test stands up a provider of its own.
 *
 * What is checked, and why each one:
 * - the discovery document names the issuer we were configured with, or a
 *   misconfigured proxy could hand us someone else's endpoints;
 * - the ID token's signature against the provider's published keys. The spec
 *   allows trusting TLS to the token endpoint instead; checking costs a key
 *   fetch and leaves nothing to argue about;
 * - `iss`, `aud`, `azp` and `exp`, which bind the token to this provider, this
 *   client and now;
 * - PKCE on every request, with or without a client secret, so an intercepted
 *   code is worth nothing.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const Discovery = z.looseObject({
  issuer: z.string(),
  authorization_endpoint: z.url(),
  token_endpoint: z.url(),
  jwks_uri: z.url(),
});
type Discovery = z.infer<typeof Discovery>;

const Jwks = z.object({ keys: z.array(z.looseObject({ kid: z.string().optional(), kty: z.string() })) });

const TokenResponse = z.looseObject({ id_token: z.string() });

const IdToken = z.looseObject({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.union([z.string(), z.array(z.string())]),
  azp: z.string().optional(),
  exp: z.number(),
  iat: z.number().optional(),
  email: z.string().optional(),
  // A boolean by the spec; a few providers send the string. Anything else,
  // including absent, means not verified.
  email_verified: z.union([z.boolean(), z.string()]).optional(),
  name: z.string().optional(),
  preferred_username: z.string().optional(),
  picture: z.string().optional(),
});

/** How each accepted algorithm is checked. `none` and the HMAC family are not among them. */
const ALGORITHMS: Record<string, (data: Buffer, key: KeyObject, signature: Buffer) => boolean> = {
  RS256: (d, k, s) => verify("sha256", d, k, s),
  RS384: (d, k, s) => verify("sha384", d, k, s),
  RS512: (d, k, s) => verify("sha512", d, k, s),
  PS256: (d, k, s) =>
    verify("sha256", d, { key: k, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 }, s),
  // JWS carries ECDSA signatures as r‖s, not as DER -- the same trap as in
  // ACME, the other way round.
  ES256: (d, k, s) => verify("sha256", d, { key: k, dsaEncoding: "ieee-p1363" }, s),
  ES384: (d, k, s) => verify("sha384", d, { key: k, dsaEncoding: "ieee-p1363" }, s),
  EdDSA: (d, k, s) => verify(null, d, k, s),
};

/** Tolerance for clocks that disagree, which they do. */
const SKEW_SECONDS = 60;

const base64url = (data: Buffer): string => data.toString("base64url");
const decodeJson = (part: string): unknown => JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

export class OidcProvider implements OAuthProvider {
  readonly id = "oidc";
  readonly usesPkce = true;
  readonly label: string;
  private discovery?: Promise<Discovery>;
  private keys = new Map<string, KeyObject>();

  constructor(
    private readonly config: OidcConfig,
    private readonly redirectUri: string,
    private readonly fetcher: Fetch = fetch,
    private readonly now: () => number = () => Date.now() / 1000,
  ) {
    this.label = config.name;
  }

  async createAuthorizationURL(state: string, codeVerifier: string): Promise<URL> {
    const discovery = await this.discover();
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("scope", "openid profile email");
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", base64url(createHash("sha256").update(codeVerifier).digest()));
    url.searchParams.set("code_challenge_method", "S256");
    return url;
  }

  async fetchClaims(code: string, codeVerifier: string): Promise<ProviderClaims> {
    const discovery = await this.discover();
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      code_verifier: codeVerifier,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    if (this.config.clientSecret) {
      // client_secret_basic, the method every provider has to support. Both
      // halves are form-encoded first, as RFC 6749 asks and few people do.
      const id = encodeURIComponent(this.config.clientId);
      const secret = encodeURIComponent(this.config.clientSecret);
      headers.authorization = `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`;
    } else {
      body.set("client_id", this.config.clientId);
    }

    const response = await this.fetcher(discovery.token_endpoint, { method: "POST", headers, body });
    if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
    const tokens = TokenResponse.parse(await response.json());
    const claims = await this.verifyIdToken(tokens.id_token, discovery);

    const verified = claims.email_verified === true || claims.email_verified === "true";
    return {
      // The issuer is part of the name an account is found by: `sub` is only
      // unique within one issuer, and a wave that moves to another provider
      // must not let that provider's user 42 into the old one's account.
      provider: `oidc:${this.config.issuer}`,
      subject: claims.sub,
      email: claims.email ?? null,
      // Absent means not verified -- the rule account linking and invitations
      // rest on. Pocket ID says true only when its "emails verified" setting
      // vouches for the address; see CLAUDE.md.
      emailVerified: verified && Boolean(claims.email),
      name: claims.name ?? claims.preferred_username ?? null,
      avatarUrl: claims.picture ?? null,
    };
  }

  /** Fetched once and kept: endpoints do not move while the server runs. A failure is retried next time. */
  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const response = await this.fetcher(`${this.config.issuer}/.well-known/openid-configuration`, {
        headers: { accept: "application/json" },
      });
      if (!response.ok) throw new Error(`discovery answered ${response.status}`);
      const discovery = Discovery.parse(await response.json());
      if (discovery.issuer.replace(/\/$/, "") !== this.config.issuer) {
        throw new Error(`the provider calls itself ${discovery.issuer}, not ${this.config.issuer}`);
      }
      return discovery;
    })().catch((error: unknown) => {
      this.discovery = undefined;
      throw error;
    });
    return this.discovery;
  }

  private async keyFor(kid: string | undefined, discovery: Discovery): Promise<KeyObject> {
    const find = () =>
      kid ? this.keys.get(kid) : this.keys.size === 1 ? [...this.keys.values()][0] : undefined;
    // An unknown key id is what a rotation looks like: fetch the set again,
    // once, before calling the token forged.
    if (!find()) await this.loadKeys(discovery);
    const key = find();
    if (!key)
      throw new Error(
        kid ? `no published key ${kid}` : "the token names no key and the provider has several",
      );
    return key;
  }

  private async loadKeys(discovery: Discovery): Promise<void> {
    const response = await this.fetcher(discovery.jwks_uri, { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`key set answered ${response.status}`);
    const jwks = Jwks.parse(await response.json());
    const keys = new Map<string, KeyObject>();
    for (const [index, jwk] of jwks.keys.entries()) {
      try {
        keys.set(
          jwk.kid ?? `#${index}`,
          createPublicKey({ key: jwk as JsonWebKeyInput["key"], format: "jwk" }),
        );
      } catch {
        // A key type this runtime cannot read is one no token of ours uses.
      }
    }
    this.keys = keys;
  }

  private async verifyIdToken(token: string, discovery: Discovery): Promise<z.infer<typeof IdToken>> {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("the ID token is not a JWS");
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];

    const header = z.object({ alg: z.string(), kid: z.string().optional() }).parse(decodeJson(headerPart));
    const check = ALGORITHMS[header.alg];
    if (!check) throw new Error(`the ID token is signed with ${header.alg}, which is not accepted`);
    const key = await this.keyFor(header.kid, discovery);
    const signed = Buffer.from(`${headerPart}.${payloadPart}`);
    if (!check(signed, key, Buffer.from(signaturePart, "base64url"))) {
      throw new Error("the ID token's signature does not verify");
    }

    const claims = IdToken.parse(decodeJson(payloadPart));
    if (claims.iss.replace(/\/$/, "") !== this.config.issuer) {
      throw new Error(`the ID token was issued by ${claims.iss}`);
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (!audience.includes(this.config.clientId)) throw new Error("the ID token is for another client");
    // With several audiences the token must say it was handed to us.
    if (audience.length > 1 && claims.azp !== this.config.clientId) {
      throw new Error("the ID token was handed to another client");
    }
    const now = this.now();
    if (claims.exp < now - SKEW_SECONDS) throw new Error("the ID token has expired");
    if (claims.iat !== undefined && claims.iat > now + SKEW_SECONDS) {
      throw new Error("the ID token was issued in the future");
    }
    return claims;
  }
}
