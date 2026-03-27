#!/usr/bin/env bash

# Only set strict mode when executed directly, not when sourced.
# When sourced, set -euo pipefail would apply to the user's shell
# and kill it on any unset variable (e.g. from shell prompt scripts).
# Detect if sourced vs executed — works in both bash and zsh
_relay_is_sourced=0
if [[ -n "${ZSH_VERSION:-}" ]]; then
  # In zsh, ZSH_EVAL_CONTEXT contains "file" when sourced
  [[ "${ZSH_EVAL_CONTEXT:-}" == *file* ]] && _relay_is_sourced=1
elif [[ -n "${BASH_SOURCE[0]:-}" ]]; then
  [[ "${BASH_SOURCE[0]}" != "${0}" ]] && _relay_is_sourced=1
fi
if [[ ${_relay_is_sourced} -eq 0 ]]; then
  set -euo pipefail
fi

# Resolve script directory — hardcoded to avoid shell escape code issues
# when sourced from zsh with terminal title-setting prompts.
SCRIPT_SOURCE_DIR="${SCRIPT_SOURCE_DIR:-$(dirname "${BASH_SOURCE[0]:-${(%):-%x}}" 2>/dev/null)}"
# If dirname failed or returned garbage, fall back to a hardcoded default
if [[ ! -d "${SCRIPT_SOURCE_DIR}" ]]; then
  # Try to find relay.sh relative to known paths
  for _candidate in \
    "${HOME}/Projects/AgentWorkforce/relayauth/scripts/relay" \
    "/Users/khaliqgant/Projects/AgentWorkforce/relayauth/scripts/relay"; do
    if [[ -f "${_candidate}/relay.sh" ]]; then
      SCRIPT_SOURCE_DIR="${_candidate}"
      break
    fi
  done
fi
RELAYAUTH_ROOT="${RELAYAUTH_ROOT:-$(dirname "$(dirname "${SCRIPT_SOURCE_DIR}")")}"
RELAYFILE_ROOT="${RELAYFILE_ROOT:-$(dirname "${RELAYAUTH_ROOT}")/relayfile}"
SCRIPT_DIR="${RELAYAUTH_ROOT}/scripts/relay"
PARSE_CONFIG_TS="${SCRIPT_DIR}/parse-config.ts"
SEED_ACL_TS="${SCRIPT_DIR}/seed-acl.ts"
DOTFILE_PARSER_TS="${SCRIPT_DIR}/dotfile-parser.ts"
DOTFILE_COMPILER_TS="${SCRIPT_DIR}/dotfile-compiler.ts"
DEV_TOKEN_SH="${RELAYAUTH_ROOT}/scripts/generate-dev-token.sh"
RELAYFILE_MOUNT_BIN="${RELAYFILE_ROOT}/bin/relayfile-mount"
DEFAULT_RELAYAUTH_URL="http://127.0.0.1:8787"
DEFAULT_RELAYFILE_URL="http://127.0.0.1:8080"
DEFAULT_ZERO_CONFIG_SECRET="dev-relay-secret"

EFFECTIVE_CONFIG_PATH=""

usage() {
  cat <<'EOF'
Usage: relay <command> [args]

Commands:
  init [--dotfiles]        Validate config or create example dot files
  up                       Start relayauth and relayfile locally
  down                     Stop locally started services
  provision                Create identities, issue tokens, and seed ACLs
  run <cli> [--agent name] [-- args]  Run an agent CLI in a sandboxed mount
  mounts                   List active managed mounts
  unmount [name|--all]     Unmount agent workspace(s)
  scan [agent-name]        Preview dot-file permissions for one or more agents
  shell <agent-name>       Open a shell with relayfile env vars for the agent
  token <agent-name>       Print the provisioned token for the agent
  mount <agent-name> <dir> Start a managed relayfile mount
  doctor                   Check prerequisites and environment health
  status                   Show service state, health, and provisioned agents
  help                     Show this help text
EOF
}

error() {
  echo "relay error: $*" >&2
  return 1 2>/dev/null || exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || error "required command not found: $1"
}

ensure_runtime_files() {
  [[ -f "${PARSE_CONFIG_TS}" ]] || error "missing parser: ${PARSE_CONFIG_TS}"
  [[ -f "${SEED_ACL_TS}" ]] || error "missing ACL seeder: ${SEED_ACL_TS}"
  [[ -f "${DOTFILE_PARSER_TS}" ]] || error "missing dotfile parser: ${DOTFILE_PARSER_TS}"
  [[ -f "${DOTFILE_COMPILER_TS}" ]] || error "missing dotfile compiler: ${DOTFILE_COMPILER_TS}"
  [[ -f "${DEV_TOKEN_SH}" ]] || error "missing token generator: ${DEV_TOKEN_SH}"
}

ensure_state_dirs() {
  mkdir -p ".relay" ".relay/tokens" ".relay/logs" ".relay/generated" ".relay/mounts"
}

check_prereqs() {
  local missing=0

  if ! command -v node >/dev/null 2>&1; then
    echo "  ✗ node not found" >&2
    missing=$((missing + 1))
  fi

  if ! command -v npx >/dev/null 2>&1; then
    echo "  ✗ npx not found" >&2
    missing=$((missing + 1))
  fi

  if ! command -v go >/dev/null 2>&1; then
    echo "  ✗ go not found" >&2
    missing=$((missing + 1))
  fi

  if ! npx wrangler --version >/dev/null 2>&1; then
    echo "  ✗ wrangler not available (npx wrangler failed)" >&2
    missing=$((missing + 1))
  fi

  if [[ -d "${RELAYFILE_ROOT}" ]]; then
    if [[ -x "${RELAYFILE_ROOT}/bin/relayfile" ]]; then
      echo "  ✓ relayfile binary found"
    else
      echo "  ⚠ relayfile binary not built; will use 'go run' fallback"
    fi
  else
    echo "  ✗ relayfile repo not found at ${RELAYFILE_ROOT}" >&2
    missing=$((missing + 1))
  fi

  if [[ -d "${RELAYAUTH_ROOT}/.wrangler/state/v3/d1" ]]; then
    echo "  ✓ local D1 database initialized"
  else
    echo "  ⚠ local D1 not yet initialized (will be created on first wrangler dev run)"
  fi

  # Build relayauth packages if dist is missing (needed for config parser)
  if [[ ! -f "${RELAYAUTH_ROOT}/packages/sdk/dist/index.js" ]]; then
    echo "  Building relayauth packages…"
    (cd "${RELAYAUTH_ROOT}" && npx turbo build 2>/dev/null) || {
      echo "  ✗ failed to build relayauth packages" >&2
      missing=$((missing + 1))
    }
    echo "  ✓ relayauth packages built"
  fi

  if [[ ${missing} -gt 0 ]]; then
    error "${missing} prerequisite(s) missing — see above"
  fi
}

