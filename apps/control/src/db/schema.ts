import type { AclPolicy, Candidate, ServiceScheme } from "@wave/proto";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  /** Lowercased. Null is legitimate: Instagram never hands out an address. */
  email: text("email"),
  /** Only a verified address may ever be used to link a second identity. */
  emailVerified: boolean("email_verified").notNull().default(false),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  /** Argon2id hash; null for accounts that only sign in through a provider. */
  passwordHash: text("password_hash"),
  /**
   * The second factor of the password login (RFC 6238), as base32. Stored as
   * it is, not sealed: it only matters together with the password, and the
   * password is an Argon2id hash -- see CLAUDE.md for the trade.
   */
  totpSecret: text("totp_secret"),
  /** A secret being set up: shown as a QR code, live only once a code from it is confirmed. */
  totpPendingSecret: text("totp_pending_secret"),
  totpEnabledAt: timestamp("totp_enabled_at", { withTimezone: true }),
  /** The 30-second step of the last code accepted; no code at or before it works again. */
  totpLastStep: integer("totp_last_step"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const identities = pgTable(
  "identities",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    /** The provider's stable subject claim -- never the email. */
    subject: text("subject").notNull(),
    email: text("email"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("identities_provider_subject_idx").on(t.provider, t.subject)],
);

export const waves = pgTable(
  "waves",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** Public domain once configured; a placeholder suffix until then. */
    dnsSuffix: text("dns_suffix").notNull(),
    ownerUserId: text("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    ipv4Prefix: text("ipv4_prefix").notNull(),
    ipv6Prefix: text("ipv6_prefix").notNull(),
    /** Bumped whenever the wave's nodes change; carried in every netmap. */
    netmapVersion: integer("netmap_version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("waves_dns_suffix_idx").on(t.dnsSuffix),
    // Two waves sharing a block would hand the same address to two nodes, and a
    // client in both would have two host routes for it. The allocator picks the
    // lowest free block; this is what makes the pick binding.
    uniqueIndex("waves_ipv4_prefix_idx").on(t.ipv4Prefix),
  ],
);

export const waveMembers = pgTable(
  "wave_members",
  {
    waveId: text("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["owner", "admin", "member"] }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.waveId, t.userId] })],
);

/**
 * A pending invitation of one address into one wave.
 *
 * Bound to an email address on purpose: a link anyone could redeem would be a
 * registration page with extra steps, and this server deliberately has none.
 * The address is also what lets a login know it should wait for the invite
 * instead of provisioning a wave of its own (see `ensureWaveForUser`).
 *
 * The token is 32 random bytes and only its SHA-256 is stored -- no Argon2id,
 * unlike a password: there is nothing to guess at that entropy, and the
 * lookup happens on every click of the link.
 */
export const waveInvites = pgTable(
  "wave_invites",
  {
    id: text("id").primaryKey(),
    waveId: text("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    /** Lowercased. Only this address may redeem the invitation. */
    email: text("email").notNull(),
    /** Never "owner": a wave has exactly one, and it is not handed out by link. */
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    tokenHash: text("token_hash").notNull(),
    invitedByUserId: text("invited_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    acceptedByUserId: text("accepted_by_user_id").references(() => users.id, { onDelete: "set null" }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("wave_invites_token_idx").on(t.tokenHash),
    index("wave_invites_wave_idx").on(t.waveId),
    // Every login looks for an invitation waiting for its address.
    index("wave_invites_email_idx").on(t.email),
  ],
);

/**
 * One-time codes for the day the phone is gone. Stored as SHA-256 like invite
 * tokens: they are random enough that there is nothing to guess, and checking
 * one must not cost an Argon2 round.
 */
export const totpRecoveryCodes = pgTable(
  "totp_recovery_codes",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    codeHash: text("code_hash").notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("totp_recovery_codes_user_idx").on(t.userId)],
);

/**
 * A password login waiting for its second factor. Not a session: it opens
 * nothing but the one form that asks for the code, and lives minutes.
 */
export const loginChallenges = pgTable(
  "login_challenges",
  {
    /** SHA-256 of the token in the cookie, like a session. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    next: text("next"),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_challenges_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the session token. The token itself is never stored. */
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: text("user_agent"),
    ip: text("ip"),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const nodes = pgTable(
  "nodes",
  {
    id: text("id").primaryKey(),
    waveId: text("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Long-lived device identity; authenticates every request this node makes. */
    machineKey: text("machine_key").notNull(),
    /** WireGuard public key. Replaced on re-registration. */
    nodeKey: text("node_key").notNull(),
    discoKey: text("disco_key").notNull(),
    hostname: text("hostname").notNull(),
    os: text("os", { enum: ["linux", "darwin", "windows", "other"] }).notNull(),
    ipv4: text("ipv4").notNull(),
    ipv6: text("ipv6").notNull(),
    /** Addresses this node believes it is reachable at. Replaced wholesale. */
    candidates: jsonb("candidates").$type<Candidate[]>().notNull().default([]),
    approved: boolean("approved").notNull().default(true),
    /**
     * Whether this device may ask for the wave's wildcard (D7).
     *
     * Off unless an operator turns it on, because a wildcard is not a name that
     * belongs to a device: it stands for every name in the wave, and whoever
     * holds its key can be any of them. That is a decision for whoever runs the
     * wave, not for the device asking.
     */
    wildcardAllowed: boolean("wildcard_allowed").notNull().default(false),
    /**
     * What this device is to the wave's policy (M7): `tag:nas`, `tag:connector`.
     *
     * Set by an operator, never by the device -- the same reason as the
     * wildcard: a tag is a grant, and a device that could name its own would
     * pick the one with the most access. A tagged device is its tags and no
     * longer counts as its owner's (see AclPolicy).
     */
    tags: jsonb("tags").$type<string[]>().notNull().default([]),
    /**
     * What the device last said about the ports of its wave's policy: true if
     * it enforces them, false if it cannot (and `filterReason` says why), null
     * if it never said -- a client from before the policy existed.
     */
    filterEnforced: boolean("filter_enforced"),
    filterReason: text("filter_reason"),
    /**
     * What the device said about itself in its last `hello` (D13): which
     * build, for which machine, and the update channel it was assigned. Null
     * for a client from before self-updates, which never says -- the same
     * shape as `filterEnforced`, and shown next to it.
     */
    clientVersion: text("client_version"),
    clientPlatform: text("client_platform"),
    updateChannel: text("update_channel"),
    ephemeral: boolean("ephemeral").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    keyExpiresAt: timestamp("key_expires_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("nodes_machine_key_idx").on(t.machineKey),
    uniqueIndex("nodes_wave_ipv4_idx").on(t.waveId, t.ipv4),
    uniqueIndex("nodes_wave_hostname_idx").on(t.waveId, t.hostname),
    index("nodes_wave_idx").on(t.waveId),
  ],
);

/**
 * A service in the wave: a name and an address of its own, reached through one
 * node (D11).
 *
 * Not a node, because a node is a WireGuard peer and a service has no keys --
 * twenty ingresses would be twenty tunnels in one pod. Instead the connector
 * that fronts them is one ordinary node, and each service is an address out of
 * the wave's own block that is routed to it.
 *
 * Addresses and names come from the *same* pool as the nodes': a name in a wave
 * should mean one thing, so `grafana` cannot be a device here and a service
 * there. No index can say that across two tables, which is why the allocation
 * takes a row lock on the wave -- where `netmap_version` already makes the
 * serialisation point.
 */
export const waveServices = pgTable(
  "wave_services",
  {
    id: text("id").primaryKey(),
    waveId: text("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    /** One label under the wave's suffix, e.g. `grafana`. */
    name: text("name").notNull(),
    /** The node that answers for it -- the cluster's connector. */
    viaNodeId: text("via_node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    ipv4: text("ipv4").notNull(),
    ipv6: text("ipv6").notNull(),
    /**
     * How the cluster serves it, which only the cluster can know (D11).
     *
     * https by default, and that is not a guess about the world: every service
     * that existed before this column came from an operator that never said,
     * and a name under the wave's own domain is there to carry a certificate
     * (D7). An operator that reports an Ingress without TLS moves it to http.
     */
    scheme: text("scheme").$type<ServiceScheme>().notNull().default("https"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("wave_services_name_idx").on(t.waveId, t.name),
    uniqueIndex("wave_services_ipv4_idx").on(t.waveId, t.ipv4),
    index("wave_services_node_idx").on(t.viaNodeId),
  ],
);

/**
 * Who may reach whom in a wave (M7). No row means the full mesh of D9.
 *
 * One document per wave rather than a table of rules: a policy is read and
 * written whole, validated whole, and an edit that is half applied is a policy
 * nobody wrote.
 */
export const aclPolicies = pgTable("acl_policies", {
  waveId: text("wave_id")
    .primaryKey()
    .references(() => waves.id, { onDelete: "cascade" }),
  document: jsonb("document").$type<AclPolicy>().notNull(),
  /** Counts every change, so a log line can say which one a device is on. */
  version: integer("version").notNull().default(1),
  updatedByUserId: text("updated_by_user_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Who changed what in a wave, and when (M7).
 *
 * Written next to the change and never updated. The actor is kept twice: as a
 * reference while the account exists, and as the words it had at the time --
 * an entry that says "a user who has since been deleted" answers nothing.
 * Entries go with their wave: a wave that is deleted takes its history along,
 * the same as its devices and members.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    waveId: text("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    /** An address, or `shell:<user>` for wave-admin, or `device:<hostname>`. */
    actor: text("actor").notNull(),
    /** A dotted name: `acl.set`, `member.remove`, `device.approve`. */
    action: text("action").notNull(),
    /** What it was done to, in words: a hostname, an address, a key id. */
    target: text("target"),
    detail: jsonb("detail").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_log_wave_idx").on(t.waveId, t.createdAt)],
);

/**
 * A key that lets a device enrol without a browser (D11's prerequisite).
 *
 * The approval flow needs a human at a link, and some devices have nobody:
 * a connector in a Kubernetes cluster is deployed, not clicked. A pre-auth key
 * is that human's decision made in advance -- it names the wave, it expires,
 * and it can be withdrawn.
 *
 * Only the SHA-256 is stored, like an invitation: 32 random bytes have nothing
 * to guess, and the comparison happens on every registration.
 */
export const waveAuthKeys = pgTable(
  "wave_auth_keys",
  {
    id: text("id").primaryKey(),
    waveId: text("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    /** Whose devices these become; a key cannot outlive its author's account. */
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    /** What it is for, so a list of keys says something a month later. */
    label: text("label"),
    /**
     * Whether more than one device may use it. A cluster that scales its
     * connector needs that; a single machine should not have it.
     */
    reusable: boolean("reusable").notNull().default(false),
    /** Devices enrolled with it, for the same reason. */
    uses: integer("uses").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("wave_auth_keys_token_idx").on(t.tokenHash),
    index("wave_auth_keys_wave_idx").on(t.waveId),
  ],
);

/**
 * A device waiting for a human to approve it. Created by an unauthenticated
 * registration and consumed either by the browser flow or a pre-auth key.
 */
export const authRequests = pgTable(
  "auth_requests",
  {
    id: text("id").primaryKey(),
    machineKey: text("machine_key").notNull(),
    nodeKey: text("node_key").notNull(),
    discoKey: text("disco_key").notNull(),
    hostname: text("hostname").notNull(),
    os: text("os", { enum: ["linux", "darwin", "windows", "other"] }).notNull(),
    /** SHA-256 of the secret the client polls with. */
    pollSecretHash: text("poll_secret_hash").notNull(),
    status: text("status", { enum: ["pending", "authorized", "expired"] })
      .notNull()
      .default("pending"),
    nodeId: text("node_id").references(() => nodes.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [uniqueIndex("auth_requests_poll_secret_idx").on(t.pollSecretHash)],
);

/**
 * This server's account at one ACME directory (D7).
 *
 * One account for the whole server, not one per wave: an account is only how
 * the CA recognises us, and the authorisation that matters happens per name
 * through dns-01. The key is stored as it is -- it authenticates nothing but
 * the account, and every certificate it could ever ask for still requires
 * control of the zone. The DNS token below is the dangerous secret, and that
 * one is sealed.
 */
/** One dns-01 challenge as the order remembers it. */
export interface CertChallenge {
  /** The record to create, e.g. _acme-challenge.laptop.wave.example.com. */
  name: string;
  value: string;
  /** Where to tell the CA to look, and where to read the outcome. */
  challengeUrl: string;
  authorizationUrl: string;
}

export const acmeAccounts = pgTable("acme_accounts", {
  /** The directory URL is the identity: staging and production are two accounts. */
  directoryUrl: text("directory_url").primaryKey(),
  /** PKCS#8 PEM, P-256. Created on first use. */
  privateKeyPem: text("private_key_pem").notNull(),
  /** The account URL the CA handed back; null until it has been registered. */
  accountUrl: text("account_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * How a wave writes into its own zone, so the control server can answer the
 * dns-01 challenge for it.
 *
 * One credential per wave, because a zone belongs to a wave the same way its
 * suffix does. The token is sealed with WAVE_DNS_SECRET and never stored as it
 * was typed: a database dump must not be a set of keys to other people's
 * domains.
 */
export const dnsCredentials = pgTable("dns_credentials", {
  waveId: text("wave_id")
    .primaryKey()
    .references(() => waves.id, { onDelete: "cascade" }),
  provider: text("provider", { enum: ["cloudflare", "hetzner", "ionos", "inwx", "manual"] }).notNull(),
  /**
   * AES-256-GCM, keyed by WAVE_DNS_SECRET. Never the token itself, and null in
   * the manual mode -- there is no token when a person writes the record.
   */
  tokenSealed: text("token_sealed"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * One certificate a node asked for, from the request to the finished chain.
 *
 * A row rather than a promise in memory, because issuance takes as long as a
 * CA takes: the node posts its CSR, gets an id, and comes back for the chain.
 * A restart in between therefore loses the order and not the node's key -- the
 * key never left the node in the first place.
 */
export const certificateOrders = pgTable(
  "certificate_orders",
  {
    id: text("id").primaryKey(),
    waveId: text("wave_id")
      .notNull()
      .references(() => waves.id, { onDelete: "cascade" }),
    nodeId: text("node_id")
      .notNull()
      .references(() => nodes.id, { onDelete: "cascade" }),
    /** The names as authorised, which is also what the CSR asked for. */
    names: jsonb("names").$type<string[]>().notNull(),
    /**
     * The dns-01 challenges of this order, with the record each one needs.
     *
     * Stored rather than held in memory because in the manual mode the order
     * waits for a person: the record may appear minutes or days later, and a
     * restart in between must not lose an order the CA is still holding open.
     */
    challenges: jsonb("challenges").$type<CertChallenge[]>().notNull().default([]),
    /** The order at the CA, so a resumed run picks up the same one. */
    acmeOrderUrl: text("acme_order_url"),
    /**
     * The request itself, base64. Kept because finalising happens minutes after
     * the node posted it and may well happen after a restart -- and because a
     * CSR is public: it is a name and a public key, signed.
     */
    csr: text("csr").notNull(),
    /**
     * `waiting` is the manual mode: the record has been named and nothing will
     * happen until it exists in the zone.
     */
    status: text("status", { enum: ["pending", "waiting", "valid", "failed"] })
      .notNull()
      .default("pending"),
    /** Leaf first, as the CA served it. Public, like every certificate. */
    chainPem: text("chain_pem"),
    /** Why it failed, in the words the node gets to see. */
    error: text("error"),
    /** ARI's suggestion, or two thirds of the lifetime when the CA has none. */
    renewAt: timestamp("renew_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("certificate_orders_node_idx").on(t.nodeId),
    index("certificate_orders_wave_idx").on(t.waveId),
  ],
);

/**
 * A wave someone pays for (Stripe, through wave-mesh.org). Only billed waves
 * have a row here; a self-hosted wave never does, and nothing below applies to
 * it.
 *
 * The subscription id is the key the site speaks in: Stripe repeats events and
 * delivers them out of order, so every call names the subscription and states
 * what the wave should be, rather than describing a change. Saying the same
 * thing twice is then the same as saying it once.
 */
export const waveBilling = pgTable(
  "wave_billing",
  {
    waveId: text("wave_id")
      .primaryKey()
      .references(() => waves.id, { onDelete: "cascade" }),
    subscriptionId: text("subscription_id").notNull(),
    /** How many people the wave may hold: members plus open invitations. */
    seats: integer("seats").notNull(),
    /** "suspended" and "ended" keep every row and stop the mesh; see netmap/build.ts. */
    state: text("state", { enum: ["active", "suspended", "ended"] }).notNull(),
    /** Set once a subscription has ended; the sweep deletes the wave after it. */
    deleteAfter: timestamp("delete_after", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("wave_billing_subscription_idx").on(t.subscriptionId)],
);

/**
 * A link that lets an account set its first password, sent to its address.
 *
 * Stored as SHA-256 like invitation tokens. Following it proves the mailbox,
 * which is why redeeming it is what marks the address verified -- nothing
 * before it did.
 */
export const passwordSetups = pgTable(
  "password_setups",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("password_setups_token_idx").on(t.tokenHash),
    index("password_setups_user_idx").on(t.userId),
  ],
);

export const schema = {
  users,
  waveAuthKeys,
  waveServices,
  identities,
  waves,
  waveMembers,
  waveInvites,
  sessions,
  nodes,
  authRequests,
  acmeAccounts,
  dnsCredentials,
  certificateOrders,
};
