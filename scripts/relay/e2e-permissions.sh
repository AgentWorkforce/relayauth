#!/usr/bin/env bash
set -euo pipefail

# Colors
GREEN="\x1b[0;32m"; RED="\x1b[0;31m"; NC="\x1b[0m"
PASS=0; FAIL=0

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; FAIL=$((FAIL+1)); }

# Setup test project
TESTDIR=$(mktemp -d)
mkdir -p "${TESTDIR}/src" "${TESTDIR}/secrets"
echo "app code" > "${TESTDIR}/src/app.ts"
echo "SECRET=abc" > "${TESTDIR}/secrets/key.txt"
echo "DB_URL=postgres://..." > "${TESTDIR}/.env"
echo "# Project" > "${TESTDIR}/README.md"

cat > "${TESTDIR}/.agentignore" << 'EOF_DOT'
.env
secrets/
EOF_DOT

cat > "${TESTDIR}/.agentreadonly" << 'EOF_DOT'
README.md
EOF_DOT

cat > "${TESTDIR}/.agentdeny" << 'EOF_DOT'
git push *
sudo *
EOF_DOT

cd "${TESTDIR}"

# Source relay
source "/Users/khaliqgant/Projects/AgentWorkforce/relayauth/scripts/relay/relay.sh"

# Test 1: dotfile parser
echo "=== Dotfile Parser ==="
if relay scan 2>/dev/null | grep -q "ignored\|Ignored"; then
  pass "relay scan shows ignored files"
else
  fail "relay scan didn't show ignored files"
fi

# Test 2: provision + workspace (needs services)
if curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1 && curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1; then
  echo "=== Services Running — Full E2E ==="

  relay provision 2>/dev/null

  # Test token scopes
  TOKEN=$(cat .relay/tokens/default-agent.jwt 2>/dev/null || echo "")
  if [[ -n "${TOKEN}" ]]; then
    # Check .env NOT in scopes
    if echo "${TOKEN}" | cut -d. -f2 | base64 -d 2>/dev/null | grep -q '.env'; then
      fail ".env found in token scopes"
    else
      pass ".env not in token scopes"
    fi

    # Check src/app.ts IS in scopes
    if echo "${TOKEN}" | cut -d. -f2 | base64 -d 2>/dev/null | grep -q 'src/app.ts'; then
      pass "src/app.ts in token scopes"
    else
      fail "src/app.ts not in token scopes"
    fi
  else
    fail "no token generated"
  fi

  # Test mount workspace
  WORKSPACE=".relay/workspace-default-agent"
  if [[ -d "${WORKSPACE}" ]] || mkdir -p "${WORKSPACE}"; then
    /Users/khaliqgant/Projects/AgentWorkforce/relayfile/bin/relayfile-mount \
      --base-url http://127.0.0.1:8080 \
      --workspace "$(basename "${TESTDIR}")" \
      --token "${TOKEN}" \
      --local-dir "${WORKSPACE}" \
      --once 2>/dev/null

    # secrets/ should not exist
    if [[ ! -d "${WORKSPACE}/secrets" ]]; then
      pass "secrets/ not in workspace"
    else
      fail "secrets/ visible in workspace"
    fi

    # README.md should be readonly
    if [[ -f "${WORKSPACE}/README.md" ]] && [[ ! -w "${WORKSPACE}/README.md" ]]; then
      pass "README.md is readonly (444)"
    elif [[ -f "${WORKSPACE}/README.md" ]]; then
      fail "README.md is writable (should be 444)"
    else
      fail "README.md not in workspace"
    fi

    # src/app.ts should be writable
    if [[ -f "${WORKSPACE}/src/app.ts" ]] && [[ -w "${WORKSPACE}/src/app.ts" ]]; then
      pass "src/app.ts is writable"
    else
      fail "src/app.ts not writable"
    fi
  fi
else
  echo "=== Services Not Running — Skipping E2E ==="
fi

# Cleanup
rm -rf "${TESTDIR}"

echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
[[ ${FAIL} -eq 0 ]] && exit 0 || exit 1
