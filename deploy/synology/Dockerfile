# syntax=docker/dockerfile:1
# Daemon and connector for a Synology NAS, in one image. Build context is the
# repository root; see README.md in this folder.
#
# Not apps/connector/Dockerfile, for one reason: the kernel. DSM 7 runs 4.4, and
# Bun there cannot follow the symlinked packages of a workspace's node_modules
# (it wants statx, Linux 4.11). So both programs are compiled to one binary
# each, the way the SPK carries the client -- nothing is resolved at run time.

FROM --platform=$BUILDPLATFORM golang:1.27-alpine AS wireguard
ARG TARGETARCH
# The same pin as apps/connector/Dockerfile and scripts/build-clients.sh.
ARG WIREGUARD_GO_VERSION=v0.0.0-20260522210424-ecfc5a8d5446
WORKDIR /src
RUN apk add --no-cache git \
  && go mod init wgbuild \
  && GOFLAGS=-mod=mod go get "golang.zx2c4.com/wireguard@${WIREGUARD_GO_VERSION}" \
  && CGO_ENABLED=0 GOOS=linux GOARCH=${TARGETARCH} go build -trimpath -o /out/wireguard-go golang.zx2c4.com/wireguard

FROM --platform=$BUILDPLATFORM oven/bun:1.4.2 AS build
ARG TARGETARCH
ARG WAVE_BUILD_VERSION=
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
COPY packages/sni/package.json packages/sni/
# @wave/tray too: the client binary carries every role, and a compiled build has
# to resolve all of them even though a NAS never draws an icon.
RUN bun install --frozen-lockfile --production --omit=optional \
  --filter @wave/client --filter @wave/connector --filter @wave/tray
COPY packages packages
COPY apps/client apps/client
COPY apps/connector apps/connector
COPY apps/tray apps/tray
# "baseline" on x86: the Celerons in these NAS models have no AVX2. No --minify
# and no --sourcemap, and x11 stays outside, as in scripts/build-clients.sh.
RUN case "$TARGETARCH" in \
    amd64) target=bun-linux-x64-baseline ;; \
    arm64) target=bun-linux-arm64 ;; \
    *) echo "no build for $TARGETARCH" >&2; exit 1 ;; \
  esac \
  && version="${WAVE_BUILD_VERSION:-$(bun -e 'console.log(require("./package.json").version)')+synology}" \
  && for entry in client/src/cli.ts:wave connector/src/main.ts:wave-connector; do \
    bun build --compile --external x11 --target="$target" \
      --define "WAVE_BUILD_VERSION=\"$version\"" \
      "apps/${entry%%:*}" --outfile "/out/${entry##*:}" || exit 1; \
  done

FROM debian:bookworm-slim
# iproute2 for the interface and the routes, iptables (with iptables-legacy) for
# the filter. No nftables: the kernel has none, and `auto` then takes iptables.
RUN apt-get update \
  && apt-get install -y --no-install-recommends iproute2 iptables ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=wireguard /out/wireguard-go /usr/local/bin/wireguard-go
# Not /usr/local/bin/wave: that is where an installed daemon updates itself, and
# an image is updated by replacing it.
COPY --from=build /out/ /opt/wave/
ENV PATH=/opt/wave:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
CMD ["wave", "daemon"]
