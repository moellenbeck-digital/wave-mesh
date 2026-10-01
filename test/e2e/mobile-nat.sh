#!/usr/bin/env bash
#
# D10/M10: the mobile core behind a NAT, punching a direct path -- and, with
# --symmetric, falling back to the relay when punching cannot work at all.
#
# M10's acceptance criterion names both: "a phone in two waves at once, with a
# direct path and relay fallback". mobile-core.sh covers the two waves on a flat
# segment, where every path is direct and trivially so. This is the other half,
# and it is the half where the core's own discovery has to work: its own socket,
# its own STUN, its own probing, its own path choice -- all of it ported code
# that has never met a real NAT.
#
#   ./test/e2e/mobile-nat.sh              two NATs that keep the port: a direct path
#   ./test/e2e/mobile-nat.sh --symmetric  two that do not: the relay
#
# The peer on the other side is the ordinary Bun client, so this is also a test
# across the two implementations: they have to punch *at each other*, which
# means agreeing on disco packets, on candidates and on when to start.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

command -v go >/dev/null || fail "no go toolchain on PATH; the core is Go (see mobile/README.md)"

MODE=direct
[[ "${1:-}" == "--symmetric" ]] && MODE=relay

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

INET=203.0.113.254
CONTROL="http://$INET:8080"
PHONE_LOG="$WORK/phone.log"
STATUS="$WORK/phone-status.json"
# Two relays, because one STUN server can only report an address -- it takes two
# to see whether the mapping changes per destination, which is what tells a
# symmetric NAT from a well-behaved one.
RELAYS='[
  {"id":"a","region":"test","url":"ws://203.0.113.254:3479/relay","stun":{"ip":"203.0.113.254","port":3478}},
  {"id":"b","region":"test","url":"ws://203.0.113.254:3481/relay","stun":{"ip":"203.0.113.254","port":3480}}
]'

