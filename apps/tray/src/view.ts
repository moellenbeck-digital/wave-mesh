import { type ProfileStatus, pathKind, type Status, waveLabel } from "@wave/ipc";
import type { IconState } from "./icon.ts";
import type { MenuEntry } from "./menu.ts";

/** What the tray shows, derived from the daemon's status. Pure, so testable. */

export const Ids = {
  header: 1,
  /** Only for the case where no wave is enrolled and there is nothing to ask. */
  /** The two lines shown when this device has joined nothing. */
  empty: 12,
  quit: 13,
  /** What self-updating has to say (D13): a line, and the button under it. */
  updateInfo: 20,
  update: 21,
  /**
   * A device can be in several waves, so each gets a block of ids. A block is
   * wider than any wave will ever be, which is what lets {@link actionForId}
   * read a profile back out of an id.
   */
  profileBase: 1000,
  profileStride: 1000,
} as const;

/** Fixed positions inside a profile's block. */
const Offset = { toggle: 0, heading: 1, open: 2, peersFrom: 10 } as const;

export const toggleId = (index: number): number => Ids.profileBase + index * Ids.profileStride;
const idFor = (index: number, offset: number): number => toggleId(index) + offset;

export type Action =
  | { kind: "quit" }
  /** Install the offered update now; which one is the daemon's decision. */
  | { kind: "update" }
  /** The address is carried along: the daemon knows it, the tray should not guess. */
  | { kind: "open"; url: string }
  | { kind: "connect"; controlUrl: string }
  | { kind: "disconnect"; controlUrl: string };

/** Turns a clicked menu id back into something to ask the daemon for. */
export function actionForId(status: Status | null, id: number): Action | null {
  if (id === Ids.quit) return { kind: "quit" };
  if (id === Ids.update) return status?.daemon?.update?.available ? { kind: "update" } : null;
  if (id < Ids.profileBase) return null;

  const index = Math.floor((id - Ids.profileBase) / Ids.profileStride);
  const offset = (id - Ids.profileBase) % Ids.profileStride;
  const profile = status?.profiles[index];
  if (!profile) return null;

  if (offset === Offset.open) {
    // Whichever server this wave actually enrolled with -- not whatever the
    // environment happened to be set to when the tray was started.
    return profile.controlUrl ? { kind: "open", url: profile.controlUrl } : null;
  }
  if (offset !== Offset.toggle) return null;
  return profile.state === "up"
    ? { kind: "disconnect", controlUrl: profile.controlUrl }
    : { kind: "connect", controlUrl: profile.controlUrl };
}

/** The icon says the best of what is going on: any wave up counts as up. */
export const iconFor = (status: Status | null): IconState => {
  if (!status || status.profiles.length === 0) return "off";
  if (status.profiles.some((profile) => profile.state === "up")) return "connected";
  const busy = status.profiles.some(
    (profile) => profile.state === "starting" || profile.state === "waiting-for-approval",
  );
  return busy ? "connecting" : "off";
};

/** Why the daemon is out of reach, when it is. */
export type Unreachable = "no-daemon" | "denied" | "unreachable" | null;

const describeProfile = (profile: ProfileStatus): string => {
  if (profile.state === "up") {
    const reachable = profile.peers.filter((peer) => peer.via !== null).length;
    return `${profile.self?.ipv4 ?? "connected"} — ${reachable}/${profile.peers.length} peer(s) reachable`;
  }
  if (profile.state === "waiting-for-approval") return "waiting for approval in the browser";
  return profile.message ?? profile.state;
};

/**
 * What there is to say about an update, if anything (D13). Shared by the
 * tooltip, the menu and the window, so the three cannot word it differently.
 */