json_eval() {
  local json_input="$1"
  local expression="$2"
  JSON_INPUT="${json_input}" node -e "const data = JSON.parse(process.env.JSON_INPUT); ${expression}"
}

config_value() {
  local json_input="$1"
  local path_expr="$2"
  json_eval "${json_input}" "const value = ${path_expr}; if (value === undefined) process.exit(2); if (typeof value === 'object') console.log(JSON.stringify(value)); else console.log(String(value));"
}

config_agent_json() {
  local json_input="$1"
  local agent_name="$2"
  json_eval "${json_input}" "const agent = data.agents.find((entry) => entry.name === ${agent_name@Q}); if (!agent) process.exit(3); console.log(JSON.stringify(agent));"
}

config_agent_lines() {
  local json_input="$1"
  json_eval "${json_input}" 'for (const agent of data.agents) console.log(JSON.stringify(agent));'
}

service_alive() {
  local pid="$1"
  [[ -n "${pid}" ]] && kill -0 "${pid}" >/dev/null 2>&1
}

wait_for_http() {
  local url="$1"
  local label="$2"
  local attempts="${3:-15}"
  local pid="${4:-}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if curl -fsS "${url}" >/dev/null 2>&1; then
      echo "  ✓ ${label} healthy"
      return 0
    fi
    if [[ -n "${pid}" ]] && ! service_alive "${pid}"; then
      error "${label} exited before becoming healthy; check logs: .relay/logs/${label}.log"
    fi
    sleep 2
  done
  error "${label} did not become healthy at ${url} after $((attempts * 2))s; check logs: .relay/logs/${label}.log"
}

http_status() {
  local url="$1"
  curl -fsS "${url}" >/dev/null 2>&1 && echo "healthy" || echo "unhealthy"
}

load_pids() {
  [[ -f ".relay/pids" ]] || error "no PID file found at .relay/pids"
  # shellcheck disable=SC1091
  source ".relay/pids"
}

write_config_cache() {
  local config_json="$1"
  ensure_state_dirs
  printf '%s\n' "${config_json}" > ".relay/config.json"
}

parse_config_json_for_path() {
  local config_path="$1"
  ensure_runtime_files
  npx tsx "${PARSE_CONFIG_TS}" --json "${config_path}"
}

dotfiles_exist() {
  local discovery_json
  discovery_json="$(npx tsx "${DOTFILE_PARSER_TS}" --discover --project-dir "$(pwd)")"
  [[ "$(config_value "${discovery_json}" 'data.hasDotfiles')" == "true" ]]
}

discover_dotfile_agents() {
  local discovery_json agents
  discovery_json="$(npx tsx "${DOTFILE_PARSER_TS}" --discover --project-dir "$(pwd)")"
  agents="$(config_value "${discovery_json}" 'data.agents.join("\n")')" || true
  if [[ -n "${agents}" ]]; then
    printf '%s\n' "${agents}"
    return 0
  fi
  printf 'default-agent\n'
}

compile_dotfile_permissions() {
  local agent_name="$1"
  local workspace="$2"
  ensure_state_dirs
  local parsed_file compiled_file
  parsed_file=".relay/generated/${agent_name}.parsed.json"
  compiled_file=".relay/generated/${agent_name}.compiled.json"
  npx tsx "${DOTFILE_PARSER_TS}" --project-dir "$(pwd)" --agent "${agent_name}" > "${parsed_file}"
  npx tsx "${DOTFILE_COMPILER_TS}" --project-dir "$(pwd)" --agent "${agent_name}" --workspace "${workspace}" > "${compiled_file}"
  printf '%s\n' "${compiled_file}"
}

build_compiled_acl_bundle() {
  local config_json="$1"
  local workspace="$2"
  ensure_state_dirs
  local compiler_files=()

  while IFS= read -r agent_json; do
    [[ -n "${agent_json}" ]] || continue
    local agent_name
    agent_name="$(config_value "${agent_json}" 'data.name')"
    compiler_files+=("$(compile_dotfile_permissions "${agent_name}" "${workspace}")")
  done < <(config_agent_lines "${config_json}")

  local bundle_path=".relay/compiled-acl.json"
  node - "${workspace}" "${bundle_path}" "${compiler_files[@]}" <<'NODE'
const fs = require("node:fs");

const [, , workspace, bundlePath, ...compilerFiles] = process.argv;
const mergedAcl = {};
const summary = { ignored: 0, readonly: 0, readwrite: 0 };
const agents = [];

for (const file of compilerFiles) {
  const payload = JSON.parse(fs.readFileSync(file, "utf8"));
  const compiled = payload.compiled;
  agents.push({
    name: compiled.agentName,
    ignoredPatterns: compiled.ignoredPatterns,
    readonlyPatterns: compiled.readonlyPatterns,
    summary: compiled.summary,
  });
  summary.ignored += compiled.summary.ignored;
  summary.readonly += compiled.summary.readonly;
  summary.readwrite += compiled.summary.readwrite;
  for (const [dirPath, rules] of Object.entries(compiled.acl)) {
    const existing = new Set(mergedAcl[dirPath] ?? []);
    for (const rule of rules) {
      existing.add(rule);
    }
    mergedAcl[dirPath] = [...existing].sort();
  }
}

fs.writeFileSync(bundlePath, JSON.stringify({
  workspace,
  acl: mergedAcl,
  summary,
  agents,
}, null, 2));
NODE

  printf '%s\n' "${bundle_path}"
}