phone_field() { bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" "$1" "$CONTROL"; }

wait_for_wave() {
  for _ in $(seq 1 120); do
    [[ -s "$STATUS" ]] && phone_field ipv4 >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "--- phone ---"; tail -40 "$PHONE_LOG"
  fail "timed out waiting for the phone's wave"
}

if [[ "$MODE" == "relay" ]]; then
  step "two symmetric NATs"
  build_two_nat_sites random
  ok "both sides reach $INET, and the port STUN reports is not the port to send to"
else
  step "two NATs that keep the source port"
  build_two_nat_sites
  ok "both sides reach $INET, neither is reachable at its private address"
fi

step "build the harness"
( cd "$REPO/mobile/core" && go build -o "$WORK/wave-harness" ./cmd/wave-harness ) \
  || fail "the harness did not build"
ok "$(cd "$REPO/mobile/core" && go version)"

step "control server and two relays"
WAVE_PORT=8080 WAVE_BASE_URL="$CONTROL" WAVE_HOST=0.0.0.0 WAVE_RELAYS="$RELAYS" \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
WAVE_STUN_PORT=3478 WAVE_RELAY_PORT=3479 bun "$REPO/apps/relay/src/index.ts" >"$WORK/relay1.log" 2>&1 &
WAVE_STUN_PORT=3480 WAVE_RELAY_PORT=3481 bun "$REPO/apps/relay/src/index.ts" >"$WORK/relay2.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$CONTROL/healthz" >/dev/null || fail "control server did not start"
curl -s --retry 20 --retry-all-errors --retry-delay 1 "http://$INET:3479/healthz" >/dev/null || fail "relay did not start"
ok "control on $CONTROL, relays on 3479 and 3481"

step "browser login"
browser_login "$CONTROL"
ok "signed in"

step "the phone joins, from behind NAT A"
# No STUN servers on the command line: they come from the netmap, like
# everything else the core learns about the wave.
ip netns exec nodea "$WORK/wave-harness" --dev wave0 --state "$WORK/phone-state.json" \
  --control "$CONTROL" --status "$STATUS" >"$PHONE_LOG" 2>&1 &
echo $! >"$WORK/phone.pid"
wait_for_line "$PHONE_LOG" 'machine/authorize\?request=' "the phone to print its connect link"
URL=$(grep -o "http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*" "$PHONE_LOG" | head -1)
approve_device "$JAR" "$URL"
wait_for_wave
PHONE_IP=$(phone_field ipv4)
ok "wave0 up as $PHONE_IP behind NAT A"

step "an ordinary client joins from behind NAT B"
start_node b nodeb wave1 "$CONTROL"
B_IP=$(tunnel_ip nodeb wave1)

dump_logs() {
  for f in "$WORK"/*.log; do echo "--- $f ---"; grep -v "socket error" "$f" | tail -25 || true; done
}

step "the core sees its own NAT for what it is"
if [[ "$MODE" == "relay" ]]; then
  wait_for_line "$PHONE_LOG" 'NAT mapping address-dependent' "the phone to classify its NAT"
  wait_for_line "$WORK/b.log" 'NAT mapping address-dependent' "the peer to classify its NAT"
  ok "both sides symmetric, so punching cannot succeed"
else
  wait_for_line "$PHONE_LOG" 'NAT mapping endpoint-independent' "the phone to classify its NAT"
  ok "the mapping does not change per destination, so punching can work"
fi

if [[ "$MODE" == "relay" ]]; then
  step "the relay carries the connection"
  wait_for_line "$PHONE_LOG" 'path to .* is relay' "the phone to fall back to the relay"
  wait_for_line "$WORK/b.log" 'path to .* is relay' "the peer to fall back to the relay"
  ok "$(grep -o 'path to .* is relay.*' "$PHONE_LOG" | head -1)"

  if grep -qE 'path to .* is 203\.0\.113\.' "$PHONE_LOG"; then
    fail "a direct path was selected, so this run did not test the relay"
  fi
  ok "no direct path was ever selected"
else
  step "the two implementations punch a hole at each other"
  # Through the NATs, with neither side reachable at its private address: the
  # only way this line appears is a pair of packets that crossed while both
  # mappings were open.
  wait_for_line "$PHONE_LOG" 'path to .* is 203\.0\.113\.' "the phone to find a direct path"
  wait_for_line "$WORK/b.log" 'path to .* is 203\.0\.113\.' "the peer to find a direct path"
  ok "$(grep -o 'path to .* is 203\.0\.113\..*' "$PHONE_LOG" | head -1)"
fi

step "traffic over the path that was chosen"
ip netns exec nodea ping -c3 -W5 -I wave0 "$B_IP" >/dev/null \
  || { dump_logs; fail "the phone could not reach the peer"; }
ok "phone ($PHONE_IP) -> peer ($B_IP)"
ip netns exec nodeb ping -c3 -W5 -I wave1 "$PHONE_IP" >/dev/null \
  || { dump_logs; fail "the peer could not reach the phone"; }
ok "peer -> phone, the other way as well"

if [[ "$MODE" == "relay" ]]; then
  step "the relay really did the forwarding"
  FORWARDED=$(curl -s "http://$INET:3479/healthz" | sed -n 's/.*"forwarded":\([0-9]*\).*/\1/p')
  [[ "${FORWARDED:-0}" -gt 0 ]] || fail "the relay forwarded nothing, so the traffic went elsewhere"
  ok "relay forwarded $FORWARDED packet(s)"

  printf '\n\033[32mPASS: the mobile core reached a peer over the relay, with punching impossible on both sides\033[0m\n'
else
  step "nothing went through the relay"
  # A direct path has to be the one carrying traffic, not merely one that exists
  # beside a relayed one -- the relay costs somebody else's bandwidth.
  VIA=$(phone_field via)
  [[ "$VIA" != "relay" ]] || { dump_logs; fail "the phone settled on the relay despite a direct path"; }
  ok "the phone is on $VIA"

  printf '\n\033[32mPASS: the mobile core punched a direct path through two NATs to an ordinary client\033[0m\n'
fi
