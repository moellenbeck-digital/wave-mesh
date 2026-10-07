#!/usr/bin/env bash
#
# The phone and a cluster's services: the Go core in two waves, and in the
# second a connector exposing services exactly as a cluster does (D11).
#
# Built after a phone in two waves could not open the services of one of them
# while a desktop in the same wave could. Everything a service needs on the way
# is real here: the operator's signed registration, the server putting the
# service addresses on the connector, the connector's own nftables ruleset
# (DNAT to an IPv4-only backend, IPv6 refused -- as on the cluster), the core's
# routes, its resolver and its packet filter. Checked over IPv4 and IPv6, with
# a large answer, directly and through the relay, and next to a device reached
# by name in the other wave.
#
# What it cannot cover is iOS itself -- Safari, its resolver, Happy Eyeballs.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

command -v go >/dev/null || fail "no go toolchain on PATH; the core is Go (see mobile/README.md)"

# --harness <file>: run against a prebuilt core instead -- an older build, to
# show whether something a phone in the field sees is fixed since.
HARNESS=""
if [[ "${1:-}" == "--harness" ]]; then HARNESS="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; fi

WORK="$(mktemp -d)"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

ONE="http://10.99.0.1:8080"   # a plain wave, devices only -- the tester's own server
TWO="http://10.99.0.1:8081"   # the wave with a cluster behind a connector
PHONE_LOG="$WORK/phone.log"
STATUS="$WORK/phone-status.json"
RELAYS='[{"id":"t","region":"test","url":"ws://10.99.0.1:3479/relay","stun":{"ip":"10.99.0.1","port":3478}}]'
BACKEND="10.43.0.80"           # the internal ingress's ClusterIP, IPv4 only

