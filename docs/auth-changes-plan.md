# Auth Changes Plan — "Work on the Relay" JWT Claim Mapping

## Problem

relayfile expects `workspace_id` and `agent_name` claims in the JWT payload, plus
`"relayfile"` in the `aud` array. relayauth currently emits `wks` (not `workspace_id`),
has no `agent_name` claim, and defaults `aud` to `["relayauth"]`. Tokens issued by
relayauth are rejected by relayfile.

## Decision: Option A — relayauth emits dual claims

Add `workspace_id` and `agent_name` to the JWT payload alongside existing claims.
Zero changes needed in relayfile. Fully backwards-compatible for existing relayauth
consumers.

---

## Exact Changes Required

### 1. `scripts/generate-dev-token.sh` — Line 17

**Current payload (line 17):**
```bash
payload="{\"sub\":\"${subject}\",\"org\":\"${org}\",\"wks\":\"${workspace}\",\"scopes\":${scopes_json},\"sponsorId\":\"${sponsor}\",\"sponsorChain\":[\"${sponsor}\"],\"token_type\":\"${token_type}\",\"iss\":\"${issuer}\",\"aud\":${audience_json},\"iat\":${now},\"exp\":${exp},\"jti\":\"${jti}\"}"
```

**New payload:**
```bash
# Add env var for agent_name (after line 7):
agent_name="${RELAYAUTH_AGENT_NAME:-${subject}}"

# Update default audience to include relayfile (line 13):
audience_json="${RELAYAUTH_AUDIENCE_JSON:-[\"relayauth\",\"relayfile\"]}"

# New payload line 17 — adds workspace_id and agent_name:
payload="{\"sub\":\"${subject}\",\"org\":\"${org}\",\"wks\":\"${workspace}\",\"workspace_id\":\"${workspace}\",\"agent_name\":\"${agent_name}\",\"scopes\":${scopes_json},\"sponsorId\":\"${sponsor}\",\"sponsorChain\":[\"${sponsor}\"],\"token_type\":\"${token_type}\",\"iss\":\"${issuer}\",\"aud\":${audience_json},\"iat\":${now},\"exp\":${exp},\"jti\":\"${jti}\"}"
```

**Changes:**
- Add `RELAYAUTH_AGENT_NAME` env var (defaults to `$subject`)
- Change default `audience_json` from `["relayauth"]` → `["relayauth","relayfile"]`
- Insert `"workspace_id":"${workspace}"` and `"agent_name":"${agent_name}"` into payload JSON

### 2. `packages/types/src/token.ts` — RelayAuthTokenClaims interface (line 7–25)

Add two optional fields to the interface:

```typescript
export interface RelayAuthTokenClaims {
  sub: string;
  org: string;
  wks: string;
  workspace_id?: string;  // ← NEW: alias for wks, consumed by relayfile
  agent_name?: string;    // ← NEW: identity name, consumed by relayfile
  scopes: string[];
  sponsorId: string;
  sponsorChain: string[];
  token_type: "access" | "refresh";
  iss: string;
  aud: string[];
  exp: number;
  iat: number;
  jti: string;
  nbf?: number;
  sid?: string;
  meta?: Record<string, string>;
  parentTokenId?: string;
  budget?: TokenBudget;
}
```

Fields are optional to remain backwards-compatible with tokens already in circulation.

### 3. `packages/server/src/__tests__/test-helpers.ts` — `generateTestToken()` (lines 122–140)

Update the payload construction to include the new claims:

```typescript
const payload: RelayAuthTokenClaims = {
  sub,
  org: claims.org ?? "org_test",
  wks: claims.wks ?? "ws_test",
  workspace_id: claims.workspace_id ?? claims.wks ?? "ws_test",  // ← NEW
  agent_name: claims.agent_name ?? sub,                           // ← NEW
  scopes: claims.scopes ?? ["*"],
  sponsorId,
  sponsorChain: claims.sponsorChain ?? [sponsorId, sub],
  token_type: claims.token_type ?? "access",
  iss: claims.iss ?? "relayauth:test",
  aud: claims.aud ?? ["relayauth", "relayfile"],                  // ← CHANGED default
  exp: claims.exp ?? now + 3600,
  iat: claims.iat ?? now,
  jti: claims.jti ?? crypto.randomUUID(),
  // ...rest unchanged
};
```

### 4. `packages/server/src/middleware/scope.ts` — Verification only, NO changes needed

