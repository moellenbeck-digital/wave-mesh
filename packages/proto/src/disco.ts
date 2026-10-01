/**
 * Constants shared between the magicsock implementation and its tests.
 *
 * Discovery packets share the UDP socket with WireGuard traffic, so they must
 * be distinguishable from it: WireGuard's own message types occupy the first
 * byte with values 0x01..0x04, therefore every disco packet starts with a magic
 * prefix that can never collide.
 */
export const DISCO_MAGIC = new Uint8Array([0x77, 0x61, 0x76, 0x65, 0x64, 0x63]); // "wavedc"
export const DISCO_VERSION = 1;

export const DiscoType = {
  Ping: 1,
  Pong: 2,
  CallMeMaybe: 3,
} as const;
export type DiscoType = (typeof DiscoType)[keyof typeof DiscoType];

/** True if the datagram cannot be a WireGuard message. */
export function isDiscoPacket(buf: Uint8Array): boolean {
  if (buf.length < DISCO_MAGIC.length) return false;
  for (let i = 0; i < DISCO_MAGIC.length; i++) {
    if (buf[i] !== DISCO_MAGIC[i]) return false;
  }
  return true;
}
