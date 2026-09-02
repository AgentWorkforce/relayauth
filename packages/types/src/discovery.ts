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

export interface AccessTokenClassLifetime {
  /** ISO-8601 duration ceiling for this access-token class. */
  access_token_maximum: string;
  /** Whether tokens of this class can be rotated via the refresh endpoint. */
  refreshable: boolean;
  /** Whether tokens of this class are restricted to read-only scopes. */
  read_only?: boolean;
  /**
   * Whether this class also supports indefinite (never-expiring) tokens, in
   * addition to bounded lifetimes up to `access_token_maximum`.
   */
  indefinite_supported?: boolean;
  /**
   * Whether tokens of this class are controlled by revocation (a fail-closed
   * denylist) rather than (or in addition to) a timer. Always true for classes
   * that support indefinite tokens.
   */
  revocation_controlled?: boolean;
}

export interface TokenLifetimeConfiguration {
  access_token_default: string;
  refresh_token_default: string;
  /**
   * Maximum lifetime for BOUNDED access tokens. This is NOT an absolute ceiling
   * across all tokens: a class advertising `indefinite_supported: true` (e.g.
   * `durable`) issues never-expiring tokens whose `exp` is far past `maximum` by
   * design. Clients MUST NOT clamp or reject a token solely because its `exp`
   * exceeds `maximum` — consult the per-class metadata in `access_token_classes`
   * (`indefinite_supported`) instead. For such tokens, revocation, not expiry, is
   * the control.
   */
  maximum: string;
  permanent_tokens_allowed: boolean;
  /**
   * Optional per-class lifetime ceilings. Advertises that some classes (e.g.
   * `durable`) permit a longer ceiling than the standard `agent` access token —
   * or, when `indefinite_supported` is true, never-expiring tokens that exceed
   * `maximum` entirely — so discovery-driven clients do not clamp or reject a
   * valid long-lived / indefinite request.
   */
  access_token_classes?: Record<string, AccessTokenClassLifetime>;
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
  /**
   * GET endpoint verifiers poll with `?jti=` to learn a token's revocation
   * state (`{ revoked: boolean }`). Distinct from `revocation_endpoint`, which
   * is the authenticated POST that *performs* a revocation (RFC 7009 style).
   */
  revocation_check_endpoint?: string;
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
