#!/usr/bin/env bash
#
# M7: a wave's policy, end to end. Three nodes on one LAN, a policy set over
# the API the way the browser sets it, and real TCP across real tunnels:
#
#   - who may see whom is the netmap's: a node the policy leaves out has no
#     peer to talk to at all;
#   - which ports and which direction is the receiving node's own nftables.
#
# No root required.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

command -v nft >/dev/null || fail "nft is needed: the port half of a policy is nftables on Linux"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

CONTROL="http://10.99.0.1:8080"
PROBE="$REPO/test/e2e/tcpprobe.ts"

step "three namespaces on one segment"
mount -t tmpfs tmpfs /run
mkdir -p /run/wireguard
ip link set lo up
ip link add br0 type bridge
ip addr add 10.99.0.1/24 dev br0
ip link set br0 up
for n in b c; do
  ip netns add "node$n"
  ip link add "veth-$n" type veth peer name eth0 netns "node$n"
  ip link set "veth-$n" master br0 up
  ip netns exec "node$n" ip link set lo up
  ip netns exec "node$n" ip link set eth0 up
done
ip netns exec nodeb ip addr add 10.99.0.2/24 dev eth0
ip netns exec nodec ip addr add 10.99.0.3/24 dev eth0
ip netns exec nodec ping -c1 -W2 10.99.0.2 >/dev/null || fail "the bridge does not carry"
ok "A 10.99.0.1, B 10.99.0.2, C 10.99.0.3"

step "control server"
WAVE_PORT=8080 WAVE_BASE_URL="$CONTROL" WAVE_HOST=0.0.0.0 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$CONTROL/healthz" >/dev/null || fail "control server did not start"
browser_login "$CONTROL"
ok "up at $CONTROL, signed in"

step "three nodes in one wave"
start_node a "" wave0 "$CONTROL"
start_node b nodeb wave1 "$CONTROL"
start_node c nodec wave2 "$CONTROL"
wait_for_line "$WORK/a.log" 'netmap v[0-9]+: 2 peer' "A to see both others"
A_IP=$(tunnel_ip "" wave0)
B_IP=$(tunnel_ip nodeb wave1)
C_IP=$(tunnel_ip nodec wave2)
ok "A $A_IP, B $B_IP, C $C_IP"

bun "$PROBE" listen "$A_IP" 8000 >"$WORK/listen-a.log" 2>&1 &
ip netns exec nodeb bun "$PROBE" listen "$B_IP" 8000 9000 >"$WORK/listen-b.log" 2>&1 &
wait_for_line "$WORK/listen-a.log" listening "A's listener"
wait_for_line "$WORK/listen-b.log" listening "B's listener"

# Waits for B's filter table to be there -- or gone. Asked of nft itself, not
# of the log: in this mode the log is a live view of the last few events, and
# a line that is followed quickly enough by four others is never drawn at all.
# That happened in CI on the first run of this test.
wait_for_table() { # <present|absent>
  for _ in $(seq 1 120); do
    if ip netns exec nodeb nft list table inet wave-acl-wave1 >/dev/null 2>&1; then
      [[ "$1" == present ]] && return 0
    else
      [[ "$1" == absent ]] && return 0
    fi
    sleep 0.5
  done
  # What B said about its filter, from every frame of its live view, and what
  # nft holds -- the two places the reason can be.
  echo "--- B on its filter ---"
  grep -a -o 'policy[^|]*enforced[^|]\{0,160\}\|no policy[^|]\{0,40\}' "$WORK/b.log" | sort -u || true
  echo "--- nft in B ---"
  ip netns exec nodeb nft list ruleset 2>&1 | head -30 || true
  fail "B's filter table is not $1"
}

reaches() { # <netns or ""> <ip> <port>
  local -a prefix=()
  [[ -n "$1" ]] && prefix=(ip netns exec "$1")
  "${prefix[@]}" bun "$PROBE" connect "$2" "$3" 4000
}

