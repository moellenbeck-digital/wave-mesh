#!/usr/bin/env bash
#
# Everything a person can do in the phone app, against real control servers,
# through the same surface the app uses: wavemobile, driven by wave-phone.
# mobile-core.sh proves the shape (two waves, one interface); this proves the
# life around it -- and each step is something that once went wrong.
#
#   join under a chosen name, and the server knows what the device is
#   sessions survive a netmap that adds a peer
#   nothing is republished, and nothing re-applied, while nothing changes
#   pause and resume without a new approval
#   a network change reconnects at once
#   a login is cancelled, and leaves nothing behind
#   a second wave, in a stable order
#   leaving a paused wave tells its server
#   the server removing the device takes the wave down, a new login brings it back
#   a rename in the web reaches the phone
#   a restart comes back, and stopping does not hang
#   a second wave at the same server: its own enrolment, names, pause, leave

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

command -v go >/dev/null || fail "no go toolchain on PATH"
command -v jq >/dev/null || fail "jq is needed to read the phone's status"

WORK="$(mktemp -d)"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

ONE="http://10.99.0.1:8080"
TWO="http://10.99.0.1:8081"
PHONE_LOG="$WORK/phone.log"
STATUS="$WORK/phone-status.json"
COMMANDS="$WORK/commands"

# --- the phone ------------------------------------------------------------

start_phone() {
  "$WORK/wave-phone" --dev wave0 --state "$WORK/phone-state.json" --status "$STATUS" \
    --commands "$COMMANDS" --hostname phone >>"$PHONE_LOG" 2>&1 &
  echo $! >"$WORK/phone.pid"
  wait_for_line "$PHONE_LOG" 'core running' "the phone's core"
}

# Says something to the phone, the way the app asks its extension.
say() { echo "$*" >"$COMMANDS"; }

# Waits for the result of a command and prints it ("ok" or the error).
result_of() {
  local line="$1" n="${2:-1}"
  for _ in $(seq 1 240); do
    local found
    found="$(grep -F "command $line: " "$PHONE_LOG" | sed -n "${n}p" || true)"
    if [[ -n "$found" ]]; then echo "${found#*"command $line: "}"; return 0; fi
    sleep 0.5
  done
  tail -40 "$PHONE_LOG"; fail "no result for: $line"
}

status() { jq -r "$1" "$STATUS" 2>/dev/null; }
# True once the wave of this control server is listed with an address. Spelled
# out because `.waves[0].ipv4 != ""` is also true while there is no wave yet:
# null is not "".
up_query() { echo "[.waves[] | select(.controlUrl == \"$1\") | .ipv4] | (length == 1 and .[0] != \"\")"; }
wave_field() { status ".waves[] | select(.controlUrl == \"$1\") | .$2"; }

wait_status() {
  local query="$1" what="$2"
  for _ in $(seq 1 120); do
    [[ "$(status "$query")" == "true" ]] && return 0
    sleep 0.5
  done
  echo "--- status ---"; cat "$STATUS" 2>/dev/null || true
  echo "--- phone ---"; tail -40 "$PHONE_LOG"
  fail "timed out waiting for $what"
}

links() { grep -c 'open this link: ' "$PHONE_LOG" 2>/dev/null || true; }

# Approves the newest link once there are at least $2 of them.
approve_newest() {
  local jar="$1" want="$2" url="" seen
  for _ in $(seq 1 120); do
    seen="$(links)"
    if [[ "${seen:-0}" -ge "$want" ]]; then
      url=$(grep -o 'open this link: http://[^ ]*' "$PHONE_LOG" | tail -1 | sed 's/^open this link: //')
      break
    fi
    sleep 0.5
  done
  [[ -n "$url" ]] || { tail -30 "$PHONE_LOG"; fail "the phone printed no link #$want"; }
  approve_device "$jar" "$url"
}

ping_ok() { ping -c1 -W2 -I wave0 "$1" >/dev/null 2>&1; }
ping_until() {
  local deadline=$((SECONDS + ${3:-30}))
  while (( SECONDS < deadline )); do ping_ok "$1" && return 0; sleep 1; done
  tail -30 "$PHONE_LOG"; fail "$2"
}

wave_id() { curl -s -b "$1" "$2/api/me" | jq -r '.waves[0].id'; }
devices() { curl -s -b "$1" "$2/api/waves/$3/nodes"; }

