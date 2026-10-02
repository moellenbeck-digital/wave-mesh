import { t } from "./messages.ts";
import type { WindowView } from "./window-view.ts";

/**
 * The window behind the tray icon: the connections with a switch each, and the
 * machines below them.
 *
 * A menu cannot draw this -- dbusmenu has labels and separators, not rows with
 * their own controls -- so it is a real window, and that means a toolkit per
 * platform. The interface is what keeps that knowledge out of everything else,
 * the same way {@link TrayBackend} does for the icon.
 */
export interface TrayWindow {
  readonly platform: string;
  /** Shows it, or raises it if it is already up. */
  open(): void;
  close(): void;
  /** What a click on the icon does: away if it is there, there if it is not. */
  toggle(): void;
  /** Replaces the contents; cheap enough to call on every status push. */
  update(view: WindowView): void;
  destroy(): void;
}

export interface TrayWindowOptions {
  /** The user moved a connection's switch. */
  onToggle: (controlUrl: string, connect: boolean) => void;
  /** Something was copied, so the caller can say so if it wants. */
  onCopy?: (text: string) => void;
  /**
   * A service was clicked and wants opening in a browser.
   *
   * The window asks rather than spawning: which command opens a URL is the
   * one piece of platform knowledge the tray already keeps in one place, and
   * three windows spawning their own would be three places to get it wrong.
   */
  onOpen?: (url: string) => void;
}

export class NoWindowBackend extends Error {
  constructor(platform: NodeJS.Platform) {
    super(t().noWindowBackend(platform));
  }
}

/**
 * Picks the toolkit for this platform, or explains that there is none.
 *
 * Linux is GTK4, macOS is Cocoa through the same Objective-C binding that draws
 * the menu bar item, and Windows is GDI through the same Win32 binding that
 * draws the notification icon. The third one paints the card itself rather than
 * assembling it from widgets: the common controls are the system's colours and
 * shapes, and a light grey checkbox on a dark card is not the same design.
 *
 * Anything else keeps the error. A window that opens empty is worse than one
 * that says it is not there, and the icon's menu carries everything.
 */
export async function createTrayWindow(
  options: TrayWindowOptions,
  platform: NodeJS.Platform = process.platform,
): Promise<TrayWindow> {
  // Imported here, not at the top: each module opens its toolkit the moment it
  // loads, which would break every platform that does not have it.
  if (platform === "linux") {
    const { GtkWindow } = await import("./window-gtk.ts");
    return new GtkWindow(options);
  }
  if (platform === "darwin") {
    const { MacosWindow } = await import("./window-macos.ts");
    return new MacosWindow(options);
  }
  if (platform === "win32") {
    const { WindowsWindow } = await import("./window-win32.ts");
    return new WindowsWindow(options);
  }
  throw new NoWindowBackend(platform);
}
