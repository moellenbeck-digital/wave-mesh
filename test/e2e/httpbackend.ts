/**
 * A stand-in for the cluster's internal ingress: answers by Host header, and
 * `/big` sends a few megabytes, so a path that breaks on large packets shows.
 *
 *   bun httpbackend.ts <ip> <port>
 */
const [hostname, port] = process.argv.slice(2);
const big = new Uint8Array(3 * 1024 * 1024).map((_, index) => index % 251);
Bun.serve({
  hostname,
  port: Number(port ?? 80),
  fetch(request) {
    const host = request.headers.get("host") ?? "";
    if (new URL(request.url).pathname === "/big") return new Response(big);
    return new Response(`hello from ${host.split(":")[0]}\n`);
  },
});
console.log(`backend on ${hostname}:${port ?? 80}`);
