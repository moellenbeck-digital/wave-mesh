#!/usr/bin/env bash
#
# One device in two waves at once. Two control servers that know nothing about
# each other, two enrolments on node A, two tunnels, two DNS zones -- and a peer
# in each wave that A can actually reach.
#
# The servers are given disjoint ranges: nothing makes two independent servers
# agree, and if they both numbered from the bottom the client would refuse the
# second wave rather than fight over a route. That refusal has its own unit test
# (apps/client/test/overlap.test.ts); this one is the case that should work.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

ONE="http://10.99.0.1:8080"
TWO="http://10.99.0.1:8081"

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
ip netns exec nodeb ping -c1 -W2 10.99.0.1 >/dev/null || fail "node B cannot reach the segment"
ip netns exec nodec ping -c1 -W2 10.99.0.1 >/dev/null || fail "node C cannot reach the segment"
ok "A 10.99.0.1, B 10.99.0.2, C 10.99.0.3"

step "two control servers, each with a range of its own"
WAVE_PORT=8080 WAVE_BASE_URL="$ONE" WAVE_HOST=0.0.0.0 WAVE_IPV4_CONTAINER=10.64.0.0/11 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-one.log" 2>&1 &
WAVE_PORT=8081 WAVE_BASE_URL="$TWO" WAVE_HOST=0.0.0.0 WAVE_IPV4_CONTAINER=10.96.0.0/11 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-two.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$ONE/healthz" >/dev/null || fail "server one did not start"
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$TWO/healthz" >/dev/null || fail "server two did not start"
ok "$ONE gives out 10.64.x, $TWO gives out 10.96.x"

step "a different account on each"
JAR="$WORK/cookies-one.txt" browser_login "$ONE" robin@example.com
JAR="$WORK/cookies-two.txt" browser_login "$TWO" someone-else@example.com
ok "robin@example.com on one, someone-else@example.com on the other"

# Both waves are joined the same way -- `wave login <url>` -- because a wave is
# its control server and nothing else. The daemon itself knows no server.
step "node A joins the first wave through the daemon"
JAR="$WORK/cookies-one.txt" start_node a "" wave0 "$ONE" daemon

step "node A joins the second wave as well"
JAR="$WORK/cookies-two.txt" join_wave a "$TWO"

# wave2 and wave3, not wave0: the namespaces share a mount namespace, and the
# WireGuard control sockets are named after the interface.
step "a peer in each wave"
JAR="$WORK/cookies-one.txt" start_node b nodeb wave2 "$ONE"
JAR="$WORK/cookies-two.txt" start_node c nodec wave3 "$TWO"

step "both tunnels are up on A at the same time"
A_ONE=$(tunnel_ip "" wave0)
A_TWO=$(tunnel_ip "" wave1)
[[ -n "$A_ONE" && -n "$A_TWO" ]] || fail "A does not have both interfaces: wave0=$A_ONE wave1=$A_TWO"
[[ "${A_ONE%%.*}.$(cut -d. -f2 <<<"$A_ONE")" != "${A_TWO%%.*}.$(cut -d. -f2 <<<"$A_TWO")" ]] \
  || fail "both waves handed out the same range: $A_ONE and $A_TWO"
ok "wave0 $A_ONE, wave1 $A_TWO — disjoint, as the two servers were told"

step "the CLI shows both"
CLI_STATUS=$(bun "$REPO/apps/client/src/cli.ts" status --daemon "$WORK/a.waved.sock" 2>&1) \
  || fail "the CLI could not reach the daemon: $CLI_STATUS"
grep -q "wave0" <<<"$CLI_STATUS" || fail "the daemon did not report wave0: $CLI_STATUS"
grep -q "wave1" <<<"$CLI_STATUS" || fail "the daemon did not report wave1: $CLI_STATUS"
ok "one status, two waves"

# Asked of the daemon, which is what actually holds the two tunnels.
PROFILES=$(bun "$REPO/apps/client/src/cli.ts" profiles --daemon "$WORK/a.waved.sock" 2>&1)
grep -q "$ONE" <<<"$PROFILES" || fail "wave profiles does not list the first enrolment: $PROFILES"
grep -q "$TWO" <<<"$PROFILES" || fail "wave profiles does not list the second enrolment: $PROFILES"
ok "$(tr '\n' ' ' <<<"$PROFILES")"

step "ping into both waves"
B_IP=$(tunnel_ip nodeb wave2)
C_IP=$(tunnel_ip nodec wave3)
dump_logs() { for f in "$WORK"/*.log; do echo "--- $f ---"; tail -20 "$f"; done; }
ping -c3 -W5 -I wave0 "$B_IP" >/dev/null || { dump_logs; fail "A could not reach B in the first wave"; }
ok "A -> B ($B_IP) over wave0"
ping -c3 -W5 -I wave1 "$C_IP" >/dev/null || { dump_logs; fail "A could not reach C in the second wave"; }
ok "A -> C ($C_IP) over wave1"

step "each wave answers for its own names, and only those"
B_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/b.log" | head -1)
C_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/c.log" | head -1)
[[ -n "$B_NAME" && -n "$C_NAME" ]] || fail "could not read the peer names from the logs"

RESOLVED=$(bun "$REPO/test/e2e/dnsquery.ts" "$A_ONE" "$B_NAME" 2>&1) \
  || { dump_logs; fail "the first wave's resolver did not answer for $B_NAME: $RESOLVED"; }
[[ "$RESOLVED" == "$B_IP" ]] || fail "$B_NAME resolved to $RESOLVED, expected $B_IP"
ok "$B_NAME -> $RESOLVED (via $A_ONE)"

RESOLVED=$(bun "$REPO/test/e2e/dnsquery.ts" "$A_TWO" "$C_NAME" 2>&1) \
  || { dump_logs; fail "the second wave's resolver did not answer for $C_NAME: $RESOLVED"; }
[[ "$RESOLVED" == "$C_IP" ]] || fail "$C_NAME resolved to $RESOLVED, expected $C_IP"
ok "$C_NAME -> $RESOLVED (via $A_TWO)"

# Each resolver serves one zone. Crossing over must not work, or a name would
# mean different things depending on which wave happened to answer first.
if bun "$REPO/test/e2e/dnsquery.ts" "$A_ONE" "$C_NAME" >/dev/null 2>&1; then
  fail "the first wave's resolver answered for a name in the second"
fi
ok "the first wave stays silent about the second's names"

printf '\n\033[32mPASS: one device in two waves at once — two tunnels, two zones, a peer reachable in each\033[0m\n'
