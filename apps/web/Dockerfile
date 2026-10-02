# syntax=docker/dockerfile:1
# Build context is the repository root -- this is a workspace, the frontend
# does not stand on its own.

FROM oven/bun:1.4.2-alpine AS deps
WORKDIR /app

# Manifests first, so a source change does not re-run the install.
# --frozen-lockfile checks the lockfile against every workspace, so all of them
# have to be here even though --filter installs just one. No --production here:
# the build needs TypeScript and Tailwind.
COPY package.json bun.lock ./
COPY apps/client/package.json apps/client/
COPY apps/control/package.json apps/control/
COPY apps/relay/package.json apps/relay/
COPY apps/tray/package.json apps/tray/
COPY apps/web/package.json apps/web/
COPY packages/crypto/package.json packages/crypto/
COPY packages/disco/package.json packages/disco/
COPY packages/dns/package.json packages/dns/
COPY packages/i18n/package.json packages/i18n/
COPY packages/ipc/package.json packages/ipc/
COPY packages/magicsock/package.json packages/magicsock/
COPY packages/proto/package.json packages/proto/
RUN bun install --frozen-lockfile --filter @wave/web

FROM deps AS build
# The one workspace package the frontend imports: how a request's language is
# chosen, shared with the control server so both pick the same one.
COPY packages/i18n packages/i18n
COPY apps/web apps/web
ENV NEXT_TELEMETRY_DISABLED=1
RUN cd apps/web && bun run build

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production PORT=3000 HOSTNAME=0.0.0.0 NEXT_TELEMETRY_DISABLED=1
# Where the control server is, read at start -- both by next.config.ts for the
# rewrites and by lib/control.ts for the server-side calls. Inside a stack that
# is the service name; the default only fits a frontend beside the server.
ENV WAVE_CONTROL_URL=http://127.0.0.1:8080

# The standalone output is a server plus exactly the modules it traced; static
# assets are not part of it and have to be laid back in beside it.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static apps/web/.next/static

USER bun
EXPOSE 3000
CMD ["bun", "apps/web/server.js"]
