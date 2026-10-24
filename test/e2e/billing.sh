#!/usr/bin/env bash
#
# A wave bought on wave-mesh.org, end to end: the billing API the site calls
# when Stripe tells it something, against real tunnels.
#
#   - a checkout makes a wave and an owner without a password; the owner sets
#     one through the single-use setup link and is signed in;
#   - two devices join it and ping each other;
#   - "suspended" empties every netmap: the devices stay enrolled but have
#     nobody to talk to, and no new device gets in -- not through the browser,
#     not with a pre-auth key, which is not spent by the refusal;
#   - "active" again brings the mesh back without a single re-approval;
#   - seats are members plus open invitations;
#   - "ended" stops the mesh, sets the deletion date, and the sweep deletes the
#     wave and cuts its devices off;
#   - a wrong token is a 401, no token at all is no API (404), a short one no
#     server.
#
# No root required.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

CONTROL="http://10.99.0.1:8080"
# Not a secret: a server of its own, in a namespace of its own, for a minute.
TOKEN="e2e-billing-token-0123456789abcdef0123456789"
SUB="sub_e2e"
OWNER="owner@example.com"
CLI=(bun "$REPO/apps/client/src/cli.ts")

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

step "control server with billing"
# Retention 0: an ended wave is due at once, so the sweep below has something
# to delete without waiting thirty days.
WAVE_PORT=8080 WAVE_BASE_URL="$CONTROL" WAVE_HOST=0.0.0.0 \
  WAVE_BILLING_TOKEN="$TOKEN" \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$CONTROL/healthz" >/dev/null || fail "control server did not start"
ok "up at $CONTROL"

# The site's side: one call with the bearer token. Prints the status code; the
# body is in $WORK/billing.json.
billing() { # <method> <path> [json]
  curl -s -o "$WORK/billing.json" -w '%{http_code}' -X "$1" \
    -H "authorization: Bearer ${BILLING_TOKEN:-$TOKEN}" -H 'content-type: application/json' \
    ${3:+--data "$3"} "${BILLING_BASE:-$CONTROL}$2"
}
field() { jq -r "$1" "$WORK/billing.json"; }
subscription() { # <state> <seats>
  local code
  code=$(billing PUT "/api/billing/subscriptions/$SUB" \
    "{\"email\":\"$OWNER\",\"name\":\"Acme\",\"seats\":$2,\"state\":\"$1\"}")
  [[ "$code" == 200 ]] || fail "PUT $1/$2 answered $code: $(cat "$WORK/billing.json")"
  [[ "$(field .state)" == "$1" && "$(field .seats)" == "$2" ]] \
    || fail "PUT $1/$2 answered $(cat "$WORK/billing.json")"
}

step "a checkout makes the wave"
subscription active 2
[[ "$(field .created)" == true ]] || fail "the first delivery did not create: $(cat "$WORK/billing.json")"
WAVE_ID=$(field .waveId)
WAVE_NAME=$(field .waveName)
SUFFIX=$(field .dnsSuffix)
[[ "$WAVE_ID" == w* && "$WAVE_NAME" == acme && "$SUFFIX" == acme.* ]] \
  || fail "unexpected wave: $(cat "$WORK/billing.json")"
# Only what the site needs -- the internal "meshChanged" stays inside.
KEYS=$(jq -c 'keys' "$WORK/billing.json")
[[ "$KEYS" == '["created","dnsSuffix","members","seats","state","waveId","waveName"]' ]] \
  || fail "the answer has the fields $KEYS"
[[ "$(field .members)" == 1 ]] || fail "a new wave has $(field .members) members, expected its owner"
ok "created $WAVE_NAME ($WAVE_ID, $SUFFIX), 1 member"

subscription active 2
[[ "$(field .created)" == false && "$(field .waveId)" == "$WAVE_ID" ]] \
  || fail "the repeated delivery made something new: $(cat "$WORK/billing.json")"
ok "the same event again: created=false, the same wave"

