export interface TokenBudget {
  maxActionsPerHour?: number;
  maxCostPerDay?: number;
  remaining?: number;
}

export interface RelayAuthTokenClaims {
  sub: string;
  org: string;
  wks: string;
  workspace_id?: string;
  agent_name?: string;
  scopes: string[];
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
