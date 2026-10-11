import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { intlTag } from "@wave/i18n";
import type { UpdateStatus } from "@wave/ipc";
import { BRAND_COLOUR, markPixmap } from "./icon.ts";
import { locale, t } from "./messages.ts";
import { icoFromPngs, pngFromPixmap } from "./png.ts";

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
 *
 * Every one of them carries the wave mark, not a stock symbol: a dialog that
 * asks to install something as root should say whose it is at a glance.
 */
export interface UpdatePrompt {
  /** Resolves true when the person chose to install, false on anything else. */
  ask(text: PromptText): Promise<boolean>;
}

export interface PromptText {
  title: string;
  body: string;
  /**
   * The two buttons, in the tray's language. Part of the text rather than
   * constants, because osascript answers with the *name* of the button that
   * was clicked: the label shown and the label compared have to be the same
   * string, and carrying them together is what keeps them so. Optional for a
   * text built by hand, which then gets the English ones.
   */
  install?: string;
  later?: string;
}

// The English labels, for a text that brought none; t() says them otherwise.
const INSTALL = "Install now";
const LATER = "Later";

/** The button labels of a text, English where it brought none. */
const buttonsOf = (text: Pick<PromptText, "install" | "later">) => ({
  install: text.install ?? INSTALL,
  later: text.later ?? LATER,
});

/** What the popup says. Pure, so the wording is tested once for all three. */
export function promptText(update: UpdateStatus, current: string, now: Date = new Date()): PromptText | null {
  if (!update.available || update.state === "installing" || update.state === "unavailable") return null;
  const when =
    update.state === "scheduled" && update.scheduledAt ? formatTime(update.scheduledAt, now) : null;
  const words = t();
  return {
    title: words.promptTitle,
    body: words.promptBody(update.available, current, when),
    install: words.promptInstall,
    later: words.promptLater,
  };
}

/** A time today is just the time; anything further away gets its date. */
function formatTime(iso: string, now: Date): string {
  const at = new Date(iso);
  const tag = intlTag(locale());
  const time = at.toLocaleTimeString(tag, { hour: "2-digit", minute: "2-digit" });
  return at.toDateString() === now.toDateString() ? time : `${at.toLocaleDateString(tag)} ${time}`;
}

/**
 * The mark as files, because none of the three takes pixels: osascript and
 * the notification server read a path, WinForms an .ico for the title bar and
 * an image for the dialog. Drawn in the brand colour, not a state colour --
 * this is the application speaking, not the tunnel.
 */
export interface PromptIcon {
  png: string;
  ico: string;
}

/** Large enough for a Retina dialog; the notification server scales it down. */
const PROMPT_ICON_SIZE = 128;

export function writePromptIcon(dir: string): PromptIcon {
  const png = join(dir, "wave.png");
  const ico = join(dir, "wave.ico");
  writeFileSync(png, pngFromPixmap(markPixmap(BRAND_COLOUR, PROMPT_ICON_SIZE)));
  writeFileSync(
    ico,
    icoFromPngs(
      [16, 32, 48, 256].map((size) => ({ size, png: pngFromPixmap(markPixmap(BRAND_COLOUR, size)) })),
    ),
  );
  return { png, ico };
}

let written: PromptIcon | null | undefined;

/**
 * Written once per tray, into a directory of its own: mkdtemp makes it 0700
 * with a name nobody could have planted a symlink under, which a fixed path in
 * a shared /tmp would not be. Gone again when the tray exits. Null when it
 * cannot be written -- then the dialogs fall back to a stock symbol, because
 * osascript refuses to show a dialog at all whose icon file is missing.
 */