# A path is up once a ping gets through, not when the netmap arrives: the first
# packets still have to find it.
warm() { # <netns or ""> <ip>
  local -a prefix=()
  [[ -n "$1" ]] && prefix=(ip netns exec "$1")
  for _ in $(seq 1 20); do "${prefix[@]}" ping -c1 -W1 "$2" >/dev/null 2>&1 && return 0; done
  fail "no path from ${1:-A} to $2"
}
warm "" "$B_IP"
warm nodeb "$A_IP"
warm nodec "$A_IP"

step "without a policy, everything reaches everything"
reaches "" "$B_IP" 9000 || fail "A could not reach B:9000 before any policy"
reaches nodeb "$A_IP" 8000 || fail "B could not reach A:8000 before any policy"
ip netns exec nodec ping -c1 -W3 "$A_IP" >/dev/null || fail "C could not reach A before any policy"
ok "the full mesh of D9"

step "a policy: robin's devices may reach tag:server on tcp:8000, and nothing else"
WAVE_ID=$(curl -s -b "$JAR" "$CONTROL/api/me" | bun -e 'const me = await Bun.stdin.json(); console.log(me.waves[0].id)')
node_id() { # <tunnel ip>
  curl -s -b "$JAR" "$CONTROL/api/waves/$WAVE_ID/nodes" \
    | IP="$1" bun -e 'const r = await Bun.stdin.json(); console.log(r.nodes.find((n) => n.ipv4 === process.env.IP).id)'
}
api() { # <method> <path> <json>
  curl -s -o "$WORK/api.json" -w '%{http_code}' -b "$JAR" -X "$1" \
    -H 'content-type: application/json' --data "$3" "$CONTROL$2"
}
[[ $(api PUT "/api/waves/$WAVE_ID/nodes/$(node_id "$B_IP")/tags" '{"tags":["tag:server"]}') == 200 ]] \
  || fail "tagging B: $(cat "$WORK/api.json")"
[[ $(api PUT "/api/waves/$WAVE_ID/nodes/$(node_id "$C_IP")/tags" '{"tags":["tag:guest"]}') == 200 ]] \
  || fail "tagging C: $(cat "$WORK/api.json")"
POLICY='{"acls":[{"src":["user:robin@example.com"],"dst":["tag:server"],"ports":["tcp:8000"]}]}'
[[ $(api PUT "/api/waves/$WAVE_ID/acl" "$POLICY") == 200 ]] || fail "setting the policy: $(cat "$WORK/api.json")"
bun -e 'const r = await Bun.file(process.argv[1]).json(); for (const line of r.reach) console.log(line)' "$WORK/api.json"

wait_for_table present
wait_for_line "$WORK/c.log" 'netmap v[0-9]+: 0 peer' "C to lose every peer"
ok "pushed: B filters, C sees nobody"

step "what the grant allows"
reaches "" "$B_IP" 8000 || fail "A could not reach B:8000, which the policy grants"
ok "A -> B:8000"
ping -c1 -W3 -I wave0 "$B_IP" >/dev/null || fail "ICMP from A to B was dropped"
ok "A -> B ping (ICMP passes)"

step "what it does not"
reaches "" "$B_IP" 9000 && fail "A reached B:9000, which no rule names"
ok "A -> B:9000 dropped by B's nftables"
reaches nodeb "$A_IP" 8000 && fail "B opened a connection to A, but the grant runs the other way"
ok "B -> A:8000 dropped: a tagged device is not robin's, so the grant is one-way"
ip netns exec nodec ping -c1 -W3 "$A_IP" >/dev/null 2>&1 && fail "C reached A, though the policy gives C nobody"
ok "C -> A: no peer to send to at all"

step "removing the policy brings the mesh back"
[[ $(api DELETE "/api/waves/$WAVE_ID/acl" '{}') == 200 ]] || fail "removing the policy: $(cat "$WORK/api.json")"
wait_for_line "$WORK/c.log" 'netmap v[0-9]+: 2 peer' "C to see both others again"
wait_for_table absent
reaches nodeb "$A_IP" 8000 || fail "B could not reach A:8000 after the policy was removed"
reaches "" "$B_IP" 9000 || fail "A could not reach B:9000 after the policy was removed"
ok "B -> A:8000 and A -> B:9000 again"
ok "no filter table left behind"

printf '\n\033[32mPASS: a policy limited who sees whom through the netmap and which ports through nftables\033[0m\n'
