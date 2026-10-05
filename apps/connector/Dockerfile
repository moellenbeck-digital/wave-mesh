# syntax=docker/dockerfile:1
# The cluster's membership in a wave, in one image: the daemon that holds the
# tunnel, the connector that forwards, and the operator that reads Kubernetes.
# Build context is the repository root -- this is a workspace.
#
# One image and three commands rather than three images, because all three are
# the same participant: they share one enrolment, one state file and one
# identity. Which one runs is the container's `command`.

# wireguard-go is pure Go without cgo, so it cross-compiles from the build
# host's architecture like the client binaries do. The version is pinned for
# the same reason as in scripts/build-clients.sh: a rebuild has to give the
# same bytes.
#
# The toolchain tracks mobile/core/go.mod, because its standard library ends up
# inside this binary: an unsupported Go ships known stdlib holes in a process
# that runs with NET_ADMIN. Reproducibility rests on -trimpath and the module
# pseudo-version above, not on the compiler's number.
FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS wireguard
ARG TARGETARCH
ARG WIREGUARD_GO_VERSION=v0.0.0-20260522210424-ecfc5a8d5446
WORKDIR /src
RUN apk add --no-cache git \
  && go mod init wgbuild \
  && GOFLAGS=-mod=mod go get "golang.zx2c4.com/wireguard@${WIREGUARD_GO_VERSION}" \
  && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath -o /out/wireguard-go golang.zx2c4.com/wireguard

FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
COPY apps/client/package.json apps/client/
COPY apps/connector/package.json apps/connector/
COPY apps/control/package.json apps/control/
COPY apps/operator/package.json apps/operator/
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
# --omit=optional cuts dbus-next's `usocket`, and with it the whole node-gyp
# tree underneath. @wave/client pulls in @wave/tray because one binary carries
# every role, but a connector never draws an icon, and node-gyp's own
# dependencies only ever run at install time -- so what lands here is dead
# weight that any image scanner reports as critical. The fd-passing socket it
# provides is optional in dbus-next itself; without it dbus-next falls back to
# node:net.
RUN bun install --frozen-lockfile --production --omit=optional \
  --filter @wave/client --filter @wave/connector --filter @wave/operator

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
# nftables for the forwarding rules, iproute2 for the interface and the routes.
RUN apk add --no-cache nftables iproute2
COPY --from=wireguard /out/wireguard-go /usr/local/bin/wireguard-go
COPY --from=deps /app ./
COPY packages packages
COPY apps/client apps/client
COPY apps/connector apps/connector
COPY apps/operator apps/operator

# What the device list shows next to this node. The client binaries carry their
# version through `bun build --define`; this image runs from source, so the
# release workflow hands it in here instead. Last, so a new version does not
# invalidate any layer above. Without it the node calls itself 0.0.0-dev.
ARG WAVE_BUILD_VERSION=
ENV WAVE_BUILD_VERSION=${WAVE_BUILD_VERSION}

# Root, and that is the point: the daemon creates a tun device, sets addresses
# and writes nftables rules. The pod asks for NET_ADMIN and /dev/net/tun and
# for nothing else -- above all for no inbound port, because STUN and the relay
# carry the tunnel out of the cluster.
CMD ["bun", "apps/client/src/cli.ts", "daemon"]
