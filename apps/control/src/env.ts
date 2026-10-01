import { Relay } from "@wave/proto";
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
  /** Password-free login for local development. Refused in production. */
  WAVE_DEV_AUTH: z
    .string()
    .optional()
    .transform((v) => v === "1" || v === "true"),
});

export type Config = {
  env: "development" | "test" | "production";
  port: number;
  baseUrl: string;
  databaseUrl: string;
  webUrl?: string;
  google?: { clientId: string; clientSecret: string };
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
};

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
  };
}
