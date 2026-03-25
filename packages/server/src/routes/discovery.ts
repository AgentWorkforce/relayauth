import type {
  AgentConfiguration,
  DiscoveryEndpoint,
  ScopeDefinition,
} from "@relayauth/types";
import { Hono } from "hono";
import type { AppEnv } from "../env.js";

const discovery = new Hono<AppEnv>();

const CACHE_CONTROL_HEADER = "public, max-age=3600";
const SCHEMA_VERSION = "1.0";
const SERVICE_NAME = "relayauth";
const SERVER_VERSION = "0.0.0";
const BUILT_IN_PLANES = ["relaycast", "relayfile", "cloud", "relayauth"] as const;
const BUILT_IN_ACTIONS = [
  "read",
  "write",
  "create",
  "delete",
  "manage",
  "run",
  "send",
  "invoke",
  "*",
] as const;
const GRANT_TYPES = [
  "client_credentials",
  "refresh_token",
  "urn:ietf:params:oauth:grant-type:token-exchange",
  "urn:relayauth:params:oauth:grant-type:delegation",
] as const;
const TOKEN_AUTH_METHODS = ["private_key_jwt", "client_secret_post"] as const;
const TOKEN_SIGNING_ALGORITHMS = ["RS256"] as const;
const SCOPE_DEFINITIONS: ScopeDefinition[] = [
  {
    name: "relaycast-channel",
    plane: "relaycast",
    resource: "channel",
    pattern: "relaycast:channel:{read|send}:{channel-or-*}",
    actions: ["read", "send"],
    path_schema: {
      type: "channel",
      required: false,
      wildcard_allowed: true,
      description: "Target channel selector such as '#billing' or '*'.",
      examples: ["#billing", "#ops", "*"],
    },
    description: "Read or send access for relaycast channels.",
    examples: ["relaycast:channel:read:*", "relaycast:channel:send:#billing"],
  },
  {
    name: "relayfile-fs",
    plane: "relayfile",
    resource: "fs",
    pattern: "relayfile:fs:{read|write}:{path}",
    actions: ["read", "write"],
    path_schema: {
      type: "fs_path",
      required: false,
      wildcard_allowed: true,
      description: "Filesystem-style path selector.",
      examples: ["/src/api/*", "/docs/*", "*"],
    },
    description: "Filesystem access within relayfile.",
    examples: ["relayfile:fs:read:/docs/*", "relayfile:fs:write:/src/api/*"],
  },
  {
    name: "cloud-workflow",
    plane: "cloud",
    resource: "workflow",
    pattern: "cloud:workflow:{read|run}:{workflow-id-or-*}",
    actions: ["read", "run"],
    path_schema: {
      type: "identifier",
      required: false,
      wildcard_allowed: true,
      description: "Workflow identifier or '*'.",
      examples: ["runner-prod", "workflow-123", "*"],
    },
    description: "Read and run capabilities for cloud workflows.",
    examples: ["cloud:workflow:read:*", "cloud:workflow:run:runner-prod"],
  },
  {
    name: "relayauth-identity",
    plane: "relayauth",
    resource: "identity",
    pattern: "relayauth:identity:{read|create|write|delete|manage|*}:{selector}",
    actions: ["read", "create", "write", "delete", "manage", "*"],
    path_schema: {
      type: "identifier",
      required: false,
      wildcard_allowed: true,
      description: "Resource selector, resource ID, or '*'.",
      examples: ["*", "agent_8x2k", "org_acme"],
    },
    description: "Administrative capabilities for identities within the relayauth plane.",
    examples: ["relayauth:identity:manage:*", "relayauth:identity:read:agent_8x2k"],
  },
];

discovery.get("/agent-configuration", (c) => {
  const origin = new URL(c.req.url).origin;
  const configuration = buildAgentConfiguration(origin);

  c.header("Cache-Control", CACHE_CONTROL_HEADER);
  return c.json(configuration, 200);
});

