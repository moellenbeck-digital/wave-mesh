/**
 * The two halves of a port check for the ACL test, in one file so both sides
 * of the tunnel run the same code.
 *
 *   bun tcpprobe.ts listen  <ip> <port>...       accepts and closes, forever
 *   bun tcpprobe.ts connect <ip> <port> [ms]     exit 0 if it connected in time
 *
 * A connection the filter drops never completes: the SYN goes nowhere, so the
 * answer is a timeout rather than a refusal -- which is also how it is told
 * apart from a port where nothing listens.
 */
const [mode, ip, ...rest] = process.argv.slice(2);

if (mode === "listen" && ip) {
  for (const port of rest) {
    Bun.listen({ hostname: ip, port: Number(port), socket: { data() {}, open: (socket) => socket.end() } });
  }
  console.log(`listening on ${ip}:${rest.join(",")}`);
  await new Promise(() => {});
}

if (mode === "connect" && ip && rest[0]) {
  const timeoutMs = Number(rest[1] ?? 2000);
  const outcome = await Promise.race([
    Bun.connect({
      hostname: ip,
      port: Number(rest[0]),
      socket: { data() {}, open: (socket) => socket.end() },
    })
      .then(() => "connected")
      .catch((error: unknown) => `refused: ${error instanceof Error ? error.message : String(error)}`),
    Bun.sleep(timeoutMs).then(() => "timed out"),
  ]);
  // Said on stderr, so a failing check in the script shows why.
  if (outcome !== "connected") console.error(`${ip}:${rest[0]} ${outcome}`);
  process.exit(outcome === "connected" ? 0 : 1);
}

console.error("usage: tcpprobe.ts listen <ip> <port>... | connect <ip> <port> [ms]");
process.exit(2);
