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

export interface JWKSResponse {
  keys: JsonWebKey[];
}
