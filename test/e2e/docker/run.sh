#!/usr/bin/env bash
# Runs one of the end-to-end tests inside the Linux image next to this file.
#
#   test/e2e/docker/run.sh mobile-core.sh [args...]
#
# Privileged, because the tests create network namespaces, TUN devices and
# nftables rules -- inside the container only; the host is not touched. The
# node_modules of the host are not used: the container installs its own, for
# Linux, into a volume of its own. Go modules are fetched before the test,
# because the test builds inside network namespaces that have no internet.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
script="${1:?which test, e.g. mobile-core.sh}"
shift

# Every node_modules of the workspace gets a volume of its own, so the Linux
# install in the container never overwrites the host's.
volumes=(-v wave-e2e-nm-root:/repo/node_modules)
for dir in "$repo"/apps/* "$repo"/packages/*; do
  [[ -d "$dir" ]] || continue
  relative="${dir#"$repo"/}"
  volumes+=(-v "wave-e2e-nm-${relative//\//-}:/repo/$relative/node_modules")
done

docker build -q -t wave-e2e "$here" >/dev/null
docker run --rm --privileged \
  -v "$repo":/repo \
  "${volumes[@]}" \
  -v wave-e2e-go-cache:/root/go/pkg/mod \
  -e WAVE_E2E_KEEP="${WAVE_E2E_KEEP:-0}" \
  wave-e2e bash -c "bun install --frozen-lockfile >/dev/null && (cd mobile/core && go mod download) && ./test/e2e/$script $*"
