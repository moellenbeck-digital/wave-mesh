#!/usr/bin/env bash
#
# M3: two nodes behind separate NATs, with no port forwarding anywhere, find a
# direct path to each other and carry WireGuard traffic over it.
#
# Topology, all inside one unprivileged user namespace:
#
#   node A ---- natA ====== br0 (203.0.113.0/24) ====== natB ---- node B
#   10.1.0.2   masquerade        control + STUN        masquerade  10.2.0.2
#              203.0.113.10      203.0.113.254         203.0.113.20
#
# Neither node is reachable from outside its NAT: there is no forwarding rule
# anywhere, so the only way A and B can talk is by punching holes from both
# sides at the same time.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

INET=203.0.113.254
CONTROL="http://$INET:8080"
STUN_SERVERS="$INET:3478,$INET:3479"

step "two NATs and a network between them"
build_two_nat_sites
ok "both nodes reach $INET through their NAT, neither is reachable at its private address"

step "control server and two STUN servers"
WAVE_PORT=8080 WAVE_BASE_URL="$CONTROL" WAVE_HOST=0.0.0.0 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
WAVE_STUN_PORT=3478 WAVE_RELAY_PORT=3480 bun "$REPO/apps/relay/src/index.ts" >"$WORK/stun1.log" 2>&1 &
WAVE_STUN_PORT=3479 WAVE_RELAY_PORT=3481 bun "$REPO/apps/relay/src/index.ts" >"$WORK/stun2.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$CONTROL/healthz" >/dev/null || fail "control server did not start"
curl -s --retry 20 --retry-all-errors --retry-delay 1 "http://$INET:3480/healthz" >/dev/null || fail "STUN server did not start"
ok "control on $CONTROL, STUN on $STUN_SERVERS"

step "browser login"
browser_login "$CONTROL"
ok "signed in"

step "enrol node A behind NAT A"
start_node a nodea wave0 "$CONTROL"

step "enrol node B behind NAT B"
start_node b nodeb wave1 "$CONTROL"

step "STUN told each node its public address"
wait_for_line "$WORK/a.log" 'NAT mapping endpoint-independent' "A's NAT classification"
wait_for_line "$WORK/b.log" 'NAT mapping endpoint-independent' "B's NAT classification"
ok "both NATs classified as endpoint-independent"

step "hole punching"
wait_for_line "$WORK/a.log" 'path to .* is 203\.0\.113\.20:' "A to find a direct path to B"
wait_for_line "$WORK/b.log" 'path to .* is 203\.0\.113\.10:' "B to find a direct path to A"
ok "$(grep -o 'path to .* is 203\.0\.113\.20:[0-9]* .*' "$WORK/a.log" | head -1)"
ok "$(grep -o 'path to .* is 203\.0\.113\.10:[0-9]* .*' "$WORK/b.log" | head -1)"

step "WireGuard is talking to the magic socket, not to the wire"
ip netns exec nodea bun "$REPO/apps/client/src/cli.ts" status \
  --state "$WORK/a/state.json" --socket /run/wireguard/wave0.sock | grep -q 'via 127.0.0.1:' \
  || fail "WireGuard's endpoint should be the local magic socket"
ok "peer endpoint is a loopback address"

step "ping through both NATs"
A_IP=$(tunnel_ip nodea wave0)
B_IP=$(tunnel_ip nodeb wave1)
ip netns exec nodea ping -c3 -W5 -I wave0 "$B_IP" >/dev/null || fail "A could not reach B over the tunnel"
ok "A ($A_IP) -> B ($B_IP)"
ip netns exec nodeb ping -c3 -W5 -I wave1 "$A_IP" >/dev/null || fail "B could not reach A over the tunnel"
ok "B ($B_IP) -> A ($A_IP)"

printf '\n\033[32mPASS: two nodes behind separate NATs punched a direct path and carried traffic over it\033[0m\n'
