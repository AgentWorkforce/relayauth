# `/.well-known/agent-configuration` Specification

## Purpose

This document defines the public discovery document served by relayauth at:

```text
GET /.well-known/agent-configuration
```

The endpoint allows SDKs, gateways, and agents to discover how a relayauth
server issues tokens, publishes keys, exposes identity APIs, models scopes, and
enforces relay-specific controls such as sponsor chains, behavioral budgets, and
sub-agent delegation.

The format intentionally borrows from OAuth 2.0 Authorization Server Metadata
(RFC 8414) and OpenID Connect discovery where those fields are a natural fit:

- `issuer`
- `jwks_uri`
- `token_endpoint`
- `grant_types_supported`
- `token_endpoint_auth_methods_supported`

It extends that shape with relayauth-specific fields:

- `identity_endpoint`
- `scope_format`
- `scope_definitions`
- `sponsor_required`
- `sponsor_chain`
- `scope_delegation`
- `budgets`
- `token_lifetimes`
- `endpoints`

## Endpoint Contract

| Property | Value |
| --- | --- |
| Method | `GET` |
| Path | `/.well-known/agent-configuration` |
| Authentication | None |
| Content-Type | `application/json` |
| Character set | UTF-8 |
| Availability | Public |

The response document describes server capabilities. It is not an authorization
decision surface and must not be used as evidence that a caller is allowed to
invoke a specific endpoint.

## Response Overview

The document is a single JSON object with required metadata, endpoint pointers,
scope-system descriptions, and relayauth extensions.

### Required Top-Level Fields

| Field | Type | Description |
| --- | --- | --- |
| `schema_version` | `string` | Version of this discovery document schema. |
| `issuer` | `string` | Canonical issuer URL. Must match the `iss` claim in tokens. |
| `jwks_uri` | `string` | Public JWKS endpoint used for offline token verification. |
| `token_endpoint` | `string` | Token issuance endpoint. |
| `identity_endpoint` | `string` | Base identity management endpoint. |
| `grant_types_supported` | `GrantType[]` | Supported token issuance and delegation flows. |
| `token_endpoint_auth_methods_supported` | `string[]` | Accepted client authentication modes at `token_endpoint`. |
| `token_signing_alg_values_supported` | `string[]` | Supported JWT signing algorithms for issued access and refresh tokens. |
| `scope_format` | `object` | Canonical scope grammar and normalization rules. |
| `scope_definitions` | `ScopeDefinition[]` | Supported built-in scope families and their path schemas. |
| `sponsor_required` | `boolean` | Whether every agent must resolve to a human sponsor. |
| `scope_delegation` | `object` | Rules for sub-agent token narrowing. |
| `budgets` | `object` | Behavioral budget capability metadata. |
| `token_lifetimes` | `object` | Server defaults and maximum token TTLs. |
| `endpoints` | `object` | Structured endpoint metadata keyed by function. |

### Optional Top-Level Fields

| Field | Type | Description |
| --- | --- | --- |
| `server_version` | `string` | relayauth server version. May be suppressed in hardened deployments. |
| `service_name` | `string` | Human-readable service name. |
| `documentation_url` | `string` | Human-readable docs URL. |
| `scopes_endpoint` | `string` | Endpoint for scope validation or template lookup. |
| `revocation_endpoint` | `string` | Token revocation endpoint. |
| `introspection_endpoint` | `string` | Server-side token validation or introspection endpoint. |
| `scope_templates_endpoint` | `string` | Endpoint exposing built-in scope bundles. |
| `capabilities` | `string[]` | Feature flags or named capabilities supported by this deployment. |
| `sponsor_chain` | `object` | Sponsor lineage limits and token propagation rules. |

