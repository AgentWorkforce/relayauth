#!/usr/bin/env bash
#
# run-rs256-migration.sh — Master executor for the api-keys + RS256 migration
#
# Runs workflows 118-123 in order with hard gates between phases. Each
# workflow has its own internal review + approval gates; this runner adds
# inter-phase ordering, state checkpointing, and an explicit human pause
# before any phase that touches production cryptography.
#
# Spec: specs/api-keys-and-rs256-migration.md
#
# Usage:
#   ./scripts/run-rs256-migration.sh                    # start from where we left off
#   ./scripts/run-rs256-migration.sh --from 119         # start at a specific phase
#   ./scripts/run-rs256-migration.sh --only 120         # run a single phase
#   ./scripts/run-rs256-migration.sh --dry-run          # print plan without running
#   ./scripts/run-rs256-migration.sh --no-pause         # skip pre-cutover human pause (for testing)
#
# State is tracked in .rs256-migration-state.json (per-phase: pending/running/passed/failed).
# Pick-up-where-we-left-off behaviour mirrors scripts/run-all.sh.
#
# Exit codes:
#   0 — all requested phases passed (or were already passed)
#   1 — a phase failed; state file shows which one
#   2 — invalid args or precondition not met

set -euo pipefail
cd "$(dirname "$0")/.."

ROOT=$(pwd)
STATE_FILE="${ROOT}/.rs256-migration-state.json"
DRY_RUN=false
NO_PAUSE=false
START_FROM=""
ONLY=""

# ── Repo paths ─────────────────────────────────────────────────────────
RELAYAUTH_REPO="${RELAYAUTH_REPO:-/Users/khaliqgant/Projects/AgentWorkforce/relayauth}"
CLOUD_REPO="${CLOUD_REPO:-/Users/khaliqgant/Projects/AgentWorkforce/cloud}"

# ── Phase definitions ──────────────────────────────────────────────────
# id|file|description|cutover_risk|repos|branch_suffix
#   repos: comma-separated list of repos to branch + commit + PR at end
#          (relayauth | cloud | both)
#   branch_suffix: appended after migration/rs256/<id>- to form the branch
declare -a PHASES=(
  "118|118-tokens-route-phase0|Implement POST /v1/tokens|low|relayauth|tokens-route"
  "119|119-api-keys-phase1|Implement /v1/api-keys + x-api-key middleware|low|both|api-keys"
  "120|120-rs256-signing-phase2a|Add RS256 signing path (additive, HS256 stays default)|medium|relayauth|rs256-signing"
  "121|121-sdk-dual-verify-phase3a|TokenVerifier accepts both RS256 + HS256|medium|relayauth|sdk-dual-verify"
  "122|122-cloud-cutover-phase3b|Production cryptographic cutover|HIGH|cloud|cutover-infra"
  "123|123-bootstrap-sage-key-phase4|Provision sage RelayAuth API key|low|cloud|bootstrap-runbook"
)

# ── Args ───────────────────────────────────────────────────────────────
SKIP_PR=false

while [[ $# -gt 0 ]]; do
  case $1 in
    --from)   START_FROM="$2"; shift 2 ;;
    --only)   ONLY="$2"; shift 2 ;;
    --dry-run) DRY_RUN=true; shift ;;
    --no-pause) NO_PAUSE=true; shift ;;
    --skip-pr) SKIP_PR=true; shift ;;
    --help|-h)
      sed -n '3,25p' "$0"
      exit 0
      ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [ -n "$START_FROM" ] && [ -n "$ONLY" ]; then
  echo "--from and --only are mutually exclusive" >&2
  exit 2
fi

# ── State helpers ──────────────────────────────────────────────────────
ensure_state() {
  if [ ! -f "$STATE_FILE" ]; then
    echo "{}" > "$STATE_FILE"
  fi
}

get_state() {
  local id="$1"
  ensure_state
  jq -r --arg id "$id" '.[$id] // "pending"' "$STATE_FILE"
}

