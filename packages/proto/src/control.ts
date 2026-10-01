import { z } from "zod";
import { DiscoKey, MachineKey, NodeId, NodeKey, PublicKey32 } from "./keys.ts";
import { Ipv4, Ipv6, Timestamp } from "./net.ts";
import { Candidate, Netmap, Peer, SignedNetmap } from "./netmap.ts";

// --- REST -------------------------------------------------------------------

export const RegisterRequest = z.object({
  machineKey: MachineKey,
  nodeKey: NodeKey,
  discoKey: DiscoKey,
  hostname: z.string().min(1).max(63),
  os: z.enum(["linux", "darwin", "windows", "other"]),
  /** Pre-auth key for headless enrolment; omitted for interactive login. */
  authKey: z.string().optional(),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RegisterResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authorized"),
    nodeId: NodeId,
    netmap: SignedNetmap,
    /** Pinned by the client on first use to verify later netmap signatures. */
    netmapPublicKey: PublicKey32,
  }),
  z.object({ status: z.literal("pending"), authUrl: z.url(), pollSecret: z.string().min(1) }),
]);
export type RegisterResponse = z.infer<typeof RegisterResponse>;

export const PollRequest = z.object({ pollSecret: z.string().min(1) });
export type PollRequest = z.infer<typeof PollRequest>;

export const PollResponse = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("authorized"),
    nodeId: NodeId,
    netmap: SignedNetmap,
    netmapPublicKey: PublicKey32,
  }),
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("expired") }),
]);
export type PollResponse = z.infer<typeof PollResponse>;

/**
 * What a cluster answers for, declared whole (D11).
 *
 * A name may be given bare (`grafana`) or fully qualified under the wave's own
 * suffix -- the operator reads an Ingress host, which is the whole name.
 */
export const ServiceSyncRequest = z.object({
  names: z.array(z.string().min(1)).max(500),
  /**
   * Which of `names` the cluster serves over TLS.
   *
   * A second list rather than a field on each entry, and that is deliberate.
   * `names` stays exactly what it was -- the whole set, the one thing that may
   * never drift -- so an operator from before schemes keeps working unchanged
   * and its services keep the default. This one is an attribute of a name, not
   * part of the set: an entry here that is not in `names` means nothing and is
   * ignored.
   */
  secure: z.array(z.string().min(1)).max(500).optional(),
});
export type ServiceSyncRequest = z.infer<typeof ServiceSyncRequest>;

/**
 * How a service is reached in a browser.
 *
 * Only the cluster knows: it is a property of the Ingress, not of the wave.
 * Where a name is served both ways, https is the one that is shown -- the
 * plain-text path is a redirect at best, and a name under the wave's own
 * domain exists to carry a certificate (D7). What leaves the server is the
 * finished URL, not this; see `Service` in the netmap.
 */
export const ServiceScheme = z.enum(["http", "https"]);
export type ServiceScheme = z.infer<typeof ServiceScheme>;

export const ServiceSyncResponse = z.object({
  services: z.array(z.object({ name: z.string(), ipv4: Ipv4, ipv6: Ipv6 })),
});
export type ServiceSyncResponse = z.infer<typeof ServiceSyncResponse>;

export const CertOrderRequest = z.object({
  /** PEM-encoded CSR. The private key stays on the node, always. */
  csr: z.string().startsWith("-----BEGIN CERTIFICATE REQUEST-----"),
  names: z.array(z.string().min(1)).min(1),
});
export type CertOrderRequest = z.infer<typeof CertOrderRequest>;

/** Where to come back for the answer; issuance takes as long as the CA takes. */
export const CertOrderAccepted = z.object({ orderId: z.string().min(1) });
export type CertOrderAccepted = z.infer<typeof CertOrderAccepted>;

/** A record somebody has to create by hand before the order can go on. */
export const CertChallengeRecord = z.object({
  name: z.string().min(1),
  value: z.string().min(1),
});
export type CertChallengeRecord = z.infer<typeof CertChallengeRecord>;

export const CertOrderStatus = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  /**
   * The wave writes its zone by hand: nothing happens until these records
   * exist. The server keeps looking, so the node has only to say so and ask
   * again later -- and the order survives both sides restarting.
   */
  z.object({ status: z.literal("waiting"), records: z.array(CertChallengeRecord).min(1) }),
  z.object({
    status: z.literal("issued"),
    chainPem: z.string().min(1),
    notAfter: Timestamp,
    /**
     * When the node should ask for the next one: the window the CA suggests
     * (ARI), or two thirds of the lifetime where it suggests none. Decided on
     * the server because only it talks to the CA.
     */
    renewAt: Timestamp,
  }),
  z.object({ status: z.literal("failed"), error: z.string() }),
]);
export type CertOrderStatus = z.infer<typeof CertOrderStatus>;

// --- WebSocket /v1/control --------------------------------------------------

export const ClientMessage = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    machineKey: MachineKey,
    nodeKey: NodeKey,
    discoKey: DiscoKey,
    version: z.string(),
  }),
  z.object({ type: z.literal("endpoints"), candidates: z.array(Candidate) }),
  z.object({ type: z.literal("ping") }),
  /**
   * Whether this device enforces the ports of its wave's policy (M7). Sent on
   * every change and again after a reconnect. A server that predates it
   * drops the message, which is the same as never hearing it.
   */
  z.object({
    type: z.literal("filter"),
    enforced: z.boolean(),
    reason: z.string().max(300).optional(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessage>;

export const PeerChange = z.discriminatedUnion("op", [
  z.object({ op: z.literal("upsert"), peer: Peer }),
  z.object({ op: z.literal("remove"), nodeId: NodeId }),
]);
export type PeerChange = z.infer<typeof PeerChange>;

export const ServerMessage = z.discriminatedUnion("type", [
  z.object({ type: z.literal("netmap"), netmap: SignedNetmap }),
  z.object({ type: z.literal("netmap-delta"), version: Netmap.shape.version, changes: z.array(PeerChange) }),
  /**
   * Both sides must punch at the same time: the first mover's packets hit a NAT
   * that has no state for them yet, so the server tells both peers at once.
   */
  z.object({ type: z.literal("disco-hint"), nodeId: NodeId, candidates: z.array(Candidate) }),
  z.object({ type: z.literal("logout"), reason: z.enum(["key-expired", "node-removed", "reauth-required"]) }),
  z.object({ type: z.literal("pong") }),
]);
export type ServerMessage = z.infer<typeof ServerMessage>;
