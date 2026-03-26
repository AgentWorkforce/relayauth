#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELAYAUTH_ROOT="${RELAYAUTH_ROOT:-$ROOT_DIR}"
RELAYFILE_ROOT="${RELAYFILE_ROOT:-$(cd "$ROOT_DIR/../relayfile" 2>/dev/null && pwd || true)}"
RELAY_SCRIPT="$RELAYAUTH_ROOT/scripts/relay/relay.sh"
PARSER_TS="$RELAYAUTH_ROOT/scripts/relay/dotfile-parser.ts"
COMPILER_TS="$RELAYAUTH_ROOT/scripts/relay/dotfile-compiler.ts"
TOKEN_SCRIPT="$RELAYAUTH_ROOT/scripts/generate-dev-token.sh"

RELAYAUTH_BASE_URL="${RELAYAUTH_BASE_URL:-http://127.0.0.1:8787}"
RELAYFILE_BASE_URL="${RELAYFILE_BASE_URL:-http://127.0.0.1:8080}"
SHARED_SECRET="${SHARED_SECRET:-e2e-test-secret}"

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_YELLOW='\033[1;33m'
COLOR_BLUE='\033[0;34m'
COLOR_BOLD='\033[1m'
COLOR_RESET='\033[0m'

ASSERTIONS=0
FAILURES=0
SKIPS=0
TEMP_DIR=""
STARTED_SERVICES=0