This file only verifies tokens; it does not build payloads. The existing validation
checks (`sub`, `org`, `wks`, `sponsorId`, etc.) remain valid. The new `workspace_id`
and `agent_name` claims are pass-through — they don't need verification on the
relayauth side (relayfile validates them).

### 5. `packages/server/src/engine/role-assignments.ts` — NO changes needed

Role assignment logic calculates scopes, not JWT claims. The new claims are identity
metadata injected at token-signing time, not during role evaluation.

### 6. Server-side token issuance route

There is **no production token issuance route** currently implemented in the server
(the `/v1/tokens` endpoint is listed in discovery but not yet built). Token issuance
is done via the dev script. When the production issuance route is implemented, it
must include:

```typescript
// At token payload construction time:
payload.workspace_id = payload.wks;
payload.agent_name = identity.name;
if (!payload.aud.includes("relayfile")) {
  payload.aud.push("relayfile");
}
```

---

## relay CLI Provisioning Flow

### `relay provision` calls generate-dev-token.sh per agent

For each agent defined in `relay.yaml`:

```bash
# Example: provision agent-1
RELAYAUTH_SUB="agent-1" \
RELAYAUTH_AGENT_NAME="agent-1" \
RELAYAUTH_WORKSPACE="my-project" \
RELAYAUTH_SCOPES_JSON='["relayfile:fs:read:/src/*","relayfile:fs:write:/src/api/*","relayfile:fs:read:/docs/*"]' \
RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]' \
SIGNING_KEY="dev-relay-secret" \
  ./scripts/generate-dev-token.sh > .relay/tokens/agent-1.jwt
```

### Provisioning pseudocode

```bash
relay_provision() {
  mkdir -p .relay/tokens

  # Parse relay.yaml (using yq or simple parser)
  local signing_secret=$(yq '.signing_secret' relay.yaml)
  local workspace=$(yq '.workspace' relay.yaml)
  local agent_count=$(yq '.agents | length' relay.yaml)

  for i in $(seq 0 $((agent_count - 1))); do
    local name=$(yq ".agents[$i].name" relay.yaml)
    local scopes=$(yq -o=json ".agents[$i].scopes" relay.yaml)

    RELAYAUTH_SUB="$name" \
    RELAYAUTH_AGENT_NAME="$name" \
    RELAYAUTH_WORKSPACE="$workspace" \
    RELAYAUTH_SCOPES_JSON="$scopes" \
    RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]' \
    SIGNING_KEY="$signing_secret" \
      ./scripts/generate-dev-token.sh > ".relay/tokens/${name}.jwt"

    echo "✓ Provisioned token for $name"
  done
}
```

### Token claim mapping summary

| Claim          | Source in relay.yaml       | Env var                    |
|----------------|----------------------------|----------------------------|
| `sub`          | `agents[].name`            | `RELAYAUTH_SUB`           |
| `agent_name`   | `agents[].name`            | `RELAYAUTH_AGENT_NAME`    |
| `wks`          | `workspace`                | `RELAYAUTH_WORKSPACE`     |
| `workspace_id` | `workspace` (alias of wks) | (derived from wks)         |
| `scopes`       | `agents[].scopes`          | `RELAYAUTH_SCOPES_JSON`   |
| `aud`          | `["relayauth","relayfile"]`| `RELAYAUTH_AUDIENCE_JSON` |

---

## Files Changed Summary

| File | Change | Risk |
|------|--------|------|
| `scripts/generate-dev-token.sh` | Add `workspace_id`, `agent_name` to payload; default aud includes `relayfile` | Low — dev tooling only |
| `packages/types/src/token.ts` | Add optional `workspace_id?`, `agent_name?` fields | Low — additive, optional |
| `packages/server/src/__tests__/test-helpers.ts` | Include new claims in `generateTestToken()` | Low — test code |
| `packages/server/src/middleware/scope.ts` | No changes | N/A |
| `packages/server/src/engine/role-assignments.ts` | No changes | N/A |

## Validation

After making changes, verify with:
```bash
# Generate a token with new claims
RELAYAUTH_AGENT_NAME="agent-1" \
RELAYAUTH_WORKSPACE="ws_dev" \
RELAYAUTH_AUDIENCE_JSON='["relayauth","relayfile"]' \
SIGNING_KEY="dev-relay-secret" \
  ./scripts/generate-dev-token.sh

# Decode and inspect (paste token into jwt.io or):
echo "<token>" | cut -d. -f2 | base64 -d 2>/dev/null | python3 -m json.tool

# Confirm payload contains: workspace_id, agent_name, aud includes "relayfile"
```
