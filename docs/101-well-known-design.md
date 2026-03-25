# `/.well-known/agent-configuration` Discovery Spec Design

## Overview

`GET /.well-known/agent-configuration` is a public, unauthenticated endpoint that describes the relayauth server's capabilities, endpoints, and configuration. It enables agents and SDKs to auto-discover how to authenticate, what scopes are available, and where to find related endpoints — without hardcoding URLs or reading docs.

This design is compatible with emerging Agent Auth Protocol discovery conventions while extending them with relayauth-specific fields for sponsor chains, behavioral budgets, and scope delegation.

---

## Endpoint

```
GET /.well-known/agent-configuration
```

- **Authentication:** None (public)
- **Rate limit:** Standard public endpoint rate limit (e.g., 60 req/min per IP)
- **Cache:** `Cache-Control: public, max-age=3600` (1 hour)
- **Content-Type:** `application/json`

---

## Response JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "AgentConfiguration",
  "description": "RelayAuth server discovery document",
  "type": "object",
  "required": [
    "issuer",
    "server_version",
    "token_endpoint",
    "token_refresh_endpoint",
    "token_revocation_endpoint",
    "token_validation_endpoint",
    "identity_endpoint",
    "jwks_uri",
    "scopes_endpoint",
    "audit_endpoint",
    "supported_algorithms",
    "supported_grant_types",
    "supported_token_types",
    "scope_format",
    "sponsor_required",
    "scope_delegation",
    "budgets",
    "token_lifetime"
  ],
  "properties": {
    "issuer": {
      "type": "string",
      "format": "uri",
      "description": "The issuer identifier. Matches the `iss` claim in issued JWTs."
    },
    "server_version": {
      "type": "string",
      "description": "Semantic version of the relayauth server (e.g., '1.0.0')."
    },
    "documentation_url": {
      "type": "string",
      "format": "uri",
      "description": "URL to human-readable documentation."
    },

    "token_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL to issue new tokens. POST with API key auth."
    },
    "token_refresh_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL to refresh an access token using a refresh token."
    },
    "token_revocation_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL to revoke a token globally (<1s propagation)."
    },
    "token_validation_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL to validate a token server-side (introspection)."
    },
    "identity_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "Base URL for identity (agent) CRUD operations."
    },
    "jwks_uri": {
      "type": "string",
      "format": "uri",
      "description": "URL to the JSON Web Key Set for offline JWT validation."
    },
    "scopes_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL to query scope templates and validate scope strings."
    },
    "roles_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL for RBAC role management."
    },
    "policies_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL for authorization policy management."
    },
    "audit_endpoint": {
      "type": "string",
      "format": "uri",
      "description": "URL for querying audit logs."
    },

    "supported_algorithms": {
      "type": "array",
      "items": { "type": "string" },
      "description": "JWT signing algorithms supported by this server. At least one of RS256, EdDSA."
    },
    "supported_grant_types": {
      "type": "array",
      "items": { "type": "string", "enum": ["api_key", "client_credentials", "token_exchange", "delegation"] },
      "description": "Grant types accepted at the token endpoint."
    },
    "supported_token_types": {
      "type": "array",
      "items": { "type": "string", "enum": ["access", "refresh"] },
      "description": "Token types the server can issue."
    },

    "scope_format": {
      "type": "object",
      "description": "Describes the scope string format and available planes.",
      "required": ["pattern", "separator", "planes", "actions", "wildcard"],
      "properties": {
        "pattern": {
          "type": "string",
          "description": "Human-readable pattern description, e.g., '{plane}:{resource}:{action}:{path?}'"
        },
        "separator": {
          "type": "string",
          "const": ":",
          "description": "Delimiter between scope segments."
        },
        "planes": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Built-in planes. Custom planes are allowed."
        },
        "actions": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Supported action verbs."
        },
        "wildcard": {
          "type": "string",
          "const": "*",
          "description": "Wildcard character for matching any value in a segment."
        },
        "path_optional": {
          "type": "boolean",
          "description": "Whether the 4th path segment can be omitted (defaults to '*')."
        }
      }
    },
    "scope_templates_url": {
      "type": "string",
      "format": "uri",
      "description": "URL to fetch predefined scope template bundles."
    },

    "sponsor_required": {
      "type": "boolean",
      "description": "Whether every agent identity must have a human sponsor. Always true in relayauth."
    },
    "sponsor_chain": {
      "type": "object",
      "description": "Configuration for sponsor chain tracking.",
      "properties": {
        "enabled": {
          "type": "boolean",
          "description": "Whether sponsor chain is tracked in tokens and audit."
        },
        "max_depth": {
          "type": "integer",
          "description": "Maximum delegation depth (human -> agent -> sub-agent -> ...). 0 = unlimited."
        }
      }
    },

    "scope_delegation": {
      "type": "object",
      "description": "Rules for sub-agent scope delegation.",
      "required": ["enabled", "mode"],
      "properties": {
        "enabled": {
          "type": "boolean",
          "description": "Whether agents can create sub-agents with delegated tokens."
        },
        "mode": {
          "type": "string",
          "enum": ["intersection", "explicit"],
          "description": "How sub-agent scopes are determined. 'intersection' = parent scopes AND requested scopes. 'explicit' = only explicitly granted scopes (must be subset of parent)."
        },
        "escalation_policy": {
          "type": "string",
          "enum": ["hard_error", "silent_deny", "audit_only"],
          "description": "What happens when a sub-agent requests scopes exceeding its parent."
        }
      }
    },

    "budgets": {
      "type": "object",
      "description": "Behavioral budget enforcement capabilities.",
      "required": ["enabled"],
      "properties": {
        "enabled": {
          "type": "boolean",
          "description": "Whether the server enforces behavioral budgets."
        },
        "supported_limits": {
          "type": "array",
          "items": { "type": "string" },
          "description": "Budget limit types supported (e.g., 'maxActionsPerHour', 'maxCostPerDay')."
        },
        "alert_webhook": {
          "type": "boolean",
          "description": "Whether budget threshold alerts can be delivered via webhook."
        },
        "auto_suspend": {
          "type": "boolean",
          "description": "Whether agents can be auto-suspended when budget is exhausted."
        }
      }
    },

    "token_lifetime": {
      "type": "object",
      "description": "Token lifetime constraints.",
      "required": ["access_default", "refresh_default", "maximum"],
      "properties": {
        "access_default": {
          "type": "string",
          "description": "Default access token TTL (ISO 8601 duration), e.g., 'PT1H'."
        },
        "refresh_default": {
          "type": "string",
          "description": "Default refresh token TTL, e.g., 'PT24H'."
        },
        "maximum": {
          "type": "string",
          "description": "Maximum allowed token TTL, e.g., 'P30D'."
        },
        "permanent_tokens": {
          "type": "boolean",
          "const": false,
          "description": "Always false. Every token expires. No exceptions."
        }
      }
    },

    "identity_types": {
      "type": "array",
      "items": { "type": "string", "enum": ["agent", "human", "service"] },
      "description": "Supported identity types."
    },

    "revocation": {
      "type": "object",
      "description": "Token revocation capabilities.",
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "propagation_target": {
          "type": "string",
          "description": "Target propagation time, e.g., '<1s'."
        },
        "mechanism": {
          "type": "string",
          "description": "How revocation propagates (e.g., 'kv_global')."
        }
      }
    },

    "audit": {
      "type": "object",
      "description": "Audit logging capabilities.",
      "properties": {
        "enabled": { "type": "boolean" },
        "queryable": { "type": "boolean" },
        "exportable": { "type": "boolean" },
        "sponsor_chain_tracing": { "type": "boolean" }
      }
    }
  }
}
```

---

## Field Descriptions

### Standard Discovery Fields (Agent Auth Protocol compatible)

| Field | Description |
|-------|-------------|
| `issuer` | Canonical issuer URI. Must match `iss` in JWTs. Used by validators to confirm token provenance. |
| `server_version` | SemVer of the running server. Clients can use this for feature detection. |
| `documentation_url` | Link to human-readable API docs. |
| `token_endpoint` | Where to POST to create new tokens (requires API key). |
| `token_refresh_endpoint` | Where to POST to refresh expired access tokens. |
| `token_revocation_endpoint` | Where to POST to revoke a token globally. |
| `token_validation_endpoint` | Server-side token introspection endpoint. |
| `identity_endpoint` | Base URL for agent/identity CRUD. |
| `jwks_uri` | Standard JWKS endpoint for offline JWT validation. Any service can fetch public keys here. |
| `supported_algorithms` | Which JWS algorithms the server uses (RS256 and/or EdDSA). |
| `supported_grant_types` | How tokens can be obtained. `api_key` is the primary method; `delegation` for sub-agent tokens. |
| `supported_token_types` | `access` and `refresh`. |

### RelayAuth Extension Fields

| Field | Description |
|-------|-------------|
| `scope_format` | Describes the `{plane}:{resource}:{action}:{path?}` format so clients can programmatically construct valid scopes. |
| `scope_templates_url` | URL to fetch pre-built scope bundles (e.g., `relaycast:full`, `cloud:workflow-runner`). |
| `sponsor_required` | Always `true`. Every agent must trace back to a human sponsor. Non-negotiable. |
| `sponsor_chain` | Describes sponsor chain tracking depth and behavior. |
| `scope_delegation` | How sub-agent scope narrowing works. `intersection` mode means sub-agents get the intersection of parent scopes and requested scopes. |
| `budgets` | Behavioral budget enforcement: rate limits, cost caps, auto-suspension. |
| `token_lifetime` | Lifetime constraints including the guarantee that permanent tokens never exist. |
| `identity_types` | What types of identities the server supports. |
| `revocation` | Revocation mechanism metadata (global, <1s propagation via KV). |
| `audit` | Audit capabilities: queryable, exportable, with sponsor chain tracing. |

---

## Example Response

```json
{
  "issuer": "https://relayauth.dev",
  "server_version": "1.0.0",
  "documentation_url": "https://docs.relayauth.dev",

  "token_endpoint": "https://api.relayauth.dev/v1/tokens",
  "token_refresh_endpoint": "https://api.relayauth.dev/v1/tokens/refresh",
  "token_revocation_endpoint": "https://api.relayauth.dev/v1/tokens/revoke",
  "token_validation_endpoint": "https://api.relayauth.dev/v1/tokens/validate",
  "identity_endpoint": "https://api.relayauth.dev/v1/identities",
  "jwks_uri": "https://api.relayauth.dev/.well-known/jwks.json",
  "scopes_endpoint": "https://api.relayauth.dev/v1/scopes",
  "roles_endpoint": "https://api.relayauth.dev/v1/roles",
  "policies_endpoint": "https://api.relayauth.dev/v1/policies",
  "audit_endpoint": "https://api.relayauth.dev/v1/audit",

  "supported_algorithms": ["RS256", "EdDSA"],
  "supported_grant_types": ["api_key", "client_credentials", "delegation"],
  "supported_token_types": ["access", "refresh"],

  "scope_format": {
    "pattern": "{plane}:{resource}:{action}:{path?}",
    "separator": ":",
    "planes": ["relaycast", "relayfile", "cloud", "relayauth"],
    "actions": ["read", "write", "create", "delete", "manage", "run", "send", "invoke", "*"],
    "wildcard": "*",
    "path_optional": true
  },
  "scope_templates_url": "https://api.relayauth.dev/v1/scopes/templates",

  "sponsor_required": true,
  "sponsor_chain": {
    "enabled": true,
    "max_depth": 0
  },

  "scope_delegation": {
    "enabled": true,
    "mode": "intersection",
    "escalation_policy": "hard_error"
  },

  "budgets": {
    "enabled": true,
    "supported_limits": ["maxActionsPerHour", "maxCostPerDay"],
    "alert_webhook": true,
    "auto_suspend": true
  },

  "token_lifetime": {
    "access_default": "PT1H",
    "refresh_default": "PT24H",
    "maximum": "P30D",
    "permanent_tokens": false
  },

  "identity_types": ["agent", "human", "service"],

  "revocation": {
    "enabled": true,
    "propagation_target": "<1s",
    "mechanism": "kv_global"
  },

  "audit": {
    "enabled": true,
    "queryable": true,
    "exportable": true,
    "sponsor_chain_tracing": true
  }
}
```

---

## Compatibility Notes

### Agent Auth Protocol Alignment

The following fields are intentionally aligned with the emerging Agent Auth Protocol discovery format:

- `issuer` — standard OIDC-style issuer identifier
- `token_endpoint`, `jwks_uri` — matches OAuth 2.0 Authorization Server Metadata (RFC 8414)
- `supported_algorithms` — maps to `id_token_signing_alg_values_supported` concept
- `supported_grant_types` — maps to `grant_types_supported`

### RelayAuth Extensions (prefixed conceptually, not in field names)

Fields like `sponsor_required`, `scope_delegation`, `budgets`, `sponsor_chain`, and `scope_format` are relayauth-specific. Clients that don't understand them can safely ignore them while still using the standard discovery fields for basic token operations.

### Versioning

The `server_version` field enables clients to detect feature availability. Breaking changes to this discovery document will be signaled by a major version bump. The response format itself is designed to be forward-compatible — new fields can be added without breaking existing clients.

---

## Implementation Notes

1. **Route placement:** Add to existing `packages/server/src/routes/well-known.ts` alongside the JWKS endpoint, or create `packages/server/src/routes/discovery.ts` and mount at `/.well-known/agent-configuration`.

2. **Response construction:** Most fields are static configuration. `server_version` should come from `package.json`. Endpoint URLs should be constructed from the server's base URL (from env or request origin).

3. **Caching:** Return `Cache-Control: public, max-age=3600` to reduce load. The configuration rarely changes.

4. **TypeScript types:** A `DiscoveryDocument` type should be added to `packages/types/src/discovery.ts` matching this schema, for use by the SDK's auto-discovery feature.

5. **SDK integration:** The SDK should have a `discover(baseUrl)` method that fetches this endpoint and caches the result, using it to configure all subsequent API calls without hardcoded paths.
