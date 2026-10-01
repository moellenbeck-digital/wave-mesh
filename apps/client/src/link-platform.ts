/** Picks the network backend for the platform we are running on. */

import type { LinkBackend } from "./link.ts";
import { DarwinLink } from "./link-darwin.ts";
import { LinuxLink } from "./link-linux.ts";
import { WindowsLink } from "./link-windows.ts";

export function platformLink(platform: NodeJS.Platform = process.platform): LinkBackend {
  if (platform === "linux") return new LinuxLink();
  if (platform === "darwin") return new DarwinLink();
  if (platform === "win32") return new WindowsLink();
  throw new Error(`wave has no network backend for ${platform}`);
}