function buildAgentConfiguration(origin: string): AgentConfiguration {
  const endpoints = buildEndpoints(origin);

  return {
    schema_version: SCHEMA_VERSION,
    service_name: SERVICE_NAME,
    issuer: origin,
    server_version: SERVER_VERSION,
    jwks_uri: absoluteUrl(origin, "/.well-known/jwks.json"),
    token_endpoint: absoluteUrl(origin, "/v1/tokens"),
    identity_endpoint: absoluteUrl(origin, "/v1/identities"),
    scopes_endpoint: absoluteUrl(origin, "/v1/scopes"),
    revocation_endpoint: absoluteUrl(origin, "/v1/tokens/revoke"),
    introspection_endpoint: absoluteUrl(origin, "/v1/tokens/introspect"),
    scope_templates_endpoint: absoluteUrl(origin, "/v1/scopes/templates"),
    capabilities: [
      "identity-management",
      "token-issuance",
      "token-revocation",
      "scope-delegation",
      "budget-enforcement",
      "audit-query",
      "role-management",
      "policy-management",
    ],
    grant_types_supported: [...GRANT_TYPES],
    token_endpoint_auth_methods_supported: [...TOKEN_AUTH_METHODS],
    token_signing_alg_values_supported: [...TOKEN_SIGNING_ALGORITHMS],
    scope_format: {
      pattern: "{plane}:{resource}:{action}:{path?}",
      separator: ":",
      path_optional: true,
      wildcard: "*",
      planes: [...BUILT_IN_PLANES],
      actions: [...BUILT_IN_ACTIONS],
      notes: [
        "A 3-segment scope normalizes to a 4-segment scope by appending '*'.",
        "Wildcard matching is segment-local only.",
        "manage implies read, write, create, and delete on the same scope family.",
      ],
    },
    scope_definitions: SCOPE_DEFINITIONS,
    sponsor_required: true,
    sponsor_chain: {
      required: true,
      propagated_in_tokens: true,
      propagated_in_audit: true,
      max_depth: 10,
    },
    scope_delegation: {
      enabled: true,
      mode: "intersection",
      escalation_policy: "hard_error",
      max_depth: 10,
    },
    budgets: {
      enabled: true,
      supported_limits: [
        "maxActionsPerHour",
        "maxCostPerDay",
        "alertThreshold",
        "autoSuspend",
      ],
      alert_webhook_supported: true,
      auto_suspend_supported: true,
    },
    token_lifetimes: {
      access_token_default: "PT1H",
      refresh_token_default: "PT24H",
      maximum: "P30D",
      permanent_tokens_allowed: false,
    },
    endpoints,
  };
}

