#!/usr/bin/env bash
#
# M2: two nodes on one LAN enrol with a real control server, configure real
# WireGuard and ping each other over the tunnel. No root required.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

CONTROL="http://10.99.0.1:8080"

step "two namespaces on one segment"
mount -t tmpfs tmpfs /run
mkdir -p /run/wireguard
ip link set lo up
ip netns add nodeb
ip link add veth-a type veth peer name veth-b
ip link set veth-b netns nodeb
ip addr add 10.99.0.1/24 dev veth-a
ip link set veth-a up
ip netns exec nodeb ip addr add 10.99.0.2/24 dev veth-b
ip netns exec nodeb ip link set veth-b up
ip netns exec nodeb ip link set lo up
ip netns exec nodeb ping -c1 -W2 10.99.0.1 >/dev/null || fail "veth link is down"
ok "node A 10.99.0.1 <-> node B 10.99.0.2"

step "control server"
WAVE_PORT=8080 WAVE_BASE_URL="$CONTROL" WAVE_HOST=0.0.0.0 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$CONTROL/healthz" >/dev/null || fail "control server did not start"
ok "up at $CONTROL"

step "browser login"
browser_login "$CONTROL"
ok "signed in"

step "enrol node A (through the privileged daemon)"
start_node a "" wave0 "$CONTROL" daemon

step "enrol node B"
start_node b nodeb wave1 "$CONTROL"

step "the unprivileged CLI can talk to the daemon"
CLI_STATUS=$(bun "$REPO/apps/client/src/cli.ts" status --daemon "$WORK/a.waved.sock" 2>&1) \
  || fail "the CLI could not reach the daemon: $CLI_STATUS"
grep -q "wave0" <<<"$CLI_STATUS" || fail "the daemon reported no interface: $CLI_STATUS"
ok "status over the control socket, without touching the tunnel itself"

step "node A learns about B without being asked"
# No polling and no restart: the control server pushes the new netmap.
wait_for_line "$WORK/a.log" 'netmap v[0-9]+: 1 peer' "A to be told about B"
ok "netmap pushed over the control socket"

step "ping over the tunnel"
A_IP=$(tunnel_ip "" wave0)
B_IP=$(tunnel_ip nodeb wave1)
dump_logs() { for f in "$WORK"/a.log "$WORK"/b.log; do echo "--- $f ---"; tail -25 "$f"; done; }
ping -c3 -W5 -I wave0 "$B_IP" >/dev/null || { dump_logs; fail "A could not reach B over the tunnel"; }
ok "A ($A_IP) -> B ($B_IP)"
ip netns exec nodeb ping -c3 -W5 -I wave1 "$A_IP" >/dev/null || fail "B could not reach A over the tunnel"
ok "B ($B_IP) -> A ($A_IP)"

step "the wave's own names resolve"
# systemd-resolved is not running in this sandbox, so ask the node's resolver
# directly -- what it answers is what the system would be given.
A_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/a.log" | head -1)
B_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/b.log" | head -1)
[[ -n "$A_NAME" && -n "$B_NAME" ]] || fail "could not read the node names from the logs"

if ! RESOLVED=$(bun "$REPO/test/e2e/dnsquery.ts" "$A_IP" "$B_NAME" 2>&1); then
  grep -iE "resolv|dns" "$WORK/a.log" | tail -5
  fail "asking $A_IP for $B_NAME failed: $RESOLVED"
fi
[[ "$RESOLVED" == "$B_IP" ]] || fail "$B_NAME resolved to $RESOLVED, expected $B_IP"
ok "$B_NAME -> $RESOLVED"

if ! SELF=$(bun "$REPO/test/e2e/dnsquery.ts" "$A_IP" "$A_NAME" 2>&1); then
  fail "the node cannot resolve its own name: $SELF"
fi
ok "$A_NAME -> $SELF"

if bun "$REPO/test/e2e/dnsquery.ts" "$A_IP" "www.example.com" >/dev/null 2>&1; then
  fail "the resolver answered for a name outside the wave"
fi
ok "stays silent for names outside the wave"

printf '\n\033[32mPASS: two nodes enrolled, pinged each other over the tunnel and resolved the wave names\033[0m\n'
