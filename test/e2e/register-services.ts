/**
 * Registers services the way the operator does, for the end-to-end tests:
 * signed with the connector's machine key, the whole set in one call.
 *
 *   bun register-services.ts <state.json> <control-url> <name>...
 *
 * Prints one "name ipv4 ipv6" line per service the server answered with.
 */
import { ControlClient } from "../../apps/client/src/api.ts";
import { connectorProfile } from "../../apps/operator/src/main.ts";

const [statePath, controlUrl, ...names] = process.argv.slice(2);
if (!statePath || !controlUrl || names.length === 0) {
  console.error("usage: register-services.ts <state.json> <control-url> <name>...");
  process.exit(2);
}
const profile = await connectorProfile(statePath, controlUrl);
const answer = await new ControlClient(profile).syncServices(names, []);
for (const service of answer.services) {
  console.log(`${service.name} ${service.ipv4} ${service.ipv6 ?? ""}`);
}
