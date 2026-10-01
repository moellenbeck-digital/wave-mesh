/**
 * The forwarding rules of a wave connector (D11).
 *
 * The connector is the whole cluster's membership in the wave: one node, one
 * tunnel, and every exposed service is an address routed to it. What it does
 * with those packets is the one rule below.
 *
 * **It needs no list of services.** WireGuard already decided which addresses
 * may arrive here: cryptokey routing accepts a packet on `wave0` only if its
 * destination is in this node's own `allowedIps`, which is its own address plus
 * exactly its services. So "arrived on wave0 and not addressed to me" *is* "for
 * one of my services" -- and a rule that says that keeps working while services
 * come and go, without a reload and without a watcher.
 *
 * The destination is the internal ingress controller's ClusterIP, and the host
 * header and SNI are left alone: the controller picks the ingress rule and the
 * certificate by name, so the wave name has to be the ingress host. A proxy
 * that rewrote it would have to terminate TLS, and there would be a second
 * place where routing lives.
 */

export interface ConnectorRules {
  /** The tunnel interface packets arrive on. */
  interfaceName: string;
  /** This node's own addresses in the wave, which are *not* forwarded. */
  ownAddresses: string[];
  /** Where the cluster's internal ingress controller listens. */
  backend: { ipv4: string; ipv6?: string };
  /**
   * Ports to forward. Everything else is dropped rather than passed on: a
   * connector is a door to named services, not a route into the cluster.
   */
  ports: number[];
  /** The tunnel MTU, for the clamp. */
  mtu: number;
}

export const DEFAULT_PORTS = [80, 443];

const address = (cidr: string): string => cidr.split("/")[0] ?? cidr;

/**
 * The whole ruleset, in one `nft -f -` document.
 *
 * Written as a complete table that is flushed first, so applying it twice is
 * the same as applying it once -- a connector that restarts must not end up
 * with two generations of rules, and it cannot know what it left behind.
 */
export function nftRuleset(rules: ConnectorRules): string {
  const own = rules.ownAddresses.map(address);
  const ownV4 = own.filter((entry) => !entry.includes(":"));
  const ownV6 = own.filter((entry) => entry.includes(":"));
  const ports = rules.ports.length > 0 ? rules.ports : DEFAULT_PORTS;
  const portSet = `{ ${ports.join(", ")} }`;
  const iif = `iifname "${rules.interfaceName}"`;

  const lines = [
    // Create-then-delete is the idempotent opening: the first line makes the
    // table if it is not there, the second takes it away with whatever it held.
    // A connector that restarts cannot know what it left behind, and two
    // generations of rules in one table forward to two different backends.
    "table inet wave-connector {}",
    "delete table inet wave-connector",
    "table inet wave-connector {",
    "  chain prerouting {",
    "    type nat hook prerouting priority dstnat; policy accept;",
    // Our own address is us: the daemon's resolver and anything else the node
    // itself serves have to keep working.
    ...ownV4.map((entry) => `    ${iif} ip daddr ${entry} return`),
    ...ownV6.map((entry) => `    ${iif} ip6 daddr ${entry} return`),
    `    ${iif} tcp dport ${portSet} dnat ip to ${rules.backend.ipv4}`,
    ...(rules.backend.ipv6
      ? [`    ${iif} tcp dport ${portSet} dnat ip6 to ${rules.backend.ipv6}`]
      : // Without an IPv6 backend the v6 half of a service address has nowhere
        // to go, and saying so beats a timeout.
        [`    ${iif} meta nfproto ipv6 tcp dport ${portSet} reject`]),
    "  }",
    "  chain forward {",
    "    type filter hook forward priority filter; policy accept;",
    // 1280 bytes of tunnel behind a 1500-byte cluster network: without the
    // clamp this is a connection that works until the first large answer.
    `    ${iif} tcp flags syn tcp option maxseg size set ${rules.mtu - 40}`,
    `    oifname "${rules.interfaceName}" tcp flags syn tcp option maxseg size set ${rules.mtu - 40}`,
    // Anything not on a service port is not a service. Dropped here rather
    // than left to the cluster network, where it would be a way in.
    `    ${iif} tcp dport != ${portSet} drop`,
    `    ${iif} meta l4proto != tcp drop`,
    "  }",
    "  chain postrouting {",
    "    type nat hook postrouting priority srcnat; policy accept;",
    // The cluster has no route back into the wave, so the reply has to come
    // back through us. The price is that the backend sees our pod address and
    // not the caller's -- the PROXY protocol would be the way out of that, and
    // then this stops being plain DNAT (see D11's open questions).
    `    ip daddr ${rules.backend.ipv4} masquerade`,
    ...(rules.backend.ipv6 ? [`    ip6 daddr ${rules.backend.ipv6} masquerade`] : []),
    "  }",
    "}",
  ];
  return `${lines.join("\n")}\n`;
}
