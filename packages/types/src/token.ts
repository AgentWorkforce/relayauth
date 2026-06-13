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
}

export interface AgentTokenPair extends TokenPair {
  agentId: string;
  workspaceId: string;
  tokenClass: "relay_ag";
  issuedViaWorkspaceTokenId: string;
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
  delegationNotAfter?: string | number;
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
