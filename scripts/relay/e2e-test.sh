#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELAYAUTH_ROOT="${RELAYAUTH_ROOT:-$ROOT_DIR}"
RELAYFILE_ROOT="${RELAYFILE_ROOT:-$(cd "$ROOT_DIR/../relayfile" 2>/dev/null && pwd || true)}"

RELAYAUTH_BASE_URL="${RELAYAUTH_BASE_URL:-http://127.0.0.1:8787}"
RELAYFILE_BASE_URL="${RELAYFILE_BASE_URL:-http://127.0.0.1:8080}"
WORKSPACE_ID="${WORKSPACE_ID:-ws_e2e}"
ORG_ID="${ORG_ID:-org_dev}"
SHARED_SECRET="e2e-test-secret"

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_BLUE='\033[0;34m'
COLOR_RESET='\033[0m'

FAILURES=0
ASSERTIONS=0
RELAYAUTH_PID=""
RELAYFILE_PID=""
LOG_DIR="$ROOT_DIR/.relay/e2e-logs"
mkdir -p "$LOG_DIR"
RELAYAUTH_LOG="$LOG_DIR/relayauth.log"
RELAYFILE_LOG="$LOG_DIR/relayfile.log"

print_info() {
  printf "%b[INFO]%b %s\n" "$COLOR_BLUE" "$COLOR_RESET" "$1"
}

print_warn() {
  printf "%b[WARN]%b %s\n" "$COLOR_YELLOW" "$COLOR_RESET" "$1"
}

print_pass() {
  ASSERTIONS=$((ASSERTIONS + 1))
  printf "%b[PASS]%b %s\n" "$COLOR_GREEN" "$COLOR_RESET" "$1"
}

print_fail() {
  ASSERTIONS=$((ASSERTIONS + 1))
  FAILURES=$((FAILURES + 1))
  printf "%b[FAIL]%b %s\n" "$COLOR_RED" "$COLOR_RESET" "$1"
}

cleanup() {
  local pid
  for pid in "$RELAYAUTH_PID" "$RELAYFILE_PID"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
      wait "$pid" 2>/dev/null || true
    fi
  done
}

trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    print_fail "Missing required command: $1"
    return 1
  fi
  return 0
}

wait_for_health() {
  local url="$1"
  local name="$2"
  local attempts=30
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "$url" >/dev/null 2>&1; then
      print_pass "$name health endpoint is reachable ($url)"
      return 0
    fi
    sleep 1
  done

  print_fail "$name health endpoint did not become ready within 30s ($url)"
  return 1
}

json_get() {
  local json="$1"
  local expr="$2"
  node -e "const obj = JSON.parse(process.argv[1]); const out = ${expr}; if (out === undefined || out === null) process.exit(1); process.stdout.write(String(out));" "$json"
}

http_json_status() {
  local method="$1"
  local url="$2"
  local token="$3"
  local body="${4:-}"
  local out_file
  out_file="$(mktemp)"
  local status

  if [[ -n "$body" ]]; then
    status="$(curl -sS -o "$out_file" -w '%{http_code}' -X "$method" "$url" \
      -H "authorization: Bearer $token" \
      -H "content-type: application/json" \
      --data "$body")"
  else
    status="$(curl -sS -o "$out_file" -w '%{http_code}' -X "$method" "$url" \
      -H "authorization: Bearer $token")"
  fi

  printf '%s\n' "$status"
  cat "$out_file"
  rm -f "$out_file"
}

expect_status() {
  local description="$1"
  local expected_status="$2"
  local method="$3"
  local url="$4"
  local token="$5"
  local body="${6:-}"

  local response
  response="$(http_json_status "$method" "$url" "$token" "$body")"
  local status
  status="$(printf '%s\n' "$response" | sed -n '1p')"
  if [[ "$status" == "$expected_status" ]]; then
    print_pass "$description (expected $expected_status, got $status)"
    return 0
  fi

  local payload
  payload="$(printf '%s\n' "$response" | sed '1d')"
  print_fail "$description (expected $expected_status, got $status) payload=$payload"
  return 1
}

