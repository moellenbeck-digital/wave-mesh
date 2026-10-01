import { z } from "zod";

/**
 * Client self-updates (D13): what a release says about itself, and the rules
 * both sides apply to it.
 *
 * The channels are the ones the release workflow already pushes. Each takes
 * its own releases and every more stable one -- `insiders` also takes a
 * stable, `stable` never an insiders.
 *
 * `stable` and not `latest`, although the image tag is called that: a channel
 * is what a device follows, and "latest" says nothing about how settled a
 * build is -- the newest develop build is the latest of all.
 */
export const UpdateChannel = z.enum(["stable", "insiders", "develop"]);
export type UpdateChannel = z.infer<typeof UpdateChannel>;

const STABILITY: Record<UpdateChannel, number> = { stable: 0, insiders: 1, develop: 2 };

/** Whether a device following `channel` may install a release from `release`. */
export const channelAccepts = (channel: UpdateChannel, release: UpdateChannel): boolean =>
  STABILITY[release] <= STABILITY[channel];

/**
 * One archive of a release. Its hash is what the device checks before it
 * opens the file, the same way the build checks the wintun zip.
 */
export const ReleaseArchive = z.looseObject({
  name: z.string().min(1),
  /** `linux-amd64` and so on; see platformName() in @wave/ipc. */
  platform: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  size: z.number().int().nonnegative(),
});
export type ReleaseArchive = z.infer<typeof ReleaseArchive>;

/**
 * What the release job signs.
 *
 * Version and channel have to be inside the signature, not beside it: signed
 * hashes alone would let a server hand a device on `stable` a `develop` build
 * -- genuine, validly signed, and from the wrong channel.
 *
 * Signed, so the same rule as for a netmap: loose objects and no `.default()`.
 * Dropping a field a newer release job wrote, or inventing one an older one
 * never did, changes the canonical form and turns a good signature into a
 * forgery.
 */
export const ReleaseManifest = z.looseObject({
  version: z.string().min(1),
  channel: UpdateChannel,
  archives: z.array(ReleaseArchive).min(1),
});
export type ReleaseManifest = z.infer<typeof ReleaseManifest>;

/** The file the release carries as `manifest.json`. */
export const SignedRelease = z.object({
  manifest: ReleaseManifest,
  /** Ed25519 over canonicalJson(manifest), base64. */
  signature: z.string().min(1),
  /** The public key that made it; must be one the binary was built with. */
  keyId: z.string().min(1),
});
export type SignedRelease = z.infer<typeof SignedRelease>;

/** The asset name the release job writes and the control server looks for. */
export const MANIFEST_ASSET = "manifest.json";

/** The archive a platform downloads, as scripts/build-clients.sh names it. */
export const archiveName = (platform: string): string =>
  `wave-${platform}.${platform.startsWith("windows-") ? "zip" : "tar.gz"}`;

interface ParsedVersion {
  core: [number, number, number];
  pre: string[];
}

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

function parseVersion(version: string): ParsedVersion | null {
  const match = VERSION.exec(version);
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : [],
  };
}

export const isVersion = (version: string): boolean => parseVersion(version) !== null;

/**
 * Semver order: -1, 0 or 1. Build metadata (`+local`) is ignored, which is
 * what lets a locally built 0.1.0 sit at 0.1.0 instead of below it -- a
 * prerelease suffix would make every release, even the one it was built from,
 * look like an upgrade.
 *
 * Something that is not a version sorts below everything, so it is never
 * mistaken for an upgrade.
 */
export function compareVersions(a: string, b: string): number {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return left ? 1 : right ? -1 : 0;
  for (let i = 0; i < 3; i++) {
    const diff = (left.core[i] as number) - (right.core[i] as number);
    if (diff !== 0) return Math.sign(diff);
  }
  // A release outranks its own prereleases.
  if (left.pre.length === 0 || right.pre.length === 0) {
    return left.pre.length === right.pre.length ? 0 : left.pre.length === 0 ? 1 : -1;
  }
  for (let i = 0; i < Math.max(left.pre.length, right.pre.length); i++) {
    const x = left.pre[i];
    const y = right.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (x === y) continue;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) return Math.sign(Number(x) - Number(y));
    if (xNum !== yNum) return xNum ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

/**
 * The channel a version belongs to, read from its shape -- the three shapes
 * the release workflow lets through. Anything else belongs to none, and is
 * never offered.
 */
export function channelOfVersion(version: string): UpdateChannel | null {
  const parsed = parseVersion(version);
  if (!parsed) return null;
  if (parsed.pre.length === 0) return "stable";
  if (parsed.pre[0] === "insiders" && parsed.pre.length === 2) return "insiders";
  if (parsed.pre[0] === "develop" && parsed.pre.length === 2) return "develop";
  return null;
}