create_generated_config() {
  ensure_state_dirs
  local workspace secret generated_config
  workspace="$(basename "$(pwd)")"
  secret="${DEFAULT_ZERO_CONFIG_SECRET}"
  generated_config=".relay/generated/relay-zero-config.json"

  local agent_names=()
  while IFS= read -r agent_name; do
    [[ -n "${agent_name}" ]] || continue
    agent_names+=("${agent_name}")
  done < <(discover_dotfile_agents)

  local compiler_files=()
  local has_restrictions="false"
  if dotfiles_exist; then
    has_restrictions="true"
    for agent_name in "${agent_names[@]}"; do
      compiler_files+=("$(compile_dotfile_permissions "${agent_name}" "${workspace}")")
    done
  fi

  node - "${workspace}" "${secret}" "${generated_config}" "${has_restrictions}" "${DEFAULT_ZERO_CONFIG_SECRET}" "${compiler_files[@]-}" <<'NODE'
const fs = require("node:fs");

const [, , workspace, secret, generatedConfigPath, hasRestrictions, defaultSecret, ...compilerFiles] = process.argv;

let agents;
let acl = {};

if (hasRestrictions === "true") {
  const compiled = compilerFiles.map((file) => JSON.parse(fs.readFileSync(file, "utf8")).compiled);
  agents = compiled.map((entry) => ({
    name: entry.agentName,
    scopes: entry.scopes,
    roles: [],
  }));
  for (const entry of compiled) {
    for (const [dirPath, rules] of Object.entries(entry.acl)) {
      const existing = new Set(acl[dirPath] ?? []);
      for (const rule of rules) {
        existing.add(rule);
      }
      acl[dirPath] = [...existing].sort();
    }
  }
} else {
  agents = [{
    name: "default-agent",
    scopes: ["relayfile:*:*:*"],
    roles: [],
  }];
}

const config = {
  version: "1",
  workspace,
  signing_secret: secret || defaultSecret,
  agents,
  acl,
  roles: {},
};

fs.writeFileSync(generatedConfigPath, JSON.stringify(config, null, 2));
NODE

  printf '%s\n' "${generated_config}"
}

resolve_effective_config_path() {
  ensure_runtime_files
  if [[ -f "relay.yaml" ]]; then
    EFFECTIVE_CONFIG_PATH="relay.yaml"
    return 0
  fi

  EFFECTIVE_CONFIG_PATH="$(create_generated_config)"
}

print_zero_config_messages() {
  if [[ -f "relay.yaml" ]]; then
    return 0
  fi

  if dotfiles_exist; then
    local agents
    agents="$(discover_dotfile_agents | paste -sd ', ' -)"
    echo "No relay.yaml found. Using dot-file permissions (zero-config mode)"
    echo "Discovered agents: ${agents}"
    return 0
  fi

  echo "No relay.yaml found. Starting in fully open zero-config mode"
}

generate_admin_token() {
  local config_json="$1"
  local secret workspace
  secret="$(config_value "${config_json}" 'data.signing_secret')"
  workspace="$(config_value "${config_json}" 'data.workspace')"
  SIGNING_KEY="${secret}" \
  RELAYAUTH_SUB="relay-admin" \
  RELAYAUTH_WORKSPACE="${workspace}" \
  RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]' \
  RELAYAUTH_SCOPES_JSON='["relayauth:*:manage:*","relayauth:*:read:*","relayfile:*:*:*","fs:read","fs:write","sync:trigger","ops:read","admin:read"]' \
  bash "${DEV_TOKEN_SH}"
}

curl_json() {
  local method="$1"
  local url="$2"
  local token="$3"
  local body="${4:-}"
  local response_file http_code
  response_file="$(mktemp)"
  if [[ -n "${body}" ]]; then
    http_code="$(curl -sS -o "${response_file}" -w '%{http_code}' -X "${method}" "${url}" \
      -H "Authorization: Bearer ${token}" \
      -H "Content-Type: application/json" \
      --data "${body}")"
  else
    http_code="$(curl -sS -o "${response_file}" -w '%{http_code}' -X "${method}" "${url}" \
      -H "Authorization: Bearer ${token}")"
  fi

  if [[ ! "${http_code}" =~ ^2 ]]; then
    echo "HTTP ${http_code}: $(cat "${response_file}")" >&2
    rm -f "${response_file}"
    return 1
  fi

  cat "${response_file}"
  rm -f "${response_file}"
}

extract_token_from_response() {
  local json_input="$1"
  json_eval "${json_input}" 'const token = data.accessToken ?? data.access_token ?? data.token ?? ""; if (!token) process.exit(4); console.log(token);'
}

permission_summary_json() {
  local agent_name="$1"
  npx tsx "${DOTFILE_PARSER_TS}" --project-dir "$(pwd)" --agent "${agent_name}"
}

print_permission_summary() {
  local agent_name="$1"
  local parsed_json ignored readonly ignored_count readonly_count
  parsed_json="$(permission_summary_json "${agent_name}")"
  ignored="$(config_value "${parsed_json}" 'data.ignoredPatterns.join(", ")')"
  readonly="$(config_value "${parsed_json}" 'data.readonlyPatterns.join(", ")')"
  ignored_count="$(config_value "${parsed_json}" 'data.ignoredPatterns.length')"
  readonly_count="$(config_value "${parsed_json}" 'data.readonlyPatterns.length')"

  if [[ -z "${ignored}" ]]; then
    ignored="(none)"
  fi
  if [[ -z "${readonly}" ]]; then
    readonly="(none)"
  fi

  echo "Ignored: ${ignored} (${ignored_count} pattern(s))"
  echo "Read-only: ${readonly} (${readonly_count} pattern(s))"
  echo "Read/write: everything else"
}

write_example_dotfiles() {
  local ignore_file=".agentignore"
  local readonly_file=".agentreadonly"

  if [[ ! -f "${ignore_file}" ]]; then
    cat > "${ignore_file}" <<'EOF'
.env
secrets/
*.pem
*.key
node_modules/
EOF
    echo "Created ${ignore_file}"
  else
    echo "Kept existing ${ignore_file}"
  fi

  if [[ ! -f "${readonly_file}" ]]; then
    cat > "${readonly_file}" <<'EOF'
README.md
LICENSE
*.lock
EOF
    echo "Created ${readonly_file}"
  else
    echo "Kept existing ${readonly_file}"
  fi
}

cmd_init() {
  require_cmd npx
  if [[ "${1:-}" == "--dotfiles" ]]; then
    write_example_dotfiles
    return 0
  fi

  resolve_effective_config_path
  local config_json workspace count
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"
  write_config_cache "${config_json}"
  workspace="$(config_value "${config_json}" 'data.workspace')"
  count="$(config_value "${config_json}" 'data.agents.length')"

  if [[ "${EFFECTIVE_CONFIG_PATH}" == "relay.yaml" ]]; then
    echo "relay.yaml is valid."
  else
    print_zero_config_messages
    echo "Generated config cache: ${EFFECTIVE_CONFIG_PATH}"
  fi
  echo "Workspace: ${workspace}"
  echo "Agents: ${count}"

  while IFS= read -r agent_json; do
    [[ -n "${agent_json}" ]] || continue
    local name scopes_count scopes
    name="$(config_value "${agent_json}" 'data.name')"
    scopes_count="$(config_value "${agent_json}" 'data.scopes.length')"
    scopes="$(config_value "${agent_json}" 'data.scopes.join(", ")')"
    echo "- ${name}: ${scopes_count} scope(s)"
    echo "  ${scopes}"
  done < <(config_agent_lines "${config_json}")
}

