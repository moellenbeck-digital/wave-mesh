/**
 * Whether a firewall on this machine drops what the pier sends to a name this
 * device put out (D12). Linux only, and only the two front ends a desktop
 * there comes with: ufw and firewalld.
 *
 * The listener of `wave expose` is bound to the wave address, and from this
 * device itself it is reached over loopback -- which every host firewall lets
 * through. So the name works here, the pier logs "no answer", and the only
 * thing in the way is a DROP for the wave interface. Ping comes through too
 * (ufw lets ICMP in), and the tunnel looks fine from every side. Hence a hint
 * at the place where the name is put out, with the command that opens it.
 *
 * Only a hint: wave does not open the port itself. A firewall belongs to the
 * person who set it up, and an accept in a table of our own would not even
 * help -- in nftables a drop in any base chain on the hook is final.
 */

import type { CommandRunner } from "./link.ts";

/** A firewall that keeps the pier out, and the one line that lets it in. */
export interface HostFirewallBlock {
  tool: "ufw" | "firewalld";
  command: string;
}

/** What a port specification of ufw (`443`, `80,443/tcp`, `8000:8100/tcp`) says about one TCP port. */
function portMatches(spec: string, port: number): boolean {
  const [ports = "", proto] = spec.split("/");
  if (proto && proto !== "tcp") return false;
  return ports.split(",").some((part) => {
    const [from, to] = part.split(":").map(Number);
    if (from === undefined || Number.isNaN(from)) return false;
    return to === undefined ? from === port : port >= from && port <= (to ?? from);
  });
}

const PORT_SPEC = /^\d+(?::\d+)?(?:,\d+(?::\d+)?)*(?:\/\w+)?$/;

/**
 * Whether `ufw status verbose` lets TCP on `port` in over `iface`: an incoming
 * policy other than deny/reject, or an ALLOW rule that covers the port -- on
 * that interface from anywhere at all, or on every interface from anywhere.
 * A rule for one source on every interface is someone's LAN, not the pier.
 * Read with LC_ALL=C; ufw translates its output otherwise.
 */
export function ufwAllows(output: string, iface: string, port: number): boolean {
  const policy = /^Default:\s*(\w+)\s*\(incoming\)/m.exec(output)?.[1];
  if (policy === "allow") return true;
  for (const raw of output.split("\n")) {
    const line = raw.replace(/\s*\(v6\)/g, "").trim();
    // "To   Action   From", the columns at least two spaces apart.
    const [to, action, from] = line.split(/\s{2,}/);
    if (!to || !action || !from || !/^ALLOW(?: IN)?$/.test(action)) continue;
    const onMatch = /\s+on\s+(\S+)$/.exec(to);
    if (onMatch && onMatch[1] !== iface) continue;
    if (!onMatch && from !== "Anywhere") continue;
    const target = (onMatch ? to.slice(0, onMatch.index) : to).trim().split(/\s+/);
    const spec = target.find((token) => PORT_SPEC.test(token));
    // No port at all (`Anywhere`, an address) is every port.
    if (!spec || portMatches(spec, port)) return true;
  }
  return false;
}

/** The ufw rule for it: this interface, this port, any source -- the policy of the wave decides who. */
export const ufwCommand = (iface: string, port: number): string =>
  `sudo ufw allow in on ${iface} to any port ${port} proto tcp`;

/** The firewalld lines for it: the interface's zone, or a zone of its own when it has none. */
export function firewalldCommand(zone: string | null, port: number, iface: string): string {
  if (zone) {
    return `sudo firewall-cmd --permanent --zone=${zone} --add-port=${port}/tcp && sudo firewall-cmd --reload`;
  }
  return [
    "sudo firewall-cmd --permanent --new-zone=wave",
    `sudo firewall-cmd --permanent --zone=wave --add-interface=${iface}`,
    `sudo firewall-cmd --permanent --zone=wave --add-port=${port}/tcp`,
    "sudo firewall-cmd --reload",
  ].join(" && ");
}

/**
 * Asks ufw, then firewalld. Null when neither is installed and running, when
 * one of them lets the port in, and when they cannot be asked (not root) --
 * a hint that might be wrong is worse than none, because it asks for sudo.
 */
export async function linuxHostFirewall(
  tool: (binary: string) => CommandRunner,
  iface: string,
  port: number,
): Promise<HostFirewallBlock | null> {
  const ufw = await tool("ufw")(["status", "verbose"]);
  if (ufw.code === 0 && /^Status:\s*active/m.test(ufw.stdout)) {
    return ufwAllows(ufw.stdout, iface, port) ? null : { tool: "ufw", command: ufwCommand(iface, port) };
  }

  const firewalld = tool("firewall-cmd");
  const state = await firewalld(["--state"]);
  if (state.code !== 0 || state.stdout.trim() !== "running") return null;
  const own = await firewalld([`--get-zone-of-interface=${iface}`]);
  const zone = own.code === 0 ? own.stdout.trim() || null : null;
  const effective = zone ?? (await firewalld(["--get-default-zone"])).stdout.trim();
  if (!effective) return null;
  if (effective === "trusted") return null;
  const open = await firewalld([`--zone=${effective}`, `--query-port=${port}/tcp`]);
  if (open.code === 0 && open.stdout.trim() === "yes") return null;
  return { tool: "firewalld", command: firewalldCommand(zone, port, iface) };
}
