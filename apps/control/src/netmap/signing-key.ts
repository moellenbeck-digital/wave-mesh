import { generateKeyPair, publicKeyFromPrivate } from "@wave/crypto";
import type { Config } from "../env.ts";
import type { SigningKey } from "./build.ts";

/**
 * Clients pin this key when they register, so losing it forces every node to
 * re-enrol. Production therefore requires it to be configured; development
 * falls back to an ephemeral key and says so.
 */
export function resolveSigningKey(config: Config): SigningKey {
  if (config.netmapSigningKey) {
    return {
      privateKey: config.netmapSigningKey,
      publicKey: publicKeyFromPrivate(config.netmapSigningKey, "ed25519"),
    };
  }
  const generated = generateKeyPair("ed25519");
  if (config.env !== "test") {
    console.warn(
      `no WAVE_NETMAP_SIGNING_KEY set — generated an ephemeral one (${generated.publicKey}).\n` +
        "Nodes registered against it stop trusting netmaps after a restart.",
    );
  }
  return generated;
}