cmd_up() {
  echo "Checking prerequisites…"
  check_prereqs
  require_cmd curl
  resolve_effective_config_path
  print_zero_config_messages

  local config_json secret project_dir relayauth_log relayfile_log
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"
  write_config_cache "${config_json}"
  ensure_state_dirs
  secret="$(config_value "${config_json}" 'data.signing_secret')"
  project_dir="$(pwd)"
  relayauth_log="${project_dir}/.relay/logs/relayauth.log"
  relayfile_log="${project_dir}/.relay/logs/relayfile.log"

  if [[ -f ".relay/pids" ]]; then
    load_pids || true
    if { [[ -n "${RELAYAUTH_PID:-}" ]] && service_alive "${RELAYAUTH_PID}"; } || { [[ -n "${RELAYFILE_PID:-}" ]] && service_alive "${RELAYFILE_PID}"; }; then
      error "services appear to already be running; use 'relay down' first"
    fi
    rm -f ".relay/pids"
  fi

  (
    cd "${RELAYAUTH_ROOT}"
    SIGNING_KEY="${secret}" npx wrangler dev --port 8787 > "${relayauth_log}" 2>&1
  ) &
  local relayauth_pid=$!

  (
    cd "${RELAYFILE_ROOT}"
    if [[ -x "${RELAYFILE_ROOT}/bin/relayfile" ]]; then
      RELAYFILE_JWT_SECRET="${secret}" RELAYFILE_BACKEND_PROFILE=durable-local "${RELAYFILE_ROOT}/bin/relayfile" > "${relayfile_log}" 2>&1
    else
      RELAYFILE_JWT_SECRET="${secret}" RELAYFILE_BACKEND_PROFILE=durable-local go run ./cmd/relayfile > "${relayfile_log}" 2>&1
    fi
  ) &
  local relayfile_pid=$!

  cat > ".relay/pids" <<EOF
RELAYAUTH_PID=${relayauth_pid}
RELAYFILE_PID=${relayfile_pid}
EOF

  echo "Waiting for services…"
  wait_for_http "${DEFAULT_RELAYAUTH_URL}/health" "relayauth" 15 "${relayauth_pid}"
  wait_for_http "${DEFAULT_RELAYFILE_URL}/health" "relayfile" 15 "${relayfile_pid}"

  echo "Both services running"
  echo "relayauth pid: ${relayauth_pid}"
  echo "relayfile pid: ${relayfile_pid}"
}

stop_pid() {
  local pid="$1"
  local label="$2"
  [[ -n "${pid}" ]] || return 0
  if ! service_alive "${pid}"; then
    return 0
  fi

  kill -TERM "${pid}" >/dev/null 2>&1 || true
  local i
  for ((i = 1; i <= 5; i++)); do
    if ! service_alive "${pid}"; then
      return 0
    fi
    sleep 1
  done

  kill -KILL "${pid}" >/dev/null 2>&1 || true
  if service_alive "${pid}"; then
    error "failed to stop ${label} (pid ${pid})"
  fi
}

cmd_down() {
  echo "Cleaning up active mounts…"
  cleanup_mounts --all

  if [[ -f ".relay/pids" ]]; then
    load_pids
    stop_pid "${RELAYAUTH_PID:-}" "relayauth"
    stop_pid "${RELAYFILE_PID:-}" "relayfile"
    rm -f ".relay/pids"
  fi

  # Also kill any processes on our ports (handles orphaned processes
  # from subshells that exited while the service kept running)
  local port_pid
  port_pid="$(lsof -ti:8787 2>/dev/null)" && kill -9 "${port_pid}" 2>/dev/null && echo "  killed orphan on :8787"
  port_pid="$(lsof -ti:8080 2>/dev/null)" && kill -9 "${port_pid}" 2>/dev/null && echo "  killed orphan on :8080"

  echo "Stopped relay services"
}

cmd_provision() {
  require_cmd npx
  require_cmd curl
  resolve_effective_config_path
  local config_json workspace secret admin_token agent_count provisioned=0
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"
  write_config_cache "${config_json}"
  ensure_state_dirs

  [[ "$(http_status "${DEFAULT_RELAYAUTH_URL}/health")" == "healthy" ]] || error "relayauth is not healthy at ${DEFAULT_RELAYAUTH_URL}"
  [[ "$(http_status "${DEFAULT_RELAYFILE_URL}/health")" == "healthy" ]] || error "relayfile is not healthy at ${DEFAULT_RELAYFILE_URL}"

  workspace="$(config_value "${config_json}" 'data.workspace')"
  secret="$(config_value "${config_json}" 'data.signing_secret')"
  agent_count="$(config_value "${config_json}" 'data.agents.length')"
  admin_token="$(generate_admin_token "${config_json}")"

  while IFS= read -r agent_json; do
    [[ -n "${agent_json}" ]] || continue
    local agent_name scopes_json create_body create_response identity_id token_body token_response token
    agent_name="$(config_value "${agent_json}" 'data.name')"
    scopes_json="$(config_value "${agent_json}" 'JSON.stringify(data.scopes)')"

    # Mint token locally using generate-dev-token.sh (no API call needed —
    # signs JWT directly with the shared secret, same key relayfile validates against)
    # Use per-file relayauth scopes only — no blanket fs:read/fs:write.
    # The relayfile server's scopeMatches() understands relayauth format.
    # The mount client's canWritePath() also understands relayauth format.
    token="$(
      SIGNING_KEY="${secret}" \
      RELAYAUTH_SUB="agent_${agent_name}" \
      RELAYAUTH_AGENT_NAME="${agent_name}" \
      RELAYAUTH_ORG="org_relay" \
      RELAYAUTH_WORKSPACE="${workspace}" \
      RELAYAUTH_SCOPES_JSON="${scopes_json}" \
      RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]' \
      bash "${DEV_TOKEN_SH}"
    )" || error "failed to generate token for ${agent_name}"

    printf '%s\n' "${token}" > ".relay/tokens/${agent_name}.jwt"
    provisioned=$((provisioned + 1))
  done < <(config_agent_lines "${config_json}")

  # Seed local project files into relayfile workspace (exclude .relay/, .git/, node_modules/)
  echo "Seeding local files into workspace ${workspace}…"
  "${RELAYFILE_ROOT}/bin/relayfile-cli" workspace create "${workspace}" 2>/dev/null || true
  local seed_tmp
  seed_tmp="$(mktemp -d)"
  # Copy project files excluding internal dirs
  rsync -a --exclude='.relay' --exclude='.git' --exclude='node_modules' --exclude='.relayfile-mount-state.json' . "${seed_tmp}/" 2>/dev/null || \
    find . -not -path './.relay/*' -not -path './.git/*' -not -path './node_modules/*' -type f -exec sh -c 'mkdir -p "'"${seed_tmp}"'/$(dirname "{}")" && cp "{}" "'"${seed_tmp}"'/{}"' \;
  RELAYFILE_BASE_URL="${DEFAULT_RELAYFILE_URL}" \
  RELAYFILE_TOKEN="${admin_token}" \
    "${RELAYFILE_ROOT}/bin/relayfile-cli" seed "${workspace}" "${seed_tmp}" 2>&1 | tail -3 || {
    echo "  ⚠ File seeding failed (non-fatal)"
  }
  rm -rf "${seed_tmp}"
  echo "  ✓ Local files seeded"

  # Seed ACL rules
  if [[ "${EFFECTIVE_CONFIG_PATH}" == "relay.yaml" ]] || ! dotfiles_exist; then
    npx tsx "${SEED_ACL_TS}" --config "${EFFECTIVE_CONFIG_PATH}" --base-url "${DEFAULT_RELAYFILE_URL}" --token "${admin_token}"
  fi

  if dotfiles_exist; then
    local compiled_bundle summary_json ignored_count readonly_count
    compiled_bundle="$(build_compiled_acl_bundle "${config_json}" "${workspace}")"
    npx tsx "${SEED_ACL_TS}" --compiled-json "${compiled_bundle}" --base-url "${DEFAULT_RELAYFILE_URL}" --token "${admin_token}"
    summary_json="$(<"${compiled_bundle}")"
    ignored_count="$(config_value "${summary_json}" 'data.summary.ignored')"
    readonly_count="$(config_value "${summary_json}" 'data.summary.readonly')"
    echo "Applied permissions: ${ignored_count} files ignored, ${readonly_count} files read-only"
  fi

  echo "Provisioned ${provisioned}/${agent_count} agent(s) for workspace ${workspace}"
}

