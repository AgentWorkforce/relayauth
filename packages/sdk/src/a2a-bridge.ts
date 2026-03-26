import type {
  AgentConfiguration,
  DiscoveryEndpoint,
  EndpointAuthMode,
  ScopeDefinition,
} from "@relayauth/types";

export interface A2aAgentSkill {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

export interface A2aAgentCard {
  name: string;
  description?: string;
  url: string;
  version?: string;
  capabilities?: {
    streaming?: boolean;
    pushNotifications?: boolean;
    stateTransitionHistory?: boolean;
  };
  skills?: A2aAgentSkill[];
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

const DEFAULT_SCHEMA_VERSION = "1.0";
const DEFAULT_GRANT_TYPES = ["client_credentials"] as const;
const DEFAULT_TOKEN_SIGNING_ALGORITHMS = ["RS256"] as const;
const DEFAULT_TOKEN_AUTH_METHODS: EndpointAuthMode[] = ["none"];

export function agentCardToConfiguration(card: A2aAgentCard): AgentConfiguration {
  assertValidA2aAgentCard(card);

  const rpcUrl = new URL(card.url);
  const origin = rpcUrl.origin;
  const scopeDefinitions = (card.skills ?? []).map(skillToScopeDefinition);
  const authMethods = mapAuthenticationSchemes(card.authentication?.schemes);

  return {
    schema_version: DEFAULT_SCHEMA_VERSION,
    issuer: origin,
    service_name: card.name,
    ...(card.version ? { server_version: card.version } : {}),
    ...(card.provider?.url ? { documentation_url: card.provider.url } : {}),
    jwks_uri: new URL("/.well-known/jwks.json", origin).toString(),
    token_endpoint: rpcUrl.toString(),
    identity_endpoint: rpcUrl.toString(),
    capabilities: mapCardCapabilities(card.capabilities),
    grant_types_supported: [...DEFAULT_GRANT_TYPES],
    token_endpoint_auth_methods_supported: authMethods,
    token_signing_alg_values_supported: [...DEFAULT_TOKEN_SIGNING_ALGORITHMS],
    scope_format: {
      pattern: "{plane}:{resource}:{action}:{path?}",
      separator: ":",
      path_optional: true,
      wildcard: "*",
      planes: ["a2a"],
      actions: ["invoke"],
      notes: [
        "Bridged A2A skills are exposed as invoke-only scope families.",
      ],
    },
    scope_definitions: scopeDefinitions,
    sponsor_required: false,
    scope_delegation: {
      enabled: false,
      mode: "intersection",
      escalation_policy: "hard_error",
    },
    budgets: {
      enabled: false,
      supported_limits: [],
      alert_webhook_supported: false,
      auto_suspend_supported: false,
    },
    token_lifetimes: {
      access_token_default: "PT1H",
      refresh_token_default: "PT24H",
      maximum: "P30D",
      permanent_tokens_allowed: false,
    },
    endpoints: {
      agent_card: endpoint(
        new URL("/.well-known/agent-card.json", origin).toString(),
        ["GET"],
        "none",
        "Published A2A agent card metadata.",
      ),
      rpc: endpoint(
        rpcUrl.toString(),
        ["POST"],
        authMethods[0] ?? "none",
        "A2A JSON-RPC endpoint.",
      ),
      jwks: endpoint(
        new URL("/.well-known/jwks.json", origin).toString(),
        ["GET"],
        "none",
        "Public signing keys if the A2A server publishes them.",
      ),
    },
  };
}

export function configurationToAgentCard(
  config: AgentConfiguration,
  name = config.service_name ?? "unknown",
): A2aAgentCard {
  const skills = config.scope_definitions.map(scopeDefinitionToSkill);

  return {
    name,
    description: `A2A bridge for ${name}`,
    url: config.token_endpoint,
    ...(config.server_version ? { version: config.server_version } : {}),
    capabilities: mapConfigurationCapabilities(config.capabilities),
    skills,
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    provider: {
      organization: name,
      url: config.documentation_url ?? config.issuer,
    },
    authentication: {
      schemes: mapConfigurationAuthentication(config.token_endpoint_auth_methods_supported),
    },
  };
}

export function assertValidA2aAgentCard(value: unknown): asserts value is A2aAgentCard {
  if (!isRecord(value)) {
    throw new Error("A2A agent card must be a JSON object");
  }

  if (typeof value.name !== "string" || value.name.trim() === "") {
    throw new Error("A2A agent card must include a non-empty name");
  }

  if (typeof value.url !== "string" || value.url.trim() === "") {
    throw new Error("A2A agent card must include a non-empty url");
  }

  try {
    new URL(value.url);
  } catch {
    throw new Error("A2A agent card url must be a valid absolute URL");
  }

  if (value.skills !== undefined) {
    if (!Array.isArray(value.skills)) {
      throw new Error("A2A agent card skills must be an array when provided");
    }

    for (const skill of value.skills) {
      if (!isRecord(skill)) {
        throw new Error("A2A agent card skills must be objects");
      }

      if (typeof skill.id !== "string" || skill.id.trim() === "") {
        throw new Error("A2A agent card skills must include a non-empty id");
      }

      if (typeof skill.name !== "string" || skill.name.trim() === "") {
        throw new Error("A2A agent card skills must include a non-empty name");
      }
    }
  }

  if (value.authentication !== undefined) {
    if (!isRecord(value.authentication) || !Array.isArray(value.authentication.schemes)) {
      throw new Error("A2A agent card authentication must include a schemes array");
    }
  }
}

function skillToScopeDefinition(skill: A2aAgentSkill): ScopeDefinition {
  const resource = normalizeIdentifier(skill.id);
  const description = skill.description?.trim() || skill.name.trim();
  const pattern = `a2a:${resource}:invoke:*`;

  return {
    name: skill.name.trim(),
    plane: "a2a",
    resource,
    pattern,
    actions: ["invoke"],
    path_schema: {
      type: "wildcard",
      required: false,
      wildcard_allowed: true,
      description: "Task selector or '*'.",
      examples: ["*"],
    },
    description,
    examples: skill.examples?.filter(isNonEmptyString) ?? [pattern],
  };
}

function scopeDefinitionToSkill(scopeDefinition: ScopeDefinition): A2aAgentSkill {
  return {
    id: normalizeIdentifier(`${scopeDefinition.plane}-${scopeDefinition.resource}`),
    name: scopeDefinition.name,
    description: scopeDefinition.description,
    tags: scopeDefinition.actions,
    examples: scopeDefinition.examples,
  };
}

function mapCardCapabilities(cardCapabilities: A2aAgentCard["capabilities"]): string[] {
  const capabilities: string[] = [];

  if (cardCapabilities?.streaming) {
    capabilities.push("streaming");
  }

  if (cardCapabilities?.pushNotifications) {
    capabilities.push("push-notifications");
  }

  if (cardCapabilities?.stateTransitionHistory) {
    capabilities.push("state-transition-history");
  }

  return capabilities;
}

function mapConfigurationCapabilities(
  capabilities: AgentConfiguration["capabilities"],
): NonNullable<A2aAgentCard["capabilities"]> {
  const capabilitySet = new Set(capabilities ?? []);

  return {
    streaming: capabilitySet.has("streaming"),
    pushNotifications:
      capabilitySet.has("push-notifications") || capabilitySet.has("audit-webhooks"),
    stateTransitionHistory:
      capabilitySet.has("state-transition-history") || capabilitySet.has("audit-query"),
  };
}

function mapAuthenticationSchemes(schemes: string[] | undefined): EndpointAuthMode[] {
  if (!schemes || schemes.length === 0) {
    return [...DEFAULT_TOKEN_AUTH_METHODS];
  }

  const mapped = schemes.flatMap((scheme) => {
    switch (scheme) {
      case "none":
      case "public":
        return ["none" as const];
      case "bearer":
      case "bearer_token":
        return ["bearer_token" as const];
      case "client_secret_post":
        return ["client_secret_post" as const];
      case "private_key_jwt":
        return ["private_key_jwt" as const];
      default:
        return [];
    }
  });

  return mapped.length > 0 ? unique(mapped) : [...DEFAULT_TOKEN_AUTH_METHODS];
}

function mapConfigurationAuthentication(
  methods: AgentConfiguration["token_endpoint_auth_methods_supported"],
): string[] {
  if (methods.length === 0) {
    return ["none"];
  }

  return unique(
    methods.map((method) => {
      switch (method) {
        case "bearer_token":
          return "bearer";
        default:
          return method;
      }
    }),
  );
}

function endpoint(
  url: string,
  methods: DiscoveryEndpoint["methods"],
  auth: DiscoveryEndpoint["auth"],
  description: string,
): DiscoveryEndpoint {
  return {
    url,
    methods,
    auth,
    description,
    rate_limited: true,
  };
}

function normalizeIdentifier(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "default";
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