dump_logs() {
  for f in "$WORK"/*.log; do echo "--- $f ---"; grep -v "socket error" "$f" | tail -25 || true; done
  echo "--- wave0 ---"; ip -o addr show dev wave0; ip route show dev wave0; ip -6 route show dev wave0
}

wait_for_wave() {
  local control="$1" what="$2"
  for _ in $(seq 1 120); do
    if [[ -s "$STATUS" ]] && bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" ipv4 "$control" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  tail -40 "$PHONE_LOG"
  fail "timed out waiting for $what"
}

approve_link() {
  local jar="$1" want="$2" what="$3" url="" seen
  for _ in $(seq 1 120); do
    seen="$(grep -c 'machine/authorize?request=' "$PHONE_LOG" 2>/dev/null || true)"
    if [[ "${seen:-0}" -ge "$want" ]]; then
      url=$(grep -o 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$PHONE_LOG" | tail -1)
      break
    fi
    sleep 0.5
  done
  [[ -n "$url" ]] || { tail -40 "$PHONE_LOG"; fail "the phone did not print a link for $what"; }
  approve_device "$jar" "$url"
}

# What the phone asks its own resolver -- the one iOS is pointed at.
resolve() { bun "$REPO/test/e2e/dnsquery.ts" "$RESOLVER" "$1" "${2:-A}" 2>/dev/null; }

# An HTTP request from the phone, by name, to the address given -- the Host
# header is what the backend routes on, as an ingress does.
fetch() {
  local name="$1" address="$2" path="${3:-/}" port="${4:-80}" seconds="${5:-10}"
  local target="$address"
  [[ "$address" == *:* ]] && target="[$address]"
  curl -sS -m "$seconds" --resolve "$name:$port:$address" "http://$name:$port$path" \
    -w '\n%{http_code} %{size_download} %{time_total}' -o "$WORK/body" >"$WORK/meta" 2>"$WORK/curl.err" || true
  tail -1 "$WORK/meta"
}

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
ok "phone 10.99.0.1, connector B 10.99.0.2, device C 10.99.0.3"

step "build the harness"
if [[ -n "$HARNESS" ]]; then
  cp "$HARNESS" "$WORK/wave-harness"
  ok "using the prebuilt core $HARNESS"
else
  ( cd "$REPO/mobile/core" && go build -o "$WORK/wave-harness" ./cmd/wave-harness ) \
    || fail "the harness did not build"
  ok "built"
fi

step "a relay, and two control servers with ranges of their own"
WAVE_STUN_PORT=3478 WAVE_RELAY_PORT=3479 bun "$REPO/apps/relay/src/index.ts" >"$WORK/relay.log" 2>&1 &
WAVE_PORT=8080 WAVE_BASE_URL="$ONE" WAVE_HOST=0.0.0.0 WAVE_IPV4_CONTAINER=10.64.0.0/11 WAVE_RELAYS="$RELAYS" \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-one.log" 2>&1 &
WAVE_PORT=8081 WAVE_BASE_URL="$TWO" WAVE_HOST=0.0.0.0 WAVE_IPV4_CONTAINER=10.160.0.0/11 WAVE_RELAYS="$RELAYS" \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-two.log" 2>&1 &
curl -s --retry 20 --retry-all-errors --retry-delay 1 "http://10.99.0.1:3479/healthz" >/dev/null || fail "the relay did not start"
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$ONE/healthz" >/dev/null || fail "server one did not start"
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$TWO/healthz" >/dev/null || fail "server two did not start"
JAR="$WORK/cookies-one.txt" browser_login "$ONE" robin@example.com
JAR="$WORK/cookies-two.txt" browser_login "$TWO" ops@example.com
ok "$ONE (robin.wave.internal), $TWO (ops.wave.internal), relay on 3479"

step "the phone joins the plain wave, then the one with the cluster"
"$WORK/wave-harness" --dev wave0 --state "$WORK/phone-state.json" \
  --control "$ONE" --control "$TWO" --status "$STATUS" >"$PHONE_LOG" 2>&1 &
approve_link "$WORK/cookies-one.txt" 1 "$ONE"
wait_for_wave "$ONE" "the phone's first wave"
approve_link "$WORK/cookies-two.txt" 2 "$TWO"
wait_for_wave "$TWO" "the phone's second wave"
RESOLVER=$(bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" resolver "$TWO" 2>/dev/null || true)
[[ -n "$RESOLVER" ]] || { tail -30 "$PHONE_LOG"; fail "the status names no resolver for the second wave"; }
ok "in both; the resolver for the cluster's wave is $RESOLVER"

step "a device in the plain wave, serving on a port"
JAR="$WORK/cookies-one.txt" start_node c nodec wave3 "$ONE"
C_IP=$(tunnel_ip nodec wave3)
C_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/c.log" | head -1)
ip netns exec nodec bun "$REPO/test/e2e/httpbackend.ts" "$C_IP" 8080 >"$WORK/c-http.log" 2>&1 &
ok "$C_NAME ($C_IP) on port 8080"

step "the connector joins the cluster's wave and the operator registers two services"
JAR="$WORK/cookies-two.txt" start_node b nodeb wave2 "$TWO"
B_V4=$(tunnel_ip nodeb wave2)
B_V6=$(ip netns exec nodeb ip -6 -o addr show dev wave2 scope global | awk '{print $4}' | cut -d/ -f1 | head -1)
GRAFANA="grafana.ops.wave.internal"
ARGOCD="argocd.ops.wave.internal"
ip netns exec nodeb bun "$REPO/test/e2e/register-services.ts" "$WORK/b/state.json" "$TWO" "$GRAFANA" "$ARGOCD" \
  >"$WORK/services.txt" 2>&1 || { cat "$WORK/services.txt"; fail "the server did not take the services"; }
LINE=$(grep "^${GRAFANA%%.*} " "$WORK/services.txt" || true)
G_V4=$(awk '{print $2}' <<<"$LINE")
G_V6=$(awk '{print $3}' <<<"$LINE")
[[ -n "$G_V4" && -n "$G_V6" ]] || { cat "$WORK/services.txt"; fail "grafana got no addresses"; }
ok "$GRAFANA at $G_V4 and $G_V6"

# The server puts the service addresses on the connector's own interface;
# its daemon assigns them with the next netmap.
for _ in $(seq 1 60); do
  ip netns exec nodeb ip -o addr show dev wave2 | grep -q " $G_V4/" && break
  sleep 0.5
done
ip netns exec nodeb ip -o addr show dev wave2 | grep -q " $G_V4/" \
  || { dump_logs; fail "the connector never got the service address $G_V4"; }

# The cluster side: an ingress with an IPv4 ClusterIP and nothing on IPv6, and
# the connector's production ruleset in front of it.
ip netns exec nodeb ip link add ingress type dummy
ip netns exec nodeb ip addr add "$BACKEND/32" dev ingress
ip netns exec nodeb ip link set ingress up
ip netns exec nodeb bun "$REPO/test/e2e/httpbackend.ts" "$BACKEND" 80 >"$WORK/backend.log" 2>&1 &
bun "$REPO/test/e2e/connector-rules.ts" wave2 "$B_V4" "$B_V6" "$BACKEND" >"$WORK/connector.nft"
ip netns exec nodeb nft -f "$WORK/connector.nft" 2>"$WORK/nft.err" \
  || { cat "$WORK/connector.nft" "$WORK/nft.err"; fail "the connector's ruleset does not load"; }
ok "connector $B_V4 forwards 80/443 to $BACKEND; IPv6 has no backend, as on the cluster"

step "the phone sees the services"
for _ in $(seq 1 60); do [[ "$(resolve "$GRAFANA")" == "$G_V4" ]] && break; sleep 0.5; done
[[ "$(resolve "$GRAFANA")" == "$G_V4" ]] || { dump_logs; fail "the phone's resolver does not answer $GRAFANA with $G_V4"; }
AAAA_ANSWER=$(bun "$REPO/test/e2e/dnsquery.ts" "$RESOLVER" "$GRAFANA" AAAA 2>&1 || true)
# Compared in canonical form: the query prints every group, the server compresses.
canon6() { bun -e 'console.log(new URL(`http://[${process.argv[1]}]`).hostname)' "$1" 2>/dev/null || echo "$1"; }
[[ "$(canon6 "$AAAA_ANSWER")" == "$(canon6 "$G_V6")" ]] || fail "the phone's resolver answers AAAA for $GRAFANA with '$AAAA_ANSWER', expected $G_V6"
ip route get "$G_V4" | grep -q "dev wave0" || fail "$G_V4 is not routed into the tunnel"
ip -6 route get "$G_V6" | grep -q "dev wave0" || fail "$G_V6 is not routed into the tunnel"
if [[ -z "$HARNESS" ]]; then
  grep -q "zone ops.wave.internal: .*resolver $RESOLVER (reserved), .*, 2 services" "$PHONE_LOG" \
    || fail "the summary line does not name the resolver and count the two services"
fi
ok "$GRAFANA -> $G_V4 / $G_V6, both routed into wave0"

step "over IPv4: a page and a large answer"
RESULT=$(fetch "$GRAFANA" "$G_V4")
[[ "$RESULT" == 200* ]] && grep -q "hello from $GRAFANA" "$WORK/body" \
  || { cat "$WORK/curl.err"; dump_logs; fail "the phone could not open $GRAFANA over IPv4: $RESULT"; }
ok "$GRAFANA over IPv4: $RESULT"
RESULT=$(fetch "$GRAFANA" "$G_V4" /big 80 30)
[[ "$RESULT" == "200 3145728 "* ]] || { cat "$WORK/curl.err"; dump_logs; fail "3 MB from $GRAFANA did not arrive whole: $RESULT"; }
ok "3 MB over IPv4: $RESULT"

step "while the netmap keeps changing"
# A wave with a cluster in it is never still: its nodes sit behind SNAT and
# publish new candidates, services come and go, and every change is a netmap
# pushed to every device. A core that rebuilt its WireGuard peers on each one
# dropped every session each time -- invisible on a quiet wave, constant on a
# busy one. Here the set of services changes twice a second while the phone
# keeps opening pages and pulling large answers.
(
  for i in $(seq 1 40); do
    if (( i % 2 )); then extra="extra$i.ops.wave.internal"; else extra=""; fi
    ip netns exec nodeb bun "$REPO/test/e2e/register-services.ts" "$WORK/b/state.json" "$TWO" \
      "$GRAFANA" "$ARGOCD" $extra >/dev/null 2>&1 || true
    sleep 0.5
  done
) &
CHURN=$!
FAILED=0
TRIES=0
while kill -0 "$CHURN" 2>/dev/null; do
  TRIES=$((TRIES + 1))
  RESULT=$(fetch "$GRAFANA" "$G_V4" / 80 5)
  [[ "$RESULT" == 200* ]] || { FAILED=$((FAILED + 1)); echo "    page $TRIES: $RESULT $(tr -d '\n' <"$WORK/curl.err" | cut -c1-60)"; }
  if (( TRIES % 4 == 0 )); then
    RESULT=$(fetch "$GRAFANA" "$G_V4" /big 80 15)
    [[ "$RESULT" == "200 3145728 "* ]] || { FAILED=$((FAILED + 1)); echo "    3 MB $TRIES: $RESULT $(tr -d '\n' <"$WORK/curl.err" | cut -c1-60)"; }
  fi
  sleep 0.3
done
(( FAILED == 0 )) || { tail -20 "$PHONE_LOG"; fail "$FAILED requests failed while the netmap changed 40 times"; }
ok "$TRIES rounds of pages and large answers, none lost, across 40 netmap changes"

step "over IPv6, where the cluster has no backend"
# The connector refuses; what matters is that it says so at once. A client
# that prefers IPv6 -- Safari does -- falls back to IPv4 only after an answer
# or a timeout, and a timeout is a page that hangs.
RESULT=$(fetch "$GRAFANA" "$G_V6" / 80 8)
SECONDS_TAKEN=$(awk '{print $3}' <<<"$RESULT")
[[ "$RESULT" == 000* ]] || fail "IPv6 to $GRAFANA answered ($RESULT); the connector has no IPv6 backend to answer with"
awk -v t="${SECONDS_TAKEN:-99}" 'BEGIN { exit !(t < 2) }' \
  || { cat "$WORK/curl.err"; fail "IPv6 to $GRAFANA was not refused at once ($RESULT): a phone preferring IPv6 would hang"; }
echo "    curl: $(tr -d '\n' <"$WORK/curl.err")"
# Reached the connector at all? It holds the address, so it answers a ping.
ping -6 -c2 -W3 "$G_V6" >"$WORK/ping6.txt" 2>&1 && echo "    ping6 $G_V6: answered" || { echo "    ping6 $G_V6: $(tail -2 "$WORK/ping6.txt" | tr '\n' ' ')"; }
ip -6 route get "$G_V6" | sed 's/^/    route: /'
ip -6 -o addr show dev wave0 | sed 's/^/    addr: /'
ok "IPv6 refused at once"
# Both addresses, the way a browser gets them: IPv6 first, then IPv4.
curl -s -m 10 --resolve "$GRAFANA:80:[$G_V6],$G_V4" "http://$GRAFANA/" -o "$WORK/body" \
  -w '%{http_code} %{time_total} %{remote_ip}' >"$WORK/meta" 2>/dev/null || true
grep -q "^200 " "$WORK/meta" || fail "with both addresses, $GRAFANA did not open: $(cat "$WORK/meta")"
ok "with both addresses the page opens: $(cat "$WORK/meta")"

step "a device in the other wave, by name"
[[ "$(resolve "$C_NAME")" == "$C_IP" ]] || fail "$C_NAME does not resolve to $C_IP on the phone"
RESULT=$(fetch "$C_NAME" "$C_IP" / 8080)
[[ "$RESULT" == 200* ]] || { cat "$WORK/curl.err"; dump_logs; fail "the phone could not open $C_NAME:8080: $RESULT"; }
ok "$C_NAME:8080 -> $RESULT"

step "the connector only through the relay"
# As on the cluster, where the connector sits behind NAT and a desktop reaches
# it through the relay. UDP between phone and connector is dropped; STUN and
# the relay (TCP) still pass.
ip netns exec nodeb nft -f - <<'NFT'
table inet block-direct {
  chain input  { type filter hook input priority -10; policy accept; ip saddr 10.99.0.1 udp sport != 3478 drop; }
  chain output { type filter hook output priority -10; policy accept; ip daddr 10.99.0.1 udp dport != 3478 drop; }
}
NFT
# The connector's path, from the phone's own status -- not a log line, which
# an earlier moment of the run could have written.
VIA=""
for _ in $(seq 1 120); do
  VIA=$(bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" via "$TWO" 2>/dev/null || true)
  [[ "$VIA" == relay* ]] && break
  sleep 0.5
done
[[ "$VIA" == relay* ]] || { dump_logs; fail "the phone did not fall back to the relay for the connector (path: ${VIA:-none})"; }
ok "the phone reaches the connector through the relay now ($VIA)"
for _ in $(seq 1 30); do [[ "$(fetch "$GRAFANA" "$G_V4" / 80 5)" == 200* ]] && break; sleep 1; done
RESULT=$(fetch "$GRAFANA" "$G_V4")
[[ "$RESULT" == 200* ]] || { cat "$WORK/curl.err"; dump_logs; fail "$GRAFANA did not open through the relay: $RESULT"; }
VIA=$(bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" via "$TWO" 2>/dev/null || true)
[[ "$VIA" == relay* ]] || fail "the path left the relay during the fetch ($VIA)"
ok "$GRAFANA through the relay: $RESULT"
RESULT=$(fetch "$GRAFANA" "$G_V4" /big 80 60)
[[ "$RESULT" == "200 3145728 "* ]] || { cat "$WORK/curl.err"; dump_logs; fail "3 MB did not arrive whole through the relay: $RESULT"; }
ok "3 MB through the relay: $RESULT"
RESULT=$(fetch "$C_NAME" "$C_IP" / 8080)
[[ "$RESULT" == 200* ]] || fail "the other wave's device stopped answering: $RESULT"
ok "and the other wave is untouched: $C_NAME:8080 -> $RESULT"

step "with an access policy, as a real wave has"
# A policy gives the phone a packet filter of its own, and the core enforces it
# itself -- the desktop does that with nftables. Here the phone may reach the
# services and nothing may reach the phone: every answer from the cluster has
# to get in as the reply to a connection the phone opened.
PHONE_TWO=$(bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" ipv4 "$TWO")
bun "$REPO/test/e2e/tcpprobe.ts" listen "$PHONE_TWO" 7000 >"$WORK/probe.log" 2>&1 &
sleep 1
ip netns exec nodeb bun "$REPO/test/e2e/tcpprobe.ts" connect "$PHONE_TWO" 7000 3000 >/dev/null 2>&1 \
  || fail "before the policy the connector could not reach the phone at $PHONE_TWO:7000 -- the check below would prove nothing"
TWO_ID=$(curl -s -b "$WORK/cookies-two.txt" "$TWO/api/me" | bun -e 'const me = await Bun.stdin.json(); console.log(me.waves[0].id)')
POLICY='{"acls":[{"src":["user:ops@example.com"],"dst":["svc:*"]}]}'
code=$(curl -s -o "$WORK/api.json" -w '%{http_code}' -b "$WORK/cookies-two.txt" -X PUT \
  -H 'content-type: application/json' --data "$POLICY" "$TWO/api/waves/$TWO_ID/acl")
[[ "$code" == 200 ]] || fail "setting the policy answered $code: $(cat "$WORK/api.json")"
# The filter is in force when the connector can no longer open a connection
# to the phone -- before the policy it could.
FILTERED=""
for _ in $(seq 1 40); do
  if ! ip netns exec nodeb bun "$REPO/test/e2e/tcpprobe.ts" connect "$PHONE_TWO" 7000 1000 >/dev/null 2>&1; then
    FILTERED=yes; break
  fi
  sleep 0.5
done
[[ -n "$FILTERED" ]] || fail "the phone's packet filter never took effect: the connector still reaches $PHONE_TWO:7000"
ok "the phone's filter is in force: the connector can no longer reach $PHONE_TWO:7000"
RESULT=$(fetch "$GRAFANA" "$G_V4")
[[ "$RESULT" == 200* ]] || { cat "$WORK/curl.err"; dump_logs; fail "with a policy, the phone could not open $GRAFANA: $RESULT"; }
ok "with the policy, $GRAFANA through the relay: $RESULT"
RESULT=$(fetch "$GRAFANA" "$G_V4" /big 80 60)
[[ "$RESULT" == "200 3145728 "* ]] || { cat "$WORK/curl.err"; dump_logs; fail "with a policy, 3 MB did not arrive whole: $RESULT"; }
ok "with the policy, 3 MB: $RESULT"
RESULT=$(fetch "$C_NAME" "$C_IP" / 8080)
[[ "$RESULT" == 200* ]] || fail "the policy in one wave broke the other: $RESULT"
ok "the other wave, which has no policy, untouched: $RESULT"

printf '\n\033[32mPASS: a phone in two waves opens a cluster'"'"'s services over IPv4, gets IPv6 refused at once, and keeps both through the relay\033[0m\n'