print_info() {
  printf "%b[INFO]%b %s\n" "$COLOR_BLUE" "$COLOR_RESET" "$1"
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

print_skip() {
  SKIPS=$((SKIPS + 1))
  printf "%b[SKIP]%b %s\n" "$COLOR_YELLOW" "$COLOR_RESET" "$1"
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    print_fail "Missing required command: $1"
    return 1
  fi
  return 0
}

cleanup() {
  if [[ "$STARTED_SERVICES" -eq 1 && -d "$TEMP_DIR" && -f "$RELAY_SCRIPT" ]]; then
    (
      cd "$TEMP_DIR"
      bash "$RELAY_SCRIPT" down >/dev/null 2>&1 || true
    )
  fi

  if [[ -n "$TEMP_DIR" && -d "$TEMP_DIR" ]]; then
    rm -rf "$TEMP_DIR"
  fi
}

trap cleanup EXIT

json_eval() {
  local json_input="$1"
  local expression="$2"
  JSON_INPUT="$json_input" node -e "const data = JSON.parse(process.env.JSON_INPUT); ${expression}"
}

json_field() {
  local json_input="$1"
  local expression="$2"
  json_eval "$json_input" "const value = ${expression}; if (value === undefined) process.exit(2); if (typeof value === 'object') console.log(JSON.stringify(value)); else console.log(String(value));"
}

write_file() {
  local file_path="$1"
  local content="$2"
  mkdir -p "$(dirname "$file_path")"
  printf "%s" "$content" >"$file_path"
}

http_health() {
  curl -fsS "$1" >/dev/null 2>&1
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
  local expected="$2"
  local method="$3"
  local url="$4"
  local token="$5"
  local body="${6:-}"

  local response status payload
  response="$(http_json_status "$method" "$url" "$token" "$body")"
  status="$(printf '%s\n' "$response" | sed -n '1p')"
  payload="$(printf '%s\n' "$response" | sed '1d')"

  if [[ "$status" == "$expected" ]]; then
    print_pass "$description (expected $expected, got $status)"
    return 0
  fi

  print_fail "$description (expected $expected, got $status) payload=$payload"
  return 1
}

run_parser_probe() {
  local project_dir="$1"
  local agent_name="$2"

  npx tsx --eval '
    (async () => {
    const path = require("node:path");
    const { pathToFileURL } = require("node:url");

    const parserPath = path.resolve(process.argv[1]);
    const projectDir = path.resolve(process.argv[2]);
    const agentName = process.argv[3];

    const parserMod = await import(pathToFileURL(parserPath).href);
    if (typeof parserMod.parseDotfiles !== "function") {
      throw new Error("dotfile-parser.ts does not export parseDotfiles()");
    }

    const perms = parserMod.parseDotfiles(projectDir, agentName);
    const readRules = (ig) => Array.isArray(ig?._rules)
      ? ig._rules
          .map((rule) => rule?.origin ?? rule?.pattern ?? rule?.input ?? null)
          .filter((value) => typeof value === "string" && value.length > 0)
      : null;
    const maybeIgnoredPatterns = readRules(perms.ignored);
    const maybeReadonlyPatterns = readRules(perms.readonly);

    const result = {
      ignoredPatterns: maybeIgnoredPatterns,
      readonlyPatterns: maybeReadonlyPatterns,
      semantics: {
        ignoresSecretsDir: Boolean(perms.ignored?.ignores?.("secrets/api-key.txt")),
        ignoresDotEnv: Boolean(perms.ignored?.ignores?.(".env")),
        readonlyReadme: typeof parserMod.isReadonly === "function"
          ? Boolean(parserMod.isReadonly("README.md", perms))
          : Boolean(perms.readonly?.ignores?.("README.md")) && !Boolean(perms.ignored?.ignores?.("README.md")),
        readonlySrcApp: typeof parserMod.isReadonly === "function"
          ? Boolean(parserMod.isReadonly("src/app.ts", perms))
          : Boolean(perms.readonly?.ignores?.("src/app.ts")),
      },
    };

    console.log(JSON.stringify(result));
    })();
  ' "$PARSER_TS" "$project_dir" "$agent_name"
}

run_compile_probe() {
  local project_dir="$1"
  local agent_name="$2"

  npx tsx --eval '
    (async () => {
    const path = require("node:path");
    const { pathToFileURL } = require("node:url");

    const parserPath = path.resolve(process.argv[1]);
    const compilerPath = path.resolve(process.argv[2]);
    const projectDir = path.resolve(process.argv[3]);
    const agentName = process.argv[4];

    const parserMod = await import(pathToFileURL(parserPath).href);
    const compilerMod = await import(pathToFileURL(compilerPath).href);

    if (typeof parserMod.parseDotfiles !== "function") {
      throw new Error("dotfile-parser.ts does not export parseDotfiles()");
    }
    if (typeof compilerMod.compileDotfiles !== "function") {
      throw new Error("dotfile-compiler.ts does not export compileDotfiles()");
    }

    const args = [projectDir, agentName, "e2e-test"];
    if (compilerMod.compileDotfiles.length >= 4) {
      args.push("local");
    }

    const compiled = compilerMod.compileDotfiles(...args);
    const aclEntries = compiled.acl instanceof Map
      ? Object.fromEntries([...compiled.acl.entries()].sort(([a], [b]) => a.localeCompare(b)))
      : compiled.acl;

    console.log(JSON.stringify({
      aclRules: aclEntries,
      scopes: compiled.scopes ?? [],
      deniedPatterns: compiled.ignoredPaths ?? [],
    }));
    })();
  ' "$PARSER_TS" "$COMPILER_TS" "$project_dir" "$agent_name"
}

assert_array_contains() {
  local json_input="$1"
  local expression="$2"
  local expected="$3"
  local message="$4"

  if JSON_INPUT="$json_input" EXPECTED_VALUE="$expected" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    const expected = process.env.EXPECTED_VALUE;
    const arr = eval(process.argv[1]);
    if (!Array.isArray(arr) || !arr.includes(expected)) process.exit(1);
  ' "$expression"; then
    print_pass "$message"
  else
    print_fail "$message"
  fi
}

assert_no_rule_for_agent() {
  local json_input="$1"
  local agent_name="$2"
  local message="$3"

  if JSON_INPUT="$json_input" AGENT_NAME="$agent_name" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    const needle = `deny:agent:${process.env.AGENT_NAME}`;
    const acl = data.aclRules ?? {};
    for (const rules of Object.values(acl)) {
      if (Array.isArray(rules) && rules.includes(needle)) process.exit(1);
    }
  '; then
    print_pass "$message"
  else
    print_fail "$message"
  fi
}

setup_temp_project() {
  TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/relay-dotfiles-e2e.XXXXXX")"

  write_file "$TEMP_DIR/src/app.ts" "export const app = 'ok';\n"
  write_file "$TEMP_DIR/src/handler.ts" "export const handler = () => 'ok';\n"
  write_file "$TEMP_DIR/secrets/api-key.txt" "super-secret\n"
  write_file "$TEMP_DIR/README.md" "# Dotfile Test\n"
  write_file "$TEMP_DIR/.env" "API_KEY=top-secret\n"
  write_file "$TEMP_DIR/.agentignore" $'secrets/\n.env\n'
  write_file "$TEMP_DIR/.agentreadonly" $'README.md\n'
}

verify_parser_contract() {
  if [[ ! -f "$PARSER_TS" ]]; then
    print_fail "Missing parser implementation: $PARSER_TS"
    return 1
  fi

  local parser_json
  if ! parser_json="$(run_parser_probe "$TEMP_DIR" "test-agent" 2>&1)"; then
    print_fail "Parser probe failed: $parser_json"
    return 1
  fi

  if JSON_INPUT="$parser_json" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    const patterns = data.ignoredPatterns;
    if (!Array.isArray(patterns)) process.exit(2);
    const expected = ["secrets/", ".env"];
    if (patterns.length !== expected.length) process.exit(1);
    for (const item of expected) {
      if (!patterns.includes(item)) process.exit(1);
    }
  '; then
    print_pass 'Parser returned ignored patterns ["secrets/", ".env"]'
  else
    local code=$?
    if [[ "$code" -eq 2 ]]; then
      print_skip "Parser does not expose raw ignored pattern arrays; verifying semantics instead"
    else
      print_fail 'Parser ignored patterns did not match ["secrets/", ".env"]'
    fi
  fi

  if JSON_INPUT="$parser_json" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    const patterns = data.readonlyPatterns;
    if (!Array.isArray(patterns)) process.exit(2);
    if (patterns.length !== 1 || patterns[0] !== "README.md") process.exit(1);
  '; then
    print_pass 'Parser returned readonly patterns ["README.md"]'
  else
    local code=$?
    if [[ "$code" -eq 2 ]]; then
      print_skip "Parser does not expose raw readonly pattern arrays; verifying semantics instead"
    else
      print_fail 'Parser readonly patterns did not match ["README.md"]'
    fi
  fi

  if JSON_INPUT="$parser_json" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    if (!data.semantics?.ignoresSecretsDir) process.exit(1);
    if (!data.semantics?.ignoresDotEnv) process.exit(1);
    if (!data.semantics?.readonlyReadme) process.exit(1);
    if (data.semantics?.readonlySrcApp) process.exit(1);
  '; then
    print_pass "Parser semantics match ignore/readonly expectations"
  else
    print_fail "Parser semantics do not match ignore/readonly expectations"
  fi
}

verify_compiler_contract() {
  if [[ ! -f "$COMPILER_TS" ]]; then
    print_fail "Missing compiler implementation: $COMPILER_TS"
    return 1
  fi

  local compile_json
  if ! compile_json="$(run_compile_probe "$TEMP_DIR" "test-agent" 2>&1)"; then
    print_fail "Compiler probe failed: $compile_json"
    return 1
  fi

  if JSON_INPUT="$compile_json" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    const acl = data.aclRules ?? {};
    const rules = acl["/secrets"] ?? acl["/secrets/"] ?? [];
    if (!Array.isArray(rules) || !rules.includes("deny:agent:test-agent")) process.exit(1);
  '; then
    print_pass "Compiler emitted deny:agent:test-agent for /secrets/"
  else
    print_fail "Compiler did not emit deny:agent:test-agent for /secrets/"
  fi

  assert_array_contains "$compile_json" "data.scopes" "relayfile:fs:read:*" \
    "Compiler scopes include relayfile:fs:read:*"

  if JSON_INPUT="$compile_json" node -e '
    const data = JSON.parse(process.env.JSON_INPUT);
    const acl = data.aclRules ?? {};
    const rules = acl["/"] ?? [];
    if (!Array.isArray(rules)) process.exit(1);
    if (!rules.includes("deny:agent:test-agent")) process.exit(1);
    if (!rules.includes("allow:scope:relayfile:fs:read:/*")) process.exit(1);
  '; then
    print_pass "Compiler restricts README.md writes via root ACL while preserving read"
  else
    print_fail "Compiler did not encode readonly root ACL as expected"
  fi
}

verify_admin_override_contract() {
  : >"$TEMP_DIR/.admin-agent.agentignore"
  : >"$TEMP_DIR/.admin-agent.agentreadonly"

  local parser_json compile_json

  if parser_json="$(run_parser_probe "$TEMP_DIR" "admin-agent" 2>/dev/null)"; then
    if JSON_INPUT="$parser_json" node -e '
      const data = JSON.parse(process.env.JSON_INPUT);
      if (data.semantics?.ignoresSecretsDir) process.exit(1);
      if (data.semantics?.ignoresDotEnv) process.exit(1);
      if (data.semantics?.readonlyReadme) process.exit(1);
    '; then
      print_pass "Per-agent empty dot files clear global ignore/readonly rules for admin-agent"
    else
      print_fail "admin-agent still inherits global dot-file restrictions"
    fi
  else
    print_fail "Parser probe for admin-agent failed"
  fi

  if compile_json="$(run_compile_probe "$TEMP_DIR" "admin-agent" 2>/dev/null)"; then
    assert_no_rule_for_agent "$compile_json" "admin-agent" \
      "Compiler emits no deny ACLs for admin-agent override"
    assert_array_contains "$compile_json" "data.scopes" "relayfile:fs:write:*" \
      "admin-agent retains write scope"
  else
    print_fail "Compiler probe for admin-agent failed"
  fi
}

maybe_start_services() {
  if http_health "$RELAYAUTH_BASE_URL/health" || http_health "$RELAYFILE_BASE_URL/health"; then
    print_skip "Integration requires an isolated zero-config stack; skipping because local relay services are already running"
    return 1
  fi

  if [[ ! -x "$RELAY_SCRIPT" && ! -f "$RELAY_SCRIPT" ]]; then
    print_skip "Integration skipped because relay CLI script is missing: $RELAY_SCRIPT"
    return 1
  fi

  if [[ -z "$RELAYFILE_ROOT" || ! -d "$RELAYFILE_ROOT" ]]; then
    print_skip "Integration skipped because RELAYFILE_ROOT is unavailable"
    return 1
  fi

  if ! command -v curl >/dev/null 2>&1 || ! command -v node >/dev/null 2>&1 || ! command -v npx >/dev/null 2>&1 || ! command -v go >/dev/null 2>&1; then
    print_skip "Integration skipped because required commands are unavailable"
    return 1
  fi

  if [[ ! -f "$TOKEN_SCRIPT" ]]; then
    print_skip "Integration skipped because token generator is missing: $TOKEN_SCRIPT"
    return 1
  fi

  print_info "Attempting isolated zero-config startup via relay.sh up"
  local up_output
  if ! up_output="$(cd "$TEMP_DIR" && bash "$RELAY_SCRIPT" up 2>&1)"; then
    print_skip "Integration skipped because relay.sh up could not start services in zero-config mode: $(printf '%s' "$up_output" | tail -n 1)"
    return 1
  fi

  STARTED_SERVICES=1
  print_pass "Started isolated relay services through relay.sh up"
  return 0
}

generate_admin_token_from_config() {
  local config_json="$1"
  local workspace secret
  workspace="$(json_field "$config_json" "data.workspace")"
  secret="$(json_field "$config_json" "data.signing_secret")"

  (
    cd "$RELAYAUTH_ROOT"
    SIGNING_KEY="$secret" \
    RELAYAUTH_SUB="dotfiles-admin" \
    RELAYAUTH_WORKSPACE="$workspace" \
    RELAYAUTH_SPONSOR="user_dev" \
    RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]' \
    RELAYAUTH_SCOPES_JSON='["relayauth:*:manage:*","relayauth:*:read:*","relayfile:*:*:*"]' \
    bash "$TOKEN_SCRIPT"
  )
}