# --- the world -------------------------------------------------------------

step "four namespaces on one segment"
mount -t tmpfs tmpfs /run
mkdir -p /run/wireguard
ip link set lo up
for peer in nodeb nodec noded; do
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
ip link set veth-noded master br0
ip addr add 10.99.0.1/24 dev br0
ip netns exec nodeb ip addr add 10.99.0.2/24 dev veth-in-nodeb
ip netns exec nodec ip addr add 10.99.0.3/24 dev veth-in-nodec
ip netns exec noded ip addr add 10.99.0.4/24 dev veth-in-noded
ok "phone 10.99.0.1, B 10.99.0.2, C 10.99.0.3, D 10.99.0.4"

step "build the phone"
( cd "$REPO/mobile/core" && go build -o "$WORK/wave-phone" ./cmd/wave-phone ) || fail "wave-phone did not build"
ok "wave-phone: the core through wavemobile, as the apps call it"

step "two control servers"
WAVE_PORT=8080 WAVE_BASE_URL="$ONE" WAVE_HOST=0.0.0.0 WAVE_IPV4_CONTAINER=10.64.0.0/11 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-one.log" 2>&1 &
WAVE_PORT=8081 WAVE_BASE_URL="$TWO" WAVE_HOST=0.0.0.0 WAVE_IPV4_CONTAINER=10.96.0.0/11 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-two.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$ONE/healthz" >/dev/null || fail "server one did not start"
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$TWO/healthz" >/dev/null || fail "server two did not start"
JAR="$WORK/cookies-one.txt" browser_login "$ONE" robin@example.com
JAR="$WORK/cookies-two.txt" browser_login "$TWO" someone-else@example.com
ONE_ID=$(wave_id "$WORK/cookies-one.txt" "$ONE")
TWO_ID=$(wave_id "$WORK/cookies-two.txt" "$TWO")
ok "$ONE and $TWO, a wave on each"

# --- 1 ---------------------------------------------------------------------
step "the phone joins under the name chosen for it"
mkfifo "$COMMANDS"
start_phone
say "hostname Test Phone"
result_of "hostname Test Phone" >/dev/null
say "login $ONE"
approve_newest "$WORK/cookies-one.txt" 1
[[ "$(result_of "login $ONE")" == "ok" ]] || fail "the login did not succeed"
wait_status "$(up_query "$ONE")" "the first wave's address"
DNS=$(wave_field "$ONE" dnsName)
[[ "$DNS" == test-phone.* ]] || fail "the device is called $DNS, not test-phone"
ok "in the wave as $DNS ($(wave_field "$ONE" ipv4))"

step "the server knows what the device is"
for _ in $(seq 1 20); do
  LISTED=$(devices "$WORK/cookies-one.txt" "$ONE" "$ONE_ID" | jq -c '.nodes[] | select(.hostname == "test-phone")')
  [[ "$(jq -r .clientPlatform <<<"$LISTED")" == "ios" ]] && break
  sleep 0.5
done
[[ "$(jq -r .clientPlatform <<<"$LISTED")" == "ios" ]] || fail "the server has $LISTED"
[[ "$(jq -r .clientVersion <<<"$LISTED")" == "0.0.0-e2e" ]] || fail "the server has $LISTED"
PHONE_NODE=$(jq -r .id <<<"$LISTED")
ok "platform ios, version 0.0.0-e2e, from the hello"

# --- 2 ---------------------------------------------------------------------
step "a peer, and a session that survives the next netmap"
JAR="$WORK/cookies-one.txt" start_node b nodeb wave2 "$ONE"
wait_status '[.waves[0].peers[]] | length == 1' "the phone to see B"
B_IP=$(status '.waves[0].peers[0].ipv4')
ping_until "$B_IP" "the phone cannot reach B"
for _ in $(seq 1 30); do
  AGE=$(status '.waves[0].peers[0].lastHandshakeSeconds')
  [[ "$AGE" -ge 8 ]] && break
  sleep 1
