# Shared helpers for the end-to-end tests. Sourced, not executed.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WG_BIN="${WAVE_WIREGUARD_GO:-$(command -v wireguard-go || echo "$HOME/go/bin/wireguard")}"

# The scripts read what `wave` prints in a few places, and the CLI speaks the
# language of the machine it runs on. Pinned, so a run on a German desktop
# reads the same words as one in CI. Log lines are English regardless.
export WAVE_LANG=en

step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '\033[32m  ok\033[0m %s\n' "$*"; }
fail() {
  if [[ "${WAVE_E2E_KEEP:-0}" == "1" && -d "${WORK:-}" ]]; then
    cp -r "$WORK" "${WAVE_E2E_KEEP_DIR:-/tmp}/wave-e2e-logs" 2>/dev/null || true
  fi
  printf '\033[31mFAIL: %s\033[0m\n' "$*"
  exit 1
}

# Re-executes the script inside an unprivileged user namespace, where we are
# uid 0 and may create network namespaces, veth pairs, NAT rules and TUN
# devices without touching the host.
reexec_in_namespace() {
  [[ -n "${WAVE_E2E_INNER:-}" ]] && return 0
  [[ -x "$WG_BIN" ]] || fail "wireguard-go not found at $WG_BIN (set WAVE_WIREGUARD_GO)"
  exec unshare -Urnm --propagation private \
    env WAVE_E2E_INNER=1 WAVE_WIREGUARD_GO="$WG_BIN" "$SCRIPT_PATH" "$@"
}

# Waits until a pattern shows up in a file, or gives up.
wait_for_line() {
  local file="$1" pattern="$2" what="$3" tries="${4:-120}"
  for _ in $(seq 1 "$tries"); do
    grep -qE "$pattern" "$file" 2>/dev/null && return 0
    sleep 0.5
  done
  # `|| true`, because an empty log makes grep exit 1 and pipefail turns that
  # into the death of the dump itself: the files after it are never shown and
  # the failure below never printed. A backgrounded `wave login` waiting for
  # approval leaves exactly such a log.
  for f in "$WORK"/*.log; do
    echo "--- $f ---"
    grep -v "socket error" "$f" 2>/dev/null | tail -25 || true
  done
  for ns in $(ip netns list 2>/dev/null | awk '{print $1}' | grep '^nat' || true); do
    echo "--- conntrack in $ns ---"
    ip netns exec "$ns" cat /proc/net/nf_conntrack 2>/dev/null | grep udp | head -8
  done
  [[ "${WAVE_E2E_KEEP:-0}" == "1" ]] && { echo "logs kept in $WORK"; cp -r "$WORK" "${WAVE_E2E_KEEP_DIR:-/tmp}/wave-e2e-logs" 2>/dev/null || true; }
  fail "timed out waiting for $what"
}

# Signs in through the dev provider, makes a wave and leaves a session in $JAR.
#
# The wave is a step of its own because signing in no longer makes one: the DNS
# suffix every device name hangs under is its owner's choice, so it is asked for
# on a form. Here that form is one POST, with the same placeholder suffix the
# server used to pick by itself.
browser_login() {
  local base="$1" email="${2:-robin@example.com}"
  local redirect state name code
  redirect=$(curl -s -c "$JAR" -o /dev/null -w '%{redirect_url}' "$base/auth/dev/start")
  state=$(sed -n 's/.*state=\([^&]*\).*/\1/p' <<<"$redirect")
  curl -s -b "$JAR" -c "$JAR" -o /dev/null "$base/auth/dev/callback?code=${email//@/%40}&state=$state"
  grep -q wave_session "$JAR" || fail "login did not produce a session"

  name="${email%%@*}"
  code=$(curl -s -b "$JAR" -c "$JAR" -o /dev/null -w '%{http_code}' -X POST "$base/waves" \
    --data-urlencode "name=$name" --data-urlencode "suffix=$name.wave.internal")
  [[ "$code" == "303" ]] || fail "creating a wave for $email answered $code"
}