function buildEndpoints(origin: string): Record<string, DiscoveryEndpoint> {
  return {
    agent_configuration: endpoint(
      origin,
      "/.well-known/agent-configuration",
      ["GET"],
      "none",
      "Public discovery metadata for relayauth capabilities.",
    ),
    jwks: endpoint(
      origin,
      "/.well-known/jwks.json",
      ["GET"],
      "none",
      "Public signing keys for token verification.",
    ),
    tokens: endpoint(
      origin,
      "/v1/tokens",
      ["POST"],
      "private_key_jwt",
      "Issues access and refresh tokens.",
    ),
    tokens_refresh: endpoint(
      origin,
      "/v1/tokens/refresh",
      ["POST"],
      "bearer_token",
      "Refreshes an access token using a refresh token exchange.",
    ),
    token_revocation: endpoint(
      origin,
      "/v1/tokens/revoke",
      ["POST"],
      "bearer_token",
      "Revokes a token globally.",
    ),
    token_introspection: endpoint(
      origin,
      "/v1/tokens/introspect",
      ["GET", "POST"],
      "bearer_token",
      "Server-side token validation.",
    ),
    token_revocation_list: endpoint(
      origin,
      "/v1/tokens/revocation",
      ["GET"],
      "none",
      "Publishes token revocation state for verifiers.",
    ),
    identities: endpoint(
      origin,
      "/v1/identities",
      ["GET", "POST"],
      "bearer_token",
      "Lists and creates agent identities.",
    ),
    identity: endpoint(
      origin,
      "/v1/identities/{id}",
      ["GET", "PATCH", "DELETE"],
      "bearer_token",
      "Fetches, updates, or deletes an identity.",
    ),
    identity_suspend: endpoint(
      origin,
      "/v1/identities/{id}/suspend",
      ["POST"],
      "bearer_token",
      "Suspends an identity and cascades revocation to descendants.",
    ),
    identity_retire: endpoint(
      origin,
      "/v1/identities/{id}/retire",
      ["POST"],
      "bearer_token",
      "Retires an identity permanently.",
    ),
    identity_reactivate: endpoint(
      origin,
      "/v1/identities/{id}/reactivate",
      ["POST"],
      "bearer_token",
      "Reactivates a suspended identity.",
    ),
    identity_activity: endpoint(
      origin,
      "/v1/identities/{id}/activity",
      ["GET"],
      "bearer_token",
      "Returns audit activity, budget usage, and sub-agent lineage for an identity.",
    ),
    identity_roles: endpoint(
      origin,
      "/v1/identities/{id}/roles",
      ["GET", "POST"],
      "bearer_token",
      "Lists or assigns roles for an identity.",
    ),
    identity_role: endpoint(
      origin,
      "/v1/identities/{id}/roles/{roleId}",
      ["DELETE"],
      "bearer_token",
      "Removes a role assignment from an identity.",
    ),
    roles: endpoint(
      origin,
      "/v1/roles",
      ["GET", "POST"],
      "bearer_token",
      "Lists and creates roles.",
    ),
    role: endpoint(
      origin,
      "/v1/roles/{id}",
      ["GET", "PATCH", "DELETE"],
      "bearer_token",
      "Fetches, updates, or deletes a role.",
    ),
    policies: endpoint(
      origin,
      "/v1/policies",
      ["GET", "POST"],
      "bearer_token",
      "Lists and creates policies.",
    ),
    policy: endpoint(
      origin,
      "/v1/policies/{id}",
      ["GET", "PATCH", "DELETE"],
      "bearer_token",
      "Fetches, updates, or deletes a policy.",
    ),
    audit_query: endpoint(
      origin,
      "/v1/audit",
      ["GET"],
      "bearer_token",
      "Queries audit log entries.",
    ),
    audit_export: endpoint(
      origin,
      "/v1/audit/export",
      ["POST"],
      "bearer_token",
      "Exports audit log entries as JSON or CSV.",
    ),
    audit_webhooks: endpoint(
      origin,
      "/v1/audit/webhooks",
      ["GET", "POST"],
      "bearer_token",
      "Lists or creates audit webhooks.",
    ),
    audit_webhook: endpoint(
      origin,
      "/v1/audit/webhooks/{id}",
      ["DELETE"],
      "bearer_token",
      "Deletes an audit webhook.",
    ),
    stats: endpoint(
      origin,
      "/v1/stats",
      ["GET"],
      "bearer_token",
      "Returns dashboard statistics for tokens, scopes, and identities.",
    ),
    scopes: endpoint(
      origin,
      "/v1/scopes",
      ["GET"],
      "bearer_token",
      "Scope validation and metadata lookup.",
    ),
    scope_templates: endpoint(
      origin,
      "/v1/scopes/templates",
      ["GET"],
      "bearer_token",
      "Named scope bundles supported by the server.",
    ),
  };
}

function endpoint(
  origin: string,
  path: string,
  methods: DiscoveryEndpoint["methods"],
  auth: DiscoveryEndpoint["auth"],
  description: string,
): DiscoveryEndpoint {
  return {
    url: absoluteUrl(origin, path),
    methods,
    auth,
    description,
    rate_limited: true,
  };
}

function absoluteUrl(origin: string, path: string): string {
  return new URL(path, origin).toString();
}

export default discovery;