done
[[ "$AGE" -ge 8 ]] || fail "no settled handshake with B (age $AGE)"
JAR="$WORK/cookies-one.txt" start_node c nodec wave3 "$ONE"
wait_status '[.waves[0].peers[]] | length == 2' "the phone to see C"
ping_ok "$B_IP" || fail "B became unreachable when C joined"
AFTER=$(status ".waves[0].peers[] | select(.ipv4 == \"$B_IP\") | .lastHandshakeSeconds")
[[ "$AFTER" -ge "$AGE" ]] || fail "the session with B was rebuilt when C joined (handshake age $AGE -> $AFTER)"
ok "B's handshake is $AFTER s old after C joined: the session was kept"

# --- 3 ---------------------------------------------------------------------
step "nothing is republished or re-applied while nothing changes"
PUBLISHED=$(grep -c 'published .* candidate' "$PHONE_LOG" || true)
APPLIED=$(grep -c 'applied #' "$PHONE_LOG" || true)
sleep 70
if [[ "$(grep -c 'published .* candidate' "$PHONE_LOG" || true)" != "$PUBLISHED" ]]; then
  grep -E 'published|candidate|NAT|rebind|network' "$PHONE_LOG" | tail -20
  fail "the phone republished unchanged candidates: the server pushes a netmap to the whole wave each time"
fi
[[ "$(grep -c 'applied #' "$PHONE_LOG" || true)" == "$APPLIED" ]] \
  || fail "the settings were re-applied with nothing changed"
ok "a minute and more without a publish or an application"

# --- 4 ---------------------------------------------------------------------
step "pause and resume, without a new approval"
LINKS=$(links)
say "pause $ONE"
[[ "$(result_of "pause $ONE")" == "ok" ]] || fail "pause failed"
wait_status "[.waves[] | select(.controlUrl == \"$ONE\") | .enabled] == [false]" "the wave to be paused"
for _ in $(seq 1 20); do ping_ok "$B_IP" || break; sleep 0.5; done
ping_ok "$B_IP" && fail "B is still reachable through a paused wave"
say "resume $ONE"
[[ "$(result_of "resume $ONE")" == "ok" ]] || fail "resume failed"
ping_until "$B_IP" "B is not reachable after resuming"
[[ "$(links)" == "$LINKS" ]] || fail "resuming asked for a new approval"
ok "paused: B unreachable; resumed: reachable again, nothing approved"

# --- 5 ---------------------------------------------------------------------
step "a network change reconnects at once"
CONNECTS=$(grep -c 'control connected' "$PHONE_LOG" || true)
say "network"
result_of "network" >/dev/null
for _ in $(seq 1 10); do
  [[ "$(grep -c 'control connected' "$PHONE_LOG" || true)" -gt "$CONNECTS" ]] && break
  sleep 0.5
done
[[ "$(grep -c 'control connected' "$PHONE_LOG" || true)" -gt "$CONNECTS" ]] \
  || fail "the control connection was not rebuilt within 5 s of the network change"
ping_until "$B_IP" "B is unreachable after the network change"
ok "control reconnected within 5 s, B reachable"

