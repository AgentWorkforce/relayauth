# 109 — A2A Discovery Bridge Plan

## Goal

Bridge Google's A2A (Agent-to-Agent) protocol agent cards with relayauth's `AgentConfiguration` discovery format. This enables bidirectional discovery: A2A agents can discover relayauth, and relayauth can discover A2A agents.

## Context

- **relayauth discovery** serves `AgentConfiguration` at `GET /.well-known/agent-configuration` (see `packages/server/src/routes/discovery.ts`)
- **A2A protocol** uses agent cards served at `GET /.well-known/agent.json` (or `/.well-known/agent-card.json`)
- **relaycast** already has an `a2a_agents` table tracking external A2A agents with `agentCard` JSON, `externalUrl`, auth info, and health status
- No `packages/sdk/src/integrations/relaycast.ts` exists yet — the bridge will be a new SDK module

## A2A Agent Card Shape

Since the relaycast A2A types are not yet formalized as a TypeScript interface, we define the minimal A2A agent card based on the Google A2A spec:

```typescript
export interface A2aAgentCard {
  name: string;
  description?: string;
  url: string;                          // JSON-RPC endpoint
  version?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills?: Array<{
    id: string;
    name: string;
    description?: string;
    tags?: string[];
    examples?: string[];
  }>;
  defaultInputModes?: string[];
  defaultOutputModes?: string[];
  provider?: {
    organization?: string;
    url?: string;
  };
  authentication?: {
    schemes: string[];
    credentials?: string;
  };
}
```

This type goes in `packages/sdk/src/a2a-bridge.ts` alongside the bridge functions.

---

## 1. `agentCardToConfiguration(card: A2aAgentCard): AgentConfiguration`

Converts an A2A agent card into a relayauth `AgentConfiguration`.

### Mapping rules

| A2A field | AgentConfiguration field | Mapping |
|---|---|---|
| `card.name` | `service_name` | Direct copy |
| `card.description` | (not mapped) | No field in AgentConfiguration |
| `card.url` | `issuer`, `token_endpoint`, `identity_endpoint`, `jwks_uri` | Derive all endpoints from URL origin |
| `card.version` | `server_version` | Direct copy |
| `card.skills` | `scope_definitions` | Each skill → a ScopeDefinition (see below) |
| `card.capabilities` | `capabilities` | Map capability flags to string array |
| `card.authentication?.schemes` | `token_endpoint_auth_methods_supported` | Map known schemes |
| `card.provider?.url` | `documentation_url` | Use provider URL as docs link |

### Skill → ScopeDefinition mapping

Each A2A skill maps to a scope definition:
- `plane`: `"a2a"` (new external plane for bridged agents)
- `resource`: `skill.id` (kebab-case)
- `actions`: `["invoke"]` (A2A skills are invocable)
- `pattern`: `a2a:{skill.id}:invoke:*`
- `description`: `skill.description ?? skill.name`
- `path_schema`: `{ type: "wildcard", required: false, wildcard_allowed: true, description: "Task identifier" }`

### Endpoint derivation from `card.url`

Given `card.url = "https://agent.example.com/a2a"`:
- `issuer`: `"https://agent.example.com"`
- `token_endpoint`: `"https://agent.example.com/a2a"` (the RPC endpoint itself)
- `identity_endpoint`: `"https://agent.example.com/a2a"`
- `jwks_uri`: `"https://agent.example.com/.well-known/jwks.json"` (conventional)

### Defaults for fields without A2A equivalents

- `schema_version`: `"1.0"`
- `grant_types_supported`: `["client_credentials"]`
- `token_signing_alg_values_supported`: `["RS256"]`
- `scope_format`: standard relayauth format with `planes: ["a2a"]`
- `sponsor_required`: `false`
- `scope_delegation`: `{ enabled: false, mode: "intersection", escalation_policy: "hard_error" }`
- `budgets`: `{ enabled: false, supported_limits: [], alert_webhook_supported: false, auto_suspend_supported: false }`
- `token_lifetimes`: `{ access_token_default: "PT1H", refresh_token_default: "PT24H", maximum: "P30D", permanent_tokens_allowed: false }`

---

## 2. `configurationToAgentCard(config: AgentConfiguration, name?: string): A2aAgentCard`

Converts a relayauth `AgentConfiguration` into an A2A agent card.

### Mapping rules

