#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RELAY_SCRIPT="$ROOT_DIR/scripts/relay/relay.sh"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/relayauth-relay-run.XXXXXX")"
FAKE_RELAYFILE_ROOT="$TEMP_DIR/fake-relayfile"

COLOR_RED='\033[0;31m'
COLOR_GREEN='\033[0;32m'
COLOR_BLUE='\033[0;34m'
COLOR_RESET='\033[0m'

ASSERTIONS=0
FAILURES=0

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

cleanup() {
  (
    cd "$TEMP_DIR"
    RELAYAUTH_ROOT="$ROOT_DIR" RELAYFILE_ROOT="$FAKE_RELAYFILE_ROOT" bash "$RELAY_SCRIPT" unmount --all >/dev/null 2>&1 || true
  )
  rm -rf "$TEMP_DIR"
}

trap cleanup EXIT

assert_mount_count() {
  local expected="$1"
  local description="$2"
  local actual
  actual="$(node -e 'const fs=require("node:fs"); const mounts=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(mounts.length));' "$TEMP_DIR/.relay/mounts.json")"
  if [[ "$actual" == "$expected" ]]; then
    print_pass "$description"
  else
    print_fail "$description (expected $expected, got $actual)"
  fi
}

assert_json_contains() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  if grep -F "$pattern" "$file" >/dev/null 2>&1; then
    print_pass "$description"
  else
    print_fail "$description"
  fi
}

assert_command_contains() {
  local description="$1"
  local pattern="$2"
  shift 2
  local output
  if output="$("$@" 2>&1)" && printf '%s' "$output" | grep -F "$pattern" >/dev/null 2>&1; then
    print_pass "$description"
  else
    print_fail "$description"
  fi
}

run_relay() {
  (
    cd "$TEMP_DIR"
    RELAYAUTH_ROOT="$ROOT_DIR" RELAYFILE_ROOT="$FAKE_RELAYFILE_ROOT" bash "$RELAY_SCRIPT" "$@"
  )
}

setup_fixture() {
  mkdir -p "$TEMP_DIR/.relay/tokens" "$FAKE_RELAYFILE_ROOT/bin"

  cat > "$TEMP_DIR/relay.yaml" <<'EOF'
version: "1"
workspace: relay-run-e2e
signing_secret: local-secret
agents:
  - name: alpha
    scopes:
      - relayfile:fs:read:*
    roles: []
  - name: beta
    scopes:
      - relayfile:fs:read:*
    roles: []
acl: {}
roles: {}
EOF

  printf 'alpha-token\n' > "$TEMP_DIR/.relay/tokens/alpha.jwt"
  printf 'beta-token\n' > "$TEMP_DIR/.relay/tokens/beta.jwt"

  cat > "$FAKE_RELAYFILE_ROOT/bin/relayfile-mount" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

BASE_URL=""
WORKSPACE=""
TOKEN=""
LOCAL_DIR=""
STATE_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --base-url)
      BASE_URL="$2"
      shift 2
      ;;
    --workspace)
      WORKSPACE="$2"
      shift 2
      ;;
    --token)
      TOKEN="$2"
      shift 2
      ;;
    --local-dir)
      LOCAL_DIR="$2"
      shift 2
      ;;
    --state-file)
      STATE_FILE="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

mkdir -p "$LOCAL_DIR" "$(dirname "$STATE_FILE")"
printf '{"pid":%s,"workspace":"%s","baseUrl":"%s","token":"%s"}\n' "$$" "$WORKSPACE" "$BASE_URL" "$TOKEN" > "$STATE_FILE"
printf '%s\n' "$$" > "$LOCAL_DIR/.mount-pid"

trap 'exit 0' TERM INT
while true; do
  sleep 1
done
EOF
  chmod +x "$FAKE_RELAYFILE_ROOT/bin/relayfile-mount"
}

main() {
  print_info "Preparing relay mount lifecycle fixture"
  setup_fixture

  run_relay mount alpha "$TEMP_DIR/mount-alpha" >/dev/null
  run_relay mount beta "$TEMP_DIR/mount-beta" >/dev/null

  assert_mount_count "2" "Mount registry tracks both managed mounts"
  assert_json_contains "$TEMP_DIR/.relay/mounts.json" '"agentName": "alpha"' "Mount registry records alpha"
  assert_json_contains "$TEMP_DIR/.relay/mounts.json" '"agentName": "beta"' "Mount registry records beta"
  assert_command_contains "relay mounts lists alpha" "alpha" run_relay mounts
  assert_command_contains "relay mounts lists beta" "beta" run_relay mounts

  run_relay unmount alpha >/dev/null
  assert_mount_count "1" "Unmount removes only the targeted mount"
  assert_command_contains "relay mounts still lists beta after alpha unmount" "beta" run_relay mounts

  run_relay down >/dev/null
  assert_mount_count "0" "relay down cleans up remaining mounts"
  assert_command_contains "relay mounts reports empty state after down" "No active managed mounts" run_relay mounts

  echo
  echo "Assertions: $ASSERTIONS"
  echo "Failures: $FAILURES"
  echo "Artifact: $ROOT_DIR/scripts/relay/e2e-relay-run.sh"

  if [[ "$FAILURES" -gt 0 ]]; then
    exit 1
  fi
}

main "$@"
