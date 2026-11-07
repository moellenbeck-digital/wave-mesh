# syntax=docker/dockerfile:1
# The pier node (D12), in one image: the daemon that holds the tunnel and the pier
# that reads the name off a connection and splices it. Published as
# `wave-reverse-proxy`. Build context is the repository root -- this is a workspace.
#
# One image and two commands rather than two images, for the reason the
# connector is one: both are the same participant. They share an enrolment, a
# state file and an identity, and a second one would be a second node in the
# wave that never carries traffic.
#
# What it does *not* carry is a key or a certificate for any of the names it
# serves. It never terminates TLS -- the device behind the name does, with its
# own certificate (D7) -- so there is nothing here to steal that opens a session.

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
COPY apps/pier/package.json apps/pier/
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
COPY packages/sni/package.json packages/sni/
# --omit=optional cuts dbus-next's `usocket`, and with it the whole node-gyp
# tree underneath. @wave/client pulls in @wave/tray because one binary carries
# every role, but a pier never draws an icon, and node-gyp's own
# dependencies only ever run at install time -- so what lands here is dead
# weight that any image scanner reports as critical. The fd-passing socket it
# provides is optional in dbus-next itself; without it dbus-next falls back to
# node:net.
RUN bun install --frozen-lockfile --production --omit=optional \
  --filter @wave/client --filter @wave/pier

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
# iproute2 for the interface and the routes, nftables for the packet filter the
# daemon writes when the wave has a policy. The pier itself needs neither.
RUN apk add --no-cache nftables iproute2
COPY --from=wireguard /out/wireguard-go /usr/local/bin/wireguard-go
COPY --from=deps /app ./
COPY packages packages
COPY apps/client apps/client
COPY apps/pier apps/pier

# What the device list shows next to this node. The release workflow hands the
# version in; without it the node calls itself 0.0.0-dev.
ARG WAVE_BUILD_VERSION=
ENV WAVE_BUILD_VERSION=${WAVE_BUILD_VERSION}

# Root, because the daemon creates a tun device and sets addresses. The pod asks
# for NET_ADMIN and /dev/net/tun. The pier listens on WAVE_PIER_PORT (8443 by
# default, above 1024 so it needs no capability); the ingress or the Service in
# front maps 443 onto it.
CMD ["bun", "apps/client/src/cli.ts", "daemon"]
