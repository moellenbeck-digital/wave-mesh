# The end-to-end tests need Linux: network namespaces, veth pairs, nftables and
# TUN devices. This image is that Linux for a Mac or any other machine with
# Docker, so the tests in test/e2e run anywhere, not only in Linux CI.
#
#   test/e2e/docker/run.sh mobile-core.sh
#
# The repository is mounted, not copied: the image holds tools, never code.
FROM golang:1.27-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
      iproute2 nftables iputils-ping curl ca-certificates unzip procps \
      util-linux dnsutils jq kmod \
    && rm -rf /var/lib/apt/lists/*

# The Bun the repository pins (see .github/workflows/release.yml).
ARG BUN_VERSION=1.4.2
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun

# wireguard-go for the desktop peers the tests run against the phone core.
RUN GOBIN=/usr/local/bin go install golang.zx2c4.com/wireguard@latest \
    && mv /usr/local/bin/wireguard /usr/local/bin/wireguard-go

WORKDIR /repo
