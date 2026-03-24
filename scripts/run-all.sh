#!/usr/bin/env bash
#
# run-all.sh — Sequential workflow runner for relayauth
#
# Runs workflows in domain order, commits between each, opens PRs at
# natural domain boundaries. Picks up where it left off if interrupted.
#
# Usage:
#   ./scripts/run-all.sh                    # start from where we left off
#   ./scripts/run-all.sh --from 007         # start from workflow 007
#   ./scripts/run-all.sh --dry-run          # validate all workflows without running
#   ./scripts/run-all.sh --skip-pr          # run without opening PRs
#
# State is tracked in .workflow-state.json

set -euo pipefail
cd "$(dirname "$0")/.."

ROOT=$(pwd)
STATE_FILE="/tmp/relayauth-workflow-state.json"
BRANCH_BASE="main"
DRY_RUN=false
SKIP_PR=false
START_FROM=""

# ── Parse args ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --from) START_FROM="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --skip-pr) SKIP_PR=true; shift ;;
    *) echo "Unknown arg: $1"; exit 1 ;;
  esac
done

# ── Domain definitions ───────────────────────────────────────────────
# Each domain is a PR boundary: [branch_name, pr_title, workflow_range]
declare -a DOMAINS=(
  # Domain 1: Foundation (007-010, since 001-006 are done)
  "domain-1/foundation|feat: Domain 1 — Foundation (error catalog, test helpers, dev env, contract tests)|007 008 009 010"

  # Domain 2: Token System
  "domain-2/token-system|feat: Domain 2 — Token System (JWT signing, JWKS, verification, issuance, refresh, revocation)|011 012 013 014 015 016 017 018 019 020"

  # Domain 3: Identity Lifecycle
  "domain-3/identity-lifecycle|feat: Domain 3 — Identity Lifecycle (Durable Object, CRUD, suspend, retire, delete)|021 022 023 024 025 026 027 028 029 030"

  # Domain 4: Scopes & RBAC
  "domain-4/scopes-rbac|feat: Domain 4 — Scopes & RBAC (parser, matcher, middleware, roles, policies, VCS scopes)|031 032 033 034 035 036 037 038 039 040"

  # Domain 5: API Routes
  "domain-5/api-routes|feat: Domain 5 — API Routes (auth middleware, org/workspace CRUD, API keys, rate limiting)|041 042 043 044 045 046 047 048 049 050"

  # Domain 6: Audit & Observability
  "domain-6/audit|feat: Domain 6 — Audit & Observability (logger, query, export, retention, webhooks, dashboard)|051 052 053 054 055 056 057 058"

  # Domain 7: SDK & Verification
  "domain-7/sdk|feat: Domain 7 — SDK & Verification (TS client, Hono/Express middleware, Go, Python)|059 060 061 062 063 064 065 066 067 068"

  # Domain 8: CLI
  "domain-8/cli|feat: Domain 8 — CLI (framework, login, identity, token, role, audit commands)|069 070 071 072 073 074 075"

  # Domain 9: Integration
  "domain-9/integration|feat: Domain 9 — Integration (relaycast, relayfile, cloud, cross-plane, propagation)|076 077 078 079 080 081 082"

  # Domain 10: Hosted Server
  "domain-10/hosted|feat: Domain 10 — Hosted Server (wrangler, D1, DOs, KV, deploy staging/prod)|083 084 085 086 087 088 089 090"

  # Domain 11: Testing & CI
  "domain-11/testing-ci|feat: Domain 11 — Testing & CI (unit, integration, E2E, CI, npm publish, deploy)|091 092 093 094 095 096"

  # Domain 12: Docs & Landing
  "domain-12/docs|feat: Domain 12 — Docs & Landing (README, API docs, integration guides, landing page)|097 098 099 100"
)

# ── State management ─────────────────────────────────────────────────
init_state() {
  if [[ ! -f "$STATE_FILE" ]]; then
    echo '{"lastCompleted": "006", "currentDomain": 0, "failedWorkflows": []}' > "$STATE_FILE"
  fi
}

get_last_completed() {
  python3 -c "import json; print(json.load(open('$STATE_FILE'))['lastCompleted'])"
}

set_last_completed() {
  local wf="$1"
  python3 -c "
import json
s = json.load(open('$STATE_FILE'))
s['lastCompleted'] = '$wf'
json.dump(s, open('$STATE_FILE', 'w'), indent=2)
"
}

record_failure() {
  local wf="$1"
  local reason="$2"
  python3 -c "
import json
s = json.load(open('$STATE_FILE'))
s['failedWorkflows'].append({'workflow': '$wf', 'reason': '''$reason''', 'timestamp': '$(date -u +%Y-%m-%dT%H:%M:%SZ)'})
json.dump(s, open('$STATE_FILE', 'w'), indent=2)
"
}

# ── Helpers ──────────────────────────────────────────────────────────
log() { echo -e "\033[1;36m[run-all]\033[0m $*"; }
ok()  { echo -e "\033[1;32m  ✅ $*\033[0m"; }
fail() { echo -e "\033[1;31m  ❌ $*\033[0m"; }
hr()  { echo -e "\033[2m$(printf '─%.0s' {1..60})\033[0m"; }

