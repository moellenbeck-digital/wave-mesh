import { cookies } from "next/headers";
import { cache } from "react";

/**
 * The frontend never touches the database. Everything it shows comes from the
 * control server's JSON API, called with the browser's session cookie, so that
 * who may see what is decided in exactly one place.
 */
const CONTROL_URL = process.env.WAVE_CONTROL_URL ?? "http://127.0.0.1:8080";

export interface Wave {
  id: string;
  name: string;
  dnsSuffix: string;
  role: "owner" | "admin" | "member";
}

/** Who may invite, remove a member and remove a device. Members may only look. */
export const canManage = (role: Wave["role"]): boolean => role === "owner" || role === "admin";

/** An invitation waiting for this account's address, without its token. */
export interface WaitingInvite {
  wave: string;
  role: "admin" | "member";
  invitedBy: string | null;
  expiresAt: string;
}

export interface Me {
  user: { id: string; email: string | null; emailVerified: boolean; name: string | null };
  waves: Wave[];
  invites: WaitingInvite[];
  /** What the create form starts with, so neither field is ever empty. */
  suggestion: { name: string; dnsSuffix: string };
}

export interface Member {
  userId: string;
  email: string | null;
  name: string | null;
  role: Wave["role"];
  /** Devices of this member in this wave -- what a removal takes with it. */
  nodeCount: number;
  joinedAt: string;
}

export interface WaveInvite {
  id: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string | null;
  expiresAt: string;
}

export interface Membership {
  /** The caller's own role, which decides whether anything can be changed. */
  role: Wave["role"];
  members: Member[];
  invites: WaveInvite[];
}

/** What the invited person is being offered, before they are signed in. */
export interface InviteOffer {
  wave: string;
  email: string;
  role: "admin" | "member";
  invitedBy: string | null;
  expiresAt: string;
  /** False means the address can set a password right here. */
  hasAccount: boolean;
}

/** A device waiting to be put into one of several waves. */
export interface DeviceRequest {
  request: { id: string; hostname: string; os: Node["os"] };
  waves: { id: string; name: string; dnsSuffix: string }[];
}

/** A name in the wave that is not a device: reached through one node (D11). */
export interface Service {
  name: string;
  ipv4: string;
  ipv6: string;
  /**
   * Where to open it, written out by the control server.
   *
   * Not assembled here from a scheme and the wave's suffix: only the cluster
   * knows the one and only the wave the other, and every device gets this same
   * address in its netmap. One spelling, one place.
   */
  url: string;
}

export interface Node {
  id: string;
  hostname: string;
  os: "linux" | "darwin" | "windows" | "other";
  ipv4: string;
  ipv6: string;
  approved: boolean;
  ephemeral: boolean;
  createdAt: string;
  lastSeenAt: string | null;
  keyExpiresAt: string | null;
  online: boolean;
  /** The client build it last reported, and its update channel (D13); null if it never said. */
  clientVersion: string | null;
  updateChannel: string | null;
  /** What this node answers for besides itself -- a connector's services. */
  services: Service[];
}

async function controlFetch(path: string): Promise<Response> {
  const cookie = (await cookies()).toString();
  return fetch(new URL(path, CONTROL_URL), {
    headers: cookie ? { cookie } : {},
    cache: "no-store",
  });
}

/**
 * Null means "not signed in" -- every page decides for itself what to do.
 * Cached per request because the layout and the page both want it.
 */
export const fetchMe = cache(async (): Promise<Me | null> => {
  const res = await controlFetch("/api/me");
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`control server answered ${res.status} for /api/me`);
  return (await res.json()) as Me;
});

export async function fetchNodes(waveId: string): Promise<Node[]> {
  const res = await controlFetch(`/api/waves/${encodeURIComponent(waveId)}/nodes`);
  if (!res.ok) throw new Error(`control server answered ${res.status} for the nodes of ${waveId}`);
  return ((await res.json()) as { nodes: Node[] }).nodes;
}

/** A way to sign in besides the password, with what the control server calls it. */
export interface AuthProvider {
  id: string;
  /** Set by the operator for an OIDC provider ("Pocket ID"); missing from an older server. */
  label: string | null;
}

export async function fetchProviders(): Promise<AuthProvider[]> {
  const res = await controlFetch("/api/auth/providers");
  if (!res.ok) throw new Error(`control server answered ${res.status} for /api/auth/providers`);
  const body = (await res.json()) as { providers: string[]; labels?: Record<string, string> };
  return body.providers.map((id) => ({ id, label: body.labels?.[id] ?? null }));
}

export async function fetchMembers(waveId: string): Promise<Membership> {
  const res = await controlFetch(`/api/waves/${encodeURIComponent(waveId)}/members`);
  if (!res.ok) throw new Error(`control server answered ${res.status} for the members of ${waveId}`);
  return (await res.json()) as Membership;
}

/** Null is an invitation that was used, withdrawn or has expired. */
export async function fetchInvite(token: string): Promise<InviteOffer | null> {
  const res = await controlFetch(`/api/invites/${encodeURIComponent(token)}`);
  if (res.status === 410 || res.status === 404) return null;
  if (!res.ok) throw new Error(`control server answered ${res.status} for an invitation`);
  return (await res.json()) as InviteOffer;
}

/** Null is a device request that expired while the browser was on the way. */
export async function fetchDeviceRequest(id: string): Promise<DeviceRequest | null> {
  const res = await controlFetch(`/api/machine/requests/${encodeURIComponent(id)}`);
  if (res.status === 410 || res.status === 401) return null;
  if (!res.ok) throw new Error(`control server answered ${res.status} for a device request`);
  return (await res.json()) as DeviceRequest;
}

/** One device as the policy page shows it: its tags and its word on the ports. */
export interface AclDevice {
  id: string;
  hostname: string;
  ipv4: string;
  /** Whose it is and in which role -- what `user:` and `role:` match while it wears no tag. */
  email: string | null;
  role: Wave["role"];
  tags: string[];
  /** In words, or null while there is no policy to enforce. */
  ports: string | null;
  enforced: boolean;
}

/** A wave's policy (M7) and what it comes to, as the control server says. */
export interface AclView {
  /** Null is the full mesh: every device reaches every other. */
  policy: unknown | null;
  version: number;
  updatedAt: string | null;
  /** One line per device: who it reaches, on which ports. */
  reach: string[];
  devices: AclDevice[];
  /** Everyone a `user:` rule can name, devices or not. */
  members: { email: string; role: Wave["role"] }[];
  services: { name: string; ipv4: string }[];
}

/** A draft judged by the control server without saving it (`/acl/preview`). */
export interface AclPreview {
  errors: string[];
  warnings: string[];
  /** Null without a policy, or while it does not hold. */
  reach: { from: string; to: string; ports: string }[] | null;
  covers: Record<string, { nodes: string[]; services: string[] }>;
}

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  target: string | null;
  detail: Record<string, unknown> | null;
}

/** Null is a wave the caller may not manage -- or is not in. */
export async function fetchAcl(waveId: string): Promise<AclView | null> {
  const res = await controlFetch(`/api/waves/${encodeURIComponent(waveId)}/acl`);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new Error(`control server answered ${res.status} for the policy of ${waveId}`);
  return (await res.json()) as AclView;
}

export async function fetchAudit(waveId: string, limit = 30): Promise<AuditEntry[]> {
  const res = await controlFetch(`/api/waves/${encodeURIComponent(waveId)}/audit?limit=${limit}`);
  if (!res.ok) return [];
  return ((await res.json()) as { entries: AuditEntry[] }).entries;
}
