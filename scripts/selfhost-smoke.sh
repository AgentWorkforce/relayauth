#!/usr/bin/env bash
# Self-host smoke test for the RelayAuth Node image (docker/Dockerfile).
#
# 1. Builds the image and generates throwaway lab secrets under .selfhost/smoke
#    (gitignored, mode 0600; never printed).
# 2. Boots relayauth with key A current + key B next, seeding a bootstrap
#    api key from RELAYAUTH_BOOTSTRAP_API_KEY_FILE.
# 3. Mints a History assertion (historyOrigin http://127.0.0.1:18780) with the
#    bootstrap key and verifies it independently against /.well-known/jwks.json.
# 4. Rotates (A -> previous, B -> current), restarts on the same data dir, and
#    checks the old token still verifies while new tokens carry B's kid
#    (assertions live at most 60s, so the rotation happens within that window).
# 5. Drops the previous key and checks the old token is no longer verifiable.
#
# Requires docker, curl, openssl, node (>= 20, used only for verification).
# Env: SMOKE_PORT (default 19380), SMOKE_IMAGE, SKIP_BUILD=1, KEEP_SECRETS=1.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-19380}"
IMAGE="${SMOKE_IMAGE:-sp-relayauth:smoke}"
CONTAINER="sp-relayauth-smoke"
BASE_URL="http://127.0.0.1:${PORT}"
ISSUER="${SMOKE_ISSUER:-$BASE_URL}"
HISTORY_ORIGIN="http://127.0.0.1:18780"
LAB="$ROOT/.selfhost/smoke"
SECRETS="$LAB/secrets"
DATA="$LAB/data"

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [[ "${KEEP_SECRETS:-0}" != "1" ]]; then
    rm -rf "$LAB"
  fi
}
trap cleanup EXIT

for bin in docker curl openssl node; do
  command -v "$bin" >/dev/null || fail "missing dependency: $bin"
done

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  log "building $IMAGE"
  docker build -q -f "$ROOT/docker/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
fi

# --- throwaway lab secrets ---------------------------------------------------
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
rm -rf "$LAB"
(umask 077 && mkdir -p "$SECRETS" "$DATA")
(
  umask 077
  for name in key-a key-b; do
    openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:3072 -out "$SECRETS/$name.pem" 2>/dev/null
  done
  openssl rand -hex 32 > "$SECRETS/internal-secret"
  printf 'rak_%s\n' "$(openssl rand -hex 32)" > "$SECRETS/bootstrap-api-key"
)
log "generated lab secrets in ${LAB#"$ROOT"/} (0600, gitignored)"

# --- helpers ------------------------------------------------------------------
# run_relayauth <current> [next] [previous]  (key file basenames, "" to omit)
run_relayauth() {
  local current="$1" next="${2:-}" previous="${3:-}"
  local args=(
    -d --name "$CONTAINER"
    --user "$(id -u):$(id -g)"
    -p "127.0.0.1:${PORT}:8787"
    -v "$SECRETS:/run/secrets:ro"
    -v "$DATA:/data"
    -e "BASE_URL=$BASE_URL"
    -e "RELAYAUTH_ISSUER=$ISSUER"
    -e "INTERNAL_SECRET_FILE=/run/secrets/internal-secret"
    -e "RELAYAUTH_BOOTSTRAP_API_KEY_FILE=/run/secrets/bootstrap-api-key"
    -e "RELAYAUTH_SIGNING_KEY_PEM_FILE=/run/secrets/$current.pem"
  )
  [[ -n "$next" ]] && args+=(-e "RELAYAUTH_SIGNING_KEY_PEM_NEXT_FILE=/run/secrets/$next.pem")
  [[ -n "$previous" ]] && args+=(-e "RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS_FILE=/run/secrets/$previous.pem")
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run "${args[@]}" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if curl -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  docker logs "$CONTAINER" >&2 || true
  fail "relayauth did not become healthy on $BASE_URL"
}

mint_assertion() {
  local status
  status=$(curl -sS -o "$LAB/mint.json" -w '%{http_code}' \
    -X POST "$BASE_URL/v1/tokens/relayhistory-assertion" \
    -H 'content-type: application/json' \
    -H "x-api-key: $(tr -d '\n' < "$SECRETS/bootstrap-api-key")" \
    --data "{\"orgId\":\"org_smoke\",\"workspaceId\":\"ws_smoke\",\"sponsorId\":\"user_smoke\",\"scopes\":[\"rth:sync\",\"rth:read\"],\"expiresIn\":60,\"historyOrigin\":\"$HISTORY_ORIGIN\"}")
  [[ "$status" == "201" ]] || fail "assertion mint returned HTTP $status: $(cat "$LAB/mint.json")"
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).accessToken)' "$LAB/mint.json"
}