export function updateNotice(status: Status | null): { text: string; installable: boolean } | null {
  const update = status?.daemon?.update;
  if (!update?.available) return null;
  if (update.state === "installing")
    return { text: `Installing wave ${update.available}…`, installable: false };
  // Only shown: this copy does not update itself (a development build, or a
  // package manager owns it), so a button would only produce an error.
  if (update.state === "unavailable")
    return { text: `wave ${update.available} is available`, installable: false };
  if (update.state === "scheduled" && update.scheduledAt) {
    const at = new Date(update.scheduledAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return { text: `Update to ${update.available} at ${at}`, installable: true };
  }
  return { text: `Update to ${update.available} available`, installable: true };
}

export function tooltipFor(status: Status | null, unreachable: Unreachable = null): string {
  const base = tooltipBase(status, unreachable);
  const notice = updateNotice(status);
  return notice ? `${base} · ${notice.text}` : base;
}

function tooltipBase(status: Status | null, unreachable: Unreachable): string {
  if (!status) {
    if (unreachable === "denied") return "not allowed to use the daemon — log out and back in";
    if (unreachable === "no-daemon") return "the wave service is not running";
    if (unreachable === "unreachable") return "the wave service is not answering";
    return "waiting for the daemon";
  }
  if (status.profiles.length === 0) return "no wave yet — run `wave login`";
  const first = status.profiles[0];
  if (status.profiles.length === 1 && first) return describeProfile(first);

  const up = status.profiles.filter((profile) => profile.state === "up").length;
  return `${up}/${status.profiles.length} waves connected`;
}

const describePath = (peer: ProfileStatus["peers"][number]): string => {
  const kind = pathKind(peer);
  if (kind === "loose") return "no fixed path";
  if (kind === "none") return "connecting…";
  return kind === "relay" ? "via relay" : `direct ${peer.via}`;
};

export function menuFor(status: Status | null, options: { unreachable?: Unreachable } = {}): MenuEntry[] {
  const entries: MenuEntry[] = [
    { id: Ids.header, label: tooltipFor(status, options.unreachable ?? null), enabled: false },
    { id: 2, separator: true },
  ];

  // Nothing here can act on a tunnel while the socket is out of reach, so say
  // what to do about it instead of offering buttons that do nothing.
  if (!status && options.unreachable === "denied") {
    entries.push(
      { id: Ids.profileBase, label: "Your account is in the 'wave' group,", enabled: false },
      { id: Ids.profileBase + 1, label: "but this session started before that.", enabled: false },
      { id: 3, separator: true },
      { id: Ids.quit, label: "Quit the tray icon" },
    );
    return entries;
  }

  const profiles = status?.profiles ?? [];
  const named = profiles.length > 1;

  profiles.forEach((profile, index) => {
    // With one wave its name would only repeat the header.
    if (named) {
      entries.push({
        id: idFor(index, Offset.heading),
        label: `${waveLabel(profile.controlUrl)} — ${describeProfile(profile)}`,
        enabled: false,
      });
    }
    profile.peers.forEach((peer, peerIndex) => {
      entries.push({
        id: idFor(index, Offset.peersFrom + peerIndex),
        label: `${named ? "   " : ""}${peer.hostname}  ${peer.ipv4}  ${describePath(peer)}`,
        enabled: false,
      });
    });
    entries.push({
      id: toggleId(index),
      label:
        profile.state === "up"
          ? named
            ? `Disconnect ${waveLabel(profile.controlUrl)}`
            : "Disconnect"
          : named
            ? `Connect ${waveLabel(profile.controlUrl)}`
            : "Connect",
    });
    // Naming the host rather than "the control server": with two waves the
    // labels would otherwise be identical, and it is the one place the address
    // is worth seeing.
    if (profile.controlUrl) {
      entries.push({ id: idFor(index, Offset.open), label: `Open ${waveLabel(profile.controlUrl)}` });
    }
    entries.push({ id: idFor(index, Ids.profileStride - 1), separator: true });
  });

  if (profiles.length === 0) {
    // Two different silences. Having asked the daemon and been told nothing is
    // joined, "Connect" would be a lie -- there is nothing to connect to until
    // `wave login` has run, and joining is not the tray's job. Not having
    // heard from the daemon at all says nothing about what this device joined,
    // so the button stays and the click is what finds out.
    if (status) {
      entries.push(
        { id: Ids.empty, label: "Not in any wave yet", enabled: false },
        { id: Ids.empty + 1, label: "Join one with: wave login <control-server-url>", enabled: false },
        { id: 3, separator: true },
      );
    } else {
      entries.push({ id: toggleId(0), label: "Connect" }, { id: 3, separator: true });
    }
  }

  // Last before Quit: it concerns the device, not any one wave.
  const notice = updateNotice(status);
  if (notice) {
    entries.push({ id: Ids.updateInfo, label: notice.text, enabled: false });
    if (notice.installable) entries.push({ id: Ids.update, label: "Install update now" });
    entries.push({ id: Ids.updateInfo + 100, separator: true });
  }

  entries.push({ id: Ids.quit, label: "Quit the tray icon" });
  return entries;
}
