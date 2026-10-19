import { z } from "zod";
import { Notice } from "./notice.ts";

/**
 * The local control channel between the privileged daemon and everything that
 * wants to look at or steer the tunnel: the CLI, and later the tray.
 *
 * A unix socket rather than a port, so access is decided by file permissions
 * -- the socket is owned by root and readable by one group, which is the same
 * arrangement Docker uses. Messages are newline-delimited JSON, one request to
 * one or more replies, because the status view wants a stream.
 */

/**
 * Where the daemon listens. A named pipe on Windows and a unix socket
 * elsewhere -- node:net serves both through the same API, which is why the
 * control channel uses it rather than a Bun-specific one.
 */
export function defaultSocketPath(platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return "\\\\.\\pipe\\wave-waved";
  if (platform === "darwin") return "/var/run/wave/waved.sock";
  return "/run/wave/waved.sock";
}

export const DEFAULT_SOCKET_PATH = defaultSocketPath();

export const Request = z.discriminatedUnion("command", [
  z.object({ command: z.literal("status") }),
  /** Streams a status snapshot on every change until the client goes away. */
  z.object({ command: z.literal("watch") }),
  /**
   * A device can be in several waves at once, and what tells them apart is the
   * control server -- there is no second name for a connection. Without a URL,
   * "up" and "down" mean every enrolment marked autoStart, which is what keeps
   * the single-wave case a plain `wave up`.
   */
  z.object({ command: z.literal("up"), controlUrl: z.string().optional() }),
  z.object({ command: z.literal("down"), controlUrl: z.string().optional() }),
  /** Leaving a wave is never a bulk operation: it throws keys away. */
  z.object({ command: z.literal("logout"), controlUrl: z.string() }),
  /**
   * Enrols with a further server, alongside the ones already there. A pre-auth
   * key stands in for the browser, which a machine in a cluster does not have.
   */
  z.object({
    command: z.literal("login"),
    controlUrl: z.string(),
    authKey: z.string().optional(),
    /**
     * Join a further wave at a server this device is already in -- another
     * project's network on the same server. A new enrolment with keys of its
     * own; the server asks on approval which wave it goes to.
     */
    newWave: z.boolean().optional(),
  }),
  /**
   * Gets a certificate for a name in one wave, and renews it from then on.
   * Without a name it is this device's own name in that wave -- the usual case,
   * and the only one that needs no thought.
   */
  z.object({
    command: z.literal("cert"),
    controlUrl: z.string().optional(),
    names: z.array(z.string()).optional(),
    /** Ask for the wave's wildcard, which only a granted device may have. */
    wildcard: z.boolean().optional(),
    /** Shell command to run after every renewal, e.g. "systemctl reload caddy". */
    hook: z.string().optional(),
  }),
  z.object({ command: z.literal("certs") }),
  /**
   * Self-updates (D13). Without fields it only reports. `channel` and
   * `autoUpdate` change the settings -- the channel is a wish the control
   * servers may overrule, null hands it back to them. `install` installs the
   * best offer now instead of after the random delay.
   *
   * Which version and from where is never part of the request: the daemon
   * decides that from signed offers. Otherwise any member of the socket's
   * group could have root run a binary of their choosing.
   */
  z.object({
    command: z.literal("update"),
    channel: z.enum(["stable", "insiders", "develop"]).nullable().optional(),
    autoUpdate: z.boolean().optional(),
    install: z.boolean().optional(),
  }),
]);
export type Request = z.infer<typeof Request>;

export const TunnelState = z.enum(["stopped", "starting", "waiting-for-approval", "up", "failed"]);
export type TunnelState = z.infer<typeof TunnelState>;

/**
 * How a wave is written where an address would be too long: its host and port.
 * Only ever a label -- the identity is the whole URL, and every command takes
 * that. The scheme is noise in a list.
 */
/** What a wave is called on screen: its DNS suffix, or its server's host. */
export const profileName = (profile: { label?: string; controlUrl: string }): string =>
  profile.label || waveLabel(profile.controlUrl);

/** What commands are given to mean exactly this wave. */
export const profileKeyOf = (profile: { id?: string; controlUrl: string }): string =>
  profile.id ?? profile.controlUrl;

export function waveLabel(controlUrl: string): string {
  try {
    return new URL(controlUrl).host;
  } catch {
    return controlUrl;
  }
}

/**
 * How a peer is being reached.
 *
 * "loose" is the honest middle. No path has been confirmed -- the probes have
 * not come back, or timed out -- but WireGuard handshook a moment ago, and
 * without a confirmed path the magic socket sprays each packet to every known
 * candidate. Traffic does flow that way; it is just wasteful and unmeasured.
 * Calling that "connecting" says the tunnel is down while it carries data,
 * which is what it did while a ping through it answered in 16 ms.
 */
export type PathKind = "direct" | "relay" | "loose" | "idle" | "none";

