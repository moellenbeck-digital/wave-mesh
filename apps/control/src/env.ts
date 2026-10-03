import { Relay, UpdateChannel } from "@wave/proto";
import { z } from "zod";
import { LETSENCRYPT_STAGING } from "./acme/client.ts";

const EnvSchema = z.object({
  WAVE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WAVE_PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  /** Public origin of this server; OAuth redirect URIs are derived from it. */
  WAVE_BASE_URL: z.url().default("http://localhost:8080"),
  /**
   * Where the Next.js frontend listens. Set it and this server stops rendering
   * HTML: browser routes are redirected to the frontend's pages and everything
   * it does not own itself is proxied there. Unset, it serves the plain HTML
   * fallback -- that is what the end-to-end tests run against.
   */
  WAVE_WEB_URL: z.url().optional(),
  DATABASE_URL: z.string().default("postgres://wave:wave@127.0.0.1:5432/wave"),
  GOOGLE_CLIENT_ID: z.string().optional(),
  GOOGLE_CLIENT_SECRET: z.string().optional(),
  /**
   * Any OpenID Connect provider that publishes a discovery document -- Pocket
   * ID is the one this is written and tested for, Authelia, Authentik or
   * Keycloak speak the same. The issuer is the URL the provider names itself
   * by, e.g. https://id.example.com; its redirect URI here is
   * <WAVE_BASE_URL>/auth/oidc/callback.
   */
  WAVE_OIDC_ISSUER: z.url().optional(),
  WAVE_OIDC_CLIENT_ID: z.string().optional(),
  /** Unset for a public client, which then rests on PKCE alone. */
  WAVE_OIDC_CLIENT_SECRET: z.string().optional(),
  /** What the login button says, e.g. "Pocket ID". Defaults to the issuer's host. */
  WAVE_OIDC_NAME: z.string().optional(),
  /** Base64 Ed25519 private key used to sign netmaps. Required in production. */
  WAVE_NETMAP_SIGNING_KEY: z.string().optional(),
  /** JSON array of relays handed to every node, see @wave/proto's Relay. */
  WAVE_RELAYS: z.string().optional(),
  /**
   * The range waves are carved out of. Two servers know nothing about each
   * other, so a device enrolled with both would get the same addresses twice
   * and refuse the second wave -- give each server a slice of its own here.
   */
  WAVE_IPV4_CONTAINER: z.string().default("10.64.0.0/10"),
  /**
   * Networks the development login may be used from, as IPv4 CIDRs. Without
   * it the login is open to anyone who can reach the port.
   */
  WAVE_DEV_AUTH_FROM: z.string().optional(),
  /**
   * The ACME directory certificates are ordered from (D7). Staging by default,
   * on purpose: the production one has rate limits that a mistake burns for a
   * week, so reaching it is a deliberate act and never the default a test run
   * or a fresh container falls into.
   */
  WAVE_ACME_DIRECTORY: z.url().default(LETSENCRYPT_STAGING),
  /** Contact address for the ACME account; the CA uses it for expiry warnings. */
  WAVE_ACME_CONTACT: z.string().optional(),
  /**
   * 32 bytes, base64: the key the DNS provider tokens are sealed with. Without
   * it no credential can be stored or opened, which is the intended answer --
   * storing them in the clear would make a database dump a set of keys to
   * other people's domains.
   */
  WAVE_DNS_SECRET: z.string().optional(),
  /**
   * The update channels this server offers its devices, comma-separated
   * (D13). The first is the default: a device that names none, or one not on
   * the list, gets it. `stable,insiders` is a production wave that lets a
   * device opt into insiders; `insiders` alone puts every device there.
   */
  WAVE_UPDATE_CHANNELS: z.string().default("stable"),
  /** Where the releases come from. The repository is private, hence the token. */
  WAVE_UPDATE_REPO: z.string().default("moellenbeck-digital/wave-mesh"),
  /**
   * A fine-grained token for that one repository, Contents: read and nothing
   * else. It lives here and only here: no device gets it, no answer carries it
   * and no log prints it. Without it no update is offered, which a server says
   * once at start and is otherwise fine with.
   */
  WAVE_GITHUB_TOKEN: z.string().optional(),
  /** Password-free login for local development. Refused in production. */
  WAVE_DEV_AUTH: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  name: string;
}

/**
 * Reads the WAVE_OIDC_* variables. Half a configuration is refused rather
 * than ignored: an issuer without a client id is a login button somebody
 * expects and never gets, with nothing in the log to say why.
 */
export function parseOidc(raw: {
  WAVE_OIDC_ISSUER?: string;
  WAVE_OIDC_CLIENT_ID?: string;
  WAVE_OIDC_CLIENT_SECRET?: string;
  WAVE_OIDC_NAME?: string;
}): OidcConfig | undefined {
  if (!raw.WAVE_OIDC_ISSUER && !raw.WAVE_OIDC_CLIENT_ID) return undefined;
  if (!raw.WAVE_OIDC_ISSUER || !raw.WAVE_OIDC_CLIENT_ID) {
    throw new Error("WAVE_OIDC_ISSUER and WAVE_OIDC_CLIENT_ID go together; set both or neither");
  }
  const issuer = new URL(raw.WAVE_OIDC_ISSUER);
  // The ID token is trusted partly because it came straight from the token
  // endpoint over TLS. Plain HTTP is a provider anyone on the path can be;
  // only a loopback address, where there is no path, gets an exception.
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(issuer.hostname);
  if (issuer.protocol !== "https:" && !loopback) {
    throw new Error(`WAVE_OIDC_ISSUER must be https:// (got ${raw.WAVE_OIDC_ISSUER})`);
  }
  return {
    // Compared byte for byte with the `iss` of every token, so it is kept as
    // written, minus a trailing slash nobody means.
    issuer: raw.WAVE_OIDC_ISSUER.replace(/\/$/, ""),
    clientId: raw.WAVE_OIDC_CLIENT_ID,
    clientSecret: raw.WAVE_OIDC_CLIENT_SECRET?.trim() || undefined,
    name: raw.WAVE_OIDC_NAME?.trim() || issuer.host,
  };
}

export type Config = {
  env: "development" | "test" | "production";
  port: number;
  baseUrl: string;
  databaseUrl: string;
  webUrl?: string;
  google?: { clientId: string; clientSecret: string };
  oidc?: OidcConfig;
  netmapSigningKey?: string;
  relays: Relay[];
  ipv4Container: string;
  acmeDirectory: string;
  acmeContact: string[];
  /** Null when WAVE_DNS_SECRET is unset; storing a token then is refused. */
  dnsSecret?: Buffer;
  devAuth: boolean;
  devAuthFrom: string[];
  secureCookies: boolean;
  updates: {
    /** At least one; the first is the default. */
    channels: UpdateChannel[];
    repo: string;
    githubToken?: string;
  };
};

/**
 * Reads WAVE_UPDATE_CHANNELS. Refused at start rather than ignored: a typo in
 * a channel name would otherwise be a wave that silently never updates.
 */
export function parseUpdateChannels(value: string): UpdateChannel[] {
  const names = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const channels: UpdateChannel[] = [];
  for (const name of names) {
    const parsed = UpdateChannel.safeParse(name);
    if (!parsed.success) {
      throw new Error(
        `WAVE_UPDATE_CHANNELS: "${name}" is not a channel (${UpdateChannel.options.join(", ")})`,
      );
    }
    if (!channels.includes(parsed.data)) channels.push(parsed.data);
  }
  if (channels.length === 0) throw new Error("WAVE_UPDATE_CHANNELS names no channel");
  return channels;
}

export function loadConfig(source: Record<string, string | undefined> = process.env): Config {
  const raw = EnvSchema.parse(source);
  const google =
    raw.GOOGLE_CLIENT_ID && raw.GOOGLE_CLIENT_SECRET
      ? { clientId: raw.GOOGLE_CLIENT_ID, clientSecret: raw.GOOGLE_CLIENT_SECRET }
      : undefined;

  // Dev login bypasses the identity provider entirely: opt-in only, and never
  // reachable in production even when the flag is set.
  const devAuth = raw.WAVE_ENV !== "production" && raw.WAVE_DEV_AUTH;

  if (raw.WAVE_ENV === "production" && !raw.WAVE_NETMAP_SIGNING_KEY) {
    throw new Error("WAVE_NETMAP_SIGNING_KEY is required in production; clients pin it to verify netmaps");
  }

  const relays = raw.WAVE_RELAYS ? z.array(Relay).parse(JSON.parse(raw.WAVE_RELAYS)) : [];

  // Checked here rather than where it is used: a key of the wrong length fails
  // inside AES with a message about nothing in particular, and a server that
  // starts is one somebody will put credentials into.
  const dnsSecret = raw.WAVE_DNS_SECRET ? Buffer.from(raw.WAVE_DNS_SECRET, "base64") : undefined;
  if (dnsSecret && dnsSecret.length !== 32) {
    throw new Error("WAVE_DNS_SECRET must be 32 bytes, base64 encoded (openssl rand -base64 32)");
  }

  return {
    env: raw.WAVE_ENV,
    port: raw.WAVE_PORT,
    baseUrl: raw.WAVE_BASE_URL.replace(/\/$/, ""),
    databaseUrl: raw.DATABASE_URL,
    webUrl: raw.WAVE_WEB_URL?.replace(/\/$/, ""),
    google,
    oidc: parseOidc(raw),
    devAuth,
    devAuthFrom: (raw.WAVE_DEV_AUTH_FROM ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean),
    netmapSigningKey: raw.WAVE_NETMAP_SIGNING_KEY,
    relays,
    ipv4Container: raw.WAVE_IPV4_CONTAINER,
    acmeDirectory: raw.WAVE_ACME_DIRECTORY,
    acmeContact: raw.WAVE_ACME_CONTACT ? [`mailto:${raw.WAVE_ACME_CONTACT.replace(/^mailto:/, "")}`] : [],
    dnsSecret,
    secureCookies: raw.WAVE_BASE_URL.startsWith("https://"),
    updates: {
      channels: parseUpdateChannels(raw.WAVE_UPDATE_CHANNELS),
      repo: raw.WAVE_UPDATE_REPO,
      githubToken: raw.WAVE_GITHUB_TOKEN?.trim() || undefined,
    },
  };
}