start_services() {
  export SHARED_SECRET

  if ! require_cmd curl || ! require_cmd node || ! require_cmd npx || ! require_cmd go; then
    return 1
  fi

  if [[ -z "$RELAYFILE_ROOT" || ! -d "$RELAYFILE_ROOT" ]]; then
    print_fail "relayfile repository not found. Set RELAYFILE_ROOT to a valid path."
    return 1
  fi

  print_info "Starting relayauth on :8787"
  (
    cd "$RELAYAUTH_ROOT"
    SIGNING_KEY="$SHARED_SECRET" PORT=8787 npm run start
  ) >"$RELAYAUTH_LOG" 2>&1 &
  RELAYAUTH_PID=$!

  print_info "Starting relayfile on :8080"
  (
    cd "$RELAYFILE_ROOT"
    RELAYFILE_JWT_SECRET="$SHARED_SECRET" RELAYFILE_BACKEND_PROFILE=durable-local go run ./cmd/relayfile
  ) >"$RELAYFILE_LOG" 2>&1 &
  RELAYFILE_PID=$!

  wait_for_health "$RELAYAUTH_BASE_URL/health" "relayauth" || return 1
  wait_for_health "$RELAYFILE_BASE_URL/health" "relayfile" || return 1

  return 0
}

provision_identity() {
  local name="$1"
  local admin_token="$2"

  local body
  body="$(node -e "console.log(JSON.stringify({name: process.argv[1], type: 'agent', sponsorId: 'user_dev', workspaceId: process.argv[2], scopes: []}))" "$name" "$WORKSPACE_ID")"

  local response
  response="$(http_json_status "POST" "$RELAYAUTH_BASE_URL/v1/identities" "$admin_token" "$body")"
  local status json id
  status="$(printf '%s\n' "$response" | sed -n '1p')"
  json="$(printf '%s\n' "$response" | sed '1d')"

  if [[ "$status" != "201" ]]; then
    print_fail "Create identity '$name' returned $status payload=$json"
    return 1
  fi

  id="$(json_get "$json" "obj.id" 2>/dev/null)" || {
    print_fail "Create identity '$name' did not return an id"
    return 1
  }

  print_pass "Created identity '$name'"
  printf '%s\n' "$id"
  return 0
}

issue_token() {
  local identity_id="$1"
  local scopes_json="$2"
  local admin_token="$3"

  local body
  body="$(IDENTITY_ID="$identity_id" SCOPES_JSON="$scopes_json" node -e 'console.log(JSON.stringify({identityId: process.env.IDENTITY_ID, scopes: JSON.parse(process.env.SCOPES_JSON), audience: ["relayauth", "relayfile"]}))')"

  local response
  response="$(http_json_status "POST" "$RELAYAUTH_BASE_URL/v1/tokens" "$admin_token" "$body")"
  local status json token
  status="$(printf '%s\n' "$response" | sed -n '1p')"
  json="$(printf '%s\n' "$response" | sed '1d')"

  if [[ "$status" != "200" ]]; then
    print_fail "Issue token for identity '$identity_id' returned $status payload=$json"
    return 1
  fi

  token="$(json_get "$json" "obj.accessToken ?? obj.access_token ?? obj.token" 2>/dev/null)" || {
    print_fail "Token response for identity '$identity_id' did not contain an access token"
    return 1
  }

  print_pass "Issued token for identity '$identity_id'"
  printf '%s\n' "$token"
  return 0
}

put_file() {
  local token="$1"
  local path="$2"
  local content="$3"

  local body
  body="$(CONTENT="$content" node -e 'console.log(JSON.stringify({content: process.env.CONTENT, encoding: "utf-8"}))')"
  expect_status "PUT $path" "200" "PUT" "$RELAYFILE_BASE_URL/v1/workspaces/$WORKSPACE_ID/fs/file?path=$path" "$token" "$body"
}

