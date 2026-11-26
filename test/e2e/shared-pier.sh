#!/usr/bin/env bash
#
# The shared pier: one pier for every wave of a server that has none of its
# own. A pier node in a hosting wave of its own, two devices in two other
# waves, each putting a name out under its wave's random zone -- and from the
# open network, each name reaches its own device through the one pier.
#
# Held to: the pier is a peer of the devices without being in their waves, it
# routes by SNI to the right one, it reaches only the claimed port (the filter
# the device holds), the two waves still cannot see each other, and a name
# taken back is no longer served.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

WORK="$(mktemp -d)"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

BASE="http://10.99.0.1:8080"
DOMAIN="wavepier.test"
PIER_PUBLIC="10.99.0.4"
CLI=(bun "$REPO/apps/client/src/cli.ts")
dump_logs() { for f in "$WORK"/*.log; do echo "--- $f ---"; tail -25 "$f"; done; }

step "four places on one segment: the server, the pier and two devices"
mount -t tmpfs tmpfs /run
mkdir -p /run/wireguard
ip link set lo up
ip link add br0 type bridge
ip link set br0 up
ip addr add 10.99.0.1/24 dev br0
for entry in nodea:2 nodeb:3 pier:4; do
  ns="${entry%%:*}"
  ip netns add "$ns"
  ip link add "veth-$ns" type veth peer name "veth-in-$ns"
  ip link set "veth-in-$ns" netns "$ns"
  ip link set "veth-$ns" master br0
  ip link set "veth-$ns" up
  ip netns exec "$ns" ip link set lo up
  ip netns exec "$ns" ip link set "veth-in-$ns" up
  ip netns exec "$ns" ip addr add "10.99.0.${entry##*:}/24" dev "veth-in-$ns"
done
ok "server 10.99.0.1, A 10.99.0.2, B 10.99.0.3, pier $PIER_PUBLIC"

step "a control server with a shared pier domain"
WAVE_PORT=8080 WAVE_BASE_URL="$BASE" WAVE_HOST=0.0.0.0 \
  WAVE_SHARED_PIER_DOMAIN="$DOMAIN" WAVE_SHARED_PIER_DNS_PROVIDER=cloudflare WAVE_SHARED_PIER_DNS_TOKEN=e2e \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$BASE/healthz" >/dev/null || fail "the server did not start"
ok "$DOMAIN"

wave_id() { curl -s -b "$JAR" "$BASE/api/me" | jq -r '.waves[0].id'; }

# A daemon per namespace, each with a /run/wireguard of its own: wireguard-go
# puts its UAPI socket there by interface name, every daemon calls its first
# tunnel wave0, and a daemon that finds a ready socket takes the device behind
# it -- another namespace's. lib.sh's start_node runs one daemon per test.
start_daemon_node() {
  local name="$1" netns="$2"
  local log="$WORK/$name.log"
  ip netns exec "$netns" unshare -m --propagation private sh -c '
    mount -t tmpfs tmpfs /run/wireguard &&
    exec env WAVE_WIREGUARD_GO="$1" bun "$2/apps/client/src/cli.ts" daemon --state "$3/state.json" \
      --daemon "$4" --group "" --wg-socket /run/wireguard/wave0.sock' \
    sh "$WG_BIN" "$REPO" "$WORK/$name" "$WORK/$name.waved.sock" >"$log" 2>&1 &
  wait_for_line "$log" 'daemon listening on' "$name's daemon socket"
  ip netns exec "$netns" "${CLI[@]}" login "$BASE" --daemon "$WORK/$name.waved.sock" >"$WORK/$name-login.log" 2>&1 &
  wait_for_line "$log" 'machine/authorize\?request=' "$name to print its connect link"
  approve_device "$JAR" "$(grep -o 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$log" | head -1)"
  wait_for_line "$log" ' up as ' "$name's tunnel"
  ok "$(grep -o '[a-z0-9]* up as .*' "$log" | head -1)"
}

step "the hosting wave and its pier"
JAR="$WORK/ops.txt"
browser_login "$BASE" ops@example.com
OPS_WAVE=$(wave_id)
start_daemon_node pier pier
PIER_HOST=$(curl -s -b "$JAR" "$BASE/api/waves/$OPS_WAVE/nodes" | jq -r '.nodes[0].hostname')
code=$(curl -s -o "$WORK/shared.json" -w '%{http_code}' -X POST \
  "$BASE/__e2e/shared-pier?wave=$OPS_WAVE&node=$PIER_HOST&ipv4=$PIER_PUBLIC")
[[ "$code" == 200 ]] || fail "making the shared pier answered $code: $(cat "$WORK/shared.json")"
ip netns exec pier env WAVE_SOCKET="$WORK/pier.waved.sock" WAVE_PIER_HOST="$PIER_PUBLIC" WAVE_PIER_PORT=8443 \
  bun "$REPO/apps/pier/src/main.ts" >"$WORK/pier-proxy.log" 2>&1 &
wait_for_line "$WORK/pier-proxy.log" "$PIER_PUBLIC" "the pier to listen"
ok "pier at $PIER_PUBLIC:8443"

# One device per wave, each with its own owner. The owner opens the first lock
# in the browser -- the API the device list uses -- and the device claims a name.
put_out() {
  local name="$1" netns="$2" iface="$3" email="$4" body="$5"
  JAR="$WORK/$name.txt"
  browser_login "$BASE" "$email"
  local wave node code
  wave=$(wave_id)
  start_daemon_node "$name" "$netns"
  node=$(curl -s -b "$JAR" "$BASE/api/waves/$wave/nodes" | jq -r '.nodes[0].id')
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$JAR" -X PUT -H 'content-type: application/json' \
    --data '{"allowed":true}' "$BASE/api/waves/$wave/nodes/$node/pier")
  [[ "$code" == 200 ]] || fail "allowing the pier for $name answered $code"

  ip netns exec "$netns" "${CLI[@]}" expose app http://127.0.0.1:3000 --listen-port 8443 \
    --daemon "$WORK/$name.waved.sock" >"$WORK/$name-expose.log" 2>&1 || true
  local fqdn
  fqdn=$(grep -oE "app\.[a-z][a-z0-9]{7}\.$DOMAIN" "$WORK/$name-expose.log" | head -1)
  [[ -n "$fqdn" ]] || { cat "$WORK/$name-expose.log"; fail "$name did not get a name under $DOMAIN"; }

  # The device's own service, terminating TLS with its own certificate. Not
  # through `wave expose`'s listener: that waits for a CA, which a test does
  # not have -- the pier moves bytes either way.
  local ip
  ip=$(tunnel_ip "$netns" "$iface")
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 1 -subj "/CN=$fqdn" \
    -addext "subjectAltName=DNS:$fqdn" -keyout "$WORK/$name.key" -out "$WORK/$name.crt" 2>/dev/null
  ip netns exec "$netns" bun "$REPO/test/e2e/tlsbackend.ts" "$ip" 8443 "$WORK/$name.crt" "$WORK/$name.key" "$body" \
    >"$WORK/$name-backend.log" 2>&1 &
  wait_for_line "$WORK/$name-backend.log" "tls backend on" "$name's service"
  eval "${name^^}_NAME=$fqdn ${name^^}_IP=$ip"
  ok "$name put out $fqdn -> $ip:8443"
}

step "device A in the wave of robin"
put_out a nodea wave0 robin@example.com alpha
step "device B in the wave of kim"
put_out b nodeb wave0 kim@example.com beta
[[ "${A_NAME#app.}" != "${B_NAME#app.}" ]] || fail "both waves got the zone ${A_NAME#app.}"
ok "two waves, two zones"

step "each zone's wildcard points at the pier"
DNS=$(curl -s -X POST "$BASE/__e2e/dns")
for zone in "${A_NAME#app.}" "${B_NAME#app.}"; do
  jq -e --arg n "*.$zone" --arg v "$PIER_PUBLIC" '.records[] | select(.name == $n and .type == "A" and .content == $v)' \
    <<<"$DNS" >/dev/null || fail "no A record *.$zone -> $PIER_PUBLIC: $DNS"
done
ok "*.${A_NAME#app.} and *.${B_NAME#app.} -> $PIER_PUBLIC"

step "from the open network, each name reaches its own device"
for _ in $(seq 1 60); do
  grep -q "$A_NAME" "$WORK/pier-proxy.log" && grep -q "$B_NAME" "$WORK/pier-proxy.log" && break
  sleep 0.5
done
grep -q "$A_NAME" "$WORK/pier-proxy.log" && grep -q "$B_NAME" "$WORK/pier-proxy.log" \
  || { dump_logs; fail "the pier does not serve both names"; }
fetch_name() {
  curl -s --max-time 10 --cacert "$WORK/$2.crt" --resolve "$1:8443:$PIER_PUBLIC" "https://$1:8443/"
}
for _ in $(seq 1 40); do [[ "$(fetch_name "$A_NAME" a)" == alpha ]] && break; sleep 0.5; done
[[ "$(fetch_name "$A_NAME" a)" == alpha ]] || { dump_logs; fail "$A_NAME did not reach A through the pier"; }
ok "$A_NAME -> alpha (TLS verified against A's own certificate)"
for _ in $(seq 1 40); do [[ "$(fetch_name "$B_NAME" b)" == beta ]] && break; sleep 0.5; done
[[ "$(fetch_name "$B_NAME" b)" == beta ]] || { dump_logs; fail "$B_NAME did not reach B through the pier"; }
ok "$B_NAME -> beta"

step "inside the wave the name resolves to the device, not to the pier"
# The shared zone is not under the wave's suffix; the wave's resolver answers
# the exact name anyway, so members take the direct way.
RESOLVED=$(ip netns exec nodea bun "$REPO/test/e2e/dnsquery.ts" "$A_IP" "$A_NAME" 2>&1) \
  || { dump_logs; fail "A's resolver did not answer for $A_NAME: $RESOLVED"; }
[[ "$RESOLVED" == "$A_IP" ]] || fail "$A_NAME resolved to $RESOLVED, expected $A_IP"
ok "$A_NAME -> $RESOLVED"

step "the pier reaches the claimed port and nothing else"
ip netns exec nodea bun "$REPO/test/e2e/tcpprobe.ts" listen "$A_IP" 9000 >"$WORK/a-probe.log" 2>&1 &
wait_for_line "$WORK/a-probe.log" "listening on" "A's second port"
ip netns exec pier bun "$REPO/test/e2e/tcpprobe.ts" connect "$A_IP" 8443 3000 \
  || fail "the pier cannot reach A's claimed port"
if ip netns exec pier bun "$REPO/test/e2e/tcpprobe.ts" connect "$A_IP" 9000 3000; then
  fail "the pier reached A on a port A never put out"
fi
ok "pier -> A:8443 yes, A:9000 no"

step "the two waves still do not see each other"
if ip netns exec nodea ping -c1 -W2 "$B_IP" >/dev/null 2>&1; then
  fail "A reached B across two waves"
fi
ok "A cannot reach B"

step "a name taken back is no longer served"
ip netns exec nodea "${CLI[@]}" expose --remove app --daemon "$WORK/a.waved.sock" >/dev/null 2>&1 \
  || fail "wave expose --remove failed"
for _ in $(seq 1 40); do [[ -z "$(fetch_name "$A_NAME" a)" ]] && break; sleep 0.5; done
[[ -z "$(fetch_name "$A_NAME" a)" ]] || fail "$A_NAME is still served after --remove"
[[ "$(fetch_name "$B_NAME" b)" == beta ]] || fail "taking A's name back broke B's"
ok "$A_NAME closed, $B_NAME still beta"

printf '\n\033[32mPASS: one shared pier for two waves — random zones, SNI to the right device, only the claimed port\033[0m\n'