# Independent verifier: node:crypto only, no RelayAuth code.
# verify_token <token-file> -> prints "kid=<kid> iss=<iss> aud=<aud>" or exits 1
verify_token() {
  curl -fsS "$BASE_URL/.well-known/jwks.json" > "$LAB/jwks.json"
  node - "$1" "$LAB/jwks.json" "$ISSUER" "$HISTORY_ORIGIN" <<'NODE'
const fs = require("node:fs");
const crypto = require("node:crypto");
const [tokenFile, jwksFile, issuer, audience] = process.argv.slice(2);
const token = fs.readFileSync(tokenFile, "utf8").trim();
const { keys } = JSON.parse(fs.readFileSync(jwksFile, "utf8"));
const [h, p, s] = token.split(".");
const header = JSON.parse(Buffer.from(h, "base64url"));
const claims = JSON.parse(Buffer.from(p, "base64url"));
const jwk = keys.find((k) => k.kid === header.kid);
const die = (msg) => { console.log(`INVALID ${msg}`); process.exit(1); };
if (header.alg !== "RS256") die(`alg=${header.alg}`);
if (!jwk) die(`kid ${header.kid} not in JWKS [${keys.map((k) => k.kid).join(", ")}]`);
const ok = crypto.verify("RSA-SHA256", Buffer.from(`${h}.${p}`),
  crypto.createPublicKey({ key: jwk, format: "jwk" }), Buffer.from(s, "base64url"));
if (!ok) die("bad signature");
if (claims.iss !== issuer) die(`iss=${claims.iss}`);
if (!claims.aud.includes(audience)) die(`aud=${claims.aud}`);
if (claims.exp <= Math.floor(Date.now() / 1000)) die("expired");
console.log(`kid=${header.kid} iss=${claims.iss} aud=${claims.aud.join(",")} wks=${claims.wks} scopes=${claims.scopes.join(",")}`);
NODE
}

jwks_kids() {
  curl -fsS "$BASE_URL/.well-known/jwks.json" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).keys.map(k=>k.kid).join(" ")))'
}

token_kid() {
  node -e 'const t=require("fs").readFileSync(process.argv[1],"utf8");console.log(JSON.parse(Buffer.from(t.split(".")[0],"base64url")).kid)' "$1"
}

# --- phase 1: A current, B next -----------------------------------------------
log "phase 1: start (current=A, next=B) on $BASE_URL"
run_relayauth key-a key-b
docker logs "$CONTAINER" 2>&1 | grep -q "bootstrap api key created" || fail "bootstrap key was not created"
log "bootstrap api key seeded (created)"
log "JWKS kids: $(jwks_kids)"
mint_assertion > "$LAB/token-old"
OLD_KID=$(token_kid "$LAB/token-old")
out=$(verify_token "$LAB/token-old") || fail "assertion #1 did not verify: $out"
log "minted assertion #1, verify: $out"

# Bootstrap key value must never reach the logs.
if docker logs "$CONTAINER" 2>&1 | grep -qF "$(tr -d '\n' < "$SECRETS/bootstrap-api-key")"; then
  fail "bootstrap api key value appeared in container logs"
fi

# --- phase 2: rotate (A -> previous, B -> current) -----------------------------
log "phase 2: rotate (current=B, previous=A), same data volume"
run_relayauth key-b "" key-a
docker logs "$CONTAINER" 2>&1 | grep -q "bootstrap api key exists" || fail "bootstrap seeding was not idempotent"
log "bootstrap api key seeding idempotent (exists)"
log "JWKS kids: $(jwks_kids)"
out=$(verify_token "$LAB/token-old") || fail "old token stopped verifying after rotation: $out"
log "old token still verifies: $out"
mint_assertion > "$LAB/token-new"
NEW_KID=$(token_kid "$LAB/token-new")
[[ "$NEW_KID" != "$OLD_KID" ]] || fail "new token reused the old kid"
out=$(verify_token "$LAB/token-new") || fail "assertion #2 did not verify: $out"
log "minted assertion #2, verify: $out"

# --- phase 3: retire A ------------------------------------------------------------
log "phase 3: retire previous key (current=B only)"
run_relayauth key-b
if out=$(verify_token "$LAB/token-old"); then
  fail "old token still verifies after its key was removed: $out"
fi
log "old token rejected after retirement: $(verify_token "$LAB/token-old" || true)"
verify_token "$LAB/token-new" >/dev/null || fail "new token stopped verifying"

log "PASS (old kid ${OLD_KID:0:12}..., new kid ${NEW_KID:0:12}...)"
