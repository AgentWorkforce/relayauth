#!/usr/bin/env bash
#
# mint-api-key.sh — provision a relayauth api-key with a given scope set
#
# Why this script exists
#   Hand-rolling api-key minting via curl is error-prone: the call requires an
#   admin bearer (HS256, signed locally with the prod SIGNING_KEY), the right
#   request body shape, and a strict scope-subset check on the server. Rotating
#   sage's api-key on 2026-04-23 surfaced two real footguns:
#     - Picking the wrong scopes (e.g., {"scopes": ["cloud:specialist:invoke"]}
#       instead of the relayauth+relayfile scopes sage actually needs) succeeds
#       at the mint, fails at runtime with insufficient_scope.
#     - Echoing the new key value into terminal/shell history before piping it
#       to a secret store leaks it.
#
#   This script wraps both: it mints the admin bearer, calls POST /v1/api-keys,
#   prints only the api-key id + scopes, and writes the secret value to either
#   a restricted tempfile or directly to a GitHub Actions secret via stdin —
#   never to the terminal unless --print-key is explicitly passed.
#
# Usage:
#   ./scripts/mint-api-key.sh \
#     --name sage-relayfile-minter \
#     --scopes-json '["relayauth:identity:manage:*","relayauth:token:create:*","relayfile:fs:read:*","relayfile:fs:write:*"]' \
#     --to-gh-secret AgentWorkforce/cloud:SAGE_RELAYAUTH_API_KEY \
#     --revoke-prior ak_3a7317be58de40f39ef18028393fd0f9
#
# Scope-picking note
#   Scope actions are NOT commutative. The matcher treats `manage` as
#   implying `create/read/write/delete`, but not the reverse — an
#   api-key with `identity:create:*` cannot call a route that requires
#   `identity:manage:*`. Always check the required-scope string at the
#   route you need to call (see docs/operations/api-key-minting.md).
#
#   Common flags:
#     --name <string>             Required. api-key name (operator-readable).
#     --scopes-json <json-array>  Required. JSON array of scope strings.
#     --org <string>              Defaults to env RELAYAUTH_ORG or "org_dev".
#                                 The new api-key will be tied to this org.
#     --relayauth-url <url>       Defaults to https://api.relayauth.dev.
#     --to-gh-secret REPO:NAME    Pipe the key directly into a GH Actions
#                                 secret. Requires gh CLI with write access.
#                                 Repo + secret name are colon-separated
#                                 (e.g., AgentWorkforce/cloud:SAGE_RELAYAUTH_API_KEY).
#     --to-file PATH              Write the key to PATH (chmod 600).
#                                 Mutually exclusive with --to-gh-secret.
#     --print-key                 Write the key value to stdout. Disabled by
#                                 default — only use when piping to another
#                                 process. The value will appear in shell
#                                 history if you run the script directly.
#     --revoke-prior <id>         After successful mint, revoke an old
#                                 api-key by id. Use to rotate cleanly.
#     --no-scrub                  Skip env-var unset at exit (debugging only).
#     --dry-run                   Mint the admin bearer but do NOT call
#                                 /v1/api-keys; print the request body instead.
#     -h, --help                  This help.
#
# Required tools: openssl, jq, curl. Optional: gh (for --to-gh-secret).
#
# Required env (for the admin bearer):
#   SIGNING_KEY              Production signing secret. Defaults to "dev-secret"
#                            via scripts/generate-dev-token.sh — fine for local
#                            dev relayauth, MUST be set explicitly to mint
#                            against a non-default-secret deployment.
#
# Exit codes:
#   0  — api-key minted (and stored, if --to-gh-secret/--to-file)
#   1  — input validation, dependency missing, or RelayAuth call failed
#   2  — api-key minted but post-mint storage step (gh secret / file) failed.
#        The minted key id is logged; manually revoke via /v1/api-keys/<id>/revoke
#        if the value did not reach a secure store.

set -euo pipefail

