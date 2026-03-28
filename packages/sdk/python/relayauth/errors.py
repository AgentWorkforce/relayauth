from __future__ import annotations


class RelayAuthError(Exception):
    def __init__(self, message: str, code: str, status_code: int | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.status_code = status_code


class TokenExpiredError(RelayAuthError):
    def __init__(self) -> None:
        super().__init__("Token has expired", "token_expired", 401)


class TokenRevokedError(RelayAuthError):
    def __init__(self) -> None:
        super().__init__("Token has been revoked", "token_revoked", 401)


class InsufficientScopeError(RelayAuthError):
    def __init__(self, required: str, actual: list[str]) -> None:
        super().__init__(
            f"Insufficient scope: requires {required}, has [{', '.join(actual)}]",
            "insufficient_scope",
            403,
        )
        self.required = required
        self.actual = list(actual)


class InvalidScopeError(RelayAuthError):
    def __init__(self, scope: str, reason: str | None = None) -> None:
        message = f'Invalid scope "{scope}"'
        if reason:
            message = f"{message}: {reason}"
        super().__init__(message, "invalid_scope", 400)
        self.scope = scope


class IdentityNotFoundError(RelayAuthError):
    def __init__(self, identity_id: str) -> None:
        super().__init__(f"Identity not found: {identity_id}", "identity_not_found", 404)
        self.identity_id = identity_id


class IdentitySuspendedError(RelayAuthError):
    def __init__(self, identity_id: str) -> None:
        super().__init__(f"Identity suspended: {identity_id}", "identity_suspended", 403)
        self.identity_id = identity_id
