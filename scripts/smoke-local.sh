#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-8787}"
BASE_URL="${BASE_URL:-http://${HOST}:${PORT}}"

server_started=false
log_file=""
server_pid=""

cleanup() {
  if [[ "$server_started" == "true" ]] && [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi

  if [[ -n "$log_file" ]] && [[ -f "$log_file" ]]; then
    rm -f "$log_file"
  fi
}

trap cleanup EXIT

wait_for_server() {
  for _ in $(seq 1 40); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  return 1
}

assert_json_field() {
  local json="$1"
  local expression="$2"
  node -e "const value = JSON.parse(process.argv[1]); if (!(${expression})) process.exit(1);" "$json"
}

if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
  echo "Reusing existing relayauth server at $BASE_URL"
else
  log_file="$(mktemp -t relayauth-local.XXXXXX.log)"
  (
    cd "$ROOT"
    PORT="$PORT" HOST="$HOST" SIGNING_KEY="${SIGNING_KEY:-dev-secret}" npm run start >"$log_file" 2>&1
  ) &
  server_pid="$!"
  server_started=true

  if ! wait_for_server; then
    echo "Local server did not become ready. Recent output:" >&2
    if [[ -f "$log_file" ]]; then
      tail -n 80 "$log_file" >&2
    fi
    exit 1
  fi
fi

health_json="$(curl -fsS "$BASE_URL/health")"
assert_json_field "$health_json" "value.status === 'ok'"

discovery_json="$(curl -fsS "$BASE_URL/.well-known/agent-configuration")"
assert_json_field "$discovery_json" "typeof value.issuer === 'string' && typeof value.identity_endpoint === 'string'"

token="$("$ROOT/scripts/generate-dev-token.sh")"
stamp="$(date +%s)"
role_name="local-smoke-${stamp}"
identity_name="local-smoke-${stamp}"

role_json="$(curl -fsS \
  -X POST \
  "$BASE_URL/v1/roles" \
  -H "authorization: Bearer $token" \
  -H "content-type: application/json" \
  --data "{\"name\":\"${role_name}\",\"description\":\"Local smoke role\",\"scopes\":[\"relayauth:identity:read:*\"]}")"
role_id="$(node -e "const value = JSON.parse(process.argv[1]); if (!value.id) process.exit(1); process.stdout.write(value.id);" "$role_json")"

roles_list_json="$(curl -fsS \
  "$BASE_URL/v1/roles" \
  -H "authorization: Bearer $token")"
assert_json_field "$roles_list_json" "Array.isArray(value.data) && value.data.some((role) => role.id === '$role_id')"

identity_json="$(curl -fsS \
  -X POST \
  "$BASE_URL/v1/identities" \
  -H "authorization: Bearer $token" \
  -H "content-type: application/json" \
  --data "{\"name\":\"${identity_name}\",\"sponsorId\":\"user_dev\"}")"
identity_id="$(node -e "const value = JSON.parse(process.argv[1]); if (!value.id) process.exit(1); process.stdout.write(value.id);" "$identity_json")"

fetched_identity_json="$(curl -fsS \
  "$BASE_URL/v1/identities/${identity_id}" \
  -H "authorization: Bearer $token")"
assert_json_field "$fetched_identity_json" "value.id === '$identity_id' && value.name === '$identity_name'"

echo "Local smoke test passed"
echo "  base_url: $BASE_URL"
echo "  role_id: $role_id"
echo "  identity_id: $identity_id"