/** WireGuard rekeys every two minutes under traffic; beyond that we know nothing. */
const HANDSHAKE_FRESH_SECONDS = 180;

export function pathKind(peer: { via: string | null; lastHandshakeSecondsAgo: number | null }): PathKind {
  if (peer.via === "relay") return "relay";
  // Nothing sent to it for a while, so nothing probes it: no path is measured,
  // and none is needed until something is sent. Not "connecting" -- that would
  // call every quiet peer broken.
  if (peer.via === "idle") return "idle";
  if (peer.via) return "direct";
  const shook = peer.lastHandshakeSecondsAgo;
  return shook !== null && shook < HANDSHAKE_FRESH_SECONDS ? "loose" : "none";
}

/** One wave as this device sees it, named by the server it belongs to. */
/** A name in the wave that is not a device, as a view has to show it. */
export const ServiceView = z.object({
  name: z.string(),
  dnsName: z.string(),
  ipv4: z.string(),
  /** Where to open it, as the server wrote it out. Never assembled here. */
  url: z.string(),
});
export type ServiceView = z.infer<typeof ServiceView>;

export const ProfileStatus = z.object({
  /**
   * The enrolment's key, what commands take to mean exactly this wave: the
   * server's address for the first enrolment there, an id of its own for every
   * further one. Optional so a tray and a daemon of different builds still
   * talk; absent, it is the address.
   */
  id: z.string().optional(),
  /** The server this wave is on. Several waves can share one. */
  controlUrl: z.string(),
  /** The wave's DNS suffix once known, so two waves at one server have names. */
  label: z.string().optional(),
  state: TunnelState,
  /** Set while the daemon waits for someone to open the enrolment link. */
  authUrl: z.string().nullable().default(null),
  message: z.string().nullable().default(null),
  /**
   * `message` as a code to be said in the reader's language; see notice.ts.
   * Only set while the daemon waits for a control server it cannot reach --
   * a tray or CLI that does not know the field shows the English `message`.
   * Optional rather than defaulted, so a status built by hand stays valid.
   */
  notice: Notice.nullish(),
  interfaceName: z.string().nullable().default(null),
  addresses: z.array(z.string()).default([]),
  /**
   * This node's own identity in the wave. `ipv6` is here because `addresses`
   * is not the same thing: since D11 it also carries the addresses of the
   * services this node answers for, and something that needs to know which of
   * them is *itself* cannot subtract them from that list.
   */
  self: z
    .object({
      hostname: z.string(),
      dnsName: z.string(),
      ipv4: z.string(),
      ipv6: z.string().default(""),
      /** What this device itself fronts -- it is a connector, then (D11). */
      services: z.array(ServiceView).default([]),
    })
    .nullable()
    .default(null),
  dnsSuffix: z.string().nullable().default(null),
  relay: z.object({ url: z.string(), connected: z.boolean() }).nullable().default(null),
  peers: z
    .array(
      z.object({
        hostname: z.string(),
        dnsName: z.string(),
        ipv4: z.string(),
        ipv6: z.string(),
        via: z.string().nullable().default(null),
        rttMs: z.number().nullable().default(null),
        lastHandshakeSecondsAgo: z.number().nullable().default(null),
        /**
         * What this peer answers for besides itself (D11).
         *
         * Under the peer and nowhere else: a service has no keys and no tunnel
         * of its own, so the node that fronts it is the only thing it can be
         * shown against -- a connector without them looks like a machine that
         * joined and then did nothing. A default is fine here, unlike in a
         * netmap: nothing signs this.
         */
        services: z.array(ServiceView).default([]),
      }),
    )
    .default([]),
  /** The last few log lines of this tunnel: netmaps applied, paths changed. */
  events: z.array(z.string()).default([]),
});
export type ProfileStatus = z.infer<typeof ProfileStatus>;

/** Where self-updating stands (D13). */
export const UpdateStatus = z.object({
  autoUpdate: z.boolean(),
  /** The channel this device asked for; null leaves it to the servers. */
  wish: z.string().nullable().default(null),
  /** What each server assigned, which is what actually applies there. */
  channels: z
    .array(z.object({ controlUrl: z.string(), channel: z.string(), offered: z.array(z.string()) }))
    .default([]),
  /** The best valid offer that is newer than this build, if any. */
  available: z.string().nullable().default(null),
  state: z.enum(["idle", "scheduled", "installing", "unavailable"]),
  /** Why not, when it cannot or will not: a dev build, a package manager... */
  message: z.string().nullable().default(null),
  /** The same, as a code to be said in the reader's language; see notice.ts. */
  notice: Notice.nullable().default(null),
  scheduledAt: z.string().nullable().default(null),
});
export type UpdateStatus = z.infer<typeof UpdateStatus>;

/** The daemon itself: which build it is, and how it updates. */
export const DaemonInfo = z.object({
  version: z.string(),
  platform: z.string(),
  update: UpdateStatus.nullable().default(null),
});
export type DaemonInfo = z.infer<typeof DaemonInfo>;

