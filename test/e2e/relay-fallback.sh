#!/usr/bin/env bash
#
# M4: two nodes behind *symmetric* NATs, where hole punching cannot work at
# all, still reach each other -- over the relay.
#
# Same topology as nat-traversal.sh, with one difference: the NAT routers
# masquerade with a random source port per flow. The port STUN reports is
# therefore not the port a peer would have to send to, and no amount of
# punching can fix that. This is the case the relay exists for.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

INET=203.0.113.254
CONTROL="http://$INET:8080"
RELAYS='[
  {"id":"a","region":"test","url":"ws://203.0.113.254:3479/relay","stun":{"ip":"203.0.113.254","port":3478}},
  {"id":"b","region":"test","url":"ws://203.0.113.254:3481/relay","stun":{"ip":"203.0.113.254","port":3480}}
]'

step "two symmetric NATs"
build_two_nat_sites random
ok "both nodes reach $INET, neither is reachable at its private address"

step "control server and two relays"
WAVE_PORT=8080 WAVE_BASE_URL="$CONTROL" WAVE_HOST=0.0.0.0 WAVE_RELAYS="$RELAYS" \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
WAVE_STUN_PORT=3478 WAVE_RELAY_PORT=3479 bun "$REPO/apps/relay/src/index.ts" >"$WORK/relay1.log" 2>&1 &
WAVE_STUN_PORT=3480 WAVE_RELAY_PORT=3481 bun "$REPO/apps/relay/src/index.ts" >"$WORK/relay2.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$CONTROL/healthz" >/dev/null || fail "control server did not start"
curl -s --retry 20 --retry-all-errors --retry-delay 1 "http://$INET:3479/healthz" >/dev/null || fail "relay did not start"
ok "control on $CONTROL, relay on ws://$INET:3479/relay"

step "browser login"
browser_login "$CONTROL"
ok "signed in"

# No --stun here on purpose: the STUN servers come from the netmap.
step "enrol node A behind NAT A"
start_node a nodea wave0 "$CONTROL"

step "enrol node B behind NAT B"
start_node b nodeb wave1 "$CONTROL"

step "STUN sees a different port per destination"
wait_for_line "$WORK/a.log" 'NAT mapping address-dependent' "A's NAT classification"
wait_for_line "$WORK/b.log" 'NAT mapping address-dependent' "B's NAT classification"
ok "both NATs are symmetric, so punching cannot succeed"

step "the relay carries the connection"
# Only a peer something is sent to is probed, so somebody has to talk first.
A_IP=$(tunnel_ip nodea wave0)
B_IP=$(tunnel_ip nodeb wave1)
ip netns exec nodea ping -i 0.5 -W1 -I wave0 "$B_IP" >/dev/null 2>&1 &
TALKER=$!
wait_for_line "$WORK/a.log" 'path to .* is relay' "A to fall back to the relay"
wait_for_line "$WORK/b.log" 'path to .* is relay' "B to fall back to the relay"
ok "$(grep -o 'path to .* is relay .*' "$WORK/a.log" | head -1)"

if grep -qE 'path to .* is 203\.0\.113\.' "$WORK/a.log"; then
  fail "a direct path was selected, so this run did not test the relay"
fi
ok "no direct path was ever selected"
kill "$TALKER" 2>/dev/null || true

step "ping over the relay"
ip netns exec nodea ping -c3 -W5 -I wave0 "$B_IP" >/dev/null || fail "A could not reach B through the relay"
ok "A ($A_IP) -> B ($B_IP)"
ip netns exec nodeb ping -c3 -W5 -I wave1 "$A_IP" >/dev/null || fail "B could not reach A through the relay"
ok "B ($B_IP) -> A ($A_IP)"

step "the relay really did the forwarding"
FORWARDED=$(curl -s "http://$INET:3479/healthz" | sed -n 's/.*"forwarded":\([0-9]*\).*/\1/p')
[[ "${FORWARDED:-0}" -gt 0 ]] || fail "the relay forwarded nothing, so the traffic went elsewhere"
ok "relay forwarded $FORWARDED packet(s)"

printf '\n\033[32mPASS: two nodes behind symmetric NATs reached each other over the relay\033[0m\n'
