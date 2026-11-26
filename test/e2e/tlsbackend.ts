/**
 * A service that terminates TLS itself, for the pier test: what a device puts
 * out through the pier answers with its own certificate, and the pier only
 * moves bytes.
 *
 *   bun tlsbackend.ts <ip> <port> <cert.pem> <key.pem> <body>
 */
const [ip, port, cert, key, body] = process.argv.slice(2);
if (!ip || !port || !cert || !key || body === undefined) {
  console.error("usage: tlsbackend.ts <ip> <port> <cert.pem> <key.pem> <body>");
  process.exit(2);
}
Bun.serve({
  hostname: ip,
  port: Number(port),
  tls: { cert: Bun.file(cert), key: Bun.file(key) },
  fetch: () => new Response(body),
});
console.log(`tls backend on ${ip}:${port}`);
