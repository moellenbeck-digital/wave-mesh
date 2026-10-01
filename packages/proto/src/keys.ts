import { z } from "zod";

/**
 * Curve25519 and Ed25519 public keys are 32 raw bytes, carried as standard
 * base64 (the format `wg` itself prints). Private keys never appear in any
 * schema in this package -- they must not leave the node that generated them.
 */
export const PublicKey32 = z.string().regex(/^[A-Za-z0-9+/]{43}=$/, "not a base64-encoded 32-byte key");

/** Long-lived device identity towards control and relay servers (Ed25519). */
export const MachineKey = PublicKey32.brand<"MachineKey">();
export type MachineKey = z.infer<typeof MachineKey>;

/** The WireGuard public key. Rotates on `wave up` and expires. */
export const NodeKey = PublicKey32.brand<"NodeKey">();
export type NodeKey = z.infer<typeof NodeKey>;

/** Per-session key that authenticates discovery packets (Curve25519). */
export const DiscoKey = PublicKey32.brand<"DiscoKey">();
export type DiscoKey = z.infer<typeof DiscoKey>;

export const NodeId = z.string().min(1).brand<"NodeId">();
export type NodeId = z.infer<typeof NodeId>;

export const WaveId = z.string().min(1).brand<"WaveId">();
export type WaveId = z.infer<typeof WaveId>;
