#!/usr/bin/env bash
#
# D10/M10: the Go core that the phones run, driven on Linux against a real TUN.
#
# The point is not that Go works. It is that the shape D10 chose works at all:
# **one** interface carrying two waves, sorted by destination prefix, with one
# UDP port, one resolver and two WireGuard devices behind it. On the desktop
# each wave gets its own interface and its own port, so none of that is
# exercised anywhere else.
#
# The peers are the ordinary Bun client, which makes this a cross-implementation
# test as well: the Go side builds the WireGuard configuration, does the
# discovery handshake and carries the traffic, and the other end is the code
# that is already in production.
#
# What it cannot cover is the two platform hosts -- VpnService and
# NEPacketTunnelProvider. Those need a phone, and `mobile/README.md` says so.

set -euo pipefail
SCRIPT_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
source "$(dirname "$SCRIPT_PATH")/lib.sh"
reexec_in_namespace "$@"

command -v go >/dev/null || fail "no go toolchain on PATH; the core is Go (see mobile/README.md)"

WORK="$(mktemp -d)"
JAR="$WORK/cookies.txt"
trap 'pkill -P $$ 2>/dev/null || true; rm -rf "$WORK"' EXIT

ONE="http://10.99.0.1:8080"
TWO="http://10.99.0.1:8081"
PHONE_LOG="$WORK/phone.log"
STATUS="$WORK/phone-status.json"
# Where the phone's resolver answers: the address the wave reserves for it, the
# 53rd of its block. Not injected -- the netmap carries it, the allocator never
# hands it to a device, and the core routes it into the tunnel without assigning
# it. That last part is the whole trick: a packet to an address the interface
# *holds* is delivered locally by the kernel, where nothing is listening, and
# the socket-less resolver would never see it.
RESOLVER="10.64.0.53"

# Waits until the phone's status file says a wave has an address.
wait_for_wave() {
  local control="$1" what="$2"
  for _ in $(seq 1 120); do
    if [[ -s "$STATUS" ]] && bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" ipv4 "$control" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  echo "--- phone ---"; tail -40 "$PHONE_LOG"
  fail "timed out waiting for $what"
}

