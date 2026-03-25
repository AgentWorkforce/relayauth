from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Any

import httpx
import jwt

from .errors import InsufficientScopeError, RelayAuthError, TokenExpiredError, TokenRevokedError
from .scopes import match_scope
from .types import Claims

DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000


@dataclass(slots=True)
class VerifyOptions:
    jwks_url: str | None = None
    issuer: str | None = None
    audience: list[str] | None = None
    max_age: int | None = None
    cache_ttl_ms: int | None = None
    check_revocation: bool = False
    revocation_url: str | None = None


def _invalid_token_error() -> RelayAuthError:
    return RelayAuthError("Invalid access token", "invalid_token", 401)


def _normalize_verify_options(
    options: VerifyOptions | dict[str, Any] | None = None,
    **kwargs: Any,
) -> VerifyOptions:
    if isinstance(options, VerifyOptions):
        base = {
            "jwks_url": options.jwks_url,
            "issuer": options.issuer,
            "audience": options.audience,
            "max_age": options.max_age,
            "cache_ttl_ms": options.cache_ttl_ms,
            "check_revocation": options.check_revocation,
            "revocation_url": options.revocation_url,
        }
    elif isinstance(options, dict):
        base = dict(options)
    elif options is None:
        base = {}
    else:
        raise TypeError("options must be VerifyOptions, dict, or None")

    merged = {**base, **kwargs}
    return VerifyOptions(
        jwks_url=merged.get("jwks_url", merged.get("jwksUrl")),
        issuer=merged.get("issuer"),
        audience=_normalize_string_list(merged.get("audience")),
        max_age=_normalize_optional_int(merged.get("max_age", merged.get("maxAge"))),
        cache_ttl_ms=_normalize_optional_int(merged.get("cache_ttl_ms", merged.get("cacheTtlMs"))),
        check_revocation=bool(
            merged.get("check_revocation", merged.get("checkRevocation", False))
        ),
        revocation_url=merged.get("revocation_url", merged.get("revocationUrl")),
    )


def _normalize_string_list(value: Any) -> list[str] | None:
    if value is None:
        return None
    return [str(item) for item in value]


def _normalize_optional_int(value: Any) -> int | None:
    if value is None:
        return None
    return int(value)


def _normalize_cache_ttl_ms(value: int | None) -> int:
    if value is None:
        return DEFAULT_CACHE_TTL_MS
    return max(0, int(value))


def _is_supported_algorithm(algorithm: str | None) -> bool:
    return algorithm in {"RS256", "EdDSA"}


def _select_jwk(keys: list[dict[str, Any]], kid: str | None, alg: str | None) -> dict[str, Any] | None:
    matches = [key for key in keys if _matches_jwk(key, kid, alg)]
    if kid:
        return matches[0] if matches else None
    return matches[0] if len(matches) == 1 else None


def _matches_jwk(key: dict[str, Any], kid: str | None, alg: str | None) -> bool:
    if kid and key.get("kid") != kid:
        return False
    if alg and key.get("alg") and key.get("alg") != alg:
        return False
    if key.get("use") and key.get("use") != "sig":
        return False
    if alg == "RS256":
        return key.get("kty") == "RSA"
    if alg == "EdDSA":
        return key.get("kty") == "OKP" and key.get("crv") == "Ed25519"
    return False