set_state() {
  local id="$1" status="$2"
  ensure_state
  local tmp
  tmp=$(mktemp)
  jq --arg id "$id" --arg status "$status" --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '.[$id] = {status: $status, ts: $ts}' "$STATE_FILE" > "$tmp"
  mv "$tmp" "$STATE_FILE"
}

# ── Preconditions ──────────────────────────────────────────────────────
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing required command: $1" >&2; exit 2; }
}

require_cmd jq
require_cmd agent-relay
require_cmd git
require_cmd gh

# ── Branch + commit + PR helpers ───────────────────────────────────────
checkout_phase_branch() {
  local repo_path="$1" id="$2" suffix="$3"
  local branch="migration/rs256/${id}-${suffix}"

  echo "  [git] preparing branch in $(basename "$repo_path"): $branch"
  git -C "$repo_path" fetch origin main --quiet
  # Branch from current main; if the branch already exists locally, reuse it.
  if git -C "$repo_path" show-ref --quiet "refs/heads/$branch"; then
    git -C "$repo_path" checkout "$branch" >/dev/null
    git -C "$repo_path" rebase origin/main >/dev/null || {
      echo "  [git] rebase conflict in $repo_path on $branch — resolve manually then re-run"
      exit 1
    }
  else
    git -C "$repo_path" checkout -b "$branch" origin/main >/dev/null
  fi
}

commit_phase_changes() {
  local repo_path="$1" id="$2" desc="$3"
  if git -C "$repo_path" diff --quiet && git -C "$repo_path" diff --cached --quiet && [ -z "$(git -C "$repo_path" ls-files --others --exclude-standard)" ]; then
    echo "  [git] no changes in $(basename "$repo_path") — skipping commit"
    return 0
  fi
  git -C "$repo_path" add -A
  git -C "$repo_path" commit -m "$(cat <<EOF
migration(rs256): phase ${id} — ${desc}

Generated by workflows/${id}-*.ts via scripts/run-rs256-migration.sh.
Spec: specs/api-keys-and-rs256-migration.md (phase ${id}).

Co-Authored-By: agent-relay <agent@agent-relay.com>
EOF
)" >/dev/null
  echo "  [git] committed $id changes in $(basename "$repo_path")"
}

open_phase_pr() {
  local repo_path="$1" id="$2" desc="$3" suffix="$4"
  local branch="migration/rs256/${id}-${suffix}"
  echo "  [gh] pushing + opening PR in $(basename "$repo_path"): $branch"
  git -C "$repo_path" push -u origin "$branch" >/dev/null 2>&1 || git -C "$repo_path" push --force-with-lease >/dev/null 2>&1
  gh pr view "$branch" --repo "$(repo_slug "$repo_path")" >/dev/null 2>&1 && {
    echo "  [gh] PR already exists for $branch"
    return 0
  }
  gh pr create \
    --repo "$(repo_slug "$repo_path")" \
    --base main \
    --head "$branch" \
    --title "migration(rs256): phase ${id} — ${desc}" \
    --body "$(phase_pr_body "$id" "$desc")" >/dev/null
  echo "  [gh] PR opened for $branch"
}

repo_slug() {
  local repo_path="$1"
  git -C "$repo_path" config --get remote.origin.url \
    | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?$#\1#'
}

