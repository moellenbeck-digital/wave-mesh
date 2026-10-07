/**
 * Prints the connector's nftables ruleset -- the one production applies --
 * for the end-to-end tests, so the test forwards exactly as a cluster does.
 *
 *   bun connector-rules.ts <iface> <own-v4> <own-v6> <backend-v4> [mtu]
 */
import { nftRuleset } from "../../apps/connector/src/rules.ts";

const [interfaceName, ownV4, ownV6, backendV4, mtu] = process.argv.slice(2);
if (!interfaceName || !ownV4 || !backendV4) {
  console.error("usage: connector-rules.ts <iface> <own-v4> <own-v6> <backend-v4> [mtu]");
  process.exit(2);
}
process.stdout.write(
  nftRuleset({
    interfaceName,
    ownAddresses: [ownV4, ownV6 ?? ""].filter((entry) => entry.length > 0),
    // IPv4 only, as on the cluster: the internal ingress has no IPv6 ClusterIP.
    backend: { ipv4: backendV4 },
    ports: [80, 443],
    mtu: Number(mtu ?? 1280),
  }),
);
