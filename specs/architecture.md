# relayauth Architecture

## Overview

relayauth is the identity and authorization plane for the Agent Relay ecosystem.
One identity, one token, scoped access across all planes.

"Your agents have keys to everything. Do you know what they're doing?"

## Core Concepts

### Identity
An agent identity (`agent_xxxx`) represents a single agent across all planes.
Identities belong to an organization and operate within workspaces.
Every identity has a **human sponsor** — the person accountable for what the agent does.

### Sponsor Chain
Every agent traces back to a human. When agent A spawns agent B, the chain is:
`human → agent_A → agent_B`. Any audit query on agent_B shows the full chain.
The sponsor is not optional.

### Token
JWTs signed by relayauth, validated at the edge by any plane.
Contains: identity, org, workspace, scopes, sponsor, expiry.

**Every token expires. No exceptions.** Default: 1h access, 24h refresh.
Organizations can configure shorter. Maximum: 30 days.

### Scopes
Fine-grained capabilities: `{plane}:{resource}:{action}:{path?}`
- `relaycast:channel:read:*`
- `relayfile:fs:write:/src/api/*`
- `cloud:workflow:run`
- `stripe:orders:approve:≤$5000`

### Scope Delegation (Sub-agents)
When an agent creates a sub-agent, the sub-agent's scopes are **intersected**
with the parent's scopes. A sub-agent can never have more access than its parent.
Attempting to escalate is a hard error + audit event.

### RBAC Roles
Named bundles of scopes: `backend-developer`, `reviewer`, `admin`.
Assigned per-workspace.

### Policies
Rules evaluated at authorization time:
- Allow/deny based on identity, role, resource, time, IP
- Hierarchical: org → workspace → agent
- Deny takes precedence over allow

### Behavioral Budget
Beyond scopes (what an agent *can* do), budgets limit what an agent *should* do:
- `maxActionsPerHour`: rate limit per identity
- `maxCostPerDay`: spending cap for metered APIs
- `alertThreshold`: % of budget that triggers alert webhook
- `autoSuspend`: suspend the agent at 100% of budget

When the $3.2M procurement fraud agent hit 40 shell company orders in 2 hours,
the budget would have suspended it at order #6.

### Audit Log
Every token use, scope check, and admin action is logged.
Queryable, exportable, retention-configurable.
Every entry traces through the sponsor chain to a human.

## The 3-Line Promise

```typescript
// Create an agent with scoped access
const agent = await auth.createAgent('billing-bot', {
  sponsor: 'jane@acme.com',
  scopes: ['stripe:orders:read', 'slack:channel:write:#billing'],
  budget: { maxActionsPerHour: 100 },
  ttl: '1h',
});

// Protect any route — works with any framework
app.use('/api/orders', auth.protect({ scope: 'stripe:orders:read' }));

// Revoke instantly — global, <1 second
await auth.revoke('agent_8x2k');
```

## Infrastructure

- Cloudflare Workers: API + edge validation (global, <10ms)
- KV: revocation list (global, <1s propagation)
- Durable Objects: per-identity state, session tracking, budget enforcement
- D1: audit logs, policies, org/workspace metadata
- JWKS: public keys at /.well-known/jwks.json (any service can validate, no callback)

## Token Format

```json
{
  "sub": "agent_8x2k",
  "org": "org_acme",
  "wks": "ws_prod",
  "sponsor": "user_jane",
  "sponsorChain": ["user_jane", "agent_8x2k"],
  "scopes": [
    "relaycast:channel:read:*",
    "relayfile:fs:write:/src/api/*",
    "cloud:workflow:run"
  ],
  "budget": {
    "maxActionsPerHour": 100,
    "remaining": 94
  },
  "parentTokenId": null,
  "iss": "https://relayauth.dev",
  "aud": ["relaycast", "relayfile", "cloud"],
  "exp": 1711324800,
  "iat": 1711321200,
  "jti": "tok_unique_id"
}
```

## Components

### Public repo (relayauth)
1. Token format spec
2. SDK: @relayauth/sdk (TS), relayauth (Go middleware), relayauth (Python)
3. CLI: relayauth
4. Verification library (zero-dependency JWT validation)
5. RBAC policy format
6. OpenAPI spec
7. Docs + landing page

### Private repo (relayauth-cloud)
1. CF Workers server (Hono)
2. Identity DO (per-agent state, budget tracking)
3. Token issuance + signing (RS256/EdDSA)
4. Revocation engine (KV propagation)
5. RBAC engine (policy evaluation)
6. Audit pipeline (D1 + webhook delivery)
7. Key management (rotation, JWKS serving)
8. Admin console

## Landing Page Framing

Hero: "Your agents have keys to everything. Do you know what they're doing?"

Three panels:
1. Scope — "Give agents exactly the access they need. Not a key to the kingdom."
2. Trace — "Every action, every agent, back to the human who authorized it."
3. Revoke — "One call. Global. Instant. The agent loses access everywhere."

Then: 3-line code example.
Then: "Works with any framework. Any language. Any cloud."
Logo row: relaycast, relayfile, LangChain, CrewAI, AutoGen, FastAPI, Express, Hono

## Workflow Domains

### Domain 1: Foundation (workflows 001-010)
Project scaffolding, spec, types, test infrastructure

### Domain 2: Token System (workflows 011-020)
JWT issuance, validation, refresh, revocation, JWKS

### Domain 3: Identity Lifecycle (workflows 021-030)
Create, read, update, suspend, retire, delete agents
Includes: sponsor chain, sub-agent delegation

### Domain 4: Scopes & RBAC (workflows 031-040)
Scope format, validation, roles, policies, inheritance
Includes: scope narrowing for sub-agents, behavioral budgets

### Domain 5: API Routes (workflows 041-050)
All HTTP endpoints, middleware, error handling

### Domain 6: Audit & Observability (workflows 051-058)
Logging pipeline, query API, export, retention
Includes: sponsor chain tracing, budget alert webhooks

### Domain 7: SDK & Verification (workflows 059-068)
TS SDK, Go middleware, Python SDK, verification library
Includes: framework integrations (Hono, Express, FastAPI)

### Domain 8: CLI (workflows 069-075)
Agent management, token operations, audit queries

### Domain 9: Integration (workflows 076-082)
relaycast integration, relayfile integration, cloud integration

### Domain 10: Hosted Server (workflows 083-090)
CF Workers, DOs, KV, D1, deployment

### Domain 11: Testing & CI (workflows 091-096)
E2E tests, contract tests, CI/CD, npm publish with provenance

### Domain 12: Docs & Landing (workflows 097-100)
Docs, guides, landing page, README
