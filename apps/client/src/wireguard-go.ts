import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Finds the userspace WireGuard implementation.
 *
 * Worth the trouble because the usual ways of getting it disagree: distribution
 * packages install `wireguard-go`, while `go install golang.zx2c4.com/wireguard`
 * produces a binary called `wireguard` in the user's own GOPATH -- which a
 * system service never has on its PATH.
 */

export const BINARY_NAMES = ["wireguard-go", "wireguard"] as const;
/** The same two, as Windows spells an executable. */
export const WINDOWS_BINARY_NAMES = ["wireguard.exe", "wireguard-go.exe"] as const;
/** The driver wireguard-go needs on Windows, and nowhere else. */
export const WINTUN_DLL = "wintun.dll";

export const binaryNames = (platform: NodeJS.Platform = process.platform): readonly string[] =>
  platform === "win32" ? WINDOWS_BINARY_NAMES : BINARY_NAMES;

export interface FindOptions {
  env?: NodeJS.ProcessEnv;
  /** Overridable so the search can be tested without touching the disk. */
  exists?: (path: string) => boolean;
  which?: (name: string) => string | null;
  platform?: NodeJS.Platform;
  /**
   * Where the running binary sits, looked at before anything else.
   *
   * This is what lets a release archive carry its own wireguard-go: whoever
   * unpacked it gets that one installed, not whichever older copy happens to
   * be first on the PATH.
   */
  selfDir?: string;
}

/** Every place worth looking, in order of preference. */
export function searchPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  if (platform === "win32") {
    // There is no package manager to have put this anywhere standard, so the
    // list is short: next to the binary `wave install` places, and wherever a
    // `go install` would have dropped it.
    const roots = [
      join(env.PROGRAMFILES ?? "C:\\Program Files", "wave"),
      join(env.PROGRAMDATA ?? "C:\\ProgramData", "wave"),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "wave")] : []),
      ...(env.USERPROFILE ? [join(env.USERPROFILE, "go", "bin")] : []),
      ...(env.GOPATH ? [join(env.GOPATH, "bin")] : []),
    ];
    return roots.flatMap((root) => WINDOWS_BINARY_NAMES.map((name) => join(root, name)));
  }

  const homes = [env.HOME ?? homedir()];
  // Running as a service through sudo: the binary may sit in the human's home.
  if (env.SUDO_USER) homes.push(`/home/${env.SUDO_USER}`, `/Users/${env.SUDO_USER}`);

  const roots = ["/usr/local/bin", "/usr/bin", "/opt/homebrew/bin"];
  for (const home of homes) {
    roots.push(join(home, "go", "bin"), join(home, ".local", "bin"));
  }
  if (env.GOPATH) roots.push(join(env.GOPATH, "bin"));

  return roots.flatMap((root) => BINARY_NAMES.map((name) => join(root, name)));
}

export function findWireguardGo(options: FindOptions = {}): string | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const which = options.which ?? ((name: string) => Bun.which(name));
  const platform = options.platform ?? process.platform;
  const selfDir = options.selfDir ?? dirname(process.execPath);

  const configured = env.WAVE_WIREGUARD_GO;
  if (configured && exists(configured)) return configured;

  // Before the PATH: a copy shipped beside wave is the one that belongs to
  // this build, and it is the only one an unpacked archive can count on.
  for (const name of binaryNames(platform)) {
    const beside = join(selfDir, name);
    if (exists(beside)) return beside;
  }

  for (const name of binaryNames(platform)) {
    const found = which(name);
    if (found) return found;
  }
  return searchPaths(env, platform).find(exists) ?? null;
}

/**
 * Where wintun.dll may be, in order of preference.
 *
 * Only Windows has this problem, and it is a nasty one: without the DLL
 * wireguard-go starts, reports a device, and then fails to create an adapter
 * -- which reads as a network fault rather than a missing file.
 */
export function wintunSearchPaths(
  env: NodeJS.ProcessEnv = process.env,
  selfDir: string = dirname(process.execPath),
): string[] {
  const roots = [
    selfDir,
    join(env.PROGRAMFILES ?? "C:\\Program Files", "wave"),
    join(env.PROGRAMDATA ?? "C:\\ProgramData", "wave"),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "wave")] : []),
    ...(env.USERPROFILE ? [join(env.USERPROFILE, "go", "bin")] : []),
    ...(env.GOPATH ? [join(env.GOPATH, "bin")] : []),
  ];
  return roots.map((root) => join(root, WINTUN_DLL));
}

/** The DLL, or null. Beside the found wireguard-go counts too. */
export function findWintun(options: FindOptions & { beside?: string | null } = {}): string | null {
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;
  const selfDir = options.selfDir ?? dirname(process.execPath);

  const configured = env.WAVE_WINTUN_DLL;
  if (configured && exists(configured)) return configured;

  // wireguard-go and its driver usually travel together, so wherever the one
  // was found is worth asking about the other.
  if (options.beside) {
    const sibling = join(dirname(options.beside), WINTUN_DLL);
    if (exists(sibling)) return sibling;
  }
  return wintunSearchPaths(env, selfDir).find(exists) ?? null;
}

/** Said when the DLL is missing, because "no adapter" helps nobody. */
export function missingWintunMessage(
  env: NodeJS.ProcessEnv = process.env,
  selfDir: string = dirname(process.execPath),
): string {
  return [
    `wave needs ${WINTUN_DLL} on Windows, and could not find it.`,
    "",
    "  Download https://www.wintun.net, and take the DLL for this machine's",
    "  architecture out of bin\\<amd64|arm64>\\ in the zip.",
    "",
    `Then put it beside wave.exe, or point WAVE_WINTUN_DLL at it.`,
    `Looked at: ${[env.WAVE_WINTUN_DLL, ...wintunSearchPaths(env, selfDir).slice(0, 4)].filter(Boolean).join(", ")}, …`,
  ].join("\n");
}

/** Said when it is missing, because "not in $PATH" helps nobody. */
export function missingMessage(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const install =
    platform === "win32"
      ? [
          "  go install golang.zx2c4.com/wireguard@latest",
          "",
          // Without it the binary starts and fails at the first adapter, which
          // reads as a tunnel problem rather than a missing file.
          "Windows also needs wintun.dll from https://www.wintun.net next to the",
          "executable — wireguard-go cannot create an adapter without it.",
        ]
      : [
          "  Arch:    pacman -S wireguard-go        (or from the AUR)",
          "  Debian:  apt install wireguard-go",
          "  macOS:   brew install wireguard-go",
          "  Any:     go install golang.zx2c4.com/wireguard@latest",
        ];
  return [
    "wave needs wireguard-go to create the tunnel, and could not find it.",
    "",
    ...install,
    "",
    "Then either put it on the PATH as wireguard-go, or point WAVE_WIREGUARD_GO at it.",
    `Looked at: ${[env.WAVE_WIREGUARD_GO, ...searchPaths(env, platform).slice(0, 6)].filter(Boolean).join(", ")}, …`,
  ].join("\n");
}
