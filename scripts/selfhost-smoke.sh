#!/usr/bin/env bash
# Self-host smoke test for the RelayAuth Node image (docker/Dockerfile).
#
# 1. Builds the image and generates throwaway lab secrets under
#    .selfhost/smoke-<run id> (gitignored, mode 0600; never printed).
# 2. Boots relayauth with key A current + key B next, seeding a bootstrap
#    api key from RELAYAUTH_BOOTSTRAP_API_KEY_FILE.
# 3. Mints a History assertion (historyOrigin http://127.0.0.1:18780) with the
#    bootstrap key and verifies it independently against /.well-known/jwks.json.
# 4. Rotates (A -> previous, B -> current), restarts on the same data dir, and
#    checks the old token still verifies while new tokens carry B's kid
#    (assertions live at most 60s, so the rotation happens within that window).
# 5. Drops the previous key and checks the old token is no longer verifiable.
# 6. Checks an assertion for the private http origin
#    http://history.relayhistory.svc:8080 is refused by default (400
#    invalid_history_origin), then restarts with
#    RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true and checks it is minted
#    and verifies with that origin as its audience.
# 7. Boots with current=B but a stale RELAYAUTH_SIGNING_KEY_PEM_PUBLIC (A's
#    public key) and checks the container refuses to start.
#
# Requires docker, curl, openssl, node (>= 20, used only for verification).
# Env: SMOKE_PORT (default 19380), SMOKE_IMAGE, SKIP_BUILD=1, KEEP_SECRETS=1,
#      SMOKE_RUN_ID (default <pid>-<random>; names the container and lab dir so
#      concurrent runs never touch each other's resources).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${SMOKE_PORT:-19380}"
IMAGE="${SMOKE_IMAGE:-sp-relayauth:smoke}"
RUN_ID="${SMOKE_RUN_ID:-$$-$RANDOM}"
CONTAINER="sp-relayauth-smoke-${RUN_ID}"
BASE_URL="http://127.0.0.1:${PORT}"
ISSUER="${SMOKE_ISSUER:-$BASE_URL}"
HISTORY_ORIGIN="http://127.0.0.1:18780"
PRIVATE_HISTORY_ORIGIN="http://history.relayhistory.svc:8080"
LAB="$ROOT/.selfhost/smoke-${RUN_ID}"
SECRETS="$LAB/secrets"
DATA="$LAB/data"

log() { printf '[smoke] %s\n' "$*"; }
fail() { printf '[smoke] FAIL: %s\n' "$*" >&2; exit 1; }
# Every request is bounded so a stalled server fails the run instead of hanging.
http() { curl --connect-timeout 2 --max-time 10 "$@"; }

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  if [[ "${KEEP_SECRETS:-0}" != "1" ]]; then
    rm -rf "$LAB"
  fi
}

for bin in docker curl openssl node; do
  command -v "$bin" >/dev/null || fail "missing dependency: $bin"
done

if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  log "building $IMAGE"
  docker build -q -f "$ROOT/docker/Dockerfile" -t "$IMAGE" "$ROOT" >/dev/null
fi

# --- throwaway lab secrets ---------------------------------------------------
# Claim the run atomically (mkdir without -p fails if the dir exists) before
# installing cleanup, so a run that reuses SMOKE_RUN_ID exits without touching
# the other run's container or lab dir. The container name derives from the
# same RUN_ID, so owning the lab dir means owning the container name too.
(umask 077 && mkdir -p "$(dirname "$LAB")" && mkdir "$LAB" 2>/dev/null) \
  || fail "lab dir already exists (reused SMOKE_RUN_ID?): ${LAB#"$ROOT"/}"
trap cleanup EXIT
(umask 077 && mkdir "$SECRETS" "$DATA")
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
# Extra `-e NAME=value` pairs can be passed via the EXTRA_ENV array.
EXTRA_ENV=()
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
  local kv
  for kv in "${EXTRA_ENV[@]}"; do args+=(-e "$kv"); done
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  docker run "${args[@]}" "$IMAGE" >/dev/null
  for _ in $(seq 1 60); do
    if http -fsS "$BASE_URL/health" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  docker logs "$CONTAINER" >&2 || true
  fail "relayauth did not become healthy on $BASE_URL"
}

