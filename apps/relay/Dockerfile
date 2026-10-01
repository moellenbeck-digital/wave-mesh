# syntax=docker/dockerfile:1
# Build context is the repository root -- this is a workspace, the relay does
# not stand on its own.

# Dependencies are installed on the build host's own architecture. Everything
# the relay pulls in is plain JavaScript, so the tree is the same on amd64 and
# arm64 and the arm64 image does not have to install under emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS deps
WORKDIR /app

# Manifests first, so a source change does not re-run the install.
# --frozen-lockfile checks the lockfile against every workspace, so all of them
# have to be here even though --filter installs just one.
COPY package.json bun.lock ./
COPY apps/client/package.json apps/client/
COPY apps/control/package.json apps/control/
COPY apps/relay/package.json apps/relay/
COPY apps/tray/package.json apps/tray/
COPY apps/web/package.json apps/web/
COPY packages/crypto/package.json packages/crypto/
COPY packages/disco/package.json packages/disco/
COPY packages/dns/package.json packages/dns/
COPY packages/ipc/package.json packages/ipc/
COPY packages/magicsock/package.json packages/magicsock/
COPY packages/proto/package.json packages/proto/
RUN bun install --frozen-lockfile --production --filter @wave/relay

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app

# Bun's isolated linker puts every package in node_modules/.bun and points
# relative symlinks at it from each workspace -- the tree only resolves as a
# whole, so it is copied as a whole.
COPY --from=deps /app ./
COPY packages packages
COPY apps/relay apps/relay

USER bun
# STUN answers on UDP, the relay itself speaks WebSocket over TCP.
EXPOSE 3478/udp
EXPOSE 3479/tcp
CMD ["bun", "apps/relay/src/index.ts"]
