#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELAYAUTH_ROOT="${RELAYAUTH_ROOT:-$ROOT_DIR}"
RELAY_SCRIPT="$RELAYAUTH_ROOT/scripts/relay/relay.sh"
DOTFILE_PARSER_TS="$RELAYAUTH_ROOT/scripts/relay/dotfile-parser.ts"
DOTFILE_COMPILER_TS="$RELAYAUTH_ROOT/scripts/relay/dotfile-compiler.ts"
RELAYAUTH_BASE_URL="${RELAYAUTH_BASE_URL:-http://127.0.0.1:8787}"
RELAYFILE_BASE_URL="${RELAYFILE_BASE_URL:-http://127.0.0.1:8080}"
RELAYFILE_ROOT="${RELAYFILE_ROOT:-$(cd "$RELAYAUTH_ROOT/../relayfile" 2>/dev/null && pwd || true)}"
RELAYFILE_MOUNT_BIN="${RELAYFILE_MOUNT_BIN:-$RELAYFILE_ROOT/bin/relayfile-mount}"

PASS=0
FAIL=0
SKIP=0
TESTDIR=""

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_BLUE='\033[0;34m'
COLOR_RESET='\033[0m'

print_section() {
  printf "%b[INFO]%b %s\n" "$COLOR_BLUE" "$COLOR_RESET" "$1"
}

pass() {
  PASS=$((PASS + 1))
  printf "%b[PASS]%b %s\n" "$COLOR_GREEN" "$COLOR_RESET" "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf "%b[FAIL]%b %s\n" "$COLOR_RED" "$COLOR_RESET" "$1"
}

skip() {
  SKIP=$((SKIP + 1))
  printf "%b[SKIP]%b %s\n" "$COLOR_YELLOW" "$COLOR_RESET" "$1"
}

cleanup() {
  if [[ -n "$TESTDIR" && -d "$TESTDIR" ]]; then
    rm -rf "$TESTDIR"
  fi
}

trap cleanup EXIT

require_file() {
  local file_path="$1"
  if [[ ! -f "$file_path" ]]; then
    fail "Missing required file: $file_path"
    return 1
  fi
  return 0
}

require_cmd() {
  local cmd_name="$1"
  if ! command -v "$cmd_name" >/dev/null 2>&1; then
    fail "Missing required command: $cmd_name"
    return 1
  fi
  return 0
}

check_health() {
  local url="$1"
  curl --max-time 2 -fsS "$url" >/dev/null 2>&1
}

extract_token_scopes() {
  local token="$1"
  TOKEN_INPUT="$token" node - <<'NODE'
const token = process.env.TOKEN_INPUT || "";
if (!token) {
  process.exit(1);
}

const parts = token.split('.');
if (parts.length < 2) {
  process.exit(2);
}

const normalizeB64 = (value) => {
  const fixed = value.replace(/-/g, '+').replace(/_/g, '/');
  return fixed + '='.repeat((4 - (fixed.length % 4)) % 4);
};

let payload;
try {
  const payloadRaw = Buffer.from(normalizeB64(parts[1]), 'base64').toString('utf8');
  payload = JSON.parse(payloadRaw);
} catch {
  process.exit(3);
}

const addValue = (next, seen) => {
  if (!next) {
    return;
  }
  if (Array.isArray(next)) {
    for (const item of next) addValue(item, seen);
    return;
  }
  if (typeof next === 'string') {
    seen.push(next);
  }
  if (typeof next === 'object' && next !== null && Array.isArray(next.scopes)) {
    for (const item of next.scopes) addValue(item, seen);
  }
};

const scopeValues = [];
addValue(payload.scope, scopeValues);
addValue(payload.scopes, scopeValues);
addValue(payload.scp, scopeValues);
addValue(payload.permissions, scopeValues);
addValue(payload.data?.scopes, scopeValues);
addValue(payload.access?.scopes, scopeValues);
addValue(payload.agent?.scopes, scopeValues);

const unique = [...new Set(scopeValues.filter(Boolean))];
if (unique.length === 0) {
  process.exit(4);
}

process.stdout.write(unique.sort().join('\n'));
NODE
}

assert_parser() {
  local parser_json
  parser_json="$TESTDIR/.e2e-parser.json"

  if ! npx tsx "$DOTFILE_PARSER_TS" --project-dir "$TESTDIR" --agent default-agent > "$parser_json" 2>/tmp/e2e-parser.err; then
    fail "dotfile parser invocation failed"
    return 1
  fi

  if node - "$parser_json" <<'NODE'
const fs = require('node:fs');
const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const ignored = new Set(payload.ignoredPatterns || []);
const readonly = new Set(payload.readonlyPatterns || []);

if (!ignored.has('.env') || !ignored.has('secrets/')) {
  process.exit(1);
}
if (!readonly.has('README.md')) {
  process.exit(2);
}
process.exit(0);
NODE
  then
    pass "Dotfile parser correctly includes .env and secrets/ as ignored and README.md as readonly"
  else
    fail "Dotfile parser output did not match expected ignore/readonly patterns"
  fi
}

