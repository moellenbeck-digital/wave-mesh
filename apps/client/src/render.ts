import { type ProfileStatus, pathKind, type Status, waveLabel } from "@wave/ipc";

/**
 * Renders the live status view. Kept pure so it can be tested without a
 * tunnel, and so the terminal handling stays in one place.
 */

const ESC = "\u001b";
const ANSI = new RegExp(`${ESC}\\[[0-9;]*m`, "g");

const dim = (text: string) => `${ESC}[2m${text}${ESC}[0m`;
const bold = (text: string) => `${ESC}[1m${text}${ESC}[0m`;
const green = (text: string) => `${ESC}[32m${text}${ESC}[0m`;
const yellow = (text: string) => `${ESC}[33m${text}${ESC}[0m`;

const pad = (text: string, width: number) => text.padEnd(width);

/** Visible width, ignoring the escape sequences used for colour. */
const visibleLength = (text: string) => text.replace(ANSI, "").length;

const padVisible = (text: string, width: number) =>
  text + " ".repeat(Math.max(0, width - visibleLength(text)));

function describePath(peer: ProfileStatus["peers"][number]): string {
  const kind = pathKind(peer);
  // Sprayed to every candidate rather than sent down a confirmed one: slower
  // and noisier, but the tunnel is carrying traffic and should not read as down.
  if (kind === "loose") return yellow("no fixed path");
  if (kind === "none") return yellow("connecting…");
  const label = kind === "relay" ? yellow("via relay") : green(`direct ${peer.via}`);
  return peer.rttMs === null ? label : `${label} ${dim(`${peer.rttMs.toFixed(0)}ms`)}`;
}

/**
 * A service under the machine that fronts it (D11).
 *
 * Written out rather than folded away like in the browser: a terminal has
 * nothing to click, and a view that repaints every second cannot hide
 * something behind an interaction it does not have. The address is the
 * server's own spelling of it, which is also what one would paste.
 */
const describeService = (service: ProfileStatus["peers"][number]["services"][number]): string =>
  dim(`  ↳ ${service.url}  ${service.ipv4}`);

function describeHandshake(seconds: number | null): string {
  if (seconds === null) return dim("—");
  return seconds < 180 ? `${seconds}s ago` : dim(`${Math.round(seconds / 60)}m ago`);
}

/** What the tunnel is doing when it is not simply up. */
function describeState(snapshot: ProfileStatus): string {
  if (snapshot.state === "waiting-for-approval" && snapshot.authUrl) {
    return `${yellow("Waiting for approval.")} Open this link to connect this device:\n\n    ${snapshot.authUrl}`;
  }
  if (snapshot.state === "failed") return `\x1b[31m${snapshot.message ?? "failed"}\x1b[0m`;
  if (snapshot.state === "starting") return yellow("Starting…");
  return dim(snapshot.message ?? "Not connected.");
}

/**
 * One wave. A device can be in several, so this renders a block rather than a
 * whole screen, and {@link renderStatus} stacks them.
 */
