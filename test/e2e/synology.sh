#!/usr/bin/env bash
#
# deploy/synology end to end, as it would run on the NAS but on this Docker
# host's kernel: the image, the compose file, login with a pre-auth key, the
# static service list, forwarding through Caddy to stand-in services, a policy
# enforced with iptables-legacy on the connector, and a clean stop. A second
# device in the wave does the asking.
#
#   ./test/e2e/synology.sh
#
# Needs Docker with compose. Builds the image for the host's architecture.
# WAVE_SUBNET_PREFIX (default 172.31.250) where that range is taken.
# WAVE_E2E_KEEP=1 leaves the stack running.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
work="$(mktemp -d)"

step() { printf '\n== %s\n' "$*"; }
ok()   { printf '  ok %s\n' "$*"; }

export WAVE_E2E_REPO="$repo"
compose() {
  docker compose -p wave-e2e-synology --env-file "$work/env" \
    -f "$repo/deploy/synology/docker-compose.yml" -f "$here/synology/override.yml" "$@"
}
fail() {
  printf 'FAIL: %s\n' "$*"
  compose logs --tail 40 daemon connector login peer-daemon 2>&1 || true
  exit 1
}
cleanup() {
  [[ "${WAVE_E2E_KEEP:-0}" == "1" ]] || compose down -v --remove-orphans >/dev/null 2>&1 || true
  rm -rf "$work"
}
trap cleanup EXIT

write_env() { # <auth key>
  cat >"$work/env" <<ENV
WAVE_IMAGE=wave-e2e-synology:latest
WAVE_CONTROL_URL=http://control:8080
WAVE_AUTH_KEY=$1
WAVE_DOMAIN=robin.wave.internal
WAVE_SERVICES=ha,paperless,openclaw
WAVE_SERVICES_NO_TLS=ha,paperless,openclaw
WAVE_SYNC_INTERVAL_MS=5000
HA_UPSTREAM=stub-ha:8123
PAPERLESS_UPSTREAM=stub-paperless:8777
OPENCLAW_UPSTREAM=192.0.2.10:18789
WAVE_SUBNET_PREFIX=${WAVE_SUBNET_PREFIX:-172.31.250}
ENV
}

# Retries a check for up to a minute.
until_ok() { # <what> <command...>
  local what="$1"
  shift
  for _ in $(seq 1 60); do
    "$@" >/dev/null 2>&1 && { ok "$what"; return 0; }
    sleep 1
  done
  fail "$what"
}

step "image"
docker build -q -f "$repo/deploy/synology/Dockerfile" -t wave-synology:e2e "$repo" >/dev/null
docker build -q --build-arg IMAGE=wave-synology:e2e -t wave-e2e-synology:latest "$here/synology" >/dev/null
ok "built"