phase_pr_body() {
  local id="$1" desc="$2"
  cat <<EOF
## Phase ${id} — ${desc}

Part of the api-keys + RS256 migration. See [\`specs/api-keys-and-rs256-migration.md\`](https://github.com/AgentWorkforce/relayauth/blob/main/specs/api-keys-and-rs256-migration.md) for the full design.

Generated by \`workflows/${id}-*.ts\` and committed by \`scripts/run-rs256-migration.sh\`. Every workflow runs the strict review template (implementer self-review + 2 parallel specialist peer reviewers + architect synthesis + approval gate); this PR exists because the gate passed.

### Run order in the migration

\`\`\`
118 → 119 → 120 → 121 → publish + propagate → 122 → 123
\`\`\`

This PR is phase **${id}**. Merge in order; each phase assumes its predecessors are deployed.

### Review focus

The workflow already enforced security + spec/compat review. Human review here should focus on:

- Cross-cutting concerns the workflow couldn't see (production load, capacity, customer-facing impact)
- Anything in the diff that *isn't* in the spec — flag it before merge
- Test coverage gaps the agents may have missed in their domain
EOF
}

# ── Resolve repos for a phase ──────────────────────────────────────────
phase_repo_paths() {
  local repos="$1"
  case "$repos" in
    relayauth) echo "$RELAYAUTH_REPO" ;;
    cloud)     echo "$CLOUD_REPO" ;;
    both)      echo "$RELAYAUTH_REPO $CLOUD_REPO" ;;
    *)         echo "Unknown repos value: $repos" >&2; exit 2 ;;
  esac
}

# ── Run a phase ────────────────────────────────────────────────────────
run_phase() {
  local id="$1" file="$2" desc="$3" risk="$4" repos="$5" suffix="$6"
  local state
  state=$(get_state "$id")

  if [ "$state" = "passed" ]; then
    echo "  [skip] $id already passed"
    return 0
  fi

  echo ""
  echo "==============================================================="
  echo "  Phase $id ($risk risk): $desc"
  echo "  Workflow: workflows/${file}.ts"
  echo "  Repos:    $repos"
  echo "==============================================================="

  if [ "$DRY_RUN" = true ]; then
    echo "  [dry-run] would: checkout migration/rs256/${id}-${suffix} in [$repos]"
    echo "  [dry-run] would run: agent-relay run workflows/${file}.ts"
    echo "  [dry-run] would commit + push + open PR per repo"
    return 0
  fi

  # HARD pause before HIGH-risk phases unless --no-pause given.
  if [ "$risk" = "HIGH" ] && [ "$NO_PAUSE" = false ]; then
    echo ""
    echo "  ⚠️  $id is HIGH-risk (production cryptographic cutover)."
    echo "      Confirm:"
    echo "        - Phases 118-121 are merged + deployed to production."
    echo "        - @relayauth/sdk dual-verify is published + consumed by every verifier (sage, etc.)."
    echo "        - You have an admin operator window scheduled for the manual go/no-go steps inside the workflow."
    echo ""
    read -r -p "  Type 'PROCEED' to continue, anything else to abort: " confirmation
    if [ "$confirmation" != "PROCEED" ]; then
      echo "  aborted by operator"
      exit 1
    fi
  fi

  # Branch in every affected repo BEFORE running the workflow, so file
  # writes land on the phase branch rather than directly on the working
  # main checkout.
  local repo
  for repo in $(phase_repo_paths "$repos"); do
    checkout_phase_branch "$repo" "$id" "$suffix"
  done

  set_state "$id" "running"
  if agent-relay run "workflows/${file}.ts"; then
    set_state "$id" "passed"
    echo "  ✓ $id workflow passed"
  else
    set_state "$id" "failed"
    echo "  ✗ $id workflow failed — see output above. Re-run this script to retry; branch is preserved."
    exit 1
  fi

  # Commit + PR each affected repo. If --skip-pr, commit only.
  for repo in $(phase_repo_paths "$repos"); do
    commit_phase_changes "$repo" "$id" "$desc"
    if [ "$SKIP_PR" = false ]; then
      open_phase_pr "$repo" "$id" "$desc" "$suffix"
    fi
  done
}

# ── Main loop ──────────────────────────────────────────────────────────
echo "rs256 migration — state file: $STATE_FILE"
ensure_state

for phase in "${PHASES[@]}"; do
  IFS='|' read -r id file desc risk repos suffix <<< "$phase"

  if [ -n "$ONLY" ] && [ "$ONLY" != "$id" ]; then
    continue
  fi

  if [ -n "$START_FROM" ] && [ "$id" \< "$START_FROM" ]; then
    continue
  fi

  run_phase "$id" "$file" "$desc" "$risk" "$repos" "$suffix"
done

echo ""
echo "==============================================================="
echo "  Migration runner complete. Final state:"
jq . "$STATE_FILE"
echo "==============================================================="
