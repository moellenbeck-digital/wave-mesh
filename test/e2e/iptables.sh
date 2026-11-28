#!/usr/bin/env bash
#
# The iptables backends against a real iptables-legacy and real packets: the
# connector's forwarding and the port half of a policy, applied twice, checked
# with iptables-save and traffic, and taken out again (iptables/run.ts).
#
#   ./test/e2e/iptables.sh
#
# Needs Docker and a `bun install` in the repository. Privileged, because the
# test makes network namespaces and writes netfilter rules -- inside the
# container only; the repository is mounted read-only.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

docker build -q -t wave-e2e-iptables "$here/iptables" >/dev/null
docker run --rm --privileged -v "$repo":/repo:ro wave-e2e-iptables bun test/e2e/iptables/run.ts