step "control server and a wave"
write_env unset
compose up -d control tool >/dev/null 2>&1 || fail "control did not start"
web() { compose exec -T tool curl -s -b /tmp/jar -c /tmp/jar "$@"; }
until_ok "control server is up" web -f http://control:8080/healthz
redirect=$(web -o /dev/null -w '%{redirect_url}' http://control:8080/auth/dev/start)
state=$(sed -n 's/.*state=\([^&]*\).*/\1/p' <<<"$redirect")
web -o /dev/null "http://control:8080/auth/dev/callback?code=robin%40example.com&state=$state"
web -o /dev/null -X POST http://control:8080/waves \
  --data-urlencode name=robin --data-urlencode suffix=robin.wave.internal
wave_id=$(web http://control:8080/api/me | sed -n 's/.*"waves":\[{"id":"\([^"]*\)".*/\1/p')
[[ -n "$wave_id" ]] || fail "no wave: $(web http://control:8080/api/me)"
auth_key() { web -X POST "http://control:8080/__e2e/auth-key?wave=$wave_id" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p'; }
ok "wave $wave_id"

step "the NAS stack"
write_env "$(auth_key)"
compose up -d net daemon login connector caddy stub-ha stub-paperless >"$work/up.log" 2>&1 || { tail -30 "$work/up.log"; fail "the stack did not start"; }
connector_says() { compose logs connector 2>&1 | grep -qE "$1"; }
until_ok "connector forwards with iptables-legacy" connector_says 'forwarding with iptables \(iptables-legacy\)'
until_ok "services declared from WAVE_SERVICES" connector_says 'services: ha '
until_ok "rules applied" connector_says "forwarding wave0 to ${WAVE_SUBNET_PREFIX:-172.31.250}.10"
address_of() { compose logs connector 2>&1 | grep -oE "services: .*" | tail -1 | grep -oE "$1 [0-9.]+" | cut -d' ' -f2; }
ha=$(address_of ha)
paperless=$(address_of paperless)
ok "ha $ha, paperless $paperless"

step "a second device"
compose up -d peer peer-daemon peer-curl >"$work/up.log" 2>&1 || { tail -30 "$work/up.log"; fail "the second device did not start"; }
key=$(auth_key)
peer_login() { compose exec -T peer-daemon sh -c "test -S /run/wave/waved.sock && wave login http://control:8080 --auth-key $key"; }
until_ok "joined" peer_login

fetch() { # <name> <address>
  compose exec -T peer-curl curl -s -m 3 --resolve "$1.robin.wave.internal:80:$2" "http://$1.robin.wave.internal/"
}
answers() { [[ "$(fetch "$1" "$2")" == "$3" ]]; }

step "through the tunnel, the connector and Caddy"
until_ok "ha answers" answers ha "$ha" stub-ha
until_ok "paperless answers" answers paperless "$paperless" stub-paperless

step "a policy, enforced on the connector with iptables"
policy() { # <json>
  [[ $(web -o /dev/null -w '%{http_code}' -X PUT -H 'content-type: application/json' \
    --data "$1" "http://control:8080/api/waves/$wave_id/acl") == 200 ]] || fail "setting the policy"
}
rules() { compose exec -T connector iptables-legacy-save; }
has_rule() { rules | grep -qE "$1"; }
policy '{"acls":[{"src":["*"],"dst":["svc:ha"],"ports":["tcp:443"]}]}'
until_ok "policy chain is in" has_rule '^-A PREROUTING -i wave0 -j WAVE-ACL-wave0'
until_ok "the granted port is in the chain" has_rule '^-A WAVE-ACL-wave0 .*--dport 443 -j RETURN'
sleep 3
answers ha "$ha" stub-ha && fail "ha:80 answered although only 443 is granted"
ok "ha:80 is dropped"
compose logs daemon 2>&1 | grep -q 'NOT enforced' && fail "the daemon says the policy is not enforced"
compose logs daemon 2>&1 | grep -q 'policy enforced' || fail "the daemon does not say the policy is enforced"
ok "the daemon reports it enforced"
policy '{"acls":[{"src":["*"],"dst":["svc:ha"],"ports":["tcp:80"]}]}'
until_ok "ha answers once 80 is granted" answers ha "$ha" stub-ha
answers paperless "$paperless" stub-paperless && fail "paperless answered although no rule names it"
ok "paperless stays closed"

step "restarts leave one set of rules"
compose restart connector >/dev/null 2>&1
until_ok "ha answers after a connector restart" answers ha "$ha" stub-ha
[[ $(rules | grep -c '^-A PREROUTING -j WAVE-CONN-PRE') == 1 ]] || fail "not exactly one jump: $(rules)"
compose restart daemon >/dev/null 2>&1
until_ok "ha answers after a daemon restart" answers ha "$ha" stub-ha
[[ $(rules | grep -c 'j WAVE-ACL-wave0') == 1 ]] || fail "not exactly one policy jump: $(rules)"
ok "one jump each"

step "stopping takes the rules out"
compose stop connector >/dev/null 2>&1
compose logs connector 2>&1 | grep -q 'forwarding rules removed' || fail "the connector did not say it removed them"
left=$(compose exec -T daemon sh -c 'iptables-legacy-save; ip6tables-legacy-save')
grep -q WAVE-CONN <<<"$left" && fail "connector chains left: $left"
ok "no connector chain left"
compose exec -T daemon wave down >"$work/down.log" 2>&1 || fail "wave down: $(cat "$work/down.log")"
policy_gone() { ! compose exec -T daemon sh -c 'iptables-legacy-save; ip6tables-legacy-save' | grep -q 'WAVE-'; }
until_ok "wave down takes the policy chain out too" policy_gone
compose exec -T daemon sh -c 'ip link show wave0' >/dev/null 2>&1 && fail "wave0 is still there"
ok "wave0 is gone"

printf '\nPASS: deploy/synology end to end with iptables-legacy\n'