mount_registry_path() {
  printf '%s\n' ".relay/mounts.json"
}

ensure_mount_registry() {
  local mounts_file
  mounts_file="$(mount_registry_path)"
  ensure_state_dirs
  if [[ ! -f "${mounts_file}" ]]; then
    printf '[]\n' > "${mounts_file}"
  fi
}

prune_mount_registry() {
  local mounts_file
  mounts_file="$(mount_registry_path)"
  ensure_mount_registry
  node - "${mounts_file}" <<'NODE'
const fs = require("node:fs");

const mountsFile = process.argv[2];
let mounts = [];
try {
  mounts = JSON.parse(fs.readFileSync(mountsFile, "utf8"));
} catch {
  mounts = [];
}

const live = mounts.filter((entry) => {
  if (!entry || typeof entry.pid !== "number" || entry.pid <= 0) {
    return false;
  }
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch {
    return false;
  }
});

fs.writeFileSync(mountsFile, `${JSON.stringify(live, null, 2)}\n`);
NODE
}

mount_registry_lines() {
  local mounts_file
  mounts_file="$(mount_registry_path)"
  prune_mount_registry
  node - "${mounts_file}" <<'NODE'
const fs = require("node:fs");

const mountsFile = process.argv[2];
const mounts = JSON.parse(fs.readFileSync(mountsFile, "utf8"));
for (const entry of mounts) {
  console.log([
    entry.agentName ?? "",
    String(entry.pid ?? ""),
    entry.dir ?? "",
    entry.workspace ?? "",
    entry.logPath ?? "",
    entry.startedAt ?? "",
  ].join("\t"));
}
NODE
}

mount_registry_entry_json() {
  local agent_name="$1"
  local mounts_file
  mounts_file="$(mount_registry_path)"
  prune_mount_registry
  node - "${mounts_file}" "${agent_name}" <<'NODE'
const fs = require("node:fs");

const mountsFile = process.argv[2];
const agentName = process.argv[3];
const mounts = JSON.parse(fs.readFileSync(mountsFile, "utf8"));
const entry = mounts.find((item) => item.agentName === agentName);
if (!entry) {
  process.exit(1);
}
process.stdout.write(JSON.stringify(entry));
NODE
}

register_mount() {
  local agent_name="$1"
  local pid="$2"
  local dir="$3"
  local workspace="$4"
  local log_path="$5"
  local state_file="$6"
  local mounts_file
  mounts_file="$(mount_registry_path)"
  ensure_mount_registry
  node - "${mounts_file}" "${agent_name}" "${pid}" "${dir}" "${workspace}" "${log_path}" "${state_file}" <<'NODE'
const fs = require("node:fs");

const [mountsFile, agentName, pid, dir, workspace, logPath, stateFile] = process.argv.slice(2);
let mounts = [];
try {
  mounts = JSON.parse(fs.readFileSync(mountsFile, "utf8"));
} catch {
  mounts = [];
}

mounts = mounts.filter((entry) => entry.agentName !== agentName);
mounts.push({
  agentName,
  pid: Number(pid),
  dir,
  workspace,
  logPath,
  stateFile,
  startedAt: new Date().toISOString(),
});

fs.writeFileSync(mountsFile, `${JSON.stringify(mounts, null, 2)}\n`);
NODE
}

unregister_mount() {
  local agent_name="$1"
  local mounts_file
  mounts_file="$(mount_registry_path)"
  ensure_mount_registry
  node - "${mounts_file}" "${agent_name}" <<'NODE'
const fs = require("node:fs");

const [mountsFile, agentName] = process.argv.slice(2);
let mounts = [];
try {
  mounts = JSON.parse(fs.readFileSync(mountsFile, "utf8"));
} catch {
  mounts = [];
}

mounts = mounts.filter((entry) => entry.agentName !== agentName);
fs.writeFileSync(mountsFile, `${JSON.stringify(mounts, null, 2)}\n`);
NODE
}

