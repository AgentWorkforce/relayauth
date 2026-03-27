export class RelayAuthError extends Error {
  constructor(
    message: string,
    public code: string,
    public statusCode?: number,
  ) {
    super(message);
    this.name = "RelayAuthError";
  }
}

export class TokenExpiredError extends RelayAuthError {
  constructor() {
    super("Token has expired", "token_expired", 401);
    this.name = "TokenExpiredError";
  }
}

export class TokenRevokedError extends RelayAuthError {
  constructor() {
    super("Token has been revoked", "token_revoked", 401);
    this.name = "TokenRevokedError";
  }
}

export class InsufficientScopeError extends RelayAuthError {
  constructor(required: string, actual: string[]) {
    super(
      `Insufficient scope: requires ${required}, has [${actual.join(", ")}]`,
      "insufficient_scope",
      403,
    );
    this.name = "InsufficientScopeError";
  }
}

export class InvalidScopeError extends RelayAuthError {
  constructor(scope: string, reason?: string) {
    super(
      reason ? `Invalid scope "${scope}": ${reason}` : `Invalid scope "${scope}"`,
      "invalid_scope",
      400,
    );
    this.name = "InvalidScopeError";
  }
}

export class IdentityNotFoundError extends RelayAuthError {
  constructor(id: string) {
    super(`Identity not found: ${id}`, "identity_not_found", 404);
    this.name = "IdentityNotFoundError";
  }
}

export class IdentitySuspendedError extends RelayAuthError {
  constructor(id: string) {
    super(`Identity suspended: ${id}`, "identity_suspended", 403);
    this.name = "IdentitySuspendedError";
  }
}
