import type { ParsedScope, RelayAuthTokenClaims } from "@relayauth/types";

import { InsufficientScopeError } from "./errors.js";
import { matchScope, matchesAny } from "./scope-matcher.js";
import { parseScopes } from "./scope-parser.js";

export class ScopeChecker {
  readonly grantedScopes: string[];
  readonly parsedScopes: ParsedScope[];

  constructor(grantedScopes: string[]) {
    this.grantedScopes = [...grantedScopes];
    this.parsedScopes = parseScopes(this.grantedScopes);
  }

  check(scope: string): boolean {
    return matchScope(scope, this.grantedScopes);
  }

  require(scope: string): void {
    if (!this.check(scope)) {
      throw new InsufficientScopeError(scope, this.grantedScopes);
    }
  }

  checkAll(scopes: string[]): boolean {
    return matchesAny(scopes, this.grantedScopes).denied.length === 0;
  }

  checkAny(scopes: string[]): boolean {
    return matchesAny(scopes, this.grantedScopes).matched.length > 0;
  }

  effectiveScopes(): ParsedScope[] {
    return this.parsedScopes.map((scope) => ({ ...scope }));
  }

  static fromToken(claims: Pick<RelayAuthTokenClaims, "scopes">): ScopeChecker {
    return new ScopeChecker(claims.scopes);
  }
}