cleanup_mounts() {
  local target="${1:---all}"
  ensure_mount_registry
  prune_mount_registry

  if [[ "${target}" == "--all" ]]; then
    local removed=0
    while IFS=$'\t' read -r agent_name pid mount_dir workspace _log_path _started_at; do
      [[ -n "${agent_name}" ]] || continue
      stop_pid "${pid}" "mount-${agent_name}" 2>/dev/null || true
      unregister_mount "${agent_name}"
      echo "Unmounted ${agent_name} from ${mount_dir} (${workspace})"
      removed=$((removed + 1))
    done < <(mount_registry_lines)

    if [[ ${removed} -eq 0 ]]; then
      echo "No managed mounts to stop"
    fi
    return 0
  fi

  local entry_json pid mount_dir workspace
  entry_json="$(mount_registry_entry_json "${target}")" || error "no managed mount found for ${target}"
  pid="$(config_value "${entry_json}" 'data.pid')"
  mount_dir="$(config_value "${entry_json}" 'data.dir')"
  workspace="$(config_value "${entry_json}" 'data.workspace')"
  stop_pid "${pid}" "mount-${target}" 2>/dev/null || true
  unregister_mount "${target}"
  echo "Unmounted ${target} from ${mount_dir} (${workspace})"
}

cmd_mounts() {
  local found=0
  while IFS=$'\t' read -r agent_name pid mount_dir workspace log_path started_at; do
    [[ -n "${agent_name}" ]] || continue
    found=1
    echo "- ${agent_name}: pid=${pid} workspace=${workspace} dir=${mount_dir}"
    echo "  log=${log_path} started=${started_at}"
  done < <(mount_registry_lines)

  if [[ ${found} -eq 0 ]]; then
    echo "No active managed mounts"
  fi
}

cmd_unmount() {
  local target="${1:-}"
  [[ -n "${target}" ]] || error "usage: relay unmount <agent-name|--all>"
  cleanup_mounts "${target}"
}

