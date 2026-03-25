import type {
  AgentConfiguration,
  DiscoveryEndpoint,
  ScopeDefinition,
} from "@relayauth/types";
import {
  agentCardToConfiguration,
  assertValidA2aAgentCard,
  configurationToAgentCard,
} from "@relayauth/sdk/src/a2a-bridge.js";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";

const discovery = new Hono<AppEnv>();
export const apiDiscovery = new Hono<AppEnv>();

const CACHE_CONTROL_HEADER = "public, max-age=3600";
const SCHEMA_VERSION = "1.0";
const SERVICE_NAME = "relayauth";
const SERVER_VERSION = "0.0.0";
const AGENT_CARD_FETCH_TIMEOUT_MS = 5_000;
const MAX_AGENT_CARD_BYTES = 1_000_000;
const MAX_AGENT_CARD_REDIRECTS = 5;
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

apiDiscovery.get("/agent-card", (c) => {
  const origin = new URL(c.req.url).origin;
  const configuration = buildAgentConfiguration(origin);
  const card = configurationToAgentCard(configuration, SERVICE_NAME);

  c.header("Cache-Control", CACHE_CONTROL_HEADER);
  return c.json(card, 200);
});

apiDiscovery.post("/bridge", async (c) => {
  const body = await c.req.json<{ url?: string }>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (typeof body.url !== "string" || body.url.trim() === "") {
    return c.json({ error: "url is required" }, 400);
  }

  try {
    const agentCardUrl = parseBridgeTargetUrl(body.url);
    const card = await fetchAgentCard(agentCardUrl);
    try {
      assertValidA2aAgentCard(card);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Fetched agent card is invalid";
      throw new DiscoveryBridgeError(422, message);
    }
    const configuration = agentCardToConfiguration(card);
    return c.json(configuration, 200);
  } catch (error) {
    return handleBridgeError(c, error);
  }
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

async function fetchAgentCard(baseUrl: URL): Promise<unknown> {
  const candidateUrls = buildAgentCardUrls(baseUrl);
  let lastNotFound = false;

  for (const candidateUrl of candidateUrls) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_CARD_FETCH_TIMEOUT_MS);

    try {
      const response = await fetchAgentCardWithRedirects(candidateUrl, controller.signal);

      if (response.status === 404) {
        lastNotFound = true;
        continue;
      }

      if (!response.ok) {
        throw new DiscoveryBridgeError(
          502,
          `Failed to fetch agent card: upstream returned ${response.status}`,
        );
      }

      const contentLength = response.headers.get("content-length");
      if (contentLength && Number(contentLength) > MAX_AGENT_CARD_BYTES) {
        throw new DiscoveryBridgeError(422, "Fetched agent card exceeds size limit");
      }

      const text = await response.text();
      if (text.length > MAX_AGENT_CARD_BYTES) {
        throw new DiscoveryBridgeError(422, "Fetched agent card exceeds size limit");
      }

      const card = JSON.parse(text) as unknown;
      return card;
    } catch (error) {
      if (error instanceof DiscoveryBridgeError) {
        throw error;
      }

      if (error instanceof SyntaxError) {
        throw new DiscoveryBridgeError(422, "Fetched agent card is not valid JSON");
      }

      if (error instanceof Error && error.name === "AbortError") {
        throw new DiscoveryBridgeError(502, "Timed out while fetching agent card");
      }

      throw new DiscoveryBridgeError(502, "Unable to reach the specified agent card URL");
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastNotFound) {
    throw new DiscoveryBridgeError(502, "Agent card was not found at the provided URL");
  }

  throw new DiscoveryBridgeError(502, "Unable to locate an A2A agent card");
}

async function fetchAgentCardWithRedirects(
  initialUrl: URL,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = new URL(initialUrl.toString());

  for (let redirectCount = 0; redirectCount <= MAX_AGENT_CARD_REDIRECTS; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      method: "GET",
      headers: {
        accept: "application/json",
      },
      redirect: "manual",
      signal,
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new DiscoveryBridgeError(502, "Upstream redirect response was missing a Location header");
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
      throw new DiscoveryBridgeError(502, "Upstream redirect used an unsupported protocol");
    }

    if (isPrivateHost(nextUrl.hostname)) {
      throw new DiscoveryBridgeError(403, "Private or loopback hosts are not allowed");
    }

    currentUrl = nextUrl;
  }

  throw new DiscoveryBridgeError(502, "Too many redirects while fetching agent card");
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function buildAgentCardUrls(baseUrl: URL): URL[] {
  const normalizedPath = baseUrl.pathname.replace(/\/+$/, "");

  if (
    normalizedPath.endsWith("/.well-known/agent-card.json") ||
    normalizedPath.endsWith("/.well-known/agent.json")
  ) {
    return [new URL(baseUrl.toString())];
  }

  return [
    new URL("/.well-known/agent-card.json", baseUrl),
    new URL("/.well-known/agent.json", baseUrl),
  ];
}

function parseBridgeTargetUrl(rawUrl: string): URL {
  let url: URL;

  try {
    url = new URL(rawUrl);
  } catch {
    throw new DiscoveryBridgeError(400, "url must be a valid absolute URL");
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new DiscoveryBridgeError(400, "url must use http or https");
  }

  if (isPrivateHost(url.hostname)) {
    throw new DiscoveryBridgeError(403, "Private or loopback hosts are not allowed");
  }

  return url;
}

function isPrivateHost(hostname: string): boolean {
  const normalizedHost = hostname.trim().toLowerCase();

  // Block localhost and .localhost subdomains (RFC 6761)
  if (
    normalizedHost === "localhost" ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost === "0.0.0.0" ||
    normalizedHost === "::1" ||
    normalizedHost === "[::1]"
  ) {
    return true;
  }

  // Block known DNS-rebinding services
  if (
    normalizedHost.endsWith(".nip.io") ||
    normalizedHost.endsWith(".sslip.io") ||
    normalizedHost.endsWith(".xip.io")
  ) {
    return true;
  }

  if (normalizedHost.includes(":")) {
    const compact = normalizedHost.replace(/^\[|\]$/g, "");
    return compact.startsWith("fc") ||
      compact.startsWith("fd") ||
      compact.startsWith("fe80:") ||
      compact === "::1" ||
      compact.startsWith("::ffff:127.");
  }

  // Try parsing as a decimal IP (e.g. 2130706433 = 127.0.0.1)
  if (/^\d+$/.test(normalizedHost)) {
    const decimal = Number(normalizedHost);
    if (decimal >= 0 && decimal <= 0xFFFFFFFF) {
      const a = (decimal >>> 24) & 0xFF;
      const b = (decimal >>> 16) & 0xFF;
      return isPrivateIPv4(a, b);
    }
  }

  // Parse dotted notation — handle octal (0177) and hex (0x7f) segments
  const segments = normalizedHost.split(".");
  if (segments.length === 4) {
    const octets = segments.map((s) => {
      if (s.startsWith("0x") || s.startsWith("0X")) return parseInt(s, 16);
      if (s.startsWith("0") && s.length > 1) return parseInt(s, 8);
      return Number(s);
    });
    if (octets.every((o) => Number.isInteger(o) && o >= 0 && o <= 255)) {
      return isPrivateIPv4(octets[0], octets[1]);
    }
  }

  return false;
}

function isPrivateIPv4(a: number, b: number): boolean {
  return a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168);
}

function handleBridgeError(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof DiscoveryBridgeError) {
    return c.json({ error: error.message }, error.status);
  }

  return c.json({ error: "internal_error" }, 500);
}

class DiscoveryBridgeError extends Error {
  constructor(
    readonly status: 400 | 403 | 422 | 502,
    message: string,
  ) {
    super(message);
    this.name = "DiscoveryBridgeError";
  }
}

export default discovery;
