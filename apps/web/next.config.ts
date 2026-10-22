import type { NextConfig } from "next";

const control = process.env.WAVE_CONTROL_URL ?? "http://127.0.0.1:8080";

/**
 * In production the control server is in front and proxies everything it does
 * not own to this app. In development it is the other way round: the browser
 * talks to `next dev`, because hot reload is a WebSocket and a proxy built on
 * `fetch` cannot upgrade one. These rewrites make :3000 a complete server, so
 * the login POST and the device link work from here too.
 */
const config: NextConfig = {
  // The image ships only what the build traced: server.js plus the modules it
  // actually reaches. Without it the runtime stage would have to carry Next
  // and its whole dependency tree.
  output: "standalone",
  async rewrites() {
    return [
      { source: "/v1/:path*", destination: `${control}/v1/:path*` },
      { source: "/auth/:path*", destination: `${control}/auth/:path*` },
      { source: "/api/:path*", destination: `${control}/api/:path*` },
      { source: "/machine/:path*", destination: `${control}/machine/:path*` },
      // The form posts of the wave card. Spelled out rather than
      // `/waves/:path*`, because an array of rewrites is checked *before* the
      // dynamic routes: a wildcard would swallow `/waves/[id]/invited`, and
      // the control server would proxy it right back here.
      // Exact, so it cannot swallow the `/waves/new` page next to it.
      { source: "/waves", destination: `${control}/waves` },
      { source: "/waves/:id/domain", destination: `${control}/waves/:id/domain` },
      { source: "/waves/:id/invites", destination: `${control}/waves/:id/invites` },
      {
        source: "/waves/:id/invites/:inviteId/revoke",
        destination: `${control}/waves/:id/invites/:inviteId/revoke`,
      },
      {
        source: "/waves/:id/members/:userId/remove",
        destination: `${control}/waves/:id/members/:userId/remove`,
      },
      {
        source: "/waves/:id/members/:userId/role",
        destination: `${control}/waves/:id/members/:userId/role`,
      },
      {
        source: "/waves/:id/nodes/:nodeId/remove",
        destination: `${control}/waves/:id/nodes/:nodeId/remove`,
      },
      { source: "/healthz", destination: `${control}/healthz` },
    ];
  },
};

export default config;
