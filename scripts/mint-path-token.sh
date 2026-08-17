#!/usr/bin/env bash
#
# mint-path-token.sh — rotate the fixed cloud Factory RelayAuth path-token pair
#
# This operator script reads FACTORY_RELAYFILE_SCOPES from the Factory source,
# mints one access/refresh relay_pa pair, validates the response contract, and
# stores both values without printing either token. The production-safe target
# is AgentWorkforce/factory-cloud, where refresh is written before access.
#
# Usage:
#   ./scripts/mint-path-token.sh --dry-run \
#     --factory-source ../factory/src/mount/relayfile-cloud-mount-client.ts
#
#   RELAYAUTH_SIGNING_KEY_PEM="..." ./scripts/mint-path-token.sh \
#     --factory-source ../factory/src/mount/relayfile-cloud-mount-client.ts \
#     --to-gh-secret AgentWorkforce/factory-cloud \
#     --revoke-prior <prior-session-id>
#
# Options:
#   --factory-source PATH    TypeScript source that exports
#                            FACTORY_RELAYFILE_SCOPES. Defaults to the sibling
#                            AgentWorkforce/factory checkout when present.
#   --relayauth-url URL      Defaults to https://api.relayauth.dev.
#   --delegation-not-after   ISO timestamp; defaults to 90 days from now.
#   --to-gh-secret REPO      Store FACTORY_RELAYAUTH_REFRESH_TOKEN first and
#                            FACTORY_RELAYAUTH_ACCESS_TOKEN last. The only
#                            accepted production repo is
#                            AgentWorkforce/factory-cloud.
#   --to-file DIR            Store access-token and refresh-token in a mode-700
#                            directory as mode-600 files. Mutually exclusive
#                            with --to-gh-secret.
#   --revoke-prior ID        Revoke a prior session only after both new values
#                            are stored successfully.
#   --dry-run                Print only the request body; do not sign, mint,
#                            store, or revoke anything.
#   -h, --help               Show this help.
#
# Required for a real mint:
#   RELAYAUTH_SIGNING_KEY_PEM  RS256 production signing key. The value is never
#                              printed or written by this script.
#
# Exit codes:
#   0 — dry-run completed, or pair minted, validated, stored, and prior session
#       revoked when requested.
#   1 — validation or mint failed before custody changed.
#   2 — mint succeeded but storage or prior-session revocation failed.

set -euo pipefail

FACTORY_WORKSPACE_ID="rw_7ccfea89"
FACTORY_AGENT_NAME="agent-relay-factory"
FACTORY_ACCESS_TTL_SECONDS=3600
FACTORY_REFRESH_TTL_SECONDS=7776000
FACTORY_TARGET_REPO="AgentWorkforce/factory-cloud"
RELAYAUTH_URL="${RELAYAUTH_URL:-https://api.relayauth.dev}"
FACTORY_SOURCE="${FACTORY_SOURCE:-}"
DELEGATION_NOT_AFTER=""
TO_GH_SECRET=""
TO_FILE=""
REVOKE_PRIOR=""
DRY_RUN=false

usage() {
  awk '
    /^set -euo/ { exit }
    /^# / { sub(/^# ?/, ""); print }
    /^#$/ { print "" }
  ' "$0"
}

require_value() {
  if [[ $# -lt 2 || -z "$2" ]]; then
    echo "$1 requires a value" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --factory-source)
      require_value "$@"
      FACTORY_SOURCE="$2"
      shift 2
      ;;
    --relayauth-url)
      require_value "$@"
      RELAYAUTH_URL="$2"
      shift 2
      ;;
    --delegation-not-after)
      require_value "$@"
      DELEGATION_NOT_AFTER="$2"
      shift 2
      ;;
    --to-gh-secret)
      require_value "$@"
      TO_GH_SECRET="$2"
      shift 2
      ;;
    --to-file)
      require_value "$@"
      TO_FILE="$2"
      shift 2
      ;;
    --revoke-prior)
      require_value "$@"
      REVOKE_PRIOR="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=true
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown arg: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing dependency: $1" >&2
    exit 1
  }
}

require_cmd node
require_cmd jq

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
if [[ -z "$FACTORY_SOURCE" ]]; then
  FACTORY_SOURCE="$REPO_ROOT/../factory/src/mount/relayfile-cloud-mount-client.ts"
fi
if [[ ! -f "$FACTORY_SOURCE" ]]; then
  echo "Factory scope source not found: $FACTORY_SOURCE" >&2
  echo "Pass --factory-source with the reviewed relayfile-cloud-mount-client.ts path." >&2
  exit 1
