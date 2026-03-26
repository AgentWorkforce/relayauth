import type { Action, Plane } from "./scope.js";

export type GrantType =
  | "client_credentials"
  | "refresh_token"
  | "urn:ietf:params:oauth:grant-type:token-exchange"
  | "urn:relayauth:params:oauth:grant-type:delegation";

export type EndpointAuthMode =
  | "none"
  | "bearer_token"
  | "client_secret_post"
  | "private_key_jwt";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type TokenSigningAlgorithm = "RS256" | "EdDSA";

export type ScopePathSchemaType =
  | "wildcard"
  | "fs_path"
  | "channel"
  | "identifier"
  | "constraint";

export interface DiscoveryEndpoint {
  url: string;
  methods: HttpMethod[];
  auth: EndpointAuthMode;
  description: string;
  rate_limited?: boolean;
}

export interface ScopePathSchema {
  type: ScopePathSchemaType;
  required: boolean;
  wildcard_allowed: boolean;
  description: string;
  examples?: string[];
}

export interface ScopeDefinition {
  name: string;
  plane: Plane | "*" | (string & {});
  resource: string;
  pattern: string;
  actions: Action[];
  path_schema: ScopePathSchema;
  description: string;
  examples: string[];
}

export interface ScopeFormatDescription {
  pattern: "{plane}:{resource}:{action}:{path?}";
  separator: ":";
  path_optional: boolean;
  wildcard: "*";
  planes: Array<Plane | (string & {})>;
  actions: Action[];
  notes?: string[];
}

export interface SponsorChainConfiguration {
  required: boolean;
  propagated_in_tokens: boolean;
  propagated_in_audit: boolean;
  /** Must be a positive integer (≥ 1). */
  max_depth?: number | null;
}

export interface ScopeDelegationConfiguration {
  enabled: boolean;
  mode: "intersection" | "explicit_subset";
  escalation_policy: "hard_error" | "silent_deny" | "audit_only";
  /** Must be a positive integer (≥ 1). */
  max_depth?: number | null;
}

export interface BudgetCapabilities {
  enabled: boolean;
  supported_limits: Array<
    "maxActionsPerHour" | "maxCostPerDay" | "alertThreshold" | "autoSuspend"
  >;
  alert_webhook_supported: boolean;
  auto_suspend_supported: boolean;
}

export interface TokenLifetimeConfiguration {
  access_token_default: string;
  refresh_token_default: string;
  maximum: string;
  permanent_tokens_allowed: boolean;
}

export interface AgentConfiguration {
  schema_version: string;
  issuer: string;
  server_version?: string;
  service_name?: string;
  documentation_url?: string;
  jwks_uri: string;
  token_endpoint: string;
  identity_endpoint: string;
  scopes_endpoint?: string;
  revocation_endpoint?: string;
  introspection_endpoint?: string;
  scope_templates_endpoint?: string;
  capabilities?: string[];
  grant_types_supported: GrantType[];
  token_endpoint_auth_methods_supported: EndpointAuthMode[];
  token_signing_alg_values_supported: TokenSigningAlgorithm[];
  scope_format: ScopeFormatDescription;
  scope_definitions: ScopeDefinition[];
  sponsor_required: boolean;
  sponsor_chain?: SponsorChainConfiguration;
  scope_delegation: ScopeDelegationConfiguration;
  budgets: BudgetCapabilities;
  token_lifetimes: TokenLifetimeConfiguration;
  endpoints: Record<string, DiscoveryEndpoint>;
}