export const Status = z.object({
  /**
   * Missing from a daemon older than D13, and from a CLI running a tunnel on
   * its own. The tray compares it with its own version, and a tray that finds
   * itself out of step with the daemon steps aside.
   */
  daemon: DaemonInfo.optional(),
  profiles: z.array(ProfileStatus).default([]),
  /**
   * Log lines from the daemon itself, the ones that belong to no single
   * tunnel -- a profile refused for overlapping with another, a socket that
   * would not bind.
   */
  events: z.array(z.string()).default([]),
});
export type Status = z.infer<typeof Status>;

/** One certificate this device holds, and where its two files are. */
export const CertificateStatus = z.object({
  controlUrl: z.string(),
  name: z.string(),
  notAfter: z.string(),
  renewAt: z.string(),
  keyPath: z.string(),
  chainPath: z.string(),
  hook: z.string().nullable().default(null),
});
export type CertificateStatus = z.infer<typeof CertificateStatus>;

/**
 * The wave writes its zone by hand, so the certificate waits for a person.
 * A command rather than a status, because the caller is the person: it prints
 * the records and asks again later, and the order is taken up where it was.
 */
export const CertWaiting = z.object({
  name: z.string(),
  records: z.array(z.object({ name: z.string(), value: z.string() })).min(1),
});
export type CertWaiting = z.infer<typeof CertWaiting>;

export const Response = z.discriminatedUnion("type", [
  z.object({ type: z.literal("status"), status: Status }),
  z.object({ type: z.literal("certs"), certs: z.array(CertificateStatus) }),
  z.object({ type: z.literal("cert-waiting"), waiting: CertWaiting }),
  z.object({
    type: z.literal("update"),
    update: UpdateStatus,
    message: z.string().nullable().default(null),
    notice: Notice.nullable().default(null),
  }),
  z.object({ type: z.literal("ok") }),
  /**
   * `message` is the English sentence and always there; `notice` says the
   * same as a code, for a reader that can put it in its person's language.
   */
  z.object({ type: z.literal("error"), message: z.string(), notice: Notice.nullable().default(null) }),
]);
export type Response = z.infer<typeof Response>;

export const encodeMessage = (message: unknown): string => `${JSON.stringify(message)}\n`;

/**
 * Splits a byte stream into lines. A socket hands over whatever arrived, which
 * may be half a message or three of them.
 */
export class LineReader {
  private buffer = "";

  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim().length > 0);
  }
}

/** The shape {@link Tunnel.snapshot} returns, without importing the engine. */
export interface SnapshotLike {
  controlUrl: string;
  interfaceName: string;
  addresses: string[];
  self?: {
    hostname: string;
    dnsName: string;
    ipv4: string;
    ipv6?: string;
    services?: Array<{ name: string; dnsName: string; ipv4: string; url: string }>;
  };
  dnsSuffix?: string;
  relay?: { url: string; connected: boolean };
  peers: Array<{
    hostname: string;
    dnsName: string;
    ipv4: string;
    ipv6: string;
    via?: string;
    rttMs?: number;
    lastHandshakeSecondsAgo?: number;
    /** The names this peer fronts, already sorted, each with its address. */
    services?: Array<{ name: string; dnsName: string; ipv4: string; url: string }>;
  }>;
}

/** One conversion, used by the daemon and by the CLI running on its own. */
export function profileStatusFromSnapshot(
  snapshot: SnapshotLike | undefined,
  extra: {
    id?: string;
    label?: string;
    controlUrl: string;
    state: TunnelState;
    authUrl?: string | null;
    message?: string | null;
    notice?: Notice | null;
    events?: string[];
  },
): ProfileStatus {
  const base = {
    id: extra.id ?? extra.controlUrl,
    label: extra.label,
    controlUrl: extra.controlUrl,
    state: extra.state,
    authUrl: extra.authUrl ?? null,
    message: extra.message ?? null,
    notice: extra.notice ?? null,
    events: extra.events ?? [],
  };
  if (!snapshot) return ProfileStatus.parse(base);

  return ProfileStatus.parse({
    ...base,
    interfaceName: snapshot.interfaceName,
    addresses: snapshot.addresses,
    self: snapshot.self ?? null,
    dnsSuffix: snapshot.dnsSuffix ?? null,
    relay: snapshot.relay ?? null,
    peers: snapshot.peers.map((peer) => ({
      hostname: peer.hostname,
      dnsName: peer.dnsName,
      ipv4: peer.ipv4,
      ipv6: peer.ipv6,
      via: peer.via ?? null,
      rttMs: peer.rttMs ?? null,
      lastHandshakeSecondsAgo: peer.lastHandshakeSecondsAgo ?? null,
      services: peer.services ?? [],
    })),
  });
}

export const emptyStatus = (message: string | null = null): Status =>
  Status.parse({ profiles: [], events: message ? [message] : [] });
