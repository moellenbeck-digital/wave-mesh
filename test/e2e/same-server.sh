#!/usr/bin/env bash
#
# One device in two waves at the same control server. One server, one account,
# two projects -- a wave each -- and node A in both: two enrolments, two
# tunnels, two DNS zones, a peer reachable in each, and the two kept apart in
# every command that names a wave.
#
# two-waves.sh is the other case, two servers. Here the server alone does not
# say which wave is meant, so the second enrolment is asked for explicitly
# (`wave login <url> --new-wave`) and the approval names the wave.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

ONE="http://10.99.0.1:8080"
CLI=(bun "$REPO/apps/client/src/cli.ts")
dump_logs() { for f in "$WORK"/*.log; do echo "--- $f ---"; tail -20 "$f"; done; }

step "three namespaces on one segment"
mount -t tmpfs tmpfs /run
mkdir -p /run/wireguard
ip link set lo up
for peer in nodeb nodec; do
  ip netns add "$peer"
  ip link add "veth-$peer" type veth peer name "veth-in-$peer"
  ip link set "veth-in-$peer" netns "$peer"
  ip link set "veth-$peer" up
  ip netns exec "$peer" ip link set lo up
  ip netns exec "$peer" ip link set "veth-in-$peer" up
done
ip link add br0 type bridge
ip link set br0 up
ip link set veth-nodeb master br0
ip link set veth-nodec master br0
ip addr add 10.99.0.1/24 dev br0
ip netns exec nodeb ip addr add 10.99.0.2/24 dev veth-in-nodeb
ip netns exec nodec ip addr add 10.99.0.3/24 dev veth-in-nodec
ok "A 10.99.0.1, B 10.99.0.2, C 10.99.0.3"

step "one control server, one account"
WAVE_PORT=8080 WAVE_BASE_URL="$ONE" WAVE_HOST=0.0.0.0 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$ONE/healthz" >/dev/null || fail "the server did not start"
browser_login "$ONE" robin@example.com
ok "robin@example.com with the wave robin.wave.internal"

# While robin has one wave, an approval needs no choice -- so the first wave's
# devices are in before the second exists.
step "node A and peer B in the first wave"
start_node a "" wave0 "$ONE" daemon
start_node b nodeb wave2 "$ONE"

step "a second wave at the same server"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -c "$JAR" -X POST "$ONE/waves" \
  --data-urlencode "name=project-b" --data-urlencode "suffix=project-b.wave.internal")
[[ "$code" == 303 ]] || fail "creating the second wave answered $code"
B_WAVE=$(curl -s -b "$JAR" "$ONE/api/me" | jq -r '.waves[] | select(.name == "project-b") | .id')
[[ -n "$B_WAVE" ]] || fail "the second wave is not listed"
ok "project-b ($B_WAVE)"

# With two waves the server asks which one; a browser sends it with the form.
approve_into() {
  local url="$1" wave="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" \
    --data-urlencode "request=${url##*request=}" --data-urlencode "wave=$wave" "${url%%\?*}")
  [[ "$code" == 2* || "$code" == 3* ]] || fail "approving into $wave answered $code"
}

step "node A joins the second wave as a new enrolment"
# Without --new-wave this would be the first wave again: the server is the
# same, and `wave login <url>` means the enrolment that is already there.
BEFORE=$(grep -c 'machine/authorize?request=' "$WORK/a.log" || true)
"${CLI[@]}" login "$ONE" --new-wave --daemon "$WORK/a.waved.sock" >"$WORK/a-second.log" 2>&1 &
for _ in $(seq 1 120); do
  [[ "$(grep -c 'machine/authorize?request=' "$WORK/a.log" || true)" -gt "$BEFORE" ]] && break
  sleep 0.5
done
URL=$(grep -o 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$WORK/a.log" | tail -1)
[[ -n "$URL" && "$(grep -c 'machine/authorize?request=' "$WORK/a.log")" -gt "$BEFORE" ]] \
  || { tail -25 "$WORK/a.log"; fail "A did not print a link for the second enrolment"; }
approve_into "$URL" "$B_WAVE"
# The daemon prefixes each tunnel's lines with its key: the server, and for a
# further enrolment there, the server plus a tag of its own.
wait_for_line "$WORK/a.log" "\\[$ONE#[0-9a-f]+\\].* up as " "A's tunnel in the second wave"
SECOND_KEY=$(grep -oE "\\[$ONE#[0-9a-f]+\\]" "$WORK/a.log" | head -1 | tr -d '[]')
ok "filed as $SECOND_KEY"

step "peer C in the second wave only"
log="$WORK/c.log"
WAVE_WIREGUARD_GO="$WG_BIN" ip netns exec nodec "${CLI[@]}" login "$ONE" \
  --state "$WORK/c/state.json" --interface wave3 --socket /run/wireguard/wave3.sock >"$log" 2>&1 &
wait_for_line "$log" 'machine/authorize\?request=' "C's connect link"
approve_into "$(grep -o 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$log" | head -1)" "$B_WAVE"
wait_for_line "$log" ' up as ' "C's tunnel"
ok "$(grep -o '[a-z0-9]* up as .*' "$log" | head -1)"

step "both tunnels are up on A, in ranges of their own"
A_ONE=$(tunnel_ip "" wave0)
A_TWO=$(tunnel_ip "" wave1)
[[ -n "$A_ONE" && -n "$A_TWO" ]] || fail "A does not have both interfaces: wave0=$A_ONE wave1=$A_TWO"
[[ "$A_ONE" != "$A_TWO" ]] || fail "both enrolments have the address $A_ONE"
ok "wave0 $A_ONE, wave1 $A_TWO"

step "wave profiles names each wave by its zone"
PROFILES=$("${CLI[@]}" profiles --daemon "$WORK/a.waved.sock" 2>&1)
grep -q "robin.wave.internal" <<<"$PROFILES" || fail "the first wave is not named: $PROFILES"
grep -q "project-b.wave.internal" <<<"$PROFILES" || fail "the second wave is not named: $PROFILES"
grep -qF "$SECOND_KEY" <<<"$PROFILES" || fail "the second wave's key is not shown: $PROFILES"
ok "$(tr '\n' ' ' <<<"$PROFILES")"

step "ping into both waves"
B_IP=$(tunnel_ip nodeb wave2)
C_IP=$(tunnel_ip nodec wave3)
ping -c3 -W5 -I wave0 "$B_IP" >/dev/null || { dump_logs; fail "A could not reach B in the first wave"; }
ok "A -> B ($B_IP) over wave0"
ping -c3 -W5 -I wave1 "$C_IP" >/dev/null || { dump_logs; fail "A could not reach C in the second wave"; }
ok "A -> C ($C_IP) over wave1"

# Same server, still two networks: B and C must not see each other.
if ip netns exec nodeb ping -c1 -W2 "$C_IP" >/dev/null 2>&1; then
  fail "B reached C across the two waves"
fi
ok "B cannot reach C -- one server, two separate networks"

step "each wave answers for its own names"
B_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/b.log" | head -1)
C_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/c.log" | head -1)
[[ "$B_NAME" == *.robin.wave.internal && "$C_NAME" == *.project-b.wave.internal ]] \
  || fail "unexpected names: $B_NAME and $C_NAME"
RESOLVED=$(bun "$REPO/test/e2e/dnsquery.ts" "$A_ONE" "$B_NAME" 2>&1) \
  || { dump_logs; fail "the first wave did not answer for $B_NAME: $RESOLVED"; }
[[ "$RESOLVED" == "$B_IP" ]] || fail "$B_NAME resolved to $RESOLVED, expected $B_IP"
ok "$B_NAME -> $RESOLVED"
RESOLVED=$(bun "$REPO/test/e2e/dnsquery.ts" "$A_TWO" "$C_NAME" 2>&1) \
  || { dump_logs; fail "the second wave did not answer for $C_NAME: $RESOLVED"; }
[[ "$RESOLVED" == "$C_IP" ]] || fail "$C_NAME resolved to $RESOLVED, expected $C_IP"
ok "$C_NAME -> $RESOLVED"

step "wave down names one wave and stops only that one"
# The server's address names the first enrolment there, exactly; the zone
# names the second. Neither may take the other with it.
"${CLI[@]}" down project-b.wave.internal --daemon "$WORK/a.waved.sock" >/dev/null 2>&1 \
  || fail "wave down project-b.wave.internal failed"
for _ in $(seq 1 40); do ip link show wave1 >/dev/null 2>&1 || break; sleep 0.25; done
ip link show wave1 >/dev/null 2>&1 && fail "wave1 is still there after wave down"
ping -c2 -W5 -I wave0 "$B_IP" >/dev/null || fail "taking the second wave down broke the first"
ok "second wave down, first still reaches B"

# `wave up` follows the daemon's status until Ctrl-C, so it runs alongside.
"${CLI[@]}" up project-b.wave.internal --daemon "$WORK/a.waved.sock" >"$WORK/a-up.log" 2>&1 &
UP_PID=$!
for _ in $(seq 1 60); do [[ -n "$(tunnel_ip "" wave1 2>/dev/null)" ]] && break; sleep 0.5; done
for _ in $(seq 1 20); do ping -c1 -W2 -I wave1 "$C_IP" >/dev/null 2>&1 && break; sleep 0.5; done
ping -c2 -W5 -I wave1 "$C_IP" >/dev/null || { dump_logs; fail "the second wave did not come back"; }
kill "$UP_PID" 2>/dev/null || true
grep -q 'machine/authorize' "$WORK/a-up.log" && fail "wave up asked for a new approval"
ok "back up without a new approval, C reachable"

step "leaving the second wave leaves the first alone"
"${CLI[@]}" logout "$SECOND_KEY" --daemon "$WORK/a.waved.sock" >/dev/null 2>&1 \
  || fail "wave logout $SECOND_KEY failed"
PROFILES=$("${CLI[@]}" profiles --daemon "$WORK/a.waved.sock" 2>&1)
grep -q "project-b.wave.internal" <<<"$PROFILES" && fail "the second wave is still listed: $PROFILES"
grep -q "robin.wave.internal" <<<"$PROFILES" || fail "the first wave went too: $PROFILES"
IN_B=$(curl -s -b "$JAR" "$ONE/api/waves/$B_WAVE/nodes" | jq '[.nodes[]] | length')
[[ "$IN_B" == "1" ]] || fail "the second wave still has $IN_B devices, expected C alone"
ping -c2 -W5 -I wave0 "$B_IP" >/dev/null || fail "leaving the second wave broke the first"
ok "left project-b on the server too; robin's wave untouched"

printf '\n\033[32mPASS: one device in two waves at one server — two enrolments, two zones, kept apart\033[0m\n'
