/**
 * Which build this is, and for which machine.
 *
 * Here rather than in the client because the tray needs it too and cannot
 * import the client -- the client imports the tray. Both compare their own
 * version with the daemon's, and that comparison is what makes a tray step
 * aside after the daemon replaced the binary under it (D13).
 */

/**
 * Set by `bun build --define` in scripts/build-clients.sh, from the version in
 * the root package.json. Running from source there is nothing to set it, and
 * the identifier does not exist at all -- hence the `typeof`.
 */
declare const WAVE_BUILD_VERSION: string;

/**
 * The connector image runs from source and has no `--define` to go through, so
 * its Dockerfile puts the release version into the environment instead. A
 * compiled binary never looks here: what it was built as is what it is.
 * Nothing hangs on this besides the label -- an update needs a compiled binary
 * as well (`updateBlocker()`), so a version from the environment cannot talk a
 * source run into replacing itself.
 */
const fromEnvironment = (): string | undefined => process.env.WAVE_BUILD_VERSION || undefined;

/** What a run from source calls itself. Never offered an update, never compared. */
export const DEV_VERSION = "0.0.0-dev";

export const VERSION: string =
  typeof WAVE_BUILD_VERSION === "string" ? WAVE_BUILD_VERSION : (fromEnvironment() ?? DEV_VERSION);

export const isDevVersion = (version: string): boolean => version === DEV_VERSION;

/**
 * The name a release archive carries for this machine: `linux-amd64`,
 * `darwin-arm64`, `windows-amd64`. The same vocabulary as the archives and the
 * docker platforms -- Node says x64 and win32, nothing else here does.
 */
export function platformName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string {
  const os = platform === "win32" ? "windows" : platform;
  const cpu = arch === "x64" ? "amd64" : arch;
  return `${os}-${cpu}`;
}

export const PLATFORM = platformName();