## Full JSON Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://relayauth.dev/schemas/agent-configuration.schema.json",
  "title": "AgentConfiguration",
  "type": "object",
  "additionalProperties": false,
  "required": [
    "schema_version",
    "issuer",
    "jwks_uri",
    "token_endpoint",
    "identity_endpoint",
    "grant_types_supported",
    "token_endpoint_auth_methods_supported",
    "token_signing_alg_values_supported",
    "scope_format",
    "scope_definitions",
    "sponsor_required",
    "scope_delegation",
    "budgets",
    "token_lifetimes",
    "endpoints"
  ],
  "properties": {
    "schema_version": {
      "type": "string",
      "pattern": "^[0-9]+\\.[0-9]+$",
      "description": "Discovery schema version. Major changes indicate breaking changes."
    },
    "service_name": {
      "type": "string",
      "minLength": 1
    },
    "issuer": {
      "type": "string",
      "format": "uri"
    },
    "server_version": {
      "type": "string",
      "minLength": 1
    },
    "documentation_url": {
      "type": "string",
      "format": "uri"
    },
    "jwks_uri": {
      "type": "string",
      "format": "uri"
    },
    "token_endpoint": {
      "type": "string",
      "format": "uri"
    },
    "identity_endpoint": {
      "type": "string",
      "format": "uri"
    },
    "scopes_endpoint": {
      "type": "string",
      "format": "uri"
    },
    "revocation_endpoint": {
      "type": "string",
      "format": "uri"
    },
    "introspection_endpoint": {
      "type": "string",
      "format": "uri"
    },
    "scope_templates_endpoint": {
      "type": "string",
      "format": "uri"
    },
    "capabilities": {
      "type": "array",
      "items": {
        "type": "string"
      },
      "uniqueItems": true
    },
    "grant_types_supported": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": [
          "client_credentials",
          "refresh_token",
          "urn:ietf:params:oauth:grant-type:token-exchange",
          "urn:relayauth:params:oauth:grant-type:delegation"
        ]
      }
    },
    "token_endpoint_auth_methods_supported": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": [
          "client_secret_post",
          "private_key_jwt",
          "bearer_token",
          "none"
        ]
      }
    },
    "token_signing_alg_values_supported": {
      "type": "array",
      "minItems": 1,
      "uniqueItems": true,
      "items": {
        "type": "string",
        "enum": ["RS256", "EdDSA"]
      }
    },
    "scope_format": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "pattern",
        "separator",
        "path_optional",
        "wildcard",
        "planes",
        "actions"
      ],
      "properties": {
        "pattern": {
          "type": "string",
          "const": "{plane}:{resource}:{action}:{path?}"
        },
        "separator": {
          "type": "string",
          "const": ":"
        },
        "path_optional": {
          "type": "boolean"
        },
        "wildcard": {
          "type": "string",
          "const": "*"
        },
        "planes": {
          "type": "array",
          "items": {
            "type": "string"
          },
          "minItems": 1,
          "uniqueItems": true
        },
        "actions": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "read",
              "write",
              "create",
              "delete",
              "manage",
              "run",
              "send",
              "invoke",
              "*"
            ]
          },
          "minItems": 1,
          "uniqueItems": true
        },
        "notes": {
          "type": "array",
          "items": {
            "type": "string"
          }
        }
      }
    },
    "scope_definitions": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": [
          "name",
          "plane",
          "resource",
          "pattern",
          "actions",
          "path_schema",
          "description",
          "examples"
        ],
        "properties": {
          "name": {
            "type": "string"
          },
          "plane": {
            "type": "string"
          },
          "resource": {
            "type": "string"
          },
          "pattern": {
            "type": "string"
          },
          "actions": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "minItems": 1,
            "uniqueItems": true
          },
          "path_schema": {
            "type": "object",
            "additionalProperties": false,
            "required": ["type", "required", "wildcard_allowed", "description"],
            "properties": {
              "type": {
                "type": "string",
                "enum": [
                  "wildcard",
                  "fs_path",
                  "channel",
                  "identifier",
                  "constraint"
                ]
              },
              "required": {
                "type": "boolean"
              },
              "wildcard_allowed": {
                "type": "boolean"
              },
              "description": {
                "type": "string"
              },
              "examples": {
                "type": "array",
                "items": {
                  "type": "string"
                }
              }
            }
          },
          "description": {
            "type": "string"
          },
          "examples": {
            "type": "array",
            "items": {
              "type": "string"
            },
            "minItems": 1
          }
        }
      }
    },
    "sponsor_required": {
      "type": "boolean"
    },
    "sponsor_chain": {
      "type": "object",
      "additionalProperties": false,
      "required": ["required", "propagated_in_tokens", "propagated_in_audit"],
      "properties": {
        "required": {
          "type": "boolean"
        },
        "propagated_in_tokens": {
          "type": "boolean"
        },
        "propagated_in_audit": {
          "type": "boolean"
        },
        "max_depth": {
          "type": ["integer", "null"],
          "minimum": 1
        }
      }
    },
    "scope_delegation": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "enabled",
        "mode",
        "escalation_policy"
      ],
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "mode": {
          "type": "string",
          "enum": ["intersection", "explicit_subset"]
        },
        "escalation_policy": {
          "type": "string",
          "enum": ["hard_error", "silent_deny", "audit_only"]
        },
        "max_depth": {
          "type": ["integer", "null"],
          "minimum": 1
        }
      }
    },
    "budgets": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "enabled",
        "supported_limits",
        "alert_webhook_supported",
        "auto_suspend_supported"
      ],
      "properties": {
        "enabled": {
          "type": "boolean"
        },
        "supported_limits": {
          "type": "array",
          "items": {
            "type": "string",
            "enum": [
              "maxActionsPerHour",
              "maxCostPerDay",
              "alertThreshold",
              "autoSuspend"
            ]
          },
          "uniqueItems": true
        },
        "alert_webhook_supported": {
          "type": "boolean"
        },
        "auto_suspend_supported": {
          "type": "boolean"
        }
      }
    },
    "token_lifetimes": {
      "type": "object",
      "additionalProperties": false,
      "required": [
        "access_token_default",
        "refresh_token_default",
        "maximum",
        "permanent_tokens_allowed"
      ],
      "properties": {
        "access_token_default": {
          "type": "string"
        },
        "refresh_token_default": {
          "type": "string"
        },
        "maximum": {
          "type": "string"
        },
        "permanent_tokens_allowed": {
          "type": "boolean"
        }
      }
    },
    "endpoints": {
      "type": "object",
      "additionalProperties": {
        "type": "object",
        "additionalProperties": false,
        "required": ["url", "methods", "auth", "description"],
        "properties": {
          "url": {
            "type": "string",
            "format": "uri"
          },
          "methods": {
            "type": "array",
            "items": {
              "type": "string",
              "enum": ["GET", "POST", "PUT", "PATCH", "DELETE"]
            },
            "minItems": 1,
            "uniqueItems": true
          },
          "auth": {
            "type": "string",
            "enum": ["none", "bearer_token", "client_secret_post", "private_key_jwt"]
          },
          "description": {
            "type": "string"
          },
          "rate_limited": {
            "type": "boolean"
          }
        }
      }
    }
  }
}
```

## Field Semantics

### Core Metadata

| Field | Rules |
| --- | --- |
| `schema_version` | Version of the discovery document contract, not the server binary. |
| `issuer` | Must be an absolute HTTPS URL in production deployments. |
| `server_version` | Should be semantic versioning when possible. |
| `service_name` | Informational only. Clients must not use it for routing or trust decisions. |

### Endpoint Pointers

| Field | Rules |
| --- | --- |
| `jwks_uri` | Must resolve to the same logical issuer or a trusted key-hosting domain controlled by the issuer. |
| `token_endpoint` | The primary endpoint for token issuance and refresh-compatible flows. |
| `identity_endpoint` | Base collection endpoint for agent identities. |
| `revocation_endpoint` | Optional but recommended if immediate revocation is supported. |
| `introspection_endpoint` | Optional. Use only when local JWT verification is insufficient. |
| `scopes_endpoint` | Optional endpoint for scope validation or documentation lookup. |
| `scope_templates_endpoint` | Optional endpoint exposing named bundles such as `read-all` or `relayauth:admin`. |

### Algorithms and Authentication Modes

| Field | Rules |
| --- | --- |
| `grant_types_supported` | Must list only flows actually accepted by the server. |
| `token_endpoint_auth_methods_supported` | Describes how clients authenticate to `token_endpoint`, not how protected APIs are called. |
| `token_signing_alg_values_supported` | Must be a subset of algorithms actually published in JWKS. For relayauth, this is `RS256`, `EdDSA`, or both. |

### Scope Model

`scope_format` describes the shared grammar:

```text
{plane}:{resource}:{action}:{path?}
```

Rules:

1. `path` is optional and normalizes to `*` when omitted.
2. `:` is the only segment delimiter.
3. `*` is the only wildcard token.
4. `actions` should align with the shared `Action` type in `@relayauth/types`.

`scope_definitions` lets the server publish built-in scope families and the
expected schema for the optional `path` segment.

### Sponsor and Delegation Extensions

| Field | Rules |
| --- | --- |
| `sponsor_required` | `true` means each agent identity must resolve to a human sponsor. |
| `sponsor_chain.required` | If `true`, sponsor lineage is part of the server’s trust model. |
| `sponsor_chain.propagated_in_tokens` | If `true`, issued tokens include lineage metadata. |
| `scope_delegation.mode` | `intersection` means child scopes are the intersection of parent scopes and the requested subset. |
| `scope_delegation.escalation_policy` | `hard_error` matches relayauth’s requirement that privilege escalation attempts fail explicitly. |

### Budget Extensions

`budgets` documents whether relayauth enforces behavioral limits in addition to
scope checks:

- `maxActionsPerHour`
- `maxCostPerDay`
- `alertThreshold`
- `autoSuspend`

### Token Lifetime Metadata

`token_lifetimes` communicates defaults and hard limits. Clients may request
shorter TTLs, but they must not assume the server will honor longer durations
than `maximum`.

## Example Response: Minimal

```json
{
  "schema_version": "1.0",
  "issuer": "https://relayauth.dev",
  "server_version": "0.1.0",
  "jwks_uri": "https://relayauth.dev/.well-known/jwks.json",
  "token_endpoint": "https://relayauth.dev/v1/tokens",
  "identity_endpoint": "https://relayauth.dev/v1/identities",
  "grant_types_supported": [
    "client_credentials",
    "urn:ietf:params:oauth:grant-type:token-exchange"
  ],
  "token_endpoint_auth_methods_supported": [
    "private_key_jwt"
  ],
  "token_signing_alg_values_supported": [
    "RS256"
  ],
  "scope_format": {
    "pattern": "{plane}:{resource}:{action}:{path?}",
    "separator": ":",
    "path_optional": true,
    "wildcard": "*",
    "planes": ["relaycast", "relayfile", "cloud", "relayauth"],
    "actions": ["read", "write", "create", "delete", "manage", "run", "send", "invoke", "*"]
  },
  "scope_definitions": [
    {
      "name": "relayfile-fs",
      "plane": "relayfile",
      "resource": "fs",
      "pattern": "relayfile:fs:{read|write}:{path}",
      "actions": ["read", "write"],
      "path_schema": {
        "type": "fs_path",
        "required": false,
        "wildcard_allowed": true,
        "description": "Filesystem path selector. Omitted path normalizes to '*'.",
        "examples": ["/docs/*", "/src/api/*", "*"]
      },
      "description": "Filesystem read and write capabilities in relayfile.",
      "examples": ["relayfile:fs:read:/docs/*", "relayfile:fs:write:/src/api/*"]
    }
  ],
  "sponsor_required": true,
  "scope_delegation": {
    "enabled": true,
    "mode": "intersection",
    "escalation_policy": "hard_error",
    "max_depth": 10
  },
  "budgets": {
    "enabled": true,
    "supported_limits": ["maxActionsPerHour", "maxCostPerDay", "alertThreshold", "autoSuspend"],
    "alert_webhook_supported": true,
    "auto_suspend_supported": true
  },
  "token_lifetimes": {
    "access_token_default": "PT1H",
    "refresh_token_default": "PT24H",
    "maximum": "P30D",
    "permanent_tokens_allowed": false
  },
  "endpoints": {
    "jwks": {
      "url": "https://relayauth.dev/.well-known/jwks.json",
      "methods": ["GET"],
      "auth": "none",
      "description": "Public keys for JWT verification.",
      "rate_limited": true
    },
    "tokens": {
      "url": "https://relayauth.dev/v1/tokens",
      "methods": ["POST"],
      "auth": "private_key_jwt",
      "description": "Issues access and refresh tokens.",
      "rate_limited": true
    },
    "identities": {
      "url": "https://relayauth.dev/v1/identities",
      "methods": ["GET", "POST"],
      "auth": "bearer_token",
      "description": "Lists and creates agent identities.",
      "rate_limited": true
    }
  }
}
```

## Example Response: Full

```json
{
  "schema_version": "1.0",
  "service_name": "relayauth",
  "issuer": "https://api.relayauth.dev",
  "server_version": "0.1.0",
  "documentation_url": "https://docs.relayauth.dev",
  "jwks_uri": "https://api.relayauth.dev/.well-known/jwks.json",
  "token_endpoint": "https://api.relayauth.dev/v1/tokens",
  "identity_endpoint": "https://api.relayauth.dev/v1/identities",
  "scopes_endpoint": "https://api.relayauth.dev/v1/scopes",
  "revocation_endpoint": "https://api.relayauth.dev/v1/tokens/revoke",
  "introspection_endpoint": "https://api.relayauth.dev/v1/tokens/introspect",
  "scope_templates_endpoint": "https://api.relayauth.dev/v1/scopes/templates",
  "capabilities": [
    "identity-management",
    "token-revocation",
    "scope-delegation",
    "budget-enforcement",
    "audit-query"
  ],
  "grant_types_supported": [
    "client_credentials",
    "refresh_token",
    "urn:ietf:params:oauth:grant-type:token-exchange",
    "urn:relayauth:params:oauth:grant-type:delegation"
  ],
  "token_endpoint_auth_methods_supported": [
    "private_key_jwt",
    "client_secret_post"
  ],
  "token_signing_alg_values_supported": [
    "RS256",
    "EdDSA"
  ],
  "scope_format": {
    "pattern": "{plane}:{resource}:{action}:{path?}",
    "separator": ":",
    "path_optional": true,
    "wildcard": "*",
    "planes": ["relaycast", "relayfile", "cloud", "relayauth"],
    "actions": ["read", "write", "create", "delete", "manage", "run", "send", "invoke", "*"],
    "notes": [
      "A 3-segment scope normalizes to a 4-segment scope by appending '*'.",
      "Wildcard matching is segment-local only.",
      "manage implies read, write, create, and delete on the same scope family."
    ]
  },
  "scope_definitions": [
    {
      "name": "relaycast-channel",
      "plane": "relaycast",
      "resource": "channel",
      "pattern": "relaycast:channel:{read|send}:{channel-or-*}",
      "actions": ["read", "send"],
      "path_schema": {
        "type": "channel",
        "required": false,
        "wildcard_allowed": true,
        "description": "Target channel selector such as '#billing' or '*'.",
        "examples": ["#billing", "#ops", "*"]
      },
      "description": "Read or send access for relaycast channels.",
      "examples": ["relaycast:channel:read:*", "relaycast:channel:send:#billing"]
    },
    {
      "name": "relayfile-fs",
      "plane": "relayfile",
      "resource": "fs",
      "pattern": "relayfile:fs:{read|write}:{path}",
      "actions": ["read", "write"],
      "path_schema": {
        "type": "fs_path",
        "required": false,
        "wildcard_allowed": true,
        "description": "Filesystem-style path selector.",
        "examples": ["/src/api/*", "/docs/*", "*"]
      },
      "description": "Filesystem access within relayfile.",
      "examples": ["relayfile:fs:read:/docs/*", "relayfile:fs:write:/src/api/*"]
    },
    {
      "name": "cloud-workflow",
      "plane": "cloud",
      "resource": "workflow",
      "pattern": "cloud:workflow:{read|run}:{workflow-id-or-*}",
      "actions": ["read", "run"],
      "path_schema": {
        "type": "identifier",
        "required": false,
        "wildcard_allowed": true,
        "description": "Workflow identifier or '*'.",
        "examples": ["runner-prod", "workflow-123", "*"]
      },
      "description": "Read and run capabilities for cloud workflows.",
      "examples": ["cloud:workflow:read:*", "cloud:workflow:run:runner-prod"]
    },
    {
      "name": "relayauth-core",
      "plane": "relayauth",
      "resource": "identity",
      "pattern": "relayauth:{identity|token|scope|role|policy|audit}:{action}:{selector}",
      "actions": ["read", "create", "write", "delete", "manage", "*"],
      "path_schema": {
        "type": "identifier",
        "required": false,
        "wildcard_allowed": true,
        "description": "Resource selector, resource ID, or '*'.",
        "examples": ["*", "agent_8x2k", "org_acme"]
      },
      "description": "Administrative capabilities within the relayauth plane.",
      "examples": ["relayauth:identity:manage:*", "relayauth:token:read:*", "relayauth:scope:read:*"]
    }
  ],
  "sponsor_required": true,
  "sponsor_chain": {
    "required": true,
    "propagated_in_tokens": true,
    "propagated_in_audit": true,
    "max_depth": 10
  },
  "scope_delegation": {
    "enabled": true,
    "mode": "intersection",
    "escalation_policy": "hard_error",
    "max_depth": 10
  },
  "budgets": {
    "enabled": true,
    "supported_limits": [
      "maxActionsPerHour",
      "maxCostPerDay",
      "alertThreshold",
      "autoSuspend"
    ],
    "alert_webhook_supported": true,
    "auto_suspend_supported": true
  },
  "token_lifetimes": {
    "access_token_default": "PT1H",
    "refresh_token_default": "PT24H",
    "maximum": "P30D",
    "permanent_tokens_allowed": false
  },
  "endpoints": {
    "jwks": {
      "url": "https://api.relayauth.dev/.well-known/jwks.json",
      "methods": ["GET"],
      "auth": "none",
      "description": "Public signing keys for token verification.",
      "rate_limited": true
    },
    "tokens": {
      "url": "https://api.relayauth.dev/v1/tokens",
      "methods": ["POST"],
      "auth": "private_key_jwt",
      "description": "Issues access and refresh tokens.",
      "rate_limited": true
    },
    "revocation": {
      "url": "https://api.relayauth.dev/v1/tokens/revoke",
      "methods": ["POST"],
      "auth": "bearer_token",
      "description": "Revokes a token globally.",
      "rate_limited": true
    },
    "introspection": {
      "url": "https://api.relayauth.dev/v1/tokens/introspect",
      "methods": ["POST"],
      "auth": "bearer_token",
      "description": "Server-side token validation.",
      "rate_limited": true
    },
    "identities": {
      "url": "https://api.relayauth.dev/v1/identities",
      "methods": ["GET", "POST", "PATCH"],
      "auth": "bearer_token",
      "description": "Lists, creates, and updates identities.",
      "rate_limited": true
    },
    "scopes": {
      "url": "https://api.relayauth.dev/v1/scopes",
      "methods": ["GET"],
      "auth": "bearer_token",
      "description": "Scope validation and metadata lookup.",
      "rate_limited": true
    },
    "scope_templates": {
      "url": "https://api.relayauth.dev/v1/scopes/templates",
      "methods": ["GET"],
      "auth": "bearer_token",
      "description": "Named scope bundles supported by the server.",
      "rate_limited": true
    },
    "audit": {
      "url": "https://api.relayauth.dev/v1/audit",
      "methods": ["GET"],
      "auth": "bearer_token",
      "description": "Query audit log entries.",
      "rate_limited": true
    }
  }
}
```

## Versioning Strategy

`schema_version` follows `MAJOR.MINOR`.

Rules:

1. Increment `MINOR` when adding optional fields, optional endpoint entries, or
   new `scope_definitions` that do not change existing semantics.
2. Increment `MAJOR` when removing fields, changing field meaning, tightening
   validation in a breaking way, or renaming established endpoint keys.
3. Clients must ignore unknown fields.
4. Servers should retain prior fields for at least one major-version cycle when
   feasible.

Recommended compatibility posture:

- clients should require only the fields they actually use
- clients should branch on `schema_version` only for breaking changes
- servers should prefer additive evolution

## Cache-Control Recommendations

The discovery document is public metadata and should be cacheable, but changes
must propagate quickly enough for SDK bootstrapping and key routing.

Recommended response headers:

```text
Cache-Control: public, max-age=3600, stale-while-revalidate=300
Content-Type: application/json; charset=utf-8
```

Guidance:

1. Use `max-age=3600` for stable deployments.
2. Reduce `max-age` during staged rollouts, endpoint migrations, or algorithm
   transitions.
3. If the deployment emits `ETag` or `Last-Modified`, clients should revalidate
   before discarding cached content.
4. Cache discovery and JWKS independently. They change on different cadences.

## Relationship to `/.well-known/jwks.json`

`jwks_uri` is the trust anchor pointer in this document.

Relationship rules:

1. `jwks_uri` must reference the endpoint defined in the token-format spec.
2. The set of `token_signing_alg_values_supported` must be compatible with the
   keys currently published by JWKS.
3. If a signing algorithm is removed from JWKS, the discovery document must stop
   advertising it.
4. Clients should fetch discovery first, then JWKS, and cache them separately.
5. Key rotation does not require a discovery schema change as long as `jwks_uri`
   remains stable.

Operationally:

- discovery answers where to verify
- JWKS answers with which keys to verify

## Implementation Notes

Recommended relayauth route behavior:

1. Serve the document from the same origin as `issuer` when possible.
2. Keep the response generated from typed server configuration, not ad hoc
   strings.
3. Ensure `issuer`, `jwks_uri`, and endpoint URLs remain internally consistent.
4. Publish only scope families the server actually enforces.
5. Treat this document as part of the public API contract and cover it with
   contract tests.
