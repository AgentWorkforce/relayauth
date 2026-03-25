#!/usr/bin/env bash
#
# Run all Domain 13 workflows (101-110) sequentially.
# Stops on first failure and reports which workflow failed.
#
# Usage: ./scripts/run-domain-13.sh
#

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

WORKFLOWS=(
  101-well-known-spec
  102-well-known-endpoint
  103-openapi-to-scopes
  104-framework-adapter-types
  105-adapter-vercel-ai
  106-adapter-openai
  107-adapter-anthropic
  108-init-wizard
  109-a2a-discovery-bridge
  110-discovery-ecosystem-e2e
)

PASSED=()
FAILED=""

log() { printf "\n\033[1;34m[domain-13]\033[0m %s\n" "$1"; }
ok()  { printf "\033[1;32m  PASS\033[0m %s\n" "$1"; }
fail(){ printf "\033[1;31m  FAIL\033[0m %s\n" "$1"; }

log "Starting Domain 13: Discovery & Ecosystem (${#WORKFLOWS[@]} workflows)"
echo "────────────────────────────────────────────────────"

for wf in "${WORKFLOWS[@]}"; do
  WF_FILE="$ROOT/workflows/${wf}.ts"

  if [[ ! -f "$WF_FILE" ]]; then
    fail "$wf — file not found: $WF_FILE"
    FAILED="$wf"
    break
  fi

  log "Running $wf ..."

  if agent-relay run "$WF_FILE" 2>&1 | tee "/tmp/relayauth-${wf}.log"; then
    ok "$wf"
    PASSED+=("$wf")
  else
    fail "$wf (exit code: $?)"
    FAILED="$wf"
    break
  fi
done

echo ""
echo "════════════════════════════════════════════════════"

if [[ -n "$FAILED" ]]; then
  log "STOPPED at $FAILED"
  echo ""
  echo "Passed (${#PASSED[@]}/${#WORKFLOWS[@]}):"
  for p in "${PASSED[@]}"; do
    echo "  - $p"
  done
  echo ""
  echo "Failed:"
  echo "  - $FAILED"
  echo ""
  echo "Log: /tmp/relayauth-${FAILED}.log"
  exit 1
else
  log "ALL ${#WORKFLOWS[@]} workflows passed"
  exit 0
fi
