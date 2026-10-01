#!/usr/bin/env bash
# Local smoke test: rendezvous + two peers on one machine.
# Proves the plumbing, NOT NAT traversal between two different NATs.
set -euo pipefail
cd "$(dirname "$0")"

bun run rendezvous.ts &
RV=$!
trap 'kill "$RV" 2>/dev/null || true' EXIT
until curl -sf http://127.0.0.1:8787 >/dev/null 2>&1; do sleep 0.1; done

bun run peer.ts --name alice "$@" &
A=$!
bun run peer.ts --name bob "$@" &
B=$!
wait "$A" && wait "$B"