for state in suspended ended; do
  code=$(billing PUT "/api/billing/subscriptions/sub_never_active" \
    "{\"email\":\"late@example.com\",\"name\":\"Late\",\"seats\":1,\"state\":\"$state\"}")
  [[ "$code" == 404 && "$(field .error)" == unknown-subscription ]] \
    || fail "a $state subscription never seen made something: $code $(cat "$WORK/billing.json")"
done
ok "a subscription first seen paused or ended makes no wave (404)"

step "the owner sets a password through the setup link"
# Keyed by the checkout session, as the site sends it: Stripe delivering the
# checkout twice must mail the same link, not one that revokes the other.
[[ $(billing POST "/api/billing/subscriptions/$SUB/owner-link" '{"key":"cs_e2e"}') == 200 ]] \
  || fail "owner-link answered $(cat "$WORK/billing.json")"
SETUP_URL=$(field .url)
[[ "$(field .signInUrl)" == "$CONTROL" ]] || fail "owner-link names no sign-in address: $(cat "$WORK/billing.json")"
[[ $(billing POST "/api/billing/subscriptions/$SUB/owner-link" '{"key":"cs_e2e"}') == 200 && "$(field .url)" == "$SETUP_URL" ]] \
  || fail "the same key gave another link: $(cat "$WORK/billing.json")"
ok "the same key, the same link"
[[ "$(field .email)" == "$OWNER" && "$(field .hasPassword)" == false && "$SETUP_URL" == "$CONTROL/account/setup/"* ]] \
  || fail "owner-link answered $(cat "$WORK/billing.json")"
code=$(curl -s -o "$WORK/setup.html" -w '%{http_code}' "$SETUP_URL")
[[ "$code" == 200 ]] && grep -q "$OWNER" "$WORK/setup.html" || fail "the setup page answered $code"
code=$(curl -s -c "$JAR" -o /dev/null -w '%{http_code}' \
  --data-urlencode "password=correct horse battery staple" "$SETUP_URL")
[[ "$code" == 303 ]] || fail "setting the password answered $code"
grep -q wave_session "$JAR" || fail "setting the password did not sign the owner in"
ME=$(curl -s -b "$JAR" "$CONTROL/api/me")
[[ "$(jq -r '.user.email' <<<"$ME")" == "$OWNER" && "$(jq -r '.user.emailVerified' <<<"$ME")" == true ]] \
  || fail "the session is not the verified owner: $ME"
[[ "$(jq -r --arg id "$WAVE_ID" '.waves[] | select(.id == $id) | .role' <<<"$ME")" == owner ]] \
  || fail "the owner does not own the wave: $ME"
ok "signed in as $OWNER, address verified, owner of $WAVE_NAME"

code=$(curl -s -o "$WORK/setup-again.html" -w '%{http_code}' \
  --data-urlencode "password=another long password" "$SETUP_URL")
[[ "$code" == 410 ]] || fail "using the link twice answered $code"
code=$(curl -s -o /dev/null -w '%{http_code}' "$SETUP_URL")
[[ "$code" == 410 ]] || fail "opening a used link answered $code"
[[ $(billing POST "/api/billing/subscriptions/$SUB/owner-link") == 200 && "$(field .url)" == null ]] \
  || fail "an owner with a password got another link: $(cat "$WORK/billing.json")"
ok "the link is spent (410), and no new one for an owner with a password"

step "two devices in the wave"
start_node a "" wave0 "$CONTROL" daemon
# One daemon per machine: a second one, in B's namespace, would share /run
# with A's and take A's wireguard-go socket for its own. B runs in the
# foreground like the peers in the other scripts, so its log is a live view
# and the netmap lines below are read from A's alone; B is judged by ping.
start_node b nodeb wave1 "$CONTROL"
wait_for_line "$WORK/a.log" 'netmap v[0-9]+: 1 peer' "A to be told about B"
A_IP=$(tunnel_ip "" wave0)
B_IP=$(tunnel_ip nodeb wave1)