# ── Args ─────────────────────────────────────────────────────────────────────
NAME=""
SCOPES_JSON=""
ORG="${RELAYAUTH_ORG:-org_dev}"
RELAYAUTH_URL="${RELAYAUTH_URL:-https://api.relayauth.dev}"
TO_GH_SECRET=""
TO_FILE=""
PRINT_KEY=false
REVOKE_PRIOR=""
NO_SCRUB=false
DRY_RUN=false

usage() {
  awk '
    /^set -euo/ { exit }
    /^# / { sub(/^# ?/, ""); print }
    /^#$/ { print "" }
  ' "$0"
}

while [[ $# -gt 0 ]]; do
  case $1 in
    --name)            NAME="$2"; shift 2 ;;
    --scopes-json)     SCOPES_JSON="$2"; shift 2 ;;
    --org)             ORG="$2"; shift 2 ;;
    --relayauth-url)   RELAYAUTH_URL="$2"; shift 2 ;;
    --to-gh-secret)    TO_GH_SECRET="$2"; shift 2 ;;
    --to-file)         TO_FILE="$2"; shift 2 ;;
    --print-key)       PRINT_KEY=true; shift ;;
    --revoke-prior)    REVOKE_PRIOR="$2"; shift 2 ;;
    --no-scrub)        NO_SCRUB=true; shift ;;
    --dry-run)         DRY_RUN=true; shift ;;
    -h|--help)         usage; exit 0 ;;
    *)                 echo "unknown arg: $1" >&2; usage >&2; exit 1 ;;
  esac
done

# ── Validate ─────────────────────────────────────────────────────────────────
require_cmd() {
  command -v "$1" >/dev/null 2>&1 || { echo "missing dependency: $1" >&2; exit 1; }
}
require_cmd openssl
require_cmd jq
require_cmd curl

[[ -n "$NAME" ]]        || { echo "--name is required" >&2; exit 1; }
[[ -n "$SCOPES_JSON" ]] || { echo "--scopes-json is required" >&2; exit 1; }
echo "$SCOPES_JSON" | jq -e 'type == "array" and all(type == "string")' >/dev/null \
  || { echo "--scopes-json must be a JSON array of strings, got: $SCOPES_JSON" >&2; exit 1; }

if [[ -n "$TO_GH_SECRET" && -n "$TO_FILE" ]]; then
  echo "--to-gh-secret and --to-file are mutually exclusive" >&2
  exit 1
