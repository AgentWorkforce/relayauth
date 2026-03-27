#!/usr/bin/env bash
set -euo pipefail

PASS=0
FAIL=0

assert_denied() {
  local cmd="$1"
  local desc="$2"
  if bash -c "source ${HOOK_PATH}; _relay_check_deny '${cmd}'" 2>/dev/null; then
    echo "FAIL: ${desc} — expected denied but was allowed"
    FAIL=$((FAIL + 1))
  else
    echo "PASS: ${desc}"
    PASS=$((PASS + 1))
  fi
}

assert_allowed() {
  local cmd="$1"
  local desc="$2"
  if bash -c "source ${HOOK_PATH}; _relay_check_deny '${cmd}'" 2>/dev/null; then
    echo "PASS: ${desc}"
    PASS=$((PASS + 1))
  else
    echo "FAIL: ${desc} — expected allowed but was denied"
    FAIL=$((FAIL + 1))
  fi
}

# Setup
HOOK_PATH="/Users/khaliqgant/Projects/AgentWorkforce/relayauth/scripts/relay/agentdeny-hook.sh"
TMPDIR=$(mktemp -d)
export RELAY_WORKSPACE="${TMPDIR}"
cat > "${TMPDIR}/.agentdeny" <<'DENY_RULES'
git push *
git push origin main
rm -rf /
rm -rf ~
sudo *
cd ../
cd ~
DENY_RULES

# Tests
assert_denied "git push origin main" "git push origin main blocked"
assert_denied "git push origin feature" "git push origin feature blocked"
assert_denied "sudo apt install vim" "sudo blocked"
assert_denied "rm -rf /" "rm -rf / blocked"
assert_denied "rm -rf ~" "rm -rf ~ blocked"
assert_denied "cd ../" "cd ../ blocked"
assert_denied "cd ~" "cd ~ blocked"
assert_allowed "git status" "git status allowed"
assert_allowed "git commit -m 'test'" "git commit allowed"
assert_allowed "git pull" "git pull allowed"
assert_allowed "ls -la" "ls allowed"
assert_allowed "npm install" "npm install allowed"
assert_allowed "rm temp.txt" "rm single file allowed"

# Cleanup
rm -rf "${TMPDIR}"

echo ""
echo "${PASS} passed, ${FAIL} failed"
[[ ${FAIL} -eq 0 ]] && exit 0 || exit 1