class TokenVerifier:
    def __init__(self, options: VerifyOptions | dict[str, Any] | None = None, **kwargs: Any) -> None:
        self.options = _normalize_verify_options(options, **kwargs)
        self._jwks_cache: dict[str, Any] | None = None

    async def verify(self, token: str) -> Claims:
        try:
            header = jwt.get_unverified_header(token)
        except jwt.InvalidTokenError as exc:
            raise _invalid_token_error() from exc

        algorithm = header.get("alg")
        if header.get("typ") != "JWT" or not _is_supported_algorithm(algorithm):
            raise _invalid_token_error()

        jwk = await self._find_key(header.get("kid"), algorithm)

        try:
            pyjwk = jwt.PyJWK.from_dict(jwk, algorithm=algorithm)

            decode_options: dict[str, Any] = {
                "verify_signature": True,
                "verify_exp": True,
                "verify_nbf": True,
                "verify_iat": True,
                "verify_aud": bool(self.options.audience),
                "verify_iss": bool(self.options.issuer),
            }

            decode_kwargs: dict[str, Any] = {
                "algorithms": [algorithm],
                "options": decode_options,
                "leeway": 30,
            }
            if self.options.audience:
                decode_kwargs["audience"] = self.options.audience
            if self.options.issuer:
                decode_kwargs["issuer"] = self.options.issuer

            payload = jwt.decode(
                token,
                key=pyjwk.key,
                **decode_kwargs,
            )
        except jwt.ExpiredSignatureError as exc:
            raise TokenExpiredError() from exc
        except jwt.InvalidSignatureError as exc:
            raise _invalid_token_error() from exc
        except jwt.InvalidTokenError as exc:
            raise _invalid_token_error() from exc

        claims = self._validate_claims(payload)

        if self.options.check_revocation:
            await self._check_revocation(claims.jti)

        return claims

    async def verify_and_check_scope(self, token: str, required_scope: str) -> Claims:
        claims = await self.verify(token)
        if not match_scope(required_scope, claims.scopes):
            raise InsufficientScopeError(required_scope, claims.scopes)
        return claims

    async def verify_or_null(self, token: str) -> Claims | None:
        try:
            return await self.verify(token)
        except RelayAuthError:
            return None

    async def _fetch_jwks(self, force_refresh: bool = False) -> dict[str, list[dict[str, Any]]]:
        jwks_url = self.options.jwks_url
        if not jwks_url:
            raise RelayAuthError("JWKS URL is required", "missing_jwks_url", 500)

        now_ms = int(time.time() * 1000)
        if (
            not force_refresh
            and self._jwks_cache is not None
            and int(self._jwks_cache["expires_at"]) > now_ms
        ):
            return {"keys": list(self._jwks_cache["keys"])}

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(jwks_url)
        except httpx.HTTPError as exc:
            raise RelayAuthError("Failed to fetch JWKS", "jwks_fetch_failed", 502) from exc

        if response.status_code >= 400:
            raise RelayAuthError(
                "Failed to fetch JWKS",
                "jwks_fetch_failed",
                response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise RelayAuthError("Invalid JWKS response", "invalid_jwks", 502) from exc

        if not isinstance(payload, dict) or not isinstance(payload.get("keys"), list):
            raise RelayAuthError("Invalid JWKS response", "invalid_jwks", 502)

        self._jwks_cache = {
            "expires_at": now_ms + _normalize_cache_ttl_ms(self.options.cache_ttl_ms),
            "keys": list(payload["keys"]),
        }
        return {"keys": list(self._jwks_cache["keys"])}

    async def _find_key(self, kid: str | None, alg: str | None) -> dict[str, Any]:
        keys = (await self._fetch_jwks()).get("keys", [])
        key = _select_jwk(keys, kid, alg)
        if key is None:
            refreshed = await self._fetch_jwks(force_refresh=True)
            key = _select_jwk(refreshed.get("keys", []), kid, alg)

        if key is None:
            raise _invalid_token_error()

        return key

    def _validate_claims(self, payload: Any) -> Claims:
        try:
            claims = Claims.from_dict(payload)
        except (KeyError, TypeError, ValueError) as exc:
            raise _invalid_token_error() from exc

        now = int(time.time())
        leeway = 30

        if claims.nbf is not None and claims.nbf > now + leeway:
            raise _invalid_token_error()
        if claims.exp <= now - leeway:
            raise TokenExpiredError()
        if self.options.issuer and claims.iss != self.options.issuer:
            raise _invalid_token_error()
        if self.options.audience and not any(aud in claims.aud for aud in self.options.audience):
            raise _invalid_token_error()
        if self.options.max_age is not None and claims.iat + self.options.max_age < now - leeway:
            raise TokenExpiredError()

        return claims

    async def _check_revocation(self, jti: str) -> None:
        revocation_url = self.options.revocation_url
        if not revocation_url:
            raise RelayAuthError("Revocation URL is required", "missing_revocation_url", 500)

        try:
            async with httpx.AsyncClient() as client:
                response = await client.get(revocation_url, params={"jti": jti})
        except httpx.HTTPError as exc:
            raise RelayAuthError(
                "Failed to check token revocation",
                "revocation_check_failed",
                502,
            ) from exc

        if response.status_code >= 400:
            raise RelayAuthError(
                "Failed to check token revocation",
                "revocation_check_failed",
                response.status_code,
            )

        try:
            payload = response.json()
        except ValueError as exc:
            raise RelayAuthError(
                "Invalid revocation response",
                "invalid_revocation_response",
                502,
            ) from exc

        if not isinstance(payload, dict):
            raise RelayAuthError("Invalid revocation response", "invalid_revocation_response", 502)

        if payload.get("revoked") is True:
            raise TokenRevokedError()