fi
if [[ -n "$TO_GH_SECRET" ]]; then
  require_cmd gh
  [[ "$TO_GH_SECRET" == */*:* ]] || {
    echo "--to-gh-secret must be in REPO:NAME form (e.g. AgentWorkforce/cloud:SAGE_RELAYAUTH_API_KEY)" >&2
    exit 1
  }
fi

# ── Mint admin bearer (HS256) via the existing helper ────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
[[ -x "$SCRIPT_DIR/generate-dev-token.sh" ]] || {
  echo "missing $SCRIPT_DIR/generate-dev-token.sh — required to mint admin bearer" >&2
  exit 1
}

ADMIN_BEARER="$(
  RELAYAUTH_ORG="$ORG" \
  RELAYAUTH_ISSUER="https://relayauth.dev" \
  RELAYAUTH_SCOPES_JSON='["*:*:*:*"]' \
  RELAYAUTH_AUDIENCE_JSON='["relayauth"]' \
  RELAYAUTH_TTL_SECONDS=600 \
  "$SCRIPT_DIR/generate-dev-token.sh"
)"

scrub() {
  if [[ "$NO_SCRUB" == "false" ]]; then
    unset ADMIN_BEARER NEW_KEY_VALUE RESPONSE
  fi
}
trap scrub EXIT

# ── Build request body ───────────────────────────────────────────────────────
REQ_BODY="$(jq -n \
  --arg name "$NAME" \
  --arg orgId "$ORG" \
  --argjson scopes "$SCOPES_JSON" \
  '{name: $name, orgId: $orgId, scopes: $scopes}')"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY RUN — would POST to $RELAYAUTH_URL/v1/api-keys with:"
  echo "$REQ_BODY" | jq .
  exit 0
fi

# ── Mint ─────────────────────────────────────────────────────────────────────
RESPONSE_FILE="$(mktemp -t relayauth-mint-XXXXXX)"
trap 'rm -f "$RESPONSE_FILE"; scrub' EXIT
HTTP_CODE="$(curl -sS -X POST "$RELAYAUTH_URL/v1/api-keys" \
  -H "Authorization: Bearer $ADMIN_BEARER" \
  -H "content-type: application/json" \
  -d "$REQ_BODY" \
  -o "$RESPONSE_FILE" \
  -w '%{http_code}')"

if [[ "$HTTP_CODE" != "201" ]]; then
  echo "mint failed: HTTP $HTTP_CODE" >&2
  cat "$RESPONSE_FILE" >&2
  echo >&2
  exit 1
fi

NEW_KEY_VALUE="$(jq -r .key < "$RESPONSE_FILE")"
NEW_KEY_ID="$(jq -r .apiKey.id < "$RESPONSE_FILE")"
NEW_KEY_SCOPES="$(jq -c .apiKey.scopes < "$RESPONSE_FILE")"

echo "minted: id=$NEW_KEY_ID scopes=$NEW_KEY_SCOPES"

# ── Store the secret value somewhere safe ────────────────────────────────────
storage_failed=0

if [[ -n "$TO_GH_SECRET" ]]; then
  REPO="${TO_GH_SECRET%%:*}"
  SECRET_NAME="${TO_GH_SECRET##*:}"
  if printf '%s' "$NEW_KEY_VALUE" | gh secret set "$SECRET_NAME" --repo "$REPO" 2>/tmp/gh-set-err; then
    echo "stored in gh secret: $REPO :: $SECRET_NAME"
  else
    echo "FAILED to set gh secret $REPO :: $SECRET_NAME:" >&2
    cat /tmp/gh-set-err >&2
    storage_failed=1
  fi
elif [[ -n "$TO_FILE" ]]; then
  if (umask 077 && printf '%s' "$NEW_KEY_VALUE" > "$TO_FILE"); then
    echo "stored at: $TO_FILE (mode 600)"
  else
    echo "FAILED to write $TO_FILE" >&2
    storage_failed=1
  fi
elif [[ "$PRINT_KEY" == "true" ]]; then
  printf '%s\n' "$NEW_KEY_VALUE"
else
  TMP="$(mktemp -t relayauth-key-XXXXXX)"
  chmod 600 "$TMP"
  printf '%s' "$NEW_KEY_VALUE" > "$TMP"
  echo "no --to-* destination given; key value written to: $TMP" >&2
  echo "(scrub it as soon as you've copied it elsewhere)" >&2
fi

if [[ "$storage_failed" -ne 0 ]]; then
  echo "mint succeeded but storage failed — manually revoke if value did not reach a secure store:" >&2
  echo "  curl -X POST $RELAYAUTH_URL/v1/api-keys/$NEW_KEY_ID/revoke -H \"Authorization: Bearer <admin>\"" >&2
  exit 2
fi

# ── Revoke the prior key, if requested ───────────────────────────────────────
if [[ -n "$REVOKE_PRIOR" ]]; then
  REVOKE_HTTP="$(curl -sS -X POST "$RELAYAUTH_URL/v1/api-keys/$REVOKE_PRIOR/revoke" \
    -H "Authorization: Bearer $ADMIN_BEARER" \
    -o /dev/null -w '%{http_code}')"
  if [[ "$REVOKE_HTTP" =~ ^(200|204)$ ]]; then
    echo "revoked prior api-key: $REVOKE_PRIOR"
  else
    echo "WARN: failed to revoke $REVOKE_PRIOR (HTTP $REVOKE_HTTP) — revoke manually" >&2
  fi
fi