phone_field() { bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" "$1" "$2"; }

# Pings until it works, or gives up.
#
# Patient on purpose. A peer keeps sending to the address it last confirmed
# until that path times out, which is fifteen seconds -- so anything that moves
# the phone's port is invisible to its peers for that long. The restart below is
# meant not to move it, and this is what would catch it if it did.
ping_until() {
  local target="$1" what="$2" seconds="${3:-30}" out=""
  local deadline=$((SECONDS + seconds))
  while (( SECONDS < deadline )); do
    if out=$(ping -c1 -W2 -I wave0 "$target" 2>&1); then
      return 0
    fi
    sleep 1
  done
  echo "$out"
  dump_logs
  fail "$what"
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
ip netns exec nodeb ping -c1 -W2 10.99.0.1 >/dev/null || fail "node B cannot reach the segment"
ip netns exec nodec ping -c1 -W2 10.99.0.1 >/dev/null || fail "node C cannot reach the segment"
ok "phone 10.99.0.1, B 10.99.0.2, C 10.99.0.3"

step "build the harness"
# The same module the phones get; only this command is left out of the binding.
( cd "$REPO/mobile/core" && go build -o "$WORK/wave-harness" ./cmd/wave-harness ) \
  || fail "the harness did not build"
ok "$(cd "$REPO/mobile/core" && go version)"

step "two control servers, each with a range of its own"
# Disjoint, because nothing makes two independent servers agree -- and if they
# both numbered from the bottom the core would refuse the second wave rather
# than fight over a route. That refusal has its own unit test; this is the case
# that has to work.
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

# Approves whichever connect link the phone has just printed. The count says
# which one: a second enrolment prints a second link, and taking the last one
# before it exists would approve the first wave twice.
approve_link() {
  local jar="$1" want="$2" what="$3" url=""
  for _ in $(seq 1 120); do
    # grep -c prints 0 *and* fails when nothing matches, so `|| echo 0` made
    # "0\n0", which is no number; and nothing at all when the log is missing.
    local seen
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

step "the phone joins both waves"
# Both at once, from one process. The interface belongs to it, so there is no
# second invocation that could enrol on the side -- which is exactly the shape a
# phone has: one core, Login called again.
"$WORK/wave-harness" --dev wave0 --state "$WORK/phone-state.json" \
  --control "$ONE" --control "$TWO" --status "$STATUS" >"$PHONE_LOG" 2>&1 &
echo $! >"$WORK/phone.pid"

approve_link "$WORK/cookies-one.txt" 1 "$ONE"
wait_for_wave "$ONE" "the phone's first wave"
ok "$(grep -o "\[$ONE\].*up as .*" "$PHONE_LOG" | head -1)"

approve_link "$WORK/cookies-two.txt" 2 "$TWO"
wait_for_wave "$TWO" "the phone's second wave"
ok "$(grep -o "\[$TWO\].*up as .*" "$PHONE_LOG" | head -1)"

PHONE_ONE=$(phone_field ipv4 "$ONE")
PHONE_TWO=$(phone_field ipv4 "$TWO")
[[ "$PHONE_ONE" != "$PHONE_TWO" ]] || fail "both waves claim $PHONE_ONE"
ok "one interface, two waves: $PHONE_ONE and $PHONE_TWO"
PHONE_PORT=$(phone_field port "$ONE")
ok "one public UDP port for both: $PHONE_PORT"

dump_logs() {
  for f in "$WORK"/*.log; do echo "--- $f ---"; grep -v "socket error" "$f" | tail -25 || true; done
  echo "--- wave0 ---"; ip -o addr show dev wave0; ip route show dev wave0
}

step "a peer in each wave"
JAR="$WORK/cookies-one.txt" start_node b nodeb wave2 "$ONE"
JAR="$WORK/cookies-two.txt" start_node c nodec wave3 "$TWO"

step "one interface really does carry both"
COUNT=$(ip -4 -o addr show dev wave0 | wc -l)
[[ "$COUNT" -eq 2 ]] || { dump_logs; fail "wave0 has $COUNT IPv4 addresses, expected 2"; }
INTERFACES=$(ip -o link show | grep -c 'wave[0-9]*:' || true)
[[ "$INTERFACES" -eq 1 ]] || fail "the core made $INTERFACES wave interfaces; a phone allows one"
ok "wave0 holds both addresses, and there is no wave1"

step "the phone restarts and comes back into both waves"
# What a phone meets every morning: the enrolments are in the state file, and
# the tunnel has to come back with both of them on the one interface the
# platform allows -- without anybody approving anything again.
kill "$(cat "$WORK/phone.pid")" 2>/dev/null || true
sleep 1
rm -f "$STATUS"
PHONE_LOG="$WORK/phone2.log"
"$WORK/wave-harness" --dev wave0 --state "$WORK/phone-state.json" \
  --status "$STATUS" >"$PHONE_LOG" 2>&1 &
echo $! >"$WORK/phone.pid"
wait_for_wave "$ONE" "the first wave after the restart"
wait_for_wave "$TWO" "the second wave after the restart"
[[ "$(phone_field ipv4 "$ONE")" == "$PHONE_ONE" ]] || fail "the first wave came back on a different address"
[[ "$(phone_field ipv4 "$TWO")" == "$PHONE_TWO" ]] || fail "the second wave came back on a different address"
ok "both waves back from the state file, same addresses, nothing re-approved"
[[ "$(phone_field port "$ONE")" == "$PHONE_PORT" ]] \
  || fail "the phone came back on port $(phone_field port "$ONE"), not $PHONE_PORT — every peer would keep sending to the old one for fifteen seconds"
ok "same UDP port ($PHONE_PORT), so no peer had to notice"

step "the phone reaches a peer in each wave, through one tunnel"
B_IP=$(tunnel_ip nodeb wave2)
C_IP=$(tunnel_ip nodec wave3)
ping_until "$B_IP" "the phone lost B after the restart"
ok "phone -> B ($B_IP), first wave"
ping_until "$C_IP" "the phone could not reach C"
ok "phone -> C ($C_IP), second wave — same interface, sorted by prefix"

step "the resolver answers on the tunnel, without a socket of its own"
# The one genuinely new piece of D10. There is no listener: the query leaves the
# device towards an address that is *routed* into the tunnel and assigned to
# nobody, so it arrives in the read loop as an ordinary packet; the
# demultiplexer recognises the address, the resolver answers from its
# suffix table, and the reply is built as an IP packet and written back --
# checksums and all, which over IPv6 are not optional.
#
# Routed and unassigned is the whole trick: a packet to an address the interface
# *holds* is delivered locally by the kernel, where nothing listens, and answers
# ICMP port unreachable. The address is the one the wave reserves -- checked
# below to be the reservation and not something this script chose.
B_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/b.log" | head -1)
C_NAME=$(sed -n 's/.* up as [^ ]* (\([^)]*\)).*/\1/p' "$WORK/c.log" | head -1)
[[ -n "$B_NAME" && -n "$C_NAME" ]] || fail "could not read the peer names from the logs"

RESOLVED=$(bun "$REPO/test/e2e/dnsquery.ts" "$RESOLVER" "$B_NAME" 2>&1) \
  || { dump_logs; fail "the resolver did not answer for $B_NAME: $RESOLVED"; }
[[ "$RESOLVED" == "$B_IP" ]] || fail "$B_NAME resolved to $RESOLVED, expected $B_IP"
ok "$B_NAME -> $RESOLVED, answered off the tunnel with no socket"

# And here a phone differs from the desktop on purpose. There, each wave has a
# resolver of its own and crossing over must not work. Here there is one
# resolver with a suffix table, because the platform accepts one DNS setting for
# the whole tunnel -- so it answers for every wave the device is in. Worth
# pinning: it would otherwise look like a leak.
RESOLVED=$(bun "$REPO/test/e2e/dnsquery.ts" "$RESOLVER" "$C_NAME" 2>&1) \
  || { dump_logs; fail "the one resolver did not answer for the second wave's $C_NAME: $RESOLVED"; }
[[ "$RESOLVED" == "$C_IP" ]] || fail "$C_NAME resolved to $RESOLVED, expected $C_IP"
ok "$C_NAME -> $RESOLVED (one resolver, the other wave's zone)"

if bun "$REPO/test/e2e/dnsquery.ts" "$RESOLVER" "www.example.com" >/dev/null 2>&1; then
  fail "the resolver answered for a name outside every wave"
fi
ok "stays silent for names outside the waves"

# A reverse lookup has to work too, or everything that prints a name before a
# line -- ping, ssh, traceroute -- waits for an answer that never comes.
if ! bun "$REPO/test/e2e/dnsquery.ts" "$RESOLVER" "$B_NAME" AAAA >/dev/null 2>&1; then
  fail "the resolver answered A but not AAAA"
fi
ok "both families answered"

# On a phone the log is the only way to see why a name did not resolve: one
# line per wave once the settings are in, and one for a name the wave's
# netmap does not have.
MISSING="nothing-here.${B_NAME#*.}"
bun "$REPO/test/e2e/dnsquery.ts" "$RESOLVER" "$MISSING" >/dev/null 2>&1 || true
for _ in $(seq 1 20); do grep -q "dns: $MISSING is not in the netmap of ${B_NAME#*.}" "$PHONE_LOG" && break; sleep 0.25; done
grep -q "dns: $MISSING is not in the netmap of ${B_NAME#*.}" "$PHONE_LOG" \
  || { tail -30 "$PHONE_LOG"; fail "the log does not say that $MISSING is missing"; }
grep -q "zone ${B_NAME#*.}: this device .*, resolver $RESOLVER (reserved)" "$PHONE_LOG" \
  || { tail -30 "$PHONE_LOG"; fail "the log has no summary line for the first wave"; }
grep -q "zone ${C_NAME#*.}: this device " "$PHONE_LOG" \
  || { tail -30 "$PHONE_LOG"; fail "the log has no summary line for the second wave"; }
ok "the log names each wave and the name that was missing"

step "the resolver address is routed, never assigned"
# The invariant the whole socket-less design rests on, and the one thing that
# has to be checked rather than assumed: assigned to the interface, the kernel
# would answer it locally and the tunnel would never see the query. Which is
# also why the address the netmap names today -- this node's own -- cannot work
# on a phone, and why a wave needs one reserved out of its block. The core says
# so in its log when it has to fall back; the choice itself has a unit test.
ip -4 -o addr show dev wave0 | grep -q "$RESOLVER" \
  && fail "the resolver address is assigned to wave0; a query to it would never leave the device"
ip route show dev wave0 | grep -q "$RESOLVER" \
  || { ip route show dev wave0; fail "the resolver address is not routed into the tunnel"; }
ok "$RESOLVER is routed into wave0 and held by nothing"
# And it is the wave's reservation, not a number this script picked: the core
# took it out of the netmap.
bun "$REPO/test/e2e/mobile-status.ts" "$STATUS" resolver "$ONE" | grep -qx "$RESOLVER" \
  || fail "the core is answering somewhere other than the reserved address"
ok "taken from the netmap, not from this script"

step "a path was measured, not just assumed"
# Without a confirmed path every packet is sprayed at all candidates, which
# carries -- so a ping that works proves less than it looks. This is the part
# that says discovery actually completed.
VIA=$(phone_field via "$ONE")
[[ -n "$VIA" ]] || { dump_logs; fail "no confirmed path to B; the pings went through spraying"; }
ok "path to the first wave's peer: $VIA"

printf '\n\033[32mPASS: the mobile core carried two waves over one interface, reached a peer in each and answered both zones\033[0m\n'
