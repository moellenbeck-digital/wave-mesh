import type { IconState } from "./icon.ts";
import type { MenuEntry } from "./menu.ts";

/**
 * What a tray icon has to be able to do, independent of how the platform
 * provides one.
 *
 * Linux exposes its tray as a D-Bus protocol, which is why that backend is
 * plain JavaScript. macOS and Windows expose theirs only through C APIs, so
 * both go through bun:ffi -- this interface is what keeps that decision out of
 * everything else.
 */
export interface TrayBackend {
  readonly platform: string;
  start(): Promise<void>;
  update(input: { state: IconState; tooltip: string; entries: MenuEntry[] }): void;
  stop(): Promise<void>;
}

export interface TrayBackendOptions {
  /** Invoked with the id of a menu entry the user picked. */
  onActivate: (id: number) => void;
  /** Invoked when the icon itself is clicked. */
  onClick: () => void;
}

export class UnsupportedPlatform extends Error {
  constructor(platform: NodeJS.Platform) {
    super(
      `wave has no tray backend for ${platform} yet. ` +
        "The tunnel itself is unaffected: use `wave status` or `wave up`.",
    );
  }
}

/** Picks the backend for this platform, or explains that there is none. */
export async function createTrayBackend(
  options: TrayBackendOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<TrayBackend> {
  if (platform === "linux") {
    const { DbusTray } = await import("./backend-dbus.ts");
    return new DbusTray(options);
  }
  if (platform === "darwin") {
    // Imported here and not at the top: the module opens macOS libraries the
    // moment it loads, which would break every other platform.
    const { MacosTray } = await import("./backend-macos.ts");
    return new MacosTray(options);
  }
  if (platform === "win32") {
    const { WindowsTray } = await import("./backend-win32.ts");
    return new WindowsTray(options);
  }
  throw new UnsupportedPlatform(platform);
}