main() {
  print_info "E2E relay integration test starting"
  print_info "Logs: relayauth=$RELAYAUTH_LOG relayfile=$RELAYFILE_LOG"

  if ! start_services; then
    print_warn "Startup failed. Recent relayauth log:"
    tail -n 40 "$RELAYAUTH_LOG" 2>/dev/null || true
    print_warn "Recent relayfile log:"
    tail -n 40 "$RELAYFILE_LOG" 2>/dev/null || true
    echo
    printf "Assertions: %s, Failures: %s\n" "$ASSERTIONS" "$FAILURES"
    exit 1
  fi

  print_info "Generating admin token via generate-dev-token.sh"
  local admin_token
  admin_token="$(
    cd "$RELAYAUTH_ROOT"
    SIGNING_KEY="$SHARED_SECRET" \
    RELAYAUTH_SUB="e2e-admin" \
    RELAYAUTH_ORG="$ORG_ID" \
    RELAYAUTH_WORKSPACE="$WORKSPACE_ID" \
    RELAYAUTH_SPONSOR="user_dev" \
    RELAYAUTH_SCOPES_JSON='["*"]' \
    RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]' \
    bash "$RELAYAUTH_ROOT/scripts/generate-dev-token.sh"
  )"

  if [[ -z "$admin_token" ]]; then
    print_fail "Failed to generate admin token"
    echo
    printf "Assertions: %s, Failures: %s\n" "$ASSERTIONS" "$FAILURES"
    exit 1
  fi
  print_pass "Generated admin token"

  print_info "Provisioning reader and writer identities + tokens"
  local reader_identity writer_identity reader_token writer_token

  reader_identity="$(provision_identity "test-reader" "$admin_token")" || true
  writer_identity="$(provision_identity "test-writer" "$admin_token")" || true

  if [[ -n "$reader_identity" ]]; then
    reader_token="$(issue_token "$reader_identity" '["relayfile:fs:read:/src/*"]' "$admin_token")" || true
  else
    reader_token=""
  fi

  if [[ -n "$writer_identity" ]]; then
    writer_token="$(issue_token "$writer_identity" '["relayfile:fs:read:*","relayfile:fs:write:/src/*"]' "$admin_token")" || true
  else
    writer_token=""
  fi

  if [[ -z "$reader_token" || -z "$writer_token" ]]; then
    print_fail "Provisioning tokens failed; cannot continue permission assertions"
    echo
    printf "Assertions: %s, Failures: %s\n" "$ASSERTIONS" "$FAILURES"
    exit 1
  fi

  print_info "Seeding files and ACL markers"
  put_file "$admin_token" "/src/hello.ts" "export const hello = 'world';"
  put_file "$admin_token" "/secrets/key.pem" "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----"

  local acl_json
  acl_json='{"semantics":{"permissions":["deny:agent:test-reader","allow:scope:relayfile:fs:read:/secrets/*"]}}'
  put_file "$admin_token" "/secrets/.relayfile.acl" "$acl_json"

  print_info "Running reader assertions"
  expect_status "Reader GET /src/hello.ts" "200" "GET" "$RELAYFILE_BASE_URL/v1/workspaces/$WORKSPACE_ID/fs/file?path=/src/hello.ts" "$reader_token"
  expect_status "Reader GET /secrets/key.pem" "403" "GET" "$RELAYFILE_BASE_URL/v1/workspaces/$WORKSPACE_ID/fs/file?path=/secrets/key.pem" "$reader_token"

  local reader_put_body
  reader_put_body='{"content":"export const hello = \"reader\";","encoding":"utf-8"}'
  expect_status "Reader PUT /src/hello.ts (no write scope)" "403" "PUT" "$RELAYFILE_BASE_URL/v1/workspaces/$WORKSPACE_ID/fs/file?path=/src/hello.ts" "$reader_token" "$reader_put_body"

  print_info "Running writer assertions"
  expect_status "Writer GET /src/hello.ts" "200" "GET" "$RELAYFILE_BASE_URL/v1/workspaces/$WORKSPACE_ID/fs/file?path=/src/hello.ts" "$writer_token"

  local writer_src_put_body writer_secret_put_body
  writer_src_put_body='{"content":"export const hello = \"writer\";","encoding":"utf-8"}'
  writer_secret_put_body='{"content":"should-not-write","encoding":"utf-8"}'

  expect_status "Writer PUT /src/hello.ts" "200" "PUT" "$RELAYFILE_BASE_URL/v1/workspaces/$WORKSPACE_ID/fs/file?path=/src/hello.ts" "$writer_token" "$writer_src_put_body"
  expect_status "Writer PUT /secrets/key.pem (no /secrets write scope)" "403" "PUT" "$RELAYFILE_BASE_URL/v1/workspaces/$WORKSPACE_ID/fs/file?path=/secrets/key.pem" "$writer_token" "$writer_secret_put_body"

  echo
  if [[ "$FAILURES" -eq 0 ]]; then
    printf "%bE2E RESULT: PASS%b\n" "$COLOR_GREEN" "$COLOR_RESET"
    printf "Assertions: %s, Failures: %s\n" "$ASSERTIONS" "$FAILURES"
    exit 0
  fi

  printf "%bE2E RESULT: FAIL%b\n" "$COLOR_RED" "$COLOR_RESET"
  printf "Assertions: %s, Failures: %s\n" "$ASSERTIONS" "$FAILURES"
  print_warn "Inspect logs for details: $RELAYAUTH_LOG, $RELAYFILE_LOG"
  exit 1
}

main "$@"