assert_token_scopes() {
  local token="$1"
  local scopes

  scopes="$(extract_token_scopes "$token")" || {
    fail "Could not decode token payload or locate scopes"
    return 1
  }

  if printf '%s\n' "$scopes" | grep -Eq '^relayfile:fs:(read|write):/\.env$'; then
    fail "Token scopes included .env"
  else
    pass "Token scopes do not include .env"
  fi

  if printf '%s\n' "$scopes" | grep -Eq '^relayfile:fs:read:/src/app\.ts$'; then
    pass "Token scopes include src/app.ts read access"
  else
    fail "Token scopes do not include src/app.ts read access"
  fi

  if printf '%s\n' "$scopes" | grep -Eq '^relayfile:fs:write:/src/app\.ts$'; then
    pass "Token scopes include src/app.ts write access"
  else
    fail "Token scopes do not include src/app.ts write access"
  fi
}

assert_mount_permissions() {
  local token="$1"
  local workspace="$(basename "$TESTDIR")"
  local mount_dir="$TESTDIR/.relay/workspace-default-agent"
  local mount_log="$TESTDIR/.e2e-mount.log"

  rm -rf "$mount_dir"
  if [[ -z "$RELAYFILE_ROOT" || ! -x "$RELAYFILE_MOUNT_BIN" ]]; then
    fail "relayfile mount binary missing or not executable: $RELAYFILE_MOUNT_BIN"
    return 1
  fi

  if ! "$RELAYFILE_MOUNT_BIN" \
      --base-url "$RELAYFILE_BASE_URL" \
      --workspace "$workspace" \
      --token "$token" \
      --local-dir "$mount_dir" \
      --once >"$mount_log" 2>&1; then
    fail "relayfile-mount returned non-zero status (see $mount_log)"
    return 1
  fi

  for _ in {1..20}; do
    if [[ -d "$mount_dir" ]]; then
      break
    fi
    sleep 0.25
  done

  if [[ ! -d "$mount_dir" ]]; then
    fail "Mounted workspace directory was not created"
    return 1
  fi

  if [[ -d "$mount_dir/secrets" ]]; then
    fail "Workspace mount exposed secrets/ directory"
  else
    pass "Workspace mount hid secrets/ directory"
  fi

  if [[ -f "$mount_dir/README.md" ]] && [[ ! -w "$mount_dir/README.md" ]]; then
    pass "Workspace mount marks README.md as readonly"
  elif [[ -f "$mount_dir/README.md" ]]; then
    fail "Workspace mount allowed WRITE on README.md"
  else
    fail "Workspace mount missing README.md"
  fi

  if [[ -f "$mount_dir/src/app.ts" ]] && [[ -w "$mount_dir/src/app.ts" ]]; then
    pass "Workspace mount keeps src/app.ts writable"
  elif [[ -f "$mount_dir/src/app.ts" ]]; then
    fail "Workspace mount marked src/app.ts read-only"
  else
    fail "Workspace mount missing src/app.ts"
  fi
}

main() {
  print_section "Preparing fixtures"
  TESTDIR="$(mktemp -d)"

  mkdir -p "$TESTDIR/src" "$TESTDIR/secrets"
  printf 'export function app() { return "ok"; }\n' >"$TESTDIR/src/app.ts"
  printf "# Project\n" >"$TESTDIR/README.md"
  printf "DB_URL=postgres://localhost/db\n" >"$TESTDIR/.env"
  printf "super-secret\n" >"$TESTDIR/secrets/key.txt"

  cat >"$TESTDIR/.agentignore" <<'EOF_DOTFILE'
.env
secrets/
EOF_DOTFILE
  cat >"$TESTDIR/.agentreadonly" <<'EOF_DOTFILE'
README.md
EOF_DOTFILE

  require_file "$DOTFILE_PARSER_TS" || return 1
  require_file "$DOTFILE_COMPILER_TS" || return 1
  require_file "$RELAY_SCRIPT" || return 1
  require_cmd npx || return 1
  require_cmd curl || return 1
  require_cmd node || return 1

  cd "$TESTDIR"
  source "$RELAY_SCRIPT"

  assert_parser

  if check_health "$RELAYAUTH_BASE_URL/health" && check_health "$RELAYFILE_BASE_URL/health"; then
    print_section "Services are available; validating token scopes + mount behavior"
    if relay provision >/tmp/e2e-relay-provision.log 2>&1; then
      local token
      token="$(cat .relay/tokens/default-agent.jwt 2>/dev/null || true)"
      if [[ -z "$token" ]]; then
        fail "Provision completed without writing .relay/tokens/default-agent.jwt"
      else
        assert_token_scopes "$token"
        assert_mount_permissions "$token"
      fi
    else
      fail "relay provision failed (see /tmp/e2e-relay-provision.log)"
    fi
  else
    skip "Services not healthy for token/mount checks: relay auth ($RELAYAUTH_BASE_URL) and relayfile ($RELAYFILE_BASE_URL)"
  fi

  echo
  print_section "Summary"
  echo "PASS: $PASS"
  echo "FAIL: $FAIL"
  echo "SKIP: $SKIP"

  if [[ "$FAIL" -ne 0 ]]; then
    exit 1
  fi
}

main "$@"