# --- 6 ---------------------------------------------------------------------
step "a login is cancelled and leaves nothing behind"
LINKS=$(links)
say "login $TWO"
for _ in $(seq 1 60); do [[ "$(links)" -gt "$LINKS" ]] && break; sleep 0.5; done
say "cancel $TWO"
RESULT=$(result_of "login $TWO")
[[ "$RESULT" == *cancel* ]] || fail "the login ended with: $RESULT"
sleep 1
[[ "$(status "[.waves[] | select(.controlUrl == \"$TWO\")] | length")" == "0" ]] || fail "the cancelled wave is listed"
grep -q "$TWO" "$WORK/phone-state.json" && fail "the cancelled enrolment was kept in the state"
ok "cancelled: not listed, not in the state"

# --- 7 ---------------------------------------------------------------------
step "a second wave, in a stable order"
say "login $TWO"
approve_newest "$WORK/cookies-two.txt" $((LINKS + 2))
[[ "$(result_of "login $TWO" 2)" == "ok" ]] || fail "the second login did not succeed"
wait_status "$(up_query "$TWO")" "the second wave"
for _ in $(seq 1 5); do
  [[ "$(status '[.waves[].controlUrl] | join(",")')" == "$ONE,$TWO" ]] || fail "the order changed: $(status '[.waves[].controlUrl]')"
  sleep 1
done
ok "two waves, listed in the order they were added, five times running"

# --- 8 ---------------------------------------------------------------------
step "leaving a paused wave tells its server"
say "pause $TWO"
[[ "$(result_of "pause $TWO")" == "ok" ]] || fail "pause failed"
say "logout $TWO"
[[ "$(result_of "logout $TWO")" == "ok" ]] || fail "logout failed"
LEFT=$(devices "$WORK/cookies-two.txt" "$TWO" "$TWO_ID" | jq '[.nodes[]] | length')
[[ "$LEFT" == "0" ]] || fail "the device is still in the second wave on its server ($LEFT devices)"
ok "gone from the wave on the server, not a ghost"

# --- 9 ---------------------------------------------------------------------
step "the server removes the device, and a new login brings it back"
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookies-one.txt" -X POST "$ONE/waves/$ONE_ID/nodes/$PHONE_NODE/remove")
[[ "$code" == 303 ]] || fail "removing the device answered $code"
wait_status "[.waves[] | select(.controlUrl == \"$ONE\") | .problem] == [\"removed\"]" "the phone to say it was removed"
ip -4 -o addr show dev wave0 | grep -q '10\.64\.' && fail "the removed wave's address is still on the interface"
say "resume $ONE"
[[ "$(result_of "resume $ONE" 2)" != "ok" ]] || fail "a removed wave was switched back on without a login"
LINKS=$(links)
say "login $ONE"
approve_newest "$WORK/cookies-one.txt" $((LINKS + 1))
[[ "$(result_of "login $ONE" 2)" == "ok" ]] || fail "logging in again did not succeed"
wait_status "[.waves[] | select(.controlUrl == \"$ONE\") | .problem] == [\"\"]" "the wave to be fine again"
ping_until "$B_IP" "B is unreachable after joining again"
ok "removed: down and said so; logged in again: back, B reachable"

# --- 10 --------------------------------------------------------------------
step "a rename in the web reaches the phone"
PHONE_NODE=$(devices "$WORK/cookies-one.txt" "$ONE" "$ONE_ID" | jq -r '.nodes[] | select(.hostname | startswith("test-phone")) | .id')
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookies-one.txt" -X POST \
  --data-urlencode "name=Max iPhone" "$ONE/waves/$ONE_ID/nodes/$PHONE_NODE/name")
[[ "$code" == 303 ]] || fail "renaming answered $code"
wait_status "[.waves[] | select(.controlUrl == \"$ONE\") | .dnsName | startswith(\"max-iphone.\")] == [true]" "the new name on the phone"
ok "now $(wave_field "$ONE" dnsName)"

# --- 11 --------------------------------------------------------------------
step "a restart comes back, and stopping does not hang"
PID=$(cat "$WORK/phone.pid")
START=$SECONDS
kill -TERM "$PID"
for _ in $(seq 1 20); do kill -0 "$PID" 2>/dev/null || break; sleep 0.25; done
kill -0 "$PID" 2>/dev/null && fail "the core did not stop within 5 s -- a quiet tunnel blocked its read loop"
ok "stopped in $((SECONDS - START)) s"
rm -f "$STATUS"
LINKS=$(links)
start_phone
wait_status "$(up_query "$ONE")" "the wave after the restart"
[[ "$(links)" == "$LINKS" ]] || fail "the restart asked for an approval"
ping_until "$B_IP" "B is unreachable after the restart"
ok "back as $(wave_field "$ONE" dnsName), nothing approved, B reachable"

# --- 12 --------------------------------------------------------------------
step "a second wave at the same server, kept apart"
# One server, two projects: a wave each, and the phone in both. Last, because
# from here on every approval on this server has to say which wave.
code=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookies-one.txt" -c "$WORK/cookies-one.txt" -X POST "$ONE/waves" \
  --data-urlencode "name=project-b" --data-urlencode "suffix=project-b.wave.internal")
[[ "$code" == 303 ]] || fail "creating the second wave answered $code"
B_WAVE=$(curl -s -b "$WORK/cookies-one.txt" "$ONE/api/me" | jq -r '.waves[] | select(.name == "project-b") | .id')
[[ -n "$B_WAVE" ]] || fail "the second wave is not listed"

# Approving names the wave: with two, the server asks which.
approve_into() {
  local url="$1" wave="$2" code
  code=$(curl -s -o /dev/null -w '%{http_code}' -b "$WORK/cookies-one.txt" \
    --data-urlencode "request=${url##*request=}" --data-urlencode "wave=$wave" "${url%%\?*}")
  [[ "$code" == 2* || "$code" == 3* ]] || fail "approving into $wave answered $code"
}

LINKS=$(links)
say "add $ONE"
for _ in $(seq 1 60); do [[ "$(links)" -gt "$LINKS" ]] && break; sleep 0.5; done
approve_into "$(grep -o 'open this link: http://[^ ]*' "$PHONE_LOG" | tail -1 | sed 's/^open this link: //')" "$B_WAVE"
[[ "$(result_of "add $ONE")" == "ok" ]] || fail "adding the second wave did not succeed"
wait_status "[.waves[] | select(.label == \"project-b.wave.internal\") | .ipv4] | (length == 1 and .[0] != \"\")" "the second wave at the same server"
SECOND_ID=$(status '.waves[] | select(.label == "project-b.wave.internal") | .id')
[[ "$SECOND_ID" != "$ONE" && "$SECOND_ID" == "$ONE#"* ]] || fail "the second wave is filed as $SECOND_ID"
[[ "$(status "[.waves[] | select(.controlUrl == \"$ONE\")] | length")" == "2" ]] || fail "not two waves at $ONE"
ok "two waves at $ONE: $(status '[.waves[] | select(.controlUrl == "'"$ONE"'") | .label] | join(" and ")')"

# A device that is only in the second wave.
log="$WORK/d.log"
WAVE_WIREGUARD_GO="$WG_BIN" ip netns exec noded bun "$REPO/apps/client/src/cli.ts" login "$ONE" \
  --state "$WORK/d/state.json" --interface wave4 --socket /run/wireguard/wave4.sock >"$log" 2>&1 &
wait_for_line "$log" 'machine/authorize\?request=' "D's connect link"
approve_into "$(grep -o 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$log" | head -1)" "$B_WAVE"
wait_for_line "$log" ' up as ' "D's tunnel"
wait_status "[.waves[] | select(.id == \"$SECOND_ID\") | .peers | length] == [1]" "the phone to see D"
D_NAME=$(status ".waves[] | select(.id == \"$SECOND_ID\") | .peers[0].dnsName")
D_IP=$(status ".waves[] | select(.id == \"$SECOND_ID\") | .peers[0].ipv4")
FIRST_RESOLVER=$(wave_field "$ONE" resolver | head -1)
ANSWER=$(dig +short +time=2 +tries=2 @"$FIRST_RESOLVER" "$D_NAME" A | head -1)
[[ "$ANSWER" == "$D_IP" ]] || fail "$D_NAME did not resolve to $D_IP through $FIRST_RESOLVER (got '$ANSWER')"
ok "$D_NAME -> $D_IP, through the first wave's resolver: one resolver, both waves' names"
ping_until "$D_IP" "D is unreachable in the second wave"
ping_ok "$B_IP" || fail "B became unreachable when the second wave came up"
ok "D reachable in the second wave, B still in the first"

say "pause $SECOND_ID"
[[ "$(result_of "pause $SECOND_ID")" == "ok" ]] || fail "pausing the second wave failed"
wait_status "[.waves[] | select(.id == \"$SECOND_ID\") | .enabled] == [false]" "the second wave paused"
[[ "$(status "[.waves[] | select(.id == \"$ONE\") | .enabled] == [true]")" == "true" ]] || fail "pausing the second paused the first"
ping_ok "$B_IP" || fail "B is unreachable after pausing the other wave"
say "logout $SECOND_ID"
[[ "$(result_of "logout $SECOND_ID")" == "ok" ]] || fail "leaving the second wave failed"
IN_B=$(devices "$WORK/cookies-one.txt" "$ONE" "$B_WAVE" | jq '[.nodes[] | select(.hostname | startswith("test-phone") or startswith("max-iphone"))] | length')
[[ "$IN_B" == "0" ]] || fail "the phone is still in the second wave on the server"
[[ "$(status "[.waves[] | select(.id == \"$ONE\")] | length")" == "1" ]] || fail "leaving the second wave took the first with it"
ok "paused and left the second wave; the first untouched, the server told"

printf '\n\033[32mPASS: every step of the phone app, against real control servers, through wavemobile\033[0m\n'