seed_workspace_files() {
  local workspace="$1"
  local admin_token="$2"

  local body
  body='{"content":"export const app = \"ok\";\n","encoding":"utf-8"}'
  expect_status "Admin PUT /src/app.ts" "200" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/src/app.ts" "$admin_token" "$body"

  body='{"content":"export const handler = () => \"ok\";\n","encoding":"utf-8"}'
  expect_status "Admin PUT /src/handler.ts" "200" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/src/handler.ts" "$admin_token" "$body"

  body='{"content":"super-secret\n","encoding":"utf-8"}'
  expect_status "Admin PUT /secrets/api-key.txt" "200" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/secrets/api-key.txt" "$admin_token" "$body"

  body='{"content":"# Dotfile Test\n","encoding":"utf-8"}'
  expect_status "Admin PUT /README.md" "200" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/README.md" "$admin_token" "$body"

  body='{"content":"API_KEY=top-secret\n","encoding":"utf-8"}'
  expect_status "Admin PUT /.env" "200" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/.env" "$admin_token" "$body"
}

run_integration_suite() {
  if ! maybe_start_services; then
    return 0
  fi

  # These empty files declare the agent names for zero-config discovery.
  : >"$TEMP_DIR/.test-agent.agentignore"
  : >"$TEMP_DIR/.test-agent.agentreadonly"

  print_info "Running zero-config provisioning from temp project"
  local provision_output
  if ! provision_output="$(cd "$TEMP_DIR" && bash "$RELAY_SCRIPT" provision 2>&1)"; then
    print_fail "relay.sh provision failed in zero-config mode: $(printf '%s' "$provision_output" | tail -n 3 | tr '\n' ' ')"
    return 1
  fi
  print_pass "relay.sh provision succeeded in zero-config mode"

  local config_json workspace admin_token test_agent_token admin_agent_token
  if [[ -f "$TEMP_DIR/.relay/config.json" ]]; then
    config_json="$(cat "$TEMP_DIR/.relay/config.json")"
  elif [[ -f "$TEMP_DIR/relay.yaml" ]]; then
    config_json="$(npx tsx "$RELAYAUTH_ROOT/scripts/relay/parse-config.ts" --json "$TEMP_DIR/relay.yaml" 2>/dev/null)" || config_json=""
  else
    config_json=""
  fi

  if [[ -z "$config_json" ]]; then
    print_fail "Could not resolve generated relay config after zero-config provision"
    return 1
  fi

  workspace="$(json_field "$config_json" "data.workspace")"
  if ! admin_token="$(generate_admin_token_from_config "$config_json" 2>/dev/null)"; then
    print_fail "Failed to generate admin token from zero-config relay settings"
    return 1
  fi
  print_pass "Generated admin token for integration assertions"

  if [[ ! -f "$TEMP_DIR/.relay/tokens/test-agent.jwt" ]]; then
    print_fail "Provisioning did not produce .relay/tokens/test-agent.jwt"
    return 1
  fi
  if [[ ! -f "$TEMP_DIR/.relay/tokens/admin-agent.jwt" ]]; then
    print_fail "Provisioning did not produce .relay/tokens/admin-agent.jwt"
    return 1
  fi

  test_agent_token="$(<"$TEMP_DIR/.relay/tokens/test-agent.jwt")"
  admin_agent_token="$(<"$TEMP_DIR/.relay/tokens/admin-agent.jwt")"

  seed_workspace_files "$workspace" "$admin_token"

  expect_status "test-agent GET /src/app.ts" "200" "GET" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/src/app.ts" "$test_agent_token"
  expect_status "test-agent PUT /src/app.ts" "200" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/src/app.ts" "$test_agent_token" \
    '{"content":"export const app = \"updated\";\n","encoding":"utf-8"}'
  expect_status "test-agent GET /secrets/api-key.txt" "403" "GET" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/secrets/api-key.txt" "$test_agent_token"
  expect_status "test-agent PUT /README.md" "403" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/README.md" "$test_agent_token" \
    '{"content":"# changed\n","encoding":"utf-8"}'
  expect_status "test-agent GET /README.md" "200" "GET" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/README.md" "$test_agent_token"

  expect_status "admin-agent GET /secrets/api-key.txt" "200" "GET" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/secrets/api-key.txt" "$admin_agent_token"
  expect_status "admin-agent PUT /README.md" "200" "PUT" \
    "$RELAYFILE_BASE_URL/v1/workspaces/$workspace/fs/file?path=/README.md" "$admin_agent_token" \
    '{"content":"# admin changed\n","encoding":"utf-8"}'
}

print_summary() {
  echo
  printf "%bDot-File E2E Summary%b\n" "$COLOR_BOLD" "$COLOR_RESET"
  printf "Assertions: %s\n" "$ASSERTIONS"
  printf "Failures: %s\n" "$FAILURES"
  printf "Skips: %s\n" "$SKIPS"
  printf "Artifact: %s\n" "$RELAYAUTH_ROOT/scripts/relay/e2e-dotfiles.sh"
}

main() {
  print_info "Preparing zero-config dot-file test project"

  require_cmd node || return 1
  require_cmd npx || return 1
  setup_temp_project

  verify_parser_contract
  verify_compiler_contract
  verify_admin_override_contract
  run_integration_suite

  print_summary

  if [[ "$FAILURES" -eq 0 ]]; then
    printf "%bRESULT: PASS%b\n" "$COLOR_GREEN" "$COLOR_RESET"
    return 0
  fi

  printf "%bRESULT: FAIL%b\n" "$COLOR_RED" "$COLOR_RESET"
  return 1
}

main "$@"
