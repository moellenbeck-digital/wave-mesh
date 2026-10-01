import type { UpdateStatus } from "@wave/ipc";

/**
 * The popup that offers an update with a button to install it (D13).
 *
 * One per platform, each with what the platform has without installing
 * anything:
 *
 * - Linux: a desktop notification with an action, on the session bus the tray
 *   already speaks. GNOME and KDE draw the action as a button; notification
 *   daemons without buttons (mako) run the default action on a click, which
 *   is the same install.
 * - macOS: `display dialog` through osascript.
 * - Windows: a MessageBox through PowerShell.
 *
 * The last two run as a process of their own rather than through the FFI the
 * tray already has. A modal dialog called from here would block the thread
 * that pumps the icon and reads the daemon's socket for as long as it stands
 * there -- and an offer may stand there for hours. A child process waits
 * instead, and the tray keeps working.
 *
 * The text goes in through the environment, never spliced into a script: it
 * carries a version string the daemon got from a server, and quoting rules
 * for AppleScript and PowerShell are not where that should be decided.
 */
export interface UpdatePrompt {
  /** Resolves true when the person chose to install, false on anything else. */
  ask(text: PromptText): Promise<boolean>;
}

export interface PromptText {
  title: string;
  body: string;
}

/** What the popup says. Pure, so the wording is tested once for all three. */
export function promptText(update: UpdateStatus, current: string, now: Date = new Date()): PromptText | null {
  if (!update.available || update.state === "installing" || update.state === "unavailable") return null;
  const when =
    update.state === "scheduled" && update.scheduledAt
      ? ` It installs by itself at ${formatTime(update.scheduledAt, now)}.`
      : "";
  return {
    title: "wave update",
    body:
      `wave ${update.available} is available (this device runs ${current}).${when}\n\n` +
      "Install it now? The tunnels drop for a few seconds while the service restarts.",
  };
}

/** A time today is just the time; anything further away gets its date. */
function formatTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString()} ${time}`;
}

const INSTALL = "Install now";
const LATER = "Later";

/**
 * The osascript invocation. "Later" is the cancel button, so Escape means
 * later; the dialog gives up after an hour so a forgotten one does not stand
 * on the screen for ever -- the menu still has the same button.
 */
export function macosDialog(): string[] {
  const script =
    'display dialog (system attribute "WAVE_PROMPT_BODY") with title (system attribute "WAVE_PROMPT_TITLE") ' +
    `buttons {"${LATER}", "${INSTALL}"} default button "${INSTALL}" cancel button "${LATER}" ` +
    "with icon note giving up after 3600";
  return ["osascript", "-e", script];
}

/** "button returned:Install now, gave up:false" -- or nothing, on Later. */
export const parseMacosAnswer = (stdout: string): boolean =>
  stdout.includes(`button returned:${INSTALL}`) && !stdout.includes("gave up:true");

/**
 * The PowerShell invocation. A MessageBox has Yes and No and nothing else, so
 * the text asks a question. DefaultDesktopOnly brings it to the front -- the
 * tray never has the foreground, and a dialog behind every window is one
 * nobody sees.
 */
export function windowsDialog(): string[] {
  const script =
    "Add-Type -AssemblyName System.Windows.Forms; " +
    "[System.Windows.Forms.MessageBox]::Show($env:WAVE_PROMPT_BODY, $env:WAVE_PROMPT_TITLE, " +
    "'YesNo', 'Information', 'Button1', 'DefaultDesktopOnly')";
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script];
}

/** MessageBox.Show returns the DialogResult by name, in English whatever the locale. */
export const parseWindowsAnswer = (stdout: string): boolean => stdout.trim() === "Yes";

/** Runs a dialog as a child process and reads its answer. */
class ProcessPrompt implements UpdatePrompt {
  constructor(
    private readonly command: () => string[],
    private readonly parse: (stdout: string) => boolean,
  ) {}

  async ask(text: PromptText): Promise<boolean> {
    try {
      const proc = Bun.spawn(this.command(), {
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, WAVE_PROMPT_TITLE: text.title, WAVE_PROMPT_BODY: text.body },
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return this.parse(stdout);
    } catch (error) {
      // No dialog is not an error worth more than a line: the menu has the
      // same button.
      console.error(`could not show the update dialog: ${error instanceof Error ? error.message : error}`);
      return false;
    }
  }
}

/** The part of org.freedesktop.Notifications this needs. */
export interface Notifications {
  Notify(
    appName: string,
    replacesId: number,
    appIcon: string,
    summary: string,
    body: string,
    actions: string[],
    hints: Record<string, unknown>,
    expireTimeout: number,
  ): Promise<number>;
  on(event: "ActionInvoked", listener: (id: number, action: string) => void): void;
  on(event: "NotificationClosed", listener: (id: number, reason: number) => void): void;
}

/**
 * A notification with an install action, answered by the signals the server
 * sends back. "default" is the click on the notification itself, which is
 * all a daemon without buttons offers; "install" is the button where there
 * are buttons. Both mean the same.
 */
export class NotificationPrompt implements UpdatePrompt {
  private readonly waiting = new Map<number, (install: boolean) => void>();

  constructor(private readonly notifications: Notifications) {
    notifications.on("ActionInvoked", (id, action) =>
      this.settle(id, action === "install" || action === "default"),
    );
    notifications.on("NotificationClosed", (id) => this.settle(id, false));
  }

  private settle(id: number, install: boolean): void {
    const resolve = this.waiting.get(id);
    if (!resolve) return;
    this.waiting.delete(id);
    resolve(install);
  }

  async ask(text: PromptText): Promise<boolean> {
    try {
      // Never expires (0): it is an offer, and one that disappears after five
      // seconds is one nobody gets to act on.
      const id = await this.notifications.Notify(
        "wave",
        0,
        "system-software-update",
        text.title,
        text.body,
        ["default", INSTALL, "install", INSTALL],
        {},
        0,
      );
      return await new Promise<boolean>((resolve) => this.waiting.set(id, resolve));
    } catch (error) {
      console.error(
        `could not show the update notification: ${error instanceof Error ? error.message : error}`,
      );
      return false;
    }
  }
}

/** The popup for this platform, or null where there is none. */
export async function createUpdatePrompt(
  platform: NodeJS.Platform = process.platform,
): Promise<UpdatePrompt | null> {
  if (platform === "darwin") return new ProcessPrompt(macosDialog, parseMacosAnswer);
  if (platform === "win32") return new ProcessPrompt(windowsDialog, parseWindowsAnswer);
  if (platform === "linux") {
    try {
      const { default: dbus } = await import("dbus-next");
      const bus = dbus.sessionBus();
      const proxy = await bus.getProxyObject(
        "org.freedesktop.Notifications",
        "/org/freedesktop/Notifications",
      );
      return new NotificationPrompt(
        proxy.getInterface("org.freedesktop.Notifications") as unknown as Notifications,
      );
    } catch (error) {
      // No notification server: the tooltip and the menu still say it.
      console.error(
        `no notification server, so no update popup: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }
  return null;
}
