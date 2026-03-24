export interface RelayAuthTokenClaims {
  sub: string;
  org: string;
  wks: string;
  scopes: string[];
  iss: string;
  aud: string[];
  exp: number;
  iat: number;
  jti: string;
  sid?: string;
  meta?: Record<string, string>;
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