# post_assertion <origin> -> prints HTTP status, body in $LAB/mint.json
post_assertion() {
  http -sS -o "$LAB/mint.json" -w '%{http_code}' \
    -X POST "$BASE_URL/v1/tokens/relayhistory-assertion" \
    -H 'content-type: application/json' \
    -H "x-api-key: $(tr -d '\n' < "$SECRETS/bootstrap-api-key")" \
    --data "{\"orgId\":\"org_smoke\",\"workspaceId\":\"ws_smoke\",\"sponsorId\":\"user_smoke\",\"machineId\":\"machine-smoke\",\"scopes\":[\"rth:sync\",\"rth:read\"],\"expiresIn\":60,\"historyOrigin\":\"$1\"}"
}

# mint_assertion [origin] -> prints the access token
mint_assertion() {
  local status
  status=$(post_assertion "${1:-$HISTORY_ORIGIN}")
  [[ "$status" == "201" ]] || fail "assertion mint returned HTTP $status: $(cat "$LAB/mint.json")"
  node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).accessToken)' "$LAB/mint.json"
}

# Independent verifier: node:crypto only, no RelayAuth code.
# verify_token <token-file> [audience] -> prints "kid=<kid> iss=<iss> aud=<aud>" or exits 1
verify_token() {
  http -fsS "$BASE_URL/.well-known/jwks.json" > "$LAB/jwks.json"
  node - "$1" "$LAB/jwks.json" "$ISSUER" "${2:-$HISTORY_ORIGIN}" <<'NODE'
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
  http -fsS "$BASE_URL/.well-known/jwks.json" \
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

# --- phase 4: private http History origin ------------------------------------------
log "phase 4: private http historyOrigin $PRIVATE_HISTORY_ORIGIN"
status=$(post_assertion "$PRIVATE_HISTORY_ORIGIN")
[[ "$status" == "400" ]] && grep -q '"invalid_history_origin"' "$LAB/mint.json" \
  || fail "flag off: expected 400 invalid_history_origin, got HTTP $status: $(cat "$LAB/mint.json")"
log "flag off: refused (HTTP 400 invalid_history_origin)"
EXTRA_ENV=("RELAYAUTH_ALLOW_PRIVATE_HTTP_HISTORY_ORIGIN=true")
run_relayauth key-b
EXTRA_ENV=()
mint_assertion "$PRIVATE_HISTORY_ORIGIN" > "$LAB/token-private"
out=$(verify_token "$LAB/token-private" "$PRIVATE_HISTORY_ORIGIN") \
  || fail "private-origin assertion did not verify: $out"
log "flag on: minted, verify: $out"
status=$(post_assertion "http://history.example.com")
[[ "$status" == "400" ]] || fail "flag on: public http origin returned HTTP $status"
log "flag on: public http origin still refused (HTTP 400)"

# --- phase 5: stale _PUBLIC after rotation is refused ------------------------------
log "phase 5: current=B with a stale RELAYAUTH_SIGNING_KEY_PEM_PUBLIC (A) must not start"
(umask 077 && openssl pkey -in "$SECRETS/key-a.pem" -pubout -out "$SECRETS/key-a.pub.pem" 2>/dev/null)
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
set +e
docker run --name "$CONTAINER" --user "$(id -u):$(id -g)" \
  -v "$SECRETS:/run/secrets:ro" -v "$DATA:/data" \
  -e "BASE_URL=$BASE_URL" -e "RELAYAUTH_ISSUER=$ISSUER" \
  -e "INTERNAL_SECRET_FILE=/run/secrets/internal-secret" \
  -e "RELAYAUTH_SIGNING_KEY_PEM_FILE=/run/secrets/key-b.pem" \
  -e "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC_FILE=/run/secrets/key-a.pub.pem" \
  "$IMAGE" >"$LAB/stale.log" 2>&1
code=$?
set -e
[[ "$code" != "0" ]] || fail "relayauth started with a mismatched public key"
grep -q "RELAYAUTH_SIGNING_KEY_PEM_PUBLIC does not match" "$LAB/stale.log" \
  || fail "stale public key: unexpected output: $(cat "$LAB/stale.log")"
log "stale public key refused at boot (exit $code)"

log "PASS (old kid ${OLD_KID:0:12}..., new kid ${NEW_KID:0:12}...)"