export function renderProfile(snapshot: ProfileStatus, events: string[] = snapshot.events): string[] {
  const lines: string[] = [];

  const self = snapshot.self;
  if (snapshot.state !== "up") lines.push(describeState(snapshot), "");
  lines.push(
    `${bold(snapshot.interfaceName ?? "wave")}  ${green(self?.ipv4 ?? "—")}  ${dim(snapshot.addresses.join("  "))}`,
  );
  if (self) lines.push(`${dim("name")}  ${self.dnsName}`);
  // This device fronting names means it is a connector; its own services are
  // in `addresses` as bare addresses and nowhere else by name.
  for (const service of self?.services ?? []) lines.push(describeService(service));
  if (snapshot.dnsSuffix) lines.push(`${dim("dns")}   ${dim(`*.${snapshot.dnsSuffix}`)}`);
  if (snapshot.relay) {
    const state = snapshot.relay.connected ? green("connected") : yellow("connecting…");
    lines.push(`${dim("relay")} ${state} ${dim(snapshot.relay.url)}`);
  }
  lines.push("");

  if (snapshot.peers.length === 0) {
    lines.push(dim("No peers yet. Run `wave up` on another device to add one."));
  } else {
    const nameWidth = Math.max(4, ...snapshot.peers.map((p) => p.hostname.length));
    const addressWidth = Math.max(7, ...snapshot.peers.map((p) => p.ipv4.length));
    lines.push(
      dim(`${pad("PEER", nameWidth)}  ${pad("ADDRESS", addressWidth)}  ${pad("PATH", 34)}  HANDSHAKE`),
    );
    for (const peer of snapshot.peers) {
      lines.push(
        `${pad(peer.hostname, nameWidth)}  ${pad(peer.ipv4, addressWidth)}  ` +
          `${padVisible(describePath(peer), 34)}  ${describeHandshake(peer.lastHandshakeSecondsAgo)}`,
      );
      for (const service of peer.services) lines.push(describeService(service));
    }
  }

  if (events.length > 0) {
    lines.push("", dim("recent"));
    for (const event of events) lines.push(dim(`  ${event}`));
  }
  return lines;
}

/**
 * Which build the service runs, and whether a newer one is coming (D13). The
 * version is shown so that a device whose only wave offers no updates is
 * noticed: it stays where it is, and this line is where that shows.
 */
function describeDaemon(status: Status): string | null {
  const info = status.daemon;
  if (!info) return null;
  const update = info.update;
  if (!update?.available) return dim(`wave ${info.version}`);
  const when =
    update.state === "installing"
      ? "installing now"
      : update.state === "scheduled" && update.scheduledAt
        ? `installing at ${new Date(update.scheduledAt).toLocaleTimeString()}`
        : "`wave update` installs it";
  return `${dim(`wave ${info.version}`)}  ${yellow(`update to ${update.available}`)} ${dim(when)}`;
}

/**
 * The footer says what Ctrl-C does, which is not the same everywhere: it ends
 * the tunnel when it runs in this process, and only the view when the daemon
 * holds it. Passing null leaves the line out, for a single printed snapshot
 * that nobody is going to interrupt.
 */
export function renderStatus(status: Status, hint: string | null = "Ctrl-C to disconnect."): string {
  if (status.profiles.length === 0) {
    const lines = [dim("No wave yet. Run `wave login --control <url>` to join one.")];
    for (const event of status.events) lines.push(dim(`  ${event}`));
    const daemon = describeDaemon(status);
    if (daemon) lines.push("", daemon);
    return lines.join("\n");
  }

  const lines: string[] = [];
  for (const [index, profile] of status.profiles.entries()) {
    if (index > 0) lines.push("", dim("─".repeat(60)), "");
    // With one wave the name would be noise; with several it is the only way
    // to tell which block is which.
    if (status.profiles.length > 1) {
      lines.push(`${bold(waveLabel(profile.controlUrl))}  ${dim(profile.controlUrl)}`);
    }
    lines.push(...renderProfile(profile));
  }

  // Daemon-level lines belong to no tunnel -- a refused profile, say.
  if (status.events.length > 0) {
    lines.push("", dim("daemon"));
    for (const event of status.events) lines.push(dim(`  ${event}`));
  }
  const daemon = describeDaemon(status);
  if (daemon) lines.push("", daemon);
  if (hint) lines.push("", dim(hint));
  return lines.join("\n");
}

/**
 * Whether a view should stay open and repaint, or print once and end.
 *
 * Off a terminal it never watches, whatever was asked for: `wave status` in a
 * `$(...)` or piped into grep has to answer once, or every script that reads
 * it hangs -- the end-to-end tests being the first of them.
 */
export const shouldWatch = (options: { once: boolean; isTty: boolean }): boolean =>
  !options.once && options.isTty;

/** Repaints in place on a terminal; falls back to plain output elsewhere. */
export function paint(text: string): void {
  if (process.stdout.isTTY) process.stdout.write(`${ESC}[H${ESC}[2J${text}\n`);
  else console.log(text);
}