dump_logs() { for f in "$WORK"/*.log; do echo "--- $f ---"; tail -20 "$f" || true; done; }
# A path is up once a ping gets through, not when the netmap arrives.
reach() { # <from netns or ""> <ip> <what>
  local -a prefix=()
  [[ -n "$1" ]] && prefix=(ip netns exec "$1")
  for _ in $(seq 1 20); do "${prefix[@]}" ping -c1 -W1 "$2" >/dev/null 2>&1 && return 0; done
  dump_logs
  fail "$3"
}
unreachable() { # <from netns or ""> <ip> <what>
  local -a prefix=()
  [[ -n "$1" ]] && prefix=(ip netns exec "$1")
  "${prefix[@]}" ping -c3 -W1 "$2" >/dev/null 2>&1 && { dump_logs; fail "$3"; }
  return 0
}
# Waits for a netmap line *after* the ones already in the log: the same words
# were there before, at enrolment, and must not count.
next_netmap() { # <node> <peers> <what>
  local log="$WORK/$1.log" before="${NETMAPS[$1]}"
  for _ in $(seq 1 60); do
    if tail -n +"$((before + 1))" "$log" | grep -qE "netmap v[0-9]+: $2 peer"; then
      NETMAPS[$1]=$(wc -l <"$log")
      return 0
    fi
    sleep 0.5
  done
  dump_logs
  fail "timed out waiting for $3"
}
declare -A NETMAPS
mark() { for n in "$@"; do NETMAPS[$n]=$(wc -l <"$WORK/$n.log"); done; }

reach "" "$B_IP" "A could not reach B in the live wave"
reach nodeb "$A_IP" "B could not reach A in the live wave"
ok "A ($A_IP) <-> B ($B_IP)"

# Where waves are sold, an account gets one through a subscription only -- not
# through the form every self-hosted server offers.
code=$(curl -s -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$CONTROL/waves" \
  --data-urlencode "name=free" --data-urlencode "suffix=free.wave.internal")
[[ "$code" == 403 ]] || fail "an account on a billing server created a wave of its own ($code)"
ok "no wave of one's own on a billing server (403)"

step "suspended: the mesh stops, the devices stay"
mark a
subscription suspended 2
next_netmap a 0 "A's netmap to empty"
unreachable "" "$B_IP" "A still reached B in a paused wave"
unreachable nodeb "$A_IP" "B still reached A in a paused wave"
[[ "$(tunnel_ip "" wave0)" == "$A_IP" ]] || fail "A lost its address while paused"
NODES=$(curl -s -b "$JAR" "$CONTROL/api/waves/$WAVE_ID/nodes" | jq '.nodes | length')
[[ "$NODES" == 2 ]] || fail "the paused wave lists $NODES devices, expected 2"
ok "A's netmap empty, no ping either way, both devices still enrolled"

subscription suspended 2
ok "a repeated suspension is harmless"

step "suspended: no device gets in"
# Through the browser: the device asks, the owner approves, the server says no.
WAVE_WIREGUARD_GO="$WG_BIN" ip netns exec nodec "${CLI[@]}" login "$CONTROL" \
  --state "$WORK/c-browser/state.json" --interface wave2 --socket /run/wireguard/wave2.sock \
  >"$WORK/c-browser.log" 2>&1 &
BROWSER_PID=$!
wait_for_line "$WORK/c-browser.log" 'machine/authorize\?request=' "C's connect link"
URL=$(grep -ao 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$WORK/c-browser.log" | head -1)
code=$(curl -s -b "$JAR" -o "$WORK/approve-c.html" -w '%{http_code}' \
  --data-urlencode "request=${URL##*request=}" "${URL%%\?*}")
[[ "$code" == 403 ]] || fail "approving into a paused wave answered $code: $(head -c 300 "$WORK/approve-c.html")"
grep -q "This wave is paused" "$WORK/approve-c.html" || fail "the refusal does not say why: $(cat "$WORK/approve-c.html")"
kill "$BROWSER_PID" 2>/dev/null || true
wait "$BROWSER_PID" 2>/dev/null || true
ok "browser approval refused: $(sed -n 's:.*<h1>\(.*\)</h1>.*:\1:p' "$WORK/approve-c.html")"

# With a pre-auth key: refused as well, and the key is not used up by it.
KEY=$(curl -s -X POST "$CONTROL/__e2e/auth-key?wave=$WAVE_ID" | jq -r .token)
[[ "$KEY" == wavekey-* ]] || fail "could not make a pre-auth key"
c_with_key() {
  WAVE_WIREGUARD_GO="$WG_BIN" ip netns exec nodec "${CLI[@]}" login "$CONTROL" --auth-key "$KEY" \
    --state "$WORK/c/state.json" --interface wave2 --socket /run/wireguard/wave2.sock \
    >"$WORK/c.log" 2>&1 &
  C_PID=$!
}
c_with_key
for _ in $(seq 1 60); do kill -0 "$C_PID" 2>/dev/null || break; sleep 0.5; done
kill -0 "$C_PID" 2>/dev/null && { dump_logs; fail "C is still running with a key for a paused wave"; }
grep -aq "paused" "$WORK/c.log" || { dump_logs; fail "C's refusal does not say the wave is paused"; }
ip -n nodec link show wave2 >/dev/null 2>&1 && fail "C has a tunnel interface after the refusal"
ok "pre-auth key refused: $(grep -ao '403 [^}]*' "$WORK/c.log" | head -1)"
NODES=$(curl -s -b "$JAR" "$CONTROL/api/waves/$WAVE_ID/nodes" | jq '.nodes | length')
[[ "$NODES" == 2 ]] || fail "the paused wave let a device in: $NODES devices"

step "active again: the mesh is back, without a single re-approval"
mark a
subscription active 2
next_netmap a 1 "A to see B again"
reach "" "$B_IP" "A could not reach B after the wave came back"
reach nodeb "$A_IP" "B could not reach A after the wave came back"
ok "A <-> B again"

# The key the refusal did not spend is good now.
mark a
c_with_key
wait_for_line "$WORK/c.log" ' up as ' "C's tunnel with the unspent key"
C_IP=$(tunnel_ip nodec wave2)
next_netmap a 2 "A to see C"
reach "" "$C_IP" "A could not reach C"
ok "the key the pause refused enrolled C ($C_IP) now"

step "seats: members and open invitations, as booked"
invite() { # <email> -> status code, page in $WORK/invite.html
  curl -s -b "$JAR" -o "$WORK/invite.html" -w '%{http_code}' \
    --data-urlencode "email=$1" --data-urlencode "role=member" "$CONTROL/waves/$WAVE_ID/invites"
}
[[ $(invite bob@example.com) == 200 ]] || fail "the first invitation: $(head -c 300 "$WORK/invite.html")"
ok "owner + an invitation for bob = 2 of 2 seats"
code=$(invite carol@example.com)
[[ "$code" == 409 ]] || fail "an invitation past the booking answered $code: $(head -c 300 "$WORK/invite.html")"
grep -q "No seat left" "$WORK/invite.html" && grep -q "booked for 2 people" "$WORK/invite.html" \
  || fail "the refusal does not say why: $(cat "$WORK/invite.html")"
ok "carol refused: $(sed -n 's:.*<h1>\(.*\)</h1>.*:\1:p' "$WORK/invite.html")"
[[ $(invite bob@example.com) == 200 ]] || fail "inviting bob again was refused: $(head -c 300 "$WORK/invite.html")"
ok "bob again replaces his invitation and costs no seat"
subscription active 3
[[ $(invite carol@example.com) == 200 ]] || fail "carol was refused with 3 seats: $(head -c 300 "$WORK/invite.html")"
ok "a third seat booked, carol invited"

step "ended: the mesh stops and the wave is due for deletion"
mark a
subscription ended 3
next_netmap a 0 "A's netmap to empty"
unreachable "" "$B_IP" "A still reached B in an ended wave"
unreachable nodeb "$A_IP" "B still reached A in an ended wave"
AUDIT=$(curl -s -b "$JAR" "$CONTROL/api/waves/$WAVE_ID/audit")
DELETE_AFTER=$(jq -r '[.entries[] | select(.action == "billing.update")][0].detail.deleteAfter // empty' <<<"$AUDIT")
[[ -n "$DELETE_AFTER" ]] || fail "ending set no deletion date: $AUDIT"
ok "no ping, delete_after $DELETE_AFTER"

code=$(billing PUT "/api/billing/subscriptions/$SUB" '{"seats":3,"state":"active"}')
[[ "$code" == 409 && "$(field .error)" == ended ]] || fail "an ended subscription came back: $code $(cat "$WORK/billing.json")"
code=$(billing PUT "/api/billing/subscriptions/$SUB" '{"seats":3,"state":"suspended"}')
[[ "$code" == 409 ]] || fail "an ended subscription was paused again: $code"
unreachable "" "$B_IP" "A reached B after a stale active"
ok "ended stays ended: a later active or suspended is 409"

step "the sweep deletes it and cuts its devices off"
mark a
SWEPT=$(curl -s -X POST "$CONTROL/__e2e/billing/sweep" | jq -r .deleted)
[[ "$SWEPT" == 0 ]] || fail "the sweep deleted $SWEPT waves inside the retention"
SWEPT=$(curl -s -X POST "$CONTROL/__e2e/billing/sweep?days=31" | jq -r .deleted)
[[ "$SWEPT" == 1 ]] || fail "the sweep deleted $SWEPT waves, expected 1"
grep -q "billing: deleted $WAVE_NAME ($WAVE_ID), subscription $SUB ended" "$WORK/control.log" \
  || fail "the operator's log does not say what was deleted"
for _ in $(seq 1 40); do
  tail -n +"$((NETMAPS[a] + 1))" "$WORK/a.log" | grep -q 're-authenticate: node-removed' && break
  sleep 0.5
done
tail -n +"$((NETMAPS[a] + 1))" "$WORK/a.log" | grep -q 're-authenticate: node-removed' \
  || { dump_logs; fail "A was not told it was removed"; }
ME=$(curl -s -b "$JAR" "$CONTROL/api/me")
[[ "$(jq -r --arg id "$WAVE_ID" '[.waves[] | select(.id == $id)] | length' <<<"$ME")" == 0 ]] \
  || fail "the owner still has the wave: $ME"
[[ $(billing PUT "/api/billing/subscriptions/$SUB" '{"seats":3,"state":"ended"}') == 404 ]] \
  || fail "the deleted subscription still answers: $(cat "$WORK/billing.json")"
[[ $(billing POST "/api/billing/subscriptions/$SUB/owner-link") == 404 ]] \
  || fail "the deleted subscription still has an owner: $(cat "$WORK/billing.json")"
ok "wave gone, A told it was removed, the subscription unknown"

step "the token"
[[ $(BILLING_TOKEN="${TOKEN}x" billing PUT "/api/billing/subscriptions/$SUB" '{"seats":1,"state":"active"}') == 401 ]] \
  || fail "a wrong token was not refused"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "$CONTROL/api/billing/subscriptions/$SUB/owner-link")
[[ "$code" == 401 ]] || fail "no Authorization header answered $code"
ok "wrong or missing token: 401"

OFF="http://127.0.0.1:8081"
WAVE_PORT=8081 WAVE_BASE_URL="$OFF" WAVE_HOST=127.0.0.1 \
  bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-off.log" 2>&1 &
curl -s --retry 40 --retry-all-errors --retry-delay 1 "$OFF/healthz" >/dev/null || fail "the second server did not start"
[[ $(BILLING_BASE="$OFF" billing PUT "/api/billing/subscriptions/$SUB" \
  "{\"email\":\"$OWNER\",\"name\":\"Acme\",\"seats\":1,\"state\":\"active\"}") == 404 ]] \
  || fail "a server without WAVE_BILLING_TOKEN has a billing API"
ok "without WAVE_BILLING_TOKEN, no billing API (404)"

if WAVE_PORT=8082 WAVE_BASE_URL="http://127.0.0.1:8082" WAVE_BILLING_TOKEN=short \
  timeout 30 bun "$REPO/apps/control/test/e2e-server.ts" >"$WORK/control-short.log" 2>&1; then
  fail "a server started with a short billing token"
fi
grep -q "WAVE_BILLING_TOKEN must be at least 32 characters" "$WORK/control-short.log" \
  || fail "a short token was refused without saying why: $(tail -5 "$WORK/control-short.log")"
ok "a short token: no server at all"

printf '\n\033[32mPASS: a billed wave was created, paused, resumed, held to its seats, ended and swept, over real tunnels\033[0m\n'