cmd_run() {
  require_cmd curl
  require_cmd npx

  local agent_cli="${1:-}"
  [[ -n "${agent_cli}" ]] || error "usage: relay run <agent-cli> [--agent name] [-- extra-args]"
  shift || true

  local requested_agent_name=""
  local extra_args=()
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --agent)
        shift || error "usage: relay run <agent-cli> [--agent name] [-- extra-args]"
        [[ $# -gt 0 ]] || error "missing value for --agent"
        requested_agent_name="$1"
        ;;
      --)
        shift
        extra_args=("$@")
        break
        ;;
      *)
        extra_args+=("$1")
        ;;
    esac
    shift || true
  done

  local agent_name
  resolve_effective_config_path
  local config_json workspace token mount_dir agent_json
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"
  write_config_cache "${config_json}"

  if [[ -n "${requested_agent_name}" ]]; then
    agent_name="${requested_agent_name}"
  else
    # Use the first (or only) agent from the config — the CLI name is which
    # binary to run, not which agent identity to use
    agent_name="$(config_value "${config_json}" 'data.agents[0].name' 2>/dev/null)" || agent_name="default-agent"
  fi

  agent_json="$(config_agent_json "${config_json}" "${agent_name}" 2>/dev/null)" || true
  workspace="$(config_value "${config_json}" 'data.workspace')"

  if [[ "$(http_status "${DEFAULT_RELAYAUTH_URL}/health")" != "healthy" ]] || [[ "$(http_status "${DEFAULT_RELAYFILE_URL}/health")" != "healthy" ]]; then
    echo "Relay services are not healthy. Starting them first…"
    cmd_up
  fi

  echo "Provisioning relay access for ${agent_name}…"
  cmd_provision
  [[ -f ".relay/tokens/${agent_name}.jwt" ]] || error "missing token for ${agent_name}: .relay/tokens/${agent_name}.jwt"
  token="$(<".relay/tokens/${agent_name}.jwt")"

  ensure_state_dirs
  mount_dir="$(pwd)/.relay/workspace-${agent_name}"
  local project_dir mount_log mount_pid mount_once_output denied_count mounted_file_count
  project_dir="$(pwd)"
  mount_log=".relay/logs/${agent_name}-mount.log"
  mkdir -p "${mount_dir}"
  [[ -x "${RELAYFILE_MOUNT_BIN}" ]] || error "missing relayfile mount binary: ${RELAYFILE_MOUNT_BIN}"

  echo "Mounting workspace at ${mount_dir}…"
  if ! mount_once_output="$(
    "${RELAYFILE_MOUNT_BIN}" \
      --base-url "${DEFAULT_RELAYFILE_URL}" \
      --workspace "${workspace}" \
      --token "${token}" \
      --local-dir "${mount_dir}" \
      --once 2>&1
  )"; then
    echo "${mount_once_output}" >&2
    error "initial workspace sync failed for ${agent_name}"
  fi

  denied_count="$(printf '%s\n' "${mount_once_output}" | grep -c "skipping denied file" 2>/dev/null || echo 0)"
  mounted_file_count="$(find "${mount_dir}" -type f -not -path "${mount_dir}/.relay/*" -not -name "_PERMISSIONS.md" -not -name "CLAUDE.md" 2>/dev/null | wc -l | tr -d ' ')"

  # Generate _PERMISSIONS.md and CLAUDE.md so agents understand the permission model
  local readonly_list ignored_list compiled_json_content
  compiled_json_content=""
  if [[ -f ".relay/compiled-acl.json" ]]; then
    compiled_json_content="$(<".relay/compiled-acl.json")"
  fi

  readonly_list="$(echo "${compiled_json_content}" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const agents = d.agents || [];
      const a = agents[0] || {};
      (a.readonlyPatterns || []).forEach(p => console.log('- ' + p));
    } catch {}
  " 2>/dev/null)" || readonly_list=""

  ignored_list="$(echo "${compiled_json_content}" | node -e "
    try {
      const d = JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));
      const agents = d.agents || [];
      const a = agents[0] || {};
      (a.ignoredPatterns || []).forEach(p => console.log('- ' + p));
    } catch {}
  " 2>/dev/null)" || ignored_list=""

  local perms_doc="# Workspace Permissions

This workspace is managed by the relay. File access is controlled
by .agentignore and .agentreadonly in the project root.

## Read-only files (cannot be modified)
${readonly_list:-None}

## Hidden files (not available in this workspace)
${ignored_list:-None}

## Writable files
All other files can be read and modified freely.

If you get \"permission denied\", the file is read-only.
Changes to read-only files will be automatically reverted.
Do not attempt to chmod files — permissions will be restored."

  chmod 644 "${mount_dir}/_PERMISSIONS.md" 2>/dev/null || true
  printf '%s\n' "${perms_doc}" > "${mount_dir}/_PERMISSIONS.md"

  mount_pid=""
  "${RELAYFILE_MOUNT_BIN}" \
    --base-url "${DEFAULT_RELAYFILE_URL}" \
    --workspace "${workspace}" \
    --token "${token}" \
    --local-dir "${mount_dir}" \
    > "${mount_log}" 2>&1 &
  mount_pid=$!
  sleep 1
  if ! service_alive "${mount_pid}"; then
    local mount_tail
    mount_tail="$(tail -n 5 "${mount_log}" 2>/dev/null | tr '\n' ' ')"
    error "mount process for ${agent_name} exited early; check ${mount_log}${mount_tail:+ (${mount_tail})}"
  fi

  local cleaned_up=0

  cleanup_run() {
    [[ ${cleaned_up} -eq 0 ]] || return 0
    cleaned_up=1

    if [[ -n "${mount_pid}" ]] && service_alive "${mount_pid}"; then
      kill -TERM "${mount_pid}" >/dev/null 2>&1 || true
      wait "${mount_pid}" 2>/dev/null || true
    fi

    # Sync writable files back to project
    echo "Syncing changes back to project…"
    local synced=0
    while IFS= read -r -d '' file; do
      local rel_path="${file#${mount_dir}/}"
      [[ "${rel_path}" != .relay/* ]] || continue
      local orig="${project_dir}/${rel_path}"
      # Only sync writable files (skip readonly)
      [[ -w "${file}" ]] || continue
      # Only sync if changed
      if [[ -f "${orig}" ]] && cmp -s "${file}" "${orig}" 2>/dev/null; then
        continue
      fi
      mkdir -p "$(dirname "${orig}")"
      cp "${file}" "${orig}"
      synced=$((synced + 1))
    done < <(find "${mount_dir}" -type f -print0 2>/dev/null)
    echo "  ✓ ${synced} file(s) synced back"

    rm -rf "${mount_dir}"
  }

  trap 'cleanup_run' EXIT
  trap 'cleanup_run; return 130 2>/dev/null || exit 130' INT TERM

  # Auto-apply sandbox bypass flags — the relay IS the sandbox
  local sandbox_flags=()
  local cli_basename
  cli_basename="$(basename "${agent_cli}")"
  case "${cli_basename}" in
    claude)
      sandbox_flags=("--dangerously-skip-permissions")
      ;;
    codex)
      sandbox_flags=("--dangerously-bypass-approvals-and-sandbox")
      ;;
    gemini)
      sandbox_flags=("--yolo")
      ;;
    aider)
      sandbox_flags=("--yes")
      ;;
  esac

  echo ""
  echo "Launching ${agent_cli} as relay agent \"${agent_name}\""
  echo "  Workspace: ${mount_dir}"
  echo "  Mounted files: ${mounted_file_count} files"
  echo "  Permissions denied (initial sync): ${denied_count} files"
  if [[ ${#sandbox_flags[@]} -gt 0 ]]; then
    echo "  Sandbox: relay-enforced (${sandbox_flags[*]})"
  fi
  echo ""

  # Copy .agentdeny if it exists
  if [[ -f "${project_dir}/.agentdeny" ]]; then
    cp "${project_dir}/.agentdeny" "${mount_dir}/.agentdeny"
  fi

  # Run agent in foreground (needs TTY for interactive agents like codex/claude)
  local agent_status=0
  (
    cd "${mount_dir}" || exit 1
    export RELAYFILE_TOKEN="${token}"
    export RELAYFILE_BASE_URL="${DEFAULT_RELAYFILE_URL}"
    export RELAYFILE_WORKSPACE="${workspace}"
    export RELAY_WORKSPACE="${mount_dir}"
    export RELAY_AGENT_NAME="${agent_name}"
    if [[ -f ".agentdeny" ]]; then
      source "${RELAYAUTH_ROOT}/scripts/relay/agentdeny-hook.sh"
    fi
    exec "${agent_cli}" "${sandbox_flags[@]}" "${extra_args[@]}"
  ) || agent_status=$?

  cleanup_run
  trap - EXIT INT TERM
  return "${agent_status}"
}

cmd_scan() {
  require_cmd npx
  resolve_effective_config_path
  local requested_agent="${1:-}"
  local config_json
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"

  if [[ -n "${requested_agent}" ]]; then
    echo "${requested_agent}:"
    print_permission_summary "${requested_agent}"
    return 0
  fi

  while IFS= read -r agent_json; do
    [[ -n "${agent_json}" ]] || continue
    local agent_name
    agent_name="$(config_value "${agent_json}" 'data.name')"
    echo "${agent_name}:"
    print_permission_summary "${agent_name}"
    echo
  done < <(config_agent_lines "${config_json}")
}

cmd_shell() {
  local agent_name="${1:-}"
  [[ -n "${agent_name}" ]] || error "usage: relay shell <agent-name>"
  resolve_effective_config_path
  [[ -f ".relay/tokens/${agent_name}.jwt" ]] || error "missing token for ${agent_name}: .relay/tokens/${agent_name}.jwt"
  local config_json token workspace agent_json shell_bin
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"
  agent_json="$(config_agent_json "${config_json}" "${agent_name}")" || error "unknown agent: ${agent_name}"
  token="$(<".relay/tokens/${agent_name}.jwt")"
  workspace="$(config_value "${config_json}" 'data.workspace')"
  shell_bin="${SHELL:-/bin/bash}"

  export RELAYFILE_TOKEN="${token}"
  export RELAYFILE_BASE_URL="${DEFAULT_RELAYFILE_URL}"
  export RELAYFILE_WORKSPACE="${workspace}"

  echo "Entering relay shell as \"${agent_name}\""
  print_permission_summary "${agent_name}"
  exec "${shell_bin}"
}

cmd_token() {
  local agent_name="${1:-}"
  [[ -n "${agent_name}" ]] || error "usage: relay token <agent-name>"
  [[ -f ".relay/tokens/${agent_name}.jwt" ]] || error "missing token for ${agent_name}: .relay/tokens/${agent_name}.jwt"
  cat ".relay/tokens/${agent_name}.jwt"
}

cmd_mount() {
  local agent_name="${1:-}"
  local mount_dir="${2:-}"
  [[ -n "${agent_name}" && -n "${mount_dir}" ]] || error "usage: relay mount <agent-name> <dir>"
  [[ -x "${RELAYFILE_MOUNT_BIN}" ]] || error "missing relayfile mount binary: ${RELAYFILE_MOUNT_BIN}"
  [[ -f ".relay/tokens/${agent_name}.jwt" ]] || error "missing token for ${agent_name}: .relay/tokens/${agent_name}.jwt"
  resolve_effective_config_path
  local config_json token workspace mount_dir_abs mount_log mount_state_file mount_pid
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"
  token="$(<".relay/tokens/${agent_name}.jwt")"
  workspace="$(config_value "${config_json}" 'data.workspace')"
  ensure_mount_registry

  if mount_registry_entry_json "${agent_name}" >/dev/null 2>&1; then
    error "mount already active for ${agent_name}; use 'relay unmount ${agent_name}' first"
  fi

  mkdir -p "${mount_dir}"
  mount_dir_abs="$(cd "${mount_dir}" && pwd)"
  mount_log=".relay/logs/${agent_name}-mount.log"
  mount_state_file=".relay/mounts/${agent_name}.state.json"

  "${RELAYFILE_MOUNT_BIN}" \
    --base-url "${DEFAULT_RELAYFILE_URL}" \
    --workspace "${workspace}" \
    --token "${token}" \
    --state-file "${mount_state_file}" \
    --local-dir "${mount_dir_abs}" \
    > "${mount_log}" 2>&1 &
  mount_pid=$!

  sleep 1
  if ! service_alive "${mount_pid}"; then
    local tail_output
    tail_output="$(tail -n 5 "${mount_log}" 2>/dev/null | tr '\n' ' ')"
    error "mount process for ${agent_name} exited early; check ${mount_log}${tail_output:+ (${tail_output})}"
  fi

  register_mount "${agent_name}" "${mount_pid}" "${mount_dir_abs}" "${workspace}" "${mount_log}" "${mount_state_file}"
  echo "Started managed mount for ${agent_name}"
  echo "  dir: ${mount_dir_abs}"
  echo "  pid: ${mount_pid}"
  echo "  log: ${mount_log}"
}

cmd_status() {
  resolve_effective_config_path
  local config_json
  config_json="$(parse_config_json_for_path "${EFFECTIVE_CONFIG_PATH}")"
  echo "Service health:"
  echo "- relayauth: $(http_status "${DEFAULT_RELAYAUTH_URL}/health")"
  echo "- relayfile: $(http_status "${DEFAULT_RELAYFILE_URL}/health")"

  if [[ -f ".relay/pids" ]]; then
    load_pids
    echo "Processes:"
    echo "- relayauth pid ${RELAYAUTH_PID:-unknown}: $(service_alive "${RELAYAUTH_PID:-}" && echo running || echo stopped)"
    echo "- relayfile pid ${RELAYFILE_PID:-unknown}: $(service_alive "${RELAYFILE_PID:-}" && echo running || echo stopped)"
  else
    echo "Processes:"
    echo "- no PID file"
  fi

  echo "Provisioned agents:"
  while IFS= read -r agent_json; do
    [[ -n "${agent_json}" ]] || continue
    local name scopes_count token_state
    name="$(config_value "${agent_json}" 'data.name')"
    scopes_count="$(config_value "${agent_json}" 'data.scopes.length')"
    if [[ -f ".relay/tokens/${name}.jwt" ]]; then
      token_state="token present"
    else
      token_state="token missing"
    fi
    echo "- ${name}: ${scopes_count} scope(s), ${token_state}"
  done < <(config_agent_lines "${config_json}")

  echo "Active mounts:"
  cmd_mounts
}

cmd_doctor() {
  echo "relay doctor — checking environment"
  echo ""
  echo "Tools:"
  for cmd in node npx go curl; do
    if command -v "${cmd}" >/dev/null 2>&1; then
      echo "  ✓ ${cmd}: $(command -v "${cmd}")"
    else
      echo "  ✗ ${cmd}: not found"
    fi
  done

  echo ""
  echo "Wrangler:"
  if npx wrangler --version >/dev/null 2>&1; then
    echo "  ✓ available ($(npx wrangler --version 2>/dev/null | head -1))"
  else
    echo "  ✗ not available"
  fi

  echo ""
  echo "Relayfile binary:"
  if [[ -x "${RELAYFILE_ROOT}/bin/relayfile" ]]; then
    echo "  ✓ built at ${RELAYFILE_ROOT}/bin/relayfile"
  elif [[ -d "${RELAYFILE_ROOT}" ]]; then
    echo "  ⚠ not built (run 'go build -o bin/relayfile ./cmd/relayfile' in ${RELAYFILE_ROOT})"
  else
    echo "  ✗ relayfile repo not found at ${RELAYFILE_ROOT}"
  fi

  echo ""
  echo "Local D1:"
  if [[ -d "${RELAYAUTH_ROOT}/.wrangler/state/v3/d1" ]]; then
    echo "  ✓ initialized"
  else
    echo "  ⚠ not initialized (created automatically on first 'relay up')"
  fi

  echo ""
  echo "Ports:"
  if lsof -i :8787 >/dev/null 2>&1; then
    echo "  ⚠ 8787 (relayauth): in use"
  else
    echo "  ✓ 8787 (relayauth): available"
  fi
  if lsof -i :8080 >/dev/null 2>&1; then
    echo "  ⚠ 8080 (relayfile): in use"
  else
    echo "  ✓ 8080 (relayfile): available"
  fi

  echo ""
  echo "Service health:"
  echo "  relayauth: $(http_status "${DEFAULT_RELAYAUTH_URL}/health")"
  echo "  relayfile: $(http_status "${DEFAULT_RELAYFILE_URL}/health")"
}

main() {
  local command="${1:-help}"
  case "${command}" in
    init)
      shift
      cmd_init "$@"
      ;;
    up)
      shift
      cmd_up "$@"
      ;;
    down)
      shift
      cmd_down "$@"
      ;;
    provision)
      shift
      cmd_provision "$@"
      ;;
    run)
      shift
      cmd_run "$@"
      ;;
    mounts)
      shift
      cmd_mounts "$@"
      ;;
    unmount)
      shift
      cmd_unmount "$@"
      ;;
    scan)
      shift
      cmd_scan "$@"
      ;;
    shell)
      shift
      cmd_shell "$@"
      ;;
    token)
      shift
      cmd_token "$@"
      ;;
    mount)
      shift
      cmd_mount "$@"
      ;;
    doctor)
      shift
      cmd_doctor "$@"
      ;;
    status)
      shift
      cmd_status "$@"
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      usage >&2
      error "unknown command: ${command}"
      ;;
  esac
}

# When sourced, define the `relay` function for interactive use.
# When executed directly, run main immediately.
if [[ ${_relay_is_sourced} -eq 0 ]]; then
  main "$@"
else
  relay() { main "$@"; }
  echo "relay loaded. Run 'relay help' for usage."
fi
