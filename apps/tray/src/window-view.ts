import { type ProfileStatus, pathKind, type Status, waveLabel } from "@wave/ipc";
import { updateNotice } from "./view.ts";

/**
 * What the window shows, derived from the daemon's status.
 *
 * Kept free of any toolkit so the layout can be tested without opening a
 * window -- the GTK and Cocoa sides only turn these rows into widgets.
 */

export interface ConnectionRow {
  /** The control server: what identifies a connection, and what an action names. */
  controlUrl: string;
  /** How it is written in the window -- host and port, the scheme left off. */
  label: string;
  /** Whether the switch is on. */
  connected: boolean;
  /** On its way up or down, so the switch should not fight the user. */
  busy: boolean;
  /** This device's address in that wave, or why there is none. */
  detail: string;
}

/**
 * A name in the wave that is not a machine: reached through one of them (D11).
 *
 * It sits under the machine that fronts it and nowhere else -- a service has
 * no keys and no tunnel of its own, so there is nothing else to show it
 * against, and a connector without them looks like a machine that joined and
 * then did nothing.
 */
export interface ServiceRow {
  /** Stable across updates, like a machine's. */
  key: string;
  /** What is written on the row: the name under the wave's suffix. */
  label: string;
  /**
   * What clicking it opens, exactly as the control server wrote it.
   *
   * Never assembled here: the scheme belongs to the cluster and the zone to
   * the wave, and both are known only on the server. A view that rebuilt the
   * address would be a fourth spelling of it.
   */
  url: string;
  address: string;
}

export interface MachineRow {
  /** Stable across updates, so a widget can be reused rather than rebuilt. */
  key: string;
  hostname: string;
  address: string;
  /**
   * The fully qualified name, and what the copy button puts on the clipboard.
   *
   * The address would be shorter, but it is the wrong thing to carry away: it
   * is assigned by the wave and can change, while the name keeps pointing at
   * the machine. Pasted into a config or a browser, only one of the two still
   * means something tomorrow.
   */
  dnsName: string;
  path: string;
  online: boolean;
  /** Which wave it belongs to, written short; only shown when there are two. */
  waveLabel: string;
  /**
   * What it answers for besides itself, folded away until it is asked for.
   *
   * A connector brings as many names as the cluster has ingresses, and written
   * out they would push the machines below it out of a card that is 420 points
   * wide. Which of them are open is the window's business, not this view's:
   * the list is rebuilt on every status push, so the state cannot live in a
   * row that only lives a second.
   */
  services: ServiceRow[];
}

export interface WindowView {
  title: string;
  subtitle: string;
  connections: ConnectionRow[];
  machines: MachineRow[];
  /** True once a second wave makes the peer list ambiguous on its own. */
  labelMachines: boolean;
  /** Shown instead of the machine list when there is nothing to show. */
  emptyMachines: string;
}

const describePath = (peer: ProfileStatus["peers"][number]): string => {
  const kind = pathKind(peer);
  if (kind === "loose") return "no fixed path";
  if (kind === "none") return "connecting…";
  const via = kind === "relay" ? "via relay" : `direct ${peer.via}`;
  return peer.rttMs === null ? via : `${via} · ${Math.round(peer.rttMs)} ms`;
};

function detailFor(profile: ProfileStatus): string {
  if (profile.state === "up") return profile.self?.ipv4 ?? "connected";
  if (profile.state === "waiting-for-approval") return "waiting for approval in the browser";
  if (profile.state === "failed") return profile.message ?? "failed";
  if (profile.state === "starting") return "connecting…";
  return "not connected";
}

/** Kept as a name the window's own tests and callers use; one implementation. */
export const hostOf = waveLabel;

export function windowView(status: Status | null, deviceName: string): WindowView {
  const profiles = status?.profiles ?? [];
  const up = profiles.filter((profile) => profile.state === "up");

  const connections: ConnectionRow[] = profiles.map((profile) => ({
    controlUrl: profile.controlUrl,
    label: waveLabel(profile.controlUrl),
    connected: profile.state === "up",
    busy: profile.state === "starting" || profile.state === "waiting-for-approval",
    detail: detailFor(profile),
  }));

  // Peers of every connected wave in one list, the way the design asks for.
  // The wave is named on the row only once there are two, where the same short
  // hostname could otherwise mean two different machines.
  const machines: MachineRow[] = profiles.flatMap((profile) =>
    profile.peers.map((peer) => ({
      key: `${profile.controlUrl}/${peer.dnsName}`,
      hostname: peer.hostname,
      address: peer.ipv4,
      dnsName: peer.dnsName,
      path: describePath(peer),
      online: pathKind(peer) !== "none",
      waveLabel: waveLabel(profile.controlUrl),
      services: peer.services.map((service) => ({
        key: `${profile.controlUrl}/${service.dnsName}`,
        label: service.dnsName,
        url: service.url,
        address: service.ipv4,
      })),
    })),
  );

  const state = !status
    ? "waiting for the daemon"
    : profiles.length === 0
      ? "no wave yet — run `wave login`"
      : profiles.length === 1
        ? detailFor(profiles[0] as ProfileStatus)
        : `${up.length}/${profiles.length} waves connected`;
  // On the subtitle, which every platform's card already draws: an update is
  // about the device, not about a wave or a machine, and this is the line that
  // speaks for the device. Installing is in the menu.
  const notice = updateNotice(status);
  const subtitle = notice ? `${state} · ${notice.text}` : state;

  return {
    title: deviceName,
    subtitle,
    connections,
    machines,
    labelMachines: profiles.length > 1,
    emptyMachines:
      profiles.length === 0
        ? "Join a wave to see its machines."
        : up.length === 0
          ? "Connect to see the machines in this wave."
          : "No other machines in this wave yet.",
  };
}