| AgentConfiguration field | A2A field | Mapping |
|---|---|---|
| `config.service_name` | `name` | Direct copy (fallback to `name` param or `"unknown"`) |
| `config.issuer` | `provider.url` | Direct copy |
| `config.server_version` | `version` | Direct copy |
| `config.token_endpoint` | `url` | Use token endpoint as the RPC endpoint |
| `config.scope_definitions` | `skills` | Each scope def → a skill (see below) |
| `config.capabilities` | `capabilities` | Map to A2A capability flags |
| `config.documentation_url` | `provider.url` | Use as provider URL |
| `config.token_endpoint_auth_methods_supported` | `authentication.schemes` | Direct copy |

### ScopeDefinition → Skill mapping

Each scope definition maps to a skill:
- `id`: `"{scopeDef.plane}-{scopeDef.resource}"` (e.g. `"relaycast-channel"`)
- `name`: `scopeDef.name`
- `description`: `scopeDef.description`
- `tags`: `scopeDef.actions`
- `examples`: `scopeDef.examples`

### Capability mapping

- If `config.capabilities` includes `"token-issuance"` → `streaming: false` (auth service, not streaming)
- Map known capabilities to A2A capability flags where meaningful
- Default: `{ streaming: false, pushNotifications: false, stateTransitionHistory: false }`

---

## 3. `GET /v1/discovery/agent-card` — Serve relayauth as an A2A agent card

New route in `packages/server/src/routes/discovery.ts`.

### Behavior
1. Build the `AgentConfiguration` using existing `buildAgentConfiguration(origin)`
2. Call `configurationToAgentCard(config, "relayauth")`
3. Return JSON with `Cache-Control: public, max-age=3600`

### Response shape
Standard A2A agent card JSON. This lets A2A-compatible agents discover relayauth and understand its capabilities.

---

## 4. `POST /v1/discovery/bridge` — Accept an A2A agent card URL, return AgentConfiguration

New route in `packages/server/src/routes/discovery.ts`.

### Request
```json
{ "url": "https://agent.example.com" }
```

### Behavior
1. Validate `url` is a well-formed HTTPS URL (reject non-HTTPS in production, allow HTTP for localhost/testing)
2. Validate URL is not a private/internal IP (SSRF protection: reject `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`, `fc00::/7`)
3. Fetch `{url}/.well-known/agent.json` with a timeout (5s) and size limit (1MB)
4. If 404, try `{url}/.well-known/agent-card.json` as fallback
5. Parse and validate the response as an A2A agent card (must have `name` and `url`)
6. Call `agentCardToConfiguration(card)`
7. Return the `AgentConfiguration` JSON

### Error responses
- `400` — invalid/missing URL
- `422` — fetched URL but response is not a valid A2A agent card
- `502` — cannot reach the specified URL or timeout
- `403` — URL targets a private/internal address (SSRF blocked)

---

## 5. How this enables bidirectional discovery

### A2A agents → relayauth
An A2A agent can fetch `GET /v1/discovery/agent-card` to get relayauth's capabilities in A2A format. It sees relayauth's scope definitions as skills it can invoke, and knows the RPC endpoint (token_endpoint) for interaction.

### relayauth → A2A agents
A relayauth client can `POST /v1/discovery/bridge` with an external agent's URL. The bridge fetches the A2A card, converts it to `AgentConfiguration`, and returns it. This lets relayauth understand external A2A agents using its native discovery format — enabling scope mapping, policy evaluation, and trust decisions for cross-system interactions.

---

## File layout

| File | Purpose |
|---|---|
| `packages/sdk/src/a2a-bridge.ts` | `A2aAgentCard` type, `agentCardToConfiguration()`, `configurationToAgentCard()` |
| `packages/sdk/src/index.ts` | Re-export bridge functions |
| `packages/sdk/src/__tests__/a2a-bridge.test.ts` | Unit tests for bridge functions |
| `packages/server/src/routes/discovery.ts` | Add `GET /v1/discovery/agent-card` and `POST /v1/discovery/bridge` |

## Security considerations

- **SSRF**: The bridge route fetches external URLs — must validate against private IP ranges
- **Input validation**: Reject oversized or malformed agent cards
- **No credential leaks**: The agent card response must not include any server secrets, private keys, or internal-only endpoints
- **Timeout**: External fetches must have a hard timeout to prevent slowloris-style abuse
