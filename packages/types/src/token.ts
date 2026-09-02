export interface TokenBudget {
  maxActionsPerHour?: number;
  maxCostPerDay?: number;
  remaining?: number;
}

export interface RelayAuthWorkspaceScope {
  product_id: string;
  scopes: string[];
}

export interface RelayAuthTokenClaims {
  sub: string;
  org: string;
  wks: string;
  /** @deprecated Duplicates `wks` — prefer using `wks` directly */
  workspace_id?: string;
  /** @deprecated Duplicates `sub` — prefer using `sub` directly */
  agent_name?: string;
  scopes: string[];
  /** Optional, additive product narrowing. Consumer enforcement happens downstream. */
  product_id?: string;
  /** Optional, additive richer narrowing for future use. Consumer enforcement happens downstream. */
  workspace_scope?: RelayAuthWorkspaceScope[];
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

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string;
  tokenType: "Bearer";
}

export interface IdentityTokenIssueRequest {
  identityId: string;
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
  /** TTL in seconds for the refresh token. Defaults to 24h; max 90 days. */
  refreshTokenTtlSeconds?: number;
}

export interface WorkspaceTokenIssueRequest {
  workspaceId: string;
  name?: string;
  scopes?: string[];
}

export interface WorkspaceToken {
  id: string;
  kind: "workspace_token";
  workspaceId: string;
  prefix: string;
  name: string;
  scopes: string[];
  createdAt: string;
  revoked: boolean;
}

export interface WorkspaceTokenIssueResponse {
  workspaceToken: WorkspaceToken;
  key: string;
}

export interface AgentTokenIssueRequest {
  agentId: string;
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
  /**
   * Opt into the durable, read-only, long-lived access-token mode. Defaults to
   * false. A durable token may live up to 90 days but must be workspace-scoped,
   * carry only `relayfile:fs:read:*` scopes, and be minted by a caller granted
   * the `relayauth:token-durable:create:*` capability. Durable mints return an
   * access token only (no refresh token). Back-compat: omit to keep the 1h cap.
   */
  durable?: boolean;
  /**
   * Equivalent opt-in to `durable: true`. Set to `"durable"` to request the
   * durable access-token class.
   */
  accessTokenClass?: "durable";
  /**
   * Opt into an INDEFINITE (never-expiring) durable access token. Implies
   * `durable` (same tight gate: read-only fs scopes, workspace-bound, minted by
   * a `relayauth:token-durable:create:*` caller) and returns an access token
   * only. The key never expires on a timer — it is controlled entirely by
   * revocation (`/v1/tokens/revoke` + the fail-closed denylist). Defaults to
   * false. Use for a pasteable customer credential that must not lapse silently.
   */
  indefinite?: boolean;
}

export interface AgentTokenPair extends Omit<
  TokenPair,
  "refreshToken" | "refreshTokenExpiresAt"
> {
  agentId: string;
  workspaceId: string;
  tokenClass: "relay_ag";
  issuedViaWorkspaceTokenId: string;
  /**
   * Present for standard (refreshable) agent tokens. Durable access tokens are
   * standalone and omit the refresh token — they cannot be rotated.
   */
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

export interface PathTokenIssueRequest {
  agentId?: string;
  agentName?: string;
  workspaceId?: string;
  paths: string[];
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
  ttlSeconds?: number;
  delegationNotAfter?: string;
  /** TTL in seconds for the rotating refresh token. Defaults to 24h; max 90 days. */
  refreshTokenTtlSeconds?: number;
}

export interface PathTokenPair extends TokenPair {
  agentId: string;
  agentName: string;
  workspaceId: string;
  tokenClass: "relay_pa";
  paths: string[];
  delegationNotAfter?: string;
  issuedViaWorkspaceTokenId: string;
}

export type WorkspacePathTokenIssueRequest =
  Omit<PathTokenIssueRequest, "workspaceId"> & {
    workspaceId: string;
  };

export type WorkspacePathTokenPair =
  Omit<PathTokenPair, "issuedViaWorkspaceTokenId">;

export interface JWKSResponse {
  keys: JsonWebKey[];
}