# Joins one node to a wave, approves the device in the browser, and waits for
# the tunnel to come up. The process keeps running: the magic socket owns the
# public UDP port, so the tunnel lives exactly as long as it does.
#
# Joining is always `wave login <url>`. Nothing is installed or started with a
# control server, so `up` on a bare device has nothing to bring up.
start_node() {
  local name="$1" netns="$2" iface="$3" base="$4"
  local mode="${5:-direct}"
  local log="$WORK/$name.log"
  local -a prefix=()
  [[ -n "$netns" ]] && prefix=(ip netns exec "$netns")

  local -a common=(--state "$WORK/$name/state.json" --interface "$iface")
  [[ -n "${STUN_SERVERS:-}" ]] && common+=(--stun "$STUN_SERVERS")

  if [[ "$mode" == "daemon" ]]; then
    # The privileged daemon holds the tunnel; the CLI only talks to it.
    WAVE_WIREGUARD_GO="$WG_BIN" WAVE_VERBOSE="${WAVE_VERBOSE:-0}" "${prefix[@]}" \
      bun "$REPO/apps/client/src/cli.ts" daemon "${common[@]}" \
      --daemon "$WORK/$name.waved.sock" --group "" \
      --wg-socket "/run/wireguard/$iface.sock" >"$log" 2>&1 &
    echo $! >"$WORK/$name.pid"
    # The socket has to exist before the CLI asks for it; without the daemon it
    # would quietly do the work itself, against the wrong state file.
    wait_for_line "$log" 'daemon listening on' "$name's daemon socket"
    # Backgrounded: enrolment waits for a human, which is the curl below. The
    # daemon is what prints the link, so the wait below reads its log.
    "${prefix[@]}" bun "$REPO/apps/client/src/cli.ts" login "$base" \
      --daemon "$WORK/$name.waved.sock" >"$WORK/$name-login.log" 2>&1 &
  else
    WAVE_WIREGUARD_GO="$WG_BIN" WAVE_VERBOSE="${WAVE_VERBOSE:-0}" "${prefix[@]}" \
      bun "$REPO/apps/client/src/cli.ts" login "$base" "${common[@]}" \
      --socket "/run/wireguard/$iface.sock" >"$log" 2>&1 &
    echo $! >"$WORK/$name.pid"
  fi

  wait_for_line "$log" 'machine/authorize\?request=' "$name to print its connect link"
  local url
  url=$(grep -o 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$log" | head -1)
  approve_device "$JAR" "$url"

  wait_for_line "$log" ' up as ' "$name's tunnel"
  ok "$(grep -o '[a-z0-9]* up as .*' "$log" | head -1)"
}

# Approves a device the way a browser does: open the link, submit the form.
#
# Opening it alone does nothing on purpose. A GET carries the session cookie
# even when the navigation comes from a foreign site -- that is what
# `SameSite=Lax` allows -- and the request id in the link is the *device's*
# secret, not the user's, so a link anybody can produce must not be an
# approval on its own. The POST is what Lax does keep cross-site.
approve_device() {
  # Two statements: bash expands every word of a `local` line before it
  # assigns any, so `$url` in the same line read whatever a caller happened to
  # have -- and with `set -u` and no caller's `url`, nothing at all.
  local jar="$1" url="$2" code
  local body="$WORK/approve-${url##*request=}.html"
  code=$(curl -s -b "$jar" -o "$body" -w '%{http_code}' \
    --data-urlencode "request=${url##*request=}" "${url%%\?*}")
  # Said here rather than as a timeout a minute later: a refused approval used
  # to surface only as "timed out waiting for the tunnel", with the server's
  # answer thrown away. 2xx is the page that says so, 3xx a redirect to it.
  [[ "$code" == 2* || "$code" == 3* ]] || fail "approving $url answered $code: $(head -c 400 "$body")"
}

# Adds a further wave to a node whose daemon is already running, and approves
# the device in the browser. The daemon keeps both tunnels; `wave login` only
# asks it to. Which wave is which is the control server, so that is all it takes.
join_wave() {
  local name="$1" base="$2"
  local log="$WORK/$name.log"
  local before
  before=$(grep -c 'machine/authorize?request=' "$log" 2>/dev/null || true)

  # Backgrounded: enrolment waits for a human, which is the curl below.
  bun "$REPO/apps/client/src/cli.ts" login "$base" \
    --daemon "$WORK/$name.waved.sock" \
    >"$WORK/$name-second.log" 2>&1 &

  local url="" tries
  for tries in $(seq 1 120); do
    url=$(grep -o 'http://[^ ]*machine/authorize?request=[A-Za-z0-9_]*' "$log" | tail -1)
    [[ -n "$url" && "$(grep -c 'machine/authorize?request=' "$log")" -gt "$before" ]] && break
    url=""
    sleep 0.5
  done
  [[ -n "$url" ]] || { tail -25 "$log"; fail "$name did not print a link for $base"; }
  approve_device "$JAR" "$url"

  # The daemon prefixes each tunnel's lines with its control server.
  wait_for_line "$log" "\\[$base\\].* up as " "$name's tunnel at $base"
  ok "$(grep -o "\[$base\].* up as .*" "$log" | head -1)"
}

tunnel_ip() {
  local netns="$1" iface="$2"
  local -a prefix=()
  [[ -n "$netns" ]] && prefix=(ip netns exec "$netns")
  "${prefix[@]}" ip -4 -o addr show dev "$iface" | awk '{print $4}' | cut -d/ -f1
}

# Builds one side: a NAT router and the node behind it.
build_site() {
  local site="$1" nat="$2" public="$3" lan="$4"
  ip netns add "$nat"
  ip netns add "$site"

  ip link add "wan-$site" type veth peer name "br-$site"
  ip link set "wan-$site" netns "$nat"
  ip link set "br-$site" master br0 up
  ip netns exec "$nat" ip link set lo up
  ip netns exec "$nat" ip addr add "$public/24" dev "wan-$site"
  ip netns exec "$nat" ip link set "wan-$site" up

  ip link add "lan-$site" type veth peer name "eth-$site"
  ip link set "lan-$site" netns "$nat"
  ip link set "eth-$site" netns "$site"
  ip netns exec "$nat" ip addr add "$lan.1/24" dev "lan-$site"
  ip netns exec "$nat" ip link set "lan-$site" up
  ip netns exec "$site" ip link set lo up
  ip netns exec "$site" ip addr add "$lan.2/24" dev "eth-$site"
  ip netns exec "$site" ip link set "eth-$site" up
  ip netns exec "$site" ip route add default via "$lan.1"

  # A real internet path has latency. Without it the test is unrealistically
  # harsh: both sides must then start punching within microseconds, because a
  # packet arriving before the peer has sent anything creates an unsolicited
  # inbound flow at its NAT, which occupies the mapping the peer needs.
  ip netns exec "$nat" tc qdisc add dev "wan-$site" root netem delay 25ms
  ip netns exec "$nat" ip route add default via "$INET"
  ip netns exec "$nat" sysctl -qw net.ipv4.ip_forward=1
  ip netns exec "$nat" nft add table ip nat
  ip netns exec "$nat" nft "add chain ip nat post { type nat hook postrouting priority 100; }"
  ip netns exec "$nat" nft "add rule ip nat post oifname \"wan-$site\" masquerade ${MASQUERADE_FLAGS:-}"

  # A real NAT router drops unsolicited inbound traffic aimed at itself. This
  # matters for more than security: a dropped packet never gets a confirmed
  # conntrack entry, so it cannot occupy the address tuple the node behind the
  # NAT needs for its own outbound mapping.
  ip netns exec "$nat" nft add table ip filter
  ip netns exec "$nat" nft "add chain ip filter input { type filter hook input priority 0; policy accept; }"
  ip netns exec "$nat" nft "add rule ip filter input iifname \"wan-$site\" ct state new,invalid drop"
}

# Builds the whole two-NAT topology. $1 is passed to the masquerade statement,
# so "random" turns both routers into symmetric NATs.
build_two_nat_sites() {
  MASQUERADE_FLAGS="${1:-}"
  mount -t tmpfs tmpfs /run
  mkdir -p /run/wireguard
  ip link set lo up
  ip link add br0 type bridge
  ip addr add "$INET/24" dev br0
  ip link set br0 up

  # The real internet silently drops traffic aimed at private ranges. Without
  # this, probing a peer's LAN candidate draws an ICMP error from the first hop,
  # which tears down the NAT mapping the punching depends on.
  ip route add blackhole 10.0.0.0/8
  ip route add blackhole 192.168.0.0/16

  build_site nodea nata 203.0.113.10 10.1.0
  build_site nodeb natb 203.0.113.20 10.2.0

  ip netns exec nodea ping -c1 -W2 "$INET" >/dev/null || fail "node A cannot reach the internet segment"
  ip netns exec nodeb ping -c1 -W2 "$INET" >/dev/null || fail "node B cannot reach the internet segment"
  if ip netns exec nodea ping -c1 -W2 10.2.0.2 >/dev/null 2>&1; then
    fail "node A can reach node B's LAN address — the NATs are not isolating"
  fi
}
