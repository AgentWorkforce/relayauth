#!/usr/bin/env bash
set -euo pipefail

HOOK_PATH="/Users/khaliqgant/Projects/AgentWorkforce/relayauth/scripts/relay/agentdeny-hook.sh"

PASS=0
FAIL=0

assert_denied() {
  local cmd="$1"
  local desc="$2"

  if _relay_check_deny "${cmd}" >/dev/null 2>&1; then
    echo "FAIL: ${desc}"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: ${desc}"
    PASS=$((PASS + 1))
  fi
}

assert_allowed() {
  local cmd="$1"
  local desc="$2"

  if _relay_check_deny "${cmd}" >/dev/null 2>&1; then
    echo "PASS: ${desc}"
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${desc}"
    FAIL=$((FAIL + 1))
  fi
}

TEST_ROOT="$(mktemp -d)"
export RELAY_WORKSPACE="${TEST_ROOT}"
cat > "${TEST_ROOT}/.agentdeny" <<'DENY_RULES'
git push *
sudo *
DENY_RULES

# shellcheck source=./agentdeny-hook.sh
source "${HOOK_PATH}"

assert_denied "git push origin main" "git push origin main denied"
assert_denied "sudo rm -rf /" "sudo rm -rf / denied"
assert_allowed "git status" "git status allowed"
assert_allowed "ls -la" "ls -la allowed"

rm -rf "${TEST_ROOT}"

echo "${PASS} passed, ${FAIL} failed"
[[ "${FAIL}" -eq 0 ]]
printf "\n"
exit "${FAIL}"