function promptIcon(): PromptIcon | null {
  if (written !== undefined) return written;
  try {
    const dir = mkdtempSync(join(tmpdir(), "wave-prompt-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    written = writePromptIcon(dir);
  } catch (error) {
    console.error(`could not write the dialog icon: ${error instanceof Error ? error.message : error}`);
    written = null;
  }
  return written;
}

/**
 * The osascript invocation. "Later" is the cancel button, so Escape means
 * later; the dialog gives up after an hour so a forgotten one does not stand
 * on the screen for ever -- the menu still has the same button.
 *
 * `with icon` takes a PNG as well as an .icns, checked on macOS 26 -- a file
 * that is no image fails with "Datei enthält kein Symbol" (-50), the PNG shows.
 */
export function macosDialog(icon: PromptIcon | null): string[] {
  const symbol = icon ? '(POSIX file (env("WAVE_PROMPT_ICON")))' : "note";
  // The labels come from the environment like the text: they are ours, but a
  // translation with a quote in it would otherwise be a syntax error.
  const later = '(env("WAVE_PROMPT_LATER"))';
  const install = '(env("WAVE_PROMPT_INSTALL"))';
  const script =
    'display dialog (env("WAVE_PROMPT_BODY")) with title (env("WAVE_PROMPT_TITLE")) ' +
    `buttons {${later}, ${install}} default button ${install} cancel button ${later} ` +
    `with icon ${symbol} giving up after 3600`;
  return ["osascript", ...MACOS_ENV_HANDLER.flatMap((line) => ["-e", line]), "-e", script];
}

/**
 * Reads a variable from the environment as UTF-8. AppleScript's own `system
 * attribute` decodes it as MacRoman, which made "verfügbar" into
 * "verf√ºgbar" in every German dialog (seen on macOS 26, 11.10.2026). `do
 * shell script` hands back what the shell printed, decoded as UTF-8. The name
 * is always one of ours; the value is expanded once by the shell and never
 * read as code, so the rule above still holds -- nothing is spliced in.
 * `without altering line endings`, or the blank line in the body would come
 * back as a carriage return.
 */
const MACOS_ENV_HANDLER = [
  "on env(name)",
  `return do shell script "printf %s \\"$" & name & "\\"" without altering line endings`,
  "end env",
];

/**
 * "button returned:Install now, gave up:false" -- or nothing, on Later. The
 * name is compared with the label this dialog was shown with, so a German
 * "Jetzt installieren" counts as the same yes.
 */
export const parseMacosAnswer = (stdout: string, text: Pick<PromptText, "install"> = {}): boolean =>
  stdout.includes(`button returned:${buttonsOf(text).install}`) && !stdout.includes("gave up:true");

/**
 * The PowerShell invocation: a small WinForms dialog rather than a MessageBox,
 * because a MessageBox shows one of four system symbols and nothing else, and
 * has no title bar icon at all. TopMost and Activate bring it to the front --
 * the tray never has the foreground, and a dialog behind every window is one
 * nobody sees.
 *
 * Should the form fail -- it is unrun on real hardware, like everything on
 * Windows here -- the catch shows the old MessageBox, so the offer still
 * reaches someone. Both answer with a DialogResult; closing the form with its
 * X is Cancel, which reads as Later.
 */
export function windowsDialog(): string[] {
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms, System.Drawing",
    "try {",
    "  if (-not $env:WAVE_PROMPT_ICON) { throw 'no icon' }",
    "  [System.Windows.Forms.Application]::EnableVisualStyles()",
    "  $f = New-Object System.Windows.Forms.Form",
    "  $f.Text = $env:WAVE_PROMPT_TITLE",
    "  $f.Icon = New-Object System.Drawing.Icon($env:WAVE_PROMPT_ICO)",
    "  $f.Font = [System.Drawing.SystemFonts]::MessageBoxFont",
    "  $f.FormBorderStyle = 'FixedDialog'; $f.MaximizeBox = $false; $f.MinimizeBox = $false",
    "  $f.StartPosition = 'CenterScreen'; $f.TopMost = $true; $f.ShowInTaskbar = $true",
    "  $p = New-Object System.Windows.Forms.PictureBox",
    "  $p.Image = [System.Drawing.Image]::FromFile($env:WAVE_PROMPT_ICON)",
    "  $p.SizeMode = 'Zoom'; $p.SetBounds(20, 20, 48, 48)",
    "  $l = New-Object System.Windows.Forms.Label",
    "  $l.Text = $env:WAVE_PROMPT_BODY; $l.AutoSize = $true",
    "  $l.MaximumSize = New-Object System.Drawing.Size(340, 0)",
    "  $l.Location = New-Object System.Drawing.Point(84, 20)",
    "  $f.Controls.AddRange(@($p, $l))",
    "  $y = [Math]::Max(68, 20 + $l.PreferredSize.Height) + 20",
    "  $yes = New-Object System.Windows.Forms.Button",
    // Wide enough for "Jetzt installieren" in the message box font; the
    // right edge stays where it was, next to Later.
    "  $yes.Text = $env:WAVE_PROMPT_INSTALL; $yes.DialogResult = 'Yes'; $yes.SetBounds(196, $y, 136, 28)",
    "  $no = New-Object System.Windows.Forms.Button",
    "  $no.Text = $env:WAVE_PROMPT_LATER; $no.DialogResult = 'No'; $no.SetBounds(340, $y, 84, 28)",
    "  $f.Controls.AddRange(@($yes, $no))",
    "  $f.AcceptButton = $yes; $f.CancelButton = $no",
    "  $f.ClientSize = New-Object System.Drawing.Size(444, ($y + 48))",
    "  $f.Add_Shown({ $f.Activate() })",
    "  $f.ShowDialog()",
    "} catch {",
    "  [System.Windows.Forms.MessageBox]::Show($env:WAVE_PROMPT_BODY, $env:WAVE_PROMPT_TITLE, " +
      "'YesNo', 'Information', 'Button1', 'DefaultDesktopOnly')",
    "}",
  ].join("\n");
  return ["powershell.exe", "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script];
}

/** ShowDialog and MessageBox.Show return the DialogResult by name, in English whatever the locale. */
export const parseWindowsAnswer = (stdout: string): boolean => stdout.trim() === "Yes";

/** What a dialog process gets to read; the icon variables only when there is an icon. */
export function promptEnv(text: PromptText, icon: PromptIcon | null): Record<string, string> {
  const buttons = buttonsOf(text);
  const env: Record<string, string> = {
    WAVE_PROMPT_TITLE: text.title,
    WAVE_PROMPT_BODY: text.body,
    WAVE_PROMPT_INSTALL: buttons.install,
    WAVE_PROMPT_LATER: buttons.later,
  };
  if (icon) {
    env.WAVE_PROMPT_ICON = icon.png;
    env.WAVE_PROMPT_ICO = icon.ico;
  }
  return env;
}

/** Runs a dialog as a child process and reads its answer. */
class ProcessPrompt implements UpdatePrompt {
  constructor(
    private readonly command: (icon: PromptIcon | null) => string[],
    private readonly parse: (stdout: string, text: PromptText) => boolean,
  ) {}

  async ask(text: PromptText): Promise<boolean> {
    try {
      const icon = promptIcon();
      const proc = Bun.spawn(this.command(icon), {
        stdout: "pipe",
        stderr: "ignore",
        env: { ...process.env, ...promptEnv(text, icon) },
      });
      const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      return this.parse(stdout, text);
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

  constructor(
    private readonly notifications: Notifications,
    private readonly icon: () => PromptIcon | null = promptIcon,
  ) {
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
      // app_icon takes a file:// URI as well as a theme name; the theme name
      // is only the fallback, for when the mark could not be written.
      const icon = this.icon();
      const id = await this.notifications.Notify(
        "wave",
        0,
        icon ? pathToFileURL(icon.png).href : "system-software-update",
        text.title,
        text.body,
        // The keys are identifiers the server hands back; only the labels
        // beside them are for a person, and so in their language.
        ["default", buttonsOf(text).install, "install", buttonsOf(text).install],
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
