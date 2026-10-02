import { hostname } from "node:os";
import { systemLocale } from "@wave/i18n/system";
import { DaemonClient, defaultSocketPath, isDevVersion, type Status, VERSION } from "@wave/ipc";
import { createTrayBackend, type TrayBackend, UnsupportedPlatform } from "./backend.ts";
import { setLocale, t } from "./messages.ts";
import { createUpdatePrompt, promptText } from "./prompt.ts";
import { actionForId, iconFor, menuFor, tooltipFor, type Unreachable } from "./view.ts";
import { createTrayWindow, NoWindowBackend, type TrayWindow } from "./window.ts";
import { windowView } from "./window-view.ts";

/**
 * Tray icon for the wave client.
 *
 * A plain reader of the daemon's control socket: everything it shows comes
 * from there, and the actions it offers are the ones the CLI already sends. It
 * needs no privileges beyond being allowed to use that socket.
 */

export interface TrayOptions {
  socketPath?: string;
}

/** The platforms differ only in the name of the "open this" command. */
function openCommand(target: string): string[] {
  if (process.platform === "darwin") return ["open", target];
  if (process.platform === "win32") return ["cmd", "/c", "start", "", target];
  return ["xdg-open", target];
}

const open = (target: string) => Bun.spawn(openCommand(target), { stdout: "ignore", stderr: "ignore" });

export async function runTray(options: TrayOptions = {}): Promise<void> {
  // Once, before anything is worded. The tray runs as the person in their
  // session, so its environment -- or, under launchd and the Task Scheduler,
  // which pass no LANG, the system settings -- is their language. The daemon
  // has none of its own and says what it means as notices (see @wave/ipc).
  setLocale(systemLocale());
  const socketPath = options.socketPath ?? process.env.WAVE_SOCKET ?? defaultSocketPath();

  let status: Status | null = null;
  let client: DaemonClient | null = null;
  let shownUrl: string | null = null;
  let unreachable: Unreachable = "no-daemon";
  const device = hostname();

  /**
   * The window is where connections are switched and machines are copied; the
   * menu stays as the fallback for a platform without one, and for a right
   * click when the window is not what is wanted.
   */
  const window: TrayWindow | null = await createTrayWindow({
    onToggle: (controlUrl, connect) =>
      void client?.request(
        connect ? { command: "up", controlUrl } : { command: "down", controlUrl },
        15 * 60 * 1000,
      ),
    // A service in the card is a name in the wave; opening it is the same
    // command the menu already uses for the enrolment link.
    onOpen: (url) => void open(url),
  }).catch((error: unknown) => {
    console.error(error instanceof NoWindowBackend ? error.message : error);
    // Without a window a left click has nothing to open, so say where the rest
    // of it still is rather than leaving the icon looking dead.
    console.error(t().menuStillThere);
    return null;
  });

  const activate = async (id: number): Promise<void> => {
    // Every address the tray shows comes from the daemon, one per wave. The
    // tray itself is not configured with a server -- nothing here is.
    const action = actionForId(status, id);
    if (!action) return;
    if (action.kind === "quit") process.exit(0);
    if (action.kind === "update") {
      // The daemon restarts on success and this tray follows it once it sees
      // the new version, so there is nothing to wait for here.
      await client?.request({ command: "update", install: true }, 15 * 60 * 1000);
      return;
    }
    if (action.kind === "open") {
      open(action.url);
      return;
    }
    if (action.kind === "connect") {
      await client?.request({ command: "up", controlUrl: action.controlUrl }, 15 * 60 * 1000);
    }
    if (action.kind === "disconnect") {
      await client?.request({ command: "down", controlUrl: action.controlUrl });
    }
  };

  // The popup that offers an update (D13). Asked once per version and tray:
  // a dialog that came back every second, or after every "Later", would be
  // something people learn to click away unread. The menu keeps the button.
  const prompt = await createUpdatePrompt();
  const offered = new Set<string>();
  const offerUpdate = (next: Status | null): void => {
    const update = next?.daemon?.update;
    if (!prompt || !update?.available || offered.has(update.available)) return;
    const text = promptText(update, next?.daemon?.version ?? VERSION);
    if (!text) return;
    offered.add(update.available);
    void prompt.ask(text).then(async (install) => {
      // Which version is the daemon's decision, not this dialog's: it may have
      // found a newer one in the meantime, and that is the one to install.
      if (install) await client?.request({ command: "update", install: true }, 15 * 60 * 1000);
    });
  };

  const tray: TrayBackend = await createTrayBackend({
    onActivate: (id) => void activate(id),
    // A click shows the overlay, and a second click puts it away again -- it
    // has no title bar of its own to close it with. Connecting and
    // disconnecting happen on the switches inside it, where it is visible
    // which wave is being acted on.
    onClick: () => window?.toggle(),
  }).catch((error: unknown) => {
    console.error(error instanceof UnsupportedPlatform ? error.message : error);
    process.exit(1);
  });

  const refresh = (next: Status | null): void => {
    // The tray is the same binary as the daemon but a process of its own, so
    // after a self-update it would go on running the old code (D13). It steps
    // aside instead -- with a failure status, because that is what systemd's
    // Restart=on-failure and Task Scheduler's RestartOnFailure answer; launchd
    // restarts it either way. What comes back is the new build.
    const daemonVersion = next?.daemon?.version;
    if (
      daemonVersion &&
      daemonVersion !== VERSION &&
      !isDevVersion(VERSION) &&
      !isDevVersion(daemonVersion)
    ) {
      console.log(`the service runs ${daemonVersion} and this tray ${VERSION}; restarting to catch up`);
      process.exit(75);
    }
    status = next;
    offerUpdate(next);
    window?.update(windowView(next, device));
    tray.update({
      state: iconFor(next),
      tooltip: tooltipFor(next, unreachable),
      entries: menuFor(next, { unreachable }),
    });

    // The enrolment link is the one thing worth pushing at the user. Whichever
    // wave is waiting for it -- only one can be enrolling at a time, since the
    // daemon brings them up in turn.
    const waiting = next?.profiles.find(
      (profile) => profile.state === "waiting-for-approval" && profile.authUrl,
    );
    if (waiting?.authUrl && waiting.authUrl !== shownUrl) {
      shownUrl = waiting.authUrl;
      open(waiting.authUrl);
    }
    if (!waiting) shownUrl = null;
  };

  await tray.start();
  refresh(null);
  console.log(`wave tray started (${tray.platform}), reading ${socketPath}`);

  // Reconnects until the daemon is there, so the icon can start first.
  for (;;) {
    const attempt = await DaemonClient.open(socketPath);
    client = attempt.ok ? attempt.client : null;
    unreachable = attempt.ok ? null : attempt.reason;
    if (client) {
      const closed = Promise.withResolvers<void>();
      await client.watch(refresh);
      const check = setInterval(async () => {
        const response = await client?.request({ command: "status" }, 3000);
        if (!response || response.type === "error") {
          clearInterval(check);
          closed.resolve();
        }
      }, 5000);
      await closed.promise;
      client?.close();
      client = null;
    }
    refresh(null);
    await Bun.sleep(2000);
  }
}
