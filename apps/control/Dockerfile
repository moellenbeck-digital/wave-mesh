# syntax=docker/dockerfile:1
# Build context is the repository root -- this is a workspace, the server does
# not stand on its own.

# Dependencies are installed on the build host's own architecture. Everything
# the control server pulls in is plain JavaScript, so the tree is the same on
# amd64 and arm64 and the arm64 image does not have to install under emulation.
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
COPY packages/i18n/package.json packages/i18n/
COPY packages/ipc/package.json packages/ipc/
COPY packages/magicsock/package.json packages/magicsock/
COPY packages/proto/package.json packages/proto/
RUN bun install --frozen-lockfile --production --filter @wave/control

# The operator CLI as one file, so administering a wave does not need the
# workspace around it: `docker exec <container> wave-admin members <wave>`, or
# copied out of the image and run anywhere.
#
# Cross-compiled from the build host rather than built in the runtime stage,
# for the same reason the install above happens on $BUILDPLATFORM: bun bakes
# the target runtime into the binary, so an arm64 image can be produced without
# running a compiler under emulation.
FROM --platform=$BUILDPLATFORM oven/bun:1.4.2-alpine AS admin
ARG TARGETARCH
WORKDIR /app
COPY --from=deps /app ./
COPY packages packages
COPY apps/control apps/control
# musl, because the runtime image is alpine. A glibc binary fails there with
# "not found" -- which reads like a missing file and is a missing libc.
#
# No --minify and no --sourcemap, the same rule the client binaries follow:
# either one leaves a binary that starts and then misbehaves.
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) target=bun-linux-x64-musl ;; \
    arm64) target=bun-linux-arm64-musl ;; \
    *) echo "no bun target for TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
  esac; \
  mkdir -p /out; \
  bun build --compile --target="$target" apps/control/src/admin.ts --outfile /out/wave-admin

FROM oven/bun:1.4.2-alpine AS runtime
WORKDIR /app
ENV WAVE_ENV=production

# Bun's isolated linker puts every package in node_modules/.bun and points
# relative symlinks at it from each workspace -- the tree only resolves as a
# whole, so it is copied as a whole.
COPY --from=deps /app ./
COPY packages packages
COPY apps/control apps/control
COPY --from=admin /out/wave-admin /usr/local/bin/wave-admin

USER bun
EXPOSE 8080
# The migrations travel with the image; apply them before the first start with
#   docker run --rm <image> bun apps/control/src/db/migrate.ts
# Accounts and everything else an operator does go through `wave-admin`, which
# is on the PATH here -- `docker run --rm <image> wave-admin` prints what it
# can do. The source it was built from is still in the image, so
# `bun apps/control/src/admin.ts` remains the same program.
CMD ["bun", "apps/control/src/index.ts"]
