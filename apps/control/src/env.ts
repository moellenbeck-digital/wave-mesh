import { Relay, UpdateChannel } from "@wave/proto";
import { z } from "zod";
import { LETSENCRYPT_STAGING } from "./acme/client.ts";
import { DEFAULT_FREE_DEVICE_LIMIT } from "./billing/device-limit.ts";
import { DEFAULT_FREE_MAX_WAVES, parseBlockedDomains } from "./billing/plan.ts";
import { parseIpv4Cidr, RESOLVER_OFFSET, usableAddresses } from "./net/addressing.ts";

/** Free waves get a /24 unless WAVE_FREE_IPV4_PREFIX_LENGTH says otherwise. */
export const DEFAULT_FREE_IPV4_PREFIX_LENGTH = 24;

/** /16 blocks kept free for billed waves: 4 of the 64 in the default container. */
export const DEFAULT_CAPACITY_RESERVE = 4;

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
  /** Where the releases come from. The current release feed requires a token. */
  WAVE_UPDATE_REPO: z.string().default("moellenbeck-digital/wave-mesh"),
  /**
   * A fine-grained token for that one repository, Contents: read and nothing
   * else. It lives here and only here: no device gets it, no answer carries it
   * and no log prints it. Without it no update is offered, which a server says
   * once at start and is otherwise fine with.
   */
  WAVE_GITHUB_TOKEN: z.string().optional(),
  /**
   * The bearer token wave-mesh.org calls the billing routes with. Unset, those
   * routes do not exist (404): a self-hosted server sells nothing, and a route
   * that answers 401 is one somebody starts guessing at.
   */
  WAVE_BILLING_TOKEN: z.string().optional(),
  /**
   * Days an ended subscription's wave is kept before it is deleted. An empty
   * value is the default, not zero: `z.coerce` reads "" as 0, and a template
   * that renders the variable empty would otherwise delete every ended wave
   * at the next sweep. At least one day, for the same reason.
   */
  WAVE_BILLING_RETENTION_DAYS: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).default(30),
  ),
  /**
   * How many distinct devices a hosted account without a subscription may
   * register across all its waves (see billing/device-limit.ts). An empty
   * value is the default, not zero, for the same reason as above.
   */
  WAVE_FREE_DEVICE_LIMIT: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).default(DEFAULT_FREE_DEVICE_LIMIT),
  ),
  /**
   * How many waves a free hosted account may hold (billing/plan.ts). Empty is
   * the default, not zero, for the same reason as above.
   */
  WAVE_FREE_MAX_WAVES: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(1).default(DEFAULT_FREE_MAX_WAVES),
  ),
  /**
   * Prefix length of the address block a new **free** wave gets (ticket #118).
   * Billed waves stay /16. Existing waves are never renumbered. Checked at
   * start against WAVE_FREE_DEVICE_LIMIT (see checkFreePrefixLength).
   */
  WAVE_FREE_IPV4_PREFIX_LENGTH: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(16).max(30).default(DEFAULT_FREE_IPV4_PREFIX_LENGTH),
  ),
  /**
   * How many whole /16 blocks must stay free in the container after a free
   * wave is numbered. Below it a free sign-up is refused (the paying customer
   * still gets a block) and every new wave logs a warning. 0 turns it off.
   */
  WAVE_CAPACITY_RESERVE: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.coerce.number().int().min(0).default(DEFAULT_CAPACITY_RESERVE),
  ),
  /**
   * Comma-separated email domains (throwaway providers) that cannot start a
   * free hosted account. Optional; empty blocks nothing.
   */
  WAVE_FREE_BLOCKED_EMAIL_DOMAINS: z.string().optional(),
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
  /** Absent when WAVE_BILLING_TOKEN is unset: no billing routes at all. */
  billing?: { token: string; retentionDays: number };
  /** Distinct devices a free hosted account may register; see billing/device-limit.ts. */
  freeDeviceLimit: number;
  /** Waves a free hosted account may hold; see billing/plan.ts. */
  freeMaxWaves: number;
  /** Lowercased domains that cannot start a free account. */
  freeBlockedEmailDomains: string[];
  /** Prefix length of the block a new free wave gets; billed waves are /16. */
  freeIpv4PrefixLength: number;
  /** Whole /16 blocks that stay free for billed waves; see WAVE_CAPACITY_RESERVE. */
  capacityReserve: number;
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

/**
 * Refused at start: a block that cannot hold the devices a free account may
 * register, or cannot spare the resolver's address, would hand out waves that
 * break only once somebody uses them.
 */
export function checkFreePrefixLength(prefixLength: number, deviceLimit: number, container: string): void {
  const name = `WAVE_FREE_IPV4_PREFIX_LENGTH=${prefixLength}`;
  const { usable, resolverFits } = usableAddresses(prefixLength);
  if (!resolverFits) {
    throw new Error(
      `${name} is too small: a /${prefixLength} cannot hold the wave's resolver address (offset ${RESOLVER_OFFSET}); use /26 or larger`,
    );
  }
  if (usable < deviceLimit) {
    throw new Error(
      `${name} is too small: it leaves ${usable} usable addresses (without network, broadcast and resolver address), WAVE_FREE_DEVICE_LIMIT=${deviceLimit} needs at least that many`,
    );
  }
  let size: number;
  try {
    size = parseIpv4Cidr(container).size;
  } catch {
    return; // not ours to judge here; the allocator says so when it is used
  }
  if (2 ** (32 - prefixLength) > size) {
    throw new Error(`${name} does not fit inside WAVE_IPV4_CONTAINER=${container}`);
  }
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

  checkFreePrefixLength(
    raw.WAVE_FREE_IPV4_PREFIX_LENGTH,
    raw.WAVE_FREE_DEVICE_LIMIT,
    raw.WAVE_IPV4_CONTAINER,
  );

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
    billing: billingConfig(raw.WAVE_BILLING_TOKEN, raw.WAVE_BILLING_RETENTION_DAYS),
    freeDeviceLimit: raw.WAVE_FREE_DEVICE_LIMIT,
    freeMaxWaves: raw.WAVE_FREE_MAX_WAVES,
    freeBlockedEmailDomains: parseBlockedDomains(raw.WAVE_FREE_BLOCKED_EMAIL_DOMAINS),
    freeIpv4PrefixLength: raw.WAVE_FREE_IPV4_PREFIX_LENGTH,
    capacityReserve: raw.WAVE_CAPACITY_RESERVE,
    updates: {
      channels: parseUpdateChannels(raw.WAVE_UPDATE_CHANNELS),
      repo: raw.WAVE_UPDATE_REPO,
      githubToken: raw.WAVE_GITHUB_TOKEN?.trim() || undefined,
    },
  };
}

/**
 * Refused at start when too short to be a secret: this token is what turns a
 * paid subscription into a wave, and a short one is a guessable one.
 */
function billingConfig(token: string | undefined, retentionDays: number): Config["billing"] {
  const trimmed = token?.trim();
  if (!trimmed) return undefined;
  if (trimmed.length < 32) {
    throw new Error("WAVE_BILLING_TOKEN must be at least 32 characters (openssl rand -base64 32)");
  }
  return { token: trimmed, retentionDays };
}