fi

if [[ -n "$TO_GH_SECRET" && -n "$TO_FILE" ]]; then
  echo "--to-gh-secret and --to-file are mutually exclusive" >&2
  exit 1
fi
if [[ "$DRY_RUN" == "false" && -z "$TO_GH_SECRET" && -z "$TO_FILE" ]]; then
  echo "a real mint requires --to-gh-secret or --to-file" >&2
  exit 1
fi
if [[ -n "$TO_GH_SECRET" && "$TO_GH_SECRET" != "$FACTORY_TARGET_REPO" ]]; then
  echo "--to-gh-secret must target $FACTORY_TARGET_REPO" >&2
  exit 1
fi

SCOPES_JSON="$(node "$SCRIPT_DIR/read-factory-relayfile-scopes.mjs" "$FACTORY_SOURCE")"

PATHS_JSON="$(jq -ce '
  [
    .[] |
    capture("^relayfile:fs:(read|write):(?<path>/.*)$").path
  ] | unique
' <<<"$SCOPES_JSON")"
NORMALIZED_SCOPES_JSON="$(jq -ce 'map(sub("/\\*\\*$"; "/*"))' <<<"$SCOPES_JSON")"

if [[ -z "$DELEGATION_NOT_AFTER" ]]; then
  DELEGATION_NOT_AFTER="$(node -e 'process.stdout.write(new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString())')"
fi
node -e '
  const value = process.argv[1]
  if (!Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) process.exit(1)
' "$DELEGATION_NOT_AFTER" || {
  echo "--delegation-not-after must be a future ISO timestamp" >&2
  exit 1
}

REQUEST_BODY="$(jq -cn \
  --arg workspaceId "$FACTORY_WORKSPACE_ID" \
  --arg agentName "$FACTORY_AGENT_NAME" \
  --arg delegationNotAfter "$DELEGATION_NOT_AFTER" \
  --argjson paths "$PATHS_JSON" \
  --argjson scopes "$SCOPES_JSON" \
  --argjson expiresIn "$FACTORY_ACCESS_TTL_SECONDS" \
  --argjson refreshTokenTtlSeconds "$FACTORY_REFRESH_TTL_SECONDS" \
  '{
    workspaceId: $workspaceId,
    agentName: $agentName,
    paths: $paths,
    scopes: $scopes,
    audience: ["relayfile"],
    expiresIn: $expiresIn,
    refreshTokenTtlSeconds: $refreshTokenTtlSeconds,
    delegationNotAfter: $delegationNotAfter
  }')"

if [[ "$DRY_RUN" == "true" ]]; then
  echo "DRY RUN — would POST to $RELAYAUTH_URL/v1/tokens/workspace-path with:"
  jq . <<<"$REQUEST_BODY"
  exit 0
fi

require_cmd openssl
require_cmd curl
if [[ -n "$TO_GH_SECRET" ]]; then
  require_cmd gh
fi
if [[ -z "${RELAYAUTH_SIGNING_KEY_PEM:-}" ]]; then
  echo "RELAYAUTH_SIGNING_KEY_PEM is required for a real mint" >&2
  exit 1
fi
if [[ ! -x "$SCRIPT_DIR/generate-dev-token.sh" ]]; then
  echo "missing executable $SCRIPT_DIR/generate-dev-token.sh" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/relayauth-factory-path.XXXXXX")"
chmod 700 "$WORK_DIR"
REQUEST_FILE="$WORK_DIR/request.json"
RESPONSE_FILE="$WORK_DIR/response.json"
ACCESS_FILE="$WORK_DIR/access-token"
REFRESH_FILE="$WORK_DIR/refresh-token"
SESSION_FILE="$WORK_DIR/session-id"
GH_ERROR_FILE="$WORK_DIR/gh-error"
REVOKE_BODY_FILE="$WORK_DIR/revoke.json"

cleanup() {
  unset ADMIN_BEARER ACCESS_TOKEN REFRESH_TOKEN
  rm -f -- "$REQUEST_FILE" "$RESPONSE_FILE" "$ACCESS_FILE" "$REFRESH_FILE" \
    "$SESSION_FILE" "$GH_ERROR_FILE" "$REVOKE_BODY_FILE"
  rmdir "$WORK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

printf '%s' "$REQUEST_BODY" > "$REQUEST_FILE"
chmod 600 "$REQUEST_FILE"

ADMIN_SCOPES_JSON="$(jq -cn \
  --argjson scopes "$NORMALIZED_SCOPES_JSON" \
  '["relayauth:api-key:manage:*", "relayauth:token:manage:*"] + $scopes')"
ADMIN_BEARER="$(
  RELAYAUTH_ORG=org_agentworkforce \
  RELAYAUTH_WORKSPACE="$FACTORY_WORKSPACE_ID" \
  RELAYAUTH_SUB=agent_factory_credential_rotator \
  RELAYAUTH_SPONSOR=user_factory_cloud_cutover \
  RELAYAUTH_ISSUER=https://relayauth.dev \
  RELAYAUTH_SCOPES_JSON="$ADMIN_SCOPES_JSON" \
  RELAYAUTH_AUDIENCE_JSON='["relayauth"]' \
  RELAYAUTH_TTL_SECONDS=600 \
  "$SCRIPT_DIR/generate-dev-token.sh"
)"

if [[ -n "$TO_GH_SECRET" ]]; then
  gh api "repos/$TO_GH_SECRET/actions/secrets/public-key" >/dev/null
fi

HTTP_CODE="$(curl -sS \
  -X POST "$RELAYAUTH_URL/v1/tokens/workspace-path" \
  -H "Authorization: Bearer $ADMIN_BEARER" \
  -H 'content-type: application/json' \
  --data-binary "@$REQUEST_FILE" \
  -o "$RESPONSE_FILE" \
  -w '%{http_code}')"
chmod 600 "$RESPONSE_FILE"
if [[ "$HTTP_CODE" != "201" ]]; then
  echo "path-token mint failed: HTTP $HTTP_CODE; response withheld" >&2
  exit 1
fi

node --input-type=module - "$REQUEST_FILE" "$RESPONSE_FILE" "$SESSION_FILE" <<'NODE'
import { readFile, writeFile } from 'node:fs/promises'

const [requestPath, responsePath, sessionPath] = process.argv.slice(2)
const request = JSON.parse(await readFile(requestPath, 'utf8'))
const pair = JSON.parse(await readFile(responsePath, 'utf8'))
const fail = (message) => { throw new Error(`invalid path-token response: ${message}`) }
const exact = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} changed`)
}
const decode = (token, label) => {
  if (typeof token !== 'string' || !token.startsWith('relay_pa_')) fail(`${label} is not relay_pa`)
  const segments = token.slice('relay_pa_'.length).split('.')
  if (segments.length !== 3 || segments.some((segment) => !segment)) fail(`${label} is not a wrapped JWT`)
  try {
    return JSON.parse(Buffer.from(segments[1], 'base64url').toString('utf8'))
  } catch {
    fail(`${label} claims are invalid`)
  }
}
const normalize = (value) => value.replace(/\/\*\*$/u, '/*')
const expectedScopes = request.scopes.map(normalize)
const expectedPaths = request.paths.map(normalize)
if (pair.tokenClass !== 'relay_pa') fail('token class changed')
if (pair.workspaceId !== request.workspaceId) fail('workspace changed')
if (pair.agentName !== request.agentName || pair.agentId !== `agent_${request.agentName}`) fail('agent changed')
if (pair.delegationNotAfter !== request.delegationNotAfter) fail('delegation horizon changed')
exact(pair.paths, expectedPaths, 'paths')
const access = decode(pair.accessToken, 'access token')
const refresh = decode(pair.refreshToken, 'refresh token')
for (const [claims, label] of [[access, 'access token'], [refresh, 'refresh token']]) {
  if (claims.sub !== `agent_${request.agentName}` || claims.wks !== request.workspaceId) fail(`${label} identity changed`)
  if (claims.sid !== access.sid || typeof claims.sid !== 'string' || !claims.sid) fail(`${label} session changed`)
  if (claims.meta?.tokenClass !== 'path' || claims.meta?.agentName !== request.agentName) fail(`${label} metadata changed`)
  if (claims.meta?.delegationNotAfter !== request.delegationNotAfter) fail(`${label} delegation metadata changed`)
}
if (access.token_type !== 'access' || refresh.token_type !== 'refresh') fail('token types changed')
exact(access.scopes, expectedScopes, 'access scopes')
exact(access.aud, ['relayfile'], 'access audience')
exact(refresh.scopes, ['relayauth:token:refresh'], 'refresh scopes')
exact(refresh.aud, ['relayauth'], 'refresh audience')
exact(JSON.parse(access.meta?.paths ?? 'null'), expectedPaths, 'access metadata paths')
exact(JSON.parse(access.meta?.accessScopes ?? 'null'), expectedScopes, 'access metadata scopes')
const accessLifetime = access.exp - access.iat
const refreshLifetime = refresh.exp - refresh.iat
if (!Number.isInteger(accessLifetime) || accessLifetime < request.expiresIn - 60 || accessLifetime > request.expiresIn) fail('access TTL changed')
if (!Number.isInteger(refreshLifetime) || refreshLifetime < request.refreshTokenTtlSeconds - 60 || refreshLifetime > request.refreshTokenTtlSeconds) fail('refresh TTL changed')
if (Math.floor(Date.parse(pair.accessTokenExpiresAt) / 1000) !== access.exp) fail('access expiry changed')
if (Math.floor(Date.parse(pair.refreshTokenExpiresAt) / 1000) !== refresh.exp) fail('refresh expiry changed')
await writeFile(sessionPath, access.sid, { mode: 0o600, flag: 'wx' })
NODE

jq -er '.accessToken' "$RESPONSE_FILE" > "$ACCESS_FILE"
jq -er '.refreshToken' "$RESPONSE_FILE" > "$REFRESH_FILE"
chmod 600 "$ACCESS_FILE" "$REFRESH_FILE" "$SESSION_FILE"

revoke_session() {
  local session_id="$1"
  jq -cn --arg sessionId "$session_id" '{sessionId: $sessionId}' > "$REVOKE_BODY_FILE"
  chmod 600 "$REVOKE_BODY_FILE"
  curl -sS \
    -X POST "$RELAYAUTH_URL/v1/tokens/revoke" \
    -H "Authorization: Bearer $ADMIN_BEARER" \
    -H 'content-type: application/json' \
    --data-binary "@$REVOKE_BODY_FILE" \
    -o /dev/null \
    -w '%{http_code}'
}

storage_failed=false
if [[ -n "$TO_GH_SECRET" ]]; then
  if ! gh secret set FACTORY_RELAYAUTH_REFRESH_TOKEN --repo "$TO_GH_SECRET" < "$REFRESH_FILE" 2> "$GH_ERROR_FILE"; then
    storage_failed=true
  else
    access_stored=false
    for attempt in 1 2 3; do
      if gh secret set FACTORY_RELAYAUTH_ACCESS_TOKEN --repo "$TO_GH_SECRET" < "$ACCESS_FILE" 2> "$GH_ERROR_FILE"; then
        access_stored=true
        break
      fi
      echo "access-token secret update attempt $attempt failed" >&2
    done
    if [[ "$access_stored" == "false" ]]; then
      storage_failed=true
    fi
  fi
elif [[ -n "$TO_FILE" ]]; then
  install -d -m 700 "$TO_FILE"
  if [[ -e "$TO_FILE/access-token" || -e "$TO_FILE/refresh-token" ]]; then
    echo "refusing to overwrite an existing token file in $TO_FILE" >&2
    storage_failed=true
  else
    install -m 600 "$ACCESS_FILE" "$TO_FILE/access-token"
    install -m 600 "$REFRESH_FILE" "$TO_FILE/refresh-token"
  fi
fi

if [[ "$storage_failed" == "true" ]]; then
  echo "pair minted but secure storage failed; revoking the unpublished session" >&2
  NEW_SESSION="$(<"$SESSION_FILE")"
  REVOKE_HTTP="$(revoke_session "$NEW_SESSION")"
  if [[ "$REVOKE_HTTP" != "204" && "$REVOKE_HTTP" != "404" ]]; then
    echo "new session cleanup failed with HTTP $REVOKE_HTTP" >&2
  fi
  exit 2
fi

if [[ -n "$REVOKE_PRIOR" ]]; then
  NEW_SESSION="$(<"$SESSION_FILE")"
  if [[ "$REVOKE_PRIOR" == "$NEW_SESSION" ]]; then
    echo "refusing to revoke the newly minted session" >&2
    exit 2
  fi
  REVOKE_HTTP="$(revoke_session "$REVOKE_PRIOR")"
  if [[ "$REVOKE_HTTP" != "204" && "$REVOKE_HTTP" != "404" ]]; then
    echo "new pair stored, but prior-session revocation failed with HTTP $REVOKE_HTTP" >&2
    exit 2
  fi
fi

if [[ -n "$TO_GH_SECRET" ]]; then
  echo "ok: validated pair stored in $TO_GH_SECRET Actions secrets"
else
  echo "ok: validated pair stored in $TO_FILE"
fi