run_workflow() {
  local wf_num="$1"
  local wf_file="workflows/${wf_num}-*.ts"

  # Find the actual file (glob)
  local actual_file
  actual_file=$(ls $wf_file 2>/dev/null | head -1)
  if [[ -z "$actual_file" ]]; then
    fail "No workflow file matching $wf_file"
    return 1
  fi

  log "Running workflow $wf_num: $(basename "$actual_file" .ts)"

  if $DRY_RUN; then
    npx agent-relay run --dry-run "$actual_file" 2>&1 | tail -3
    return $?
  fi

  # Run the workflow
  local start_time
  start_time=$(date +%s)

  if npx agent-relay run "$actual_file" 2>&1 | tee "/tmp/relayauth-wf-${wf_num}.log"; then
    local elapsed=$(( $(date +%s) - start_time ))
    ok "Workflow $wf_num completed in ${elapsed}s"

    # Commit any changes
    if [[ -n "$(git status --porcelain)" ]]; then
      git add -A
      git commit -m "wf${wf_num}: $(basename "$actual_file" .ts | sed 's/^[0-9]*-//')"
      ok "Committed changes from $wf_num"
    else
      log "  No file changes from $wf_num"
    fi

    set_last_completed "$wf_num"
    return 0
  else
    local elapsed=$(( $(date +%s) - start_time ))
    fail "Workflow $wf_num failed after ${elapsed}s"

    # Still commit if there are changes (partial work)
    if [[ -n "$(git status --porcelain)" ]]; then
      git add -A
      git commit -m "wf${wf_num}: $(basename "$actual_file" .ts | sed 's/^[0-9]*-//') (partial — workflow failed)"
      log "  Committed partial work from $wf_num"
    fi

    record_failure "$wf_num" "exit code $?"
    # Continue to next workflow instead of stopping
    set_last_completed "$wf_num"
    return 0
  fi
}

open_pr() {
  local branch="$1"
  local title="$2"

  if $SKIP_PR || $DRY_RUN; then
    log "Would open PR: $title"
    return 0
  fi

  git push origin "$branch" 2>&1

  # Check if PR already exists
  local existing
  existing=$(gh pr list --head "$branch" --repo AgentWorkforce/relayauth --json number -q '.[0].number' 2>/dev/null || true)
  if [[ -n "$existing" ]]; then
    log "PR #$existing already exists for $branch"
    return 0
  fi

  gh pr create \
    --title "$title" \
    --body "Auto-generated by run-all.sh. See individual commit messages for workflow details." \
    --base main \
    --head "$branch" \
    --repo AgentWorkforce/relayauth \
    --draft

  ok "PR opened: $title"
}

typecheck() {
  log "Running typecheck..."
  if npm run typecheck 2>&1 | tail -3; then
    ok "Typecheck passed"
    return 0
  else
    fail "Typecheck failed"
    return 1
  fi
}

# ── Main ─────────────────────────────────────────────────────────────
init_state

LAST_COMPLETED=$(get_last_completed)
if [[ -n "$START_FROM" ]]; then
  LAST_COMPLETED=$(printf "%03d" $(( 10#$START_FROM - 1 )))
  log "Starting from workflow $START_FROM (override)"
else
  log "Last completed: $LAST_COMPLETED, resuming from next"
fi

for domain_entry in "${DOMAINS[@]}"; do
  IFS='|' read -r branch title workflows <<< "$domain_entry"

  # Parse workflow numbers
  read -ra wf_nums <<< "$workflows"

  # Skip domains that are fully completed
  last_wf="${wf_nums[${#wf_nums[@]}-1]}"
  if [[ "$(printf "%03d" "$((10#$last_wf))")" < "$LAST_COMPLETED" ]] || [[ "$(printf "%03d" "$((10#$last_wf))")" == "$LAST_COMPLETED" ]]; then
    log "Skipping $branch (all workflows ≤ $LAST_COMPLETED)"
    continue
  fi

  hr
  log "📦 Domain: $title"
  log "   Branch: $branch"
  log "   Workflows: ${workflows}"
  hr

  if ! $DRY_RUN; then
    # Create or switch to domain branch
    git fetch origin main 2>/dev/null || true
    if git show-ref --verify --quiet "refs/heads/$branch" 2>/dev/null; then
      git checkout "$branch"
    else
      git checkout -b "$branch" origin/main
    fi
  fi

  for wf_num in "${wf_nums[@]}"; do
    wf_padded=$(printf "%03d" "$((10#$wf_num))")

    # Skip already completed
    if [[ "$wf_padded" < "$LAST_COMPLETED" ]] || [[ "$wf_padded" == "$LAST_COMPLETED" ]]; then
      log "  Skipping $wf_padded (already completed)"
      continue
    fi

    run_workflow "$wf_padded"
  done

  # Typecheck at domain boundary
  if ! $DRY_RUN; then
    typecheck || true
  fi

  # Open PR at domain boundary
  open_pr "$branch" "$title"

  log "✅ Domain complete: $branch"
  echo ""
done

hr
log "🎉 All domains complete!"
log "State: $(cat "$STATE_FILE")"
