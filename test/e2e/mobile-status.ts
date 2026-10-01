/**
 * Reads one field out of the mobile core's status file, for the end-to-end test.
 *
 * The core hands the platform its whole state as JSON -- that is the shape that
 * crosses into Swift and Kotlin -- so a shell test reads the same thing a phone
 * would draw from, rather than parsing log lines.
 *
 * Deliberately free of workspace imports: it runs from outside any package.
 *
 *   mobile-status.ts <status.json> <ipv4|dnsName|via|suffix|relay|resolver|port> <control-url>
 *
 * Exits non-zero when the wave is not there yet or the field is empty, so a
 * script can spin on it.
 */
const [path, field, controlUrl] = process.argv.slice(2);
if (!path || !field || !controlUrl) {
  console.error("usage: mobile-status.ts <status.json> <field> <control-url>");
  process.exit(2);
}

const text = await Bun.file(path)
  .text()
  .catch(() => "");
if (!text.trim()) process.exit(1);

let status: unknown;
try {
  status = JSON.parse(text);
} catch {
  // Written atomically, so this should not happen -- but a half-read file must
  // look like "not ready" rather than like a broken test.
  process.exit(1);
}

// `port` belongs to the device, not to a wave: there is one public UDP port for
// all of them, which is the whole point of the single socket.
if (field === "port") {
  const port = (status as { port?: number }).port;
  if (typeof port !== "number" || port === 0) process.exit(1);
  console.log(String(port));
  process.exit(0);
}

const waves = (status as { waves?: Array<Record<string, unknown>> }).waves ?? [];
const wave = waves.find((entry) => entry.controlUrl === controlUrl);
if (!wave) process.exit(1);

if (field === "via") {
  // The path to the first peer, which is what says discovery finished. Empty
  // means traffic is being sprayed at every candidate instead.
  const peers = (wave.peers ?? []) as Array<Record<string, unknown>>;
  const via = peers.map((peer) => peer.via).find((value) => typeof value === "string" && value !== "");
  if (!via) process.exit(1);
  console.log(via);
  process.exit(0);
}

const value = wave[field];
if (typeof value !== "string" || value === "") process.exit(1);
console.log(value);
