from __future__ import annotations

import dataclasses
import inspect
import json
import time
from typing import Any

import jwt
import pytest
import respx
from cryptography.hazmat.primitives.asymmetric import rsa
from jwt.algorithms import RSAAlgorithm

from relayauth import RelayAuthClient, RelayAuthError, TokenExpiredError, TokenVerifier
from relayauth.scopes import match_scope

try:
    from relayauth import VerifyOptions
except ImportError:  # pragma: no cover - implementation detail
    VerifyOptions = None  # type: ignore[assignment]


BASE_URL = "https://relay.example.test"
JWKS_URL = f"{BASE_URL}/.well-known/jwks.json"
AUTH_TOKEN = "sdk_test_token"
NOW = 1_774_432_800


def _to_mapping(value: Any) -> dict[str, Any]:
    if dataclasses.is_dataclass(value):
        return dataclasses.asdict(value)
    if isinstance(value, dict):
        return value
    return {
        name: getattr(value, name)
        for name in dir(value)
        if not name.startswith("_") and not callable(getattr(value, name))
    }


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def _get_method(instance: Any, *names: str) -> Any:
    for name in names:
        candidate = getattr(instance, name, None)
        if candidate is not None:
            return candidate
    raise AttributeError(f"None of the methods exist: {', '.join(names)}")


async def _call_create_identity(client: Any, org_id: str, payload: dict[str, Any]) -> Any:
    method = _get_method(client, "create_identity", "createIdentity")
    try:
        return await _maybe_await(method(org_id, payload))
    except TypeError:
        return await _maybe_await(method(org_id, **payload))


async def _call_get_identity(client: Any, identity_id: str) -> Any:
    return await _maybe_await(
        _get_method(client, "get_identity", "getIdentity")(identity_id)
    )


async def _call_issue_token(client: Any, identity_id: str, payload: dict[str, Any]) -> Any:
    method = _get_method(client, "issue_token", "issueToken")
    try:
        return await _maybe_await(method(identity_id, payload))
    except TypeError:
        return await _maybe_await(method(identity_id, **payload))


async def _call_revoke_token(client: Any, token_id: str) -> Any:
    return await _maybe_await(
        _get_method(client, "revoke_token", "revokeToken")(token_id)
    )


def _make_verify_options(**kwargs: Any) -> Any:
    snake = {
        "jwks_url": kwargs.get("jwks_url"),
        "issuer": kwargs.get("issuer"),
        "audience": kwargs.get("audience"),
        "max_age": kwargs.get("max_age"),
        "cache_ttl_ms": kwargs.get("cache_ttl_ms"),
        "check_revocation": kwargs.get("check_revocation"),
        "revocation_url": kwargs.get("revocation_url"),
    }
    camel = {
        "jwksUrl": kwargs.get("jwks_url"),
        "issuer": kwargs.get("issuer"),
        "audience": kwargs.get("audience"),
        "maxAge": kwargs.get("max_age"),
        "cacheTtlMs": kwargs.get("cache_ttl_ms"),
        "checkRevocation": kwargs.get("check_revocation"),
        "revocationUrl": kwargs.get("revocation_url"),
    }

    if VerifyOptions is None:
        return None

    for candidate in (snake, camel):
        compact = {key: value for key, value in candidate.items() if value is not None}
        try:
            return VerifyOptions(**compact)
        except TypeError:
            continue

    return None


def _create_verifier(**kwargs: Any) -> TokenVerifier:
    options = _make_verify_options(**kwargs)
    if options is not None:
        try:
            return TokenVerifier(options)
        except TypeError:
            pass
        try:
            return TokenVerifier(options=options)
        except TypeError:
            pass

    snake = {
        "jwks_url": kwargs.get("jwks_url"),
        "issuer": kwargs.get("issuer"),
        "audience": kwargs.get("audience"),
        "max_age": kwargs.get("max_age"),
        "cache_ttl_ms": kwargs.get("cache_ttl_ms"),
        "check_revocation": kwargs.get("check_revocation"),
        "revocation_url": kwargs.get("revocation_url"),
    }
    camel = {
        "jwksUrl": kwargs.get("jwks_url"),
        "issuer": kwargs.get("issuer"),
        "audience": kwargs.get("audience"),
        "maxAge": kwargs.get("max_age"),
        "cacheTtlMs": kwargs.get("cache_ttl_ms"),
        "checkRevocation": kwargs.get("check_revocation"),
        "revocationUrl": kwargs.get("revocation_url"),
    }

    for candidate in (snake, camel):
        compact = {key: value for key, value in candidate.items() if value is not None}
        try:
            return TokenVerifier(**compact)
        except TypeError:
            continue

    return TokenVerifier(snake)


def _create_client(**kwargs: Any) -> RelayAuthClient:
    snake = {
        "base_url": kwargs["base_url"],
        "api_key": kwargs.get("api_key"),
        "token": kwargs.get("token"),
    }
    camel = {
        "baseUrl": kwargs["base_url"],
        "apiKey": kwargs.get("api_key"),
        "token": kwargs.get("token"),
    }

    for candidate in (snake, camel):
        compact = {key: value for key, value in candidate.items() if value is not None}
        try:
            return RelayAuthClient(**compact)
        except TypeError:
            continue

    for candidate in (snake, camel):
        compact = {key: value for key, value in candidate.items() if value is not None}
        try:
            return RelayAuthClient(compact)
        except TypeError:
            continue

    return RelayAuthClient(camel)


def _generate_rsa_keypair() -> tuple[Any, dict[str, Any]]:
    private_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    public_key = private_key.public_key()
    jwk = json.loads(RSAAlgorithm.to_jwk(public_key))
    jwk.update({"kid": "test-key", "alg": "RS256", "use": "sig"})
    return private_key, jwk


def _claims(**overrides: Any) -> dict[str, Any]:
    claims = {
        "sub": "agent_123",
        "org": "org_123",
        "wks": "ws_123",
        "scopes": ["relayauth:identity:read:*", "relayfile:fs:write:/src/*"],
        "sponsorId": "user_123",
        "sponsorChain": ["user_123", "svc_gateway"],
        "token_type": "access",
        "iss": "https://issuer.example.test",
        "aud": ["relay-api", "worker-runtime"],
        "exp": NOW + 3600,
        "iat": NOW,
        "jti": "jti_123",
        "nbf": NOW - 5,
        "sid": "sid_123",
        "meta": {"env": "test"},
        "parentTokenId": "parent_jti_123",
        "budget": {
            "maxActionsPerHour": 500,
            "maxCostPerDay": 25,
            "remaining": 412,
        },
    }
    claims.update(overrides)
    return claims


def _issue_token(private_key: Any, claims: dict[str, Any]) -> str:
    return jwt.encode(
        claims,
        private_key,
        algorithm="RS256",
        headers={"kid": "test-key", "typ": "JWT"},
    )


@pytest.fixture()
def rsa_material() -> tuple[Any, dict[str, Any]]:
    return _generate_rsa_keypair()


@pytest.fixture()
def identity_payload() -> dict[str, Any]:
    return {
        "id": "agent_123",
        "name": "billing-bot",
        "type": "agent",
        "orgId": "org_123",
        "status": "active",
        "scopes": ["relayauth:identity:read:*"],
        "roles": ["role_admin"],
        "metadata": {"team": "ops"},
        "createdAt": "2026-03-25T10:00:00.000Z",
        "updatedAt": "2026-03-25T10:00:00.000Z",
    }


@pytest.fixture(autouse=True)
def fixed_time(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(time, "time", lambda: float(NOW))


@pytest.mark.asyncio
@respx.mock
async def test_verify_valid_token(rsa_material: tuple[Any, dict[str, Any]]) -> None:
    private_key, jwk = rsa_material
    token = _issue_token(private_key, _claims())
    route = respx.get(JWKS_URL).mock(
        return_value=httpx_response(200, {"keys": [jwk]}),
    )
    verifier = _create_verifier(
        jwks_url=JWKS_URL,
        issuer="https://issuer.example.test",
        audience=["relay-api"],
        cache_ttl_ms=60_000,
    )

    claims = await _maybe_await(verifier.verify(token))

    result = _to_mapping(claims)
    assert result["sub"] == "agent_123"
    assert result["org"] == "org_123"
    assert result["aud"] == ["relay-api", "worker-runtime"]
    assert result["token_type"] == "access"
    assert result["budget"]["remaining"] == 412
    assert route.call_count == 1


@pytest.mark.asyncio
@respx.mock
async def test_verify_expired_token(rsa_material: tuple[Any, dict[str, Any]]) -> None:
    private_key, jwk = rsa_material
    expired = _issue_token(private_key, _claims(exp=NOW - 1))
    respx.get(JWKS_URL).mock(return_value=httpx_response(200, {"keys": [jwk]}))
    verifier = _create_verifier(
        jwks_url=JWKS_URL,
        issuer="https://issuer.example.test",
        audience=["relay-api"],
    )

    with pytest.raises(TokenExpiredError):
        await _maybe_await(verifier.verify(expired))


@pytest.mark.asyncio
@respx.mock
async def test_verify_invalid_signature(rsa_material: tuple[Any, dict[str, Any]]) -> None:
    _, jwk = rsa_material
    wrong_private_key, _ = _generate_rsa_keypair()
    tampered = _issue_token(wrong_private_key, _claims())
    respx.get(JWKS_URL).mock(return_value=httpx_response(200, {"keys": [jwk]}))
    verifier = _create_verifier(
        jwks_url=JWKS_URL,
        issuer="https://issuer.example.test",
        audience=["relay-api"],
    )

    with pytest.raises(RelayAuthError) as exc_info:
        await _maybe_await(verifier.verify(tampered))

    assert getattr(exc_info.value, "code", None) == "invalid_token"


@pytest.mark.asyncio
@respx.mock
async def test_verify_wrong_audience(rsa_material: tuple[Any, dict[str, Any]]) -> None:
    private_key, jwk = rsa_material
    token = _issue_token(private_key, _claims(aud=["different-service"]))
    respx.get(JWKS_URL).mock(return_value=httpx_response(200, {"keys": [jwk]}))
    verifier = _create_verifier(
        jwks_url=JWKS_URL,
        issuer="https://issuer.example.test",
        audience=["relay-api"],
    )

    with pytest.raises(RelayAuthError) as exc_info:
        await _maybe_await(verifier.verify(token))

    assert getattr(exc_info.value, "code", None) == "invalid_token"


@pytest.mark.asyncio
@respx.mock
async def test_jwks_caching(rsa_material: tuple[Any, dict[str, Any]]) -> None:
    private_key, jwk = rsa_material
    token = _issue_token(private_key, _claims())
    route = respx.get(JWKS_URL).mock(
        return_value=httpx_response(200, {"keys": [jwk]}),
    )
    verifier = _create_verifier(
        jwks_url=JWKS_URL,
        issuer="https://issuer.example.test",
        audience=["relay-api"],
        cache_ttl_ms=300_000,
    )

    first = await _maybe_await(verifier.verify(token))
    second = await _maybe_await(verifier.verify(token))

    assert _to_mapping(first)["jti"] == "jti_123"
    assert _to_mapping(second)["jti"] == "jti_123"
    assert route.call_count == 1


def test_scope_matching() -> None:
    granted = ["relayauth:*:manage:*", "relayfile:fs:write:/src/*"]

    assert match_scope("relayauth:identity:read:*", granted) is True
    assert match_scope("relayauth:token:create:*", granted) is True
    assert match_scope("relayfile:fs:write:/src/api/app.py", granted) is True
    assert match_scope("relayfile:fs:write:/etc/passwd", granted) is False
    assert match_scope("cloud:workflow:run:*", granted) is False


@pytest.mark.asyncio
@respx.mock
async def test_client_create_identity(identity_payload: dict[str, Any]) -> None:
    route = respx.post(f"{BASE_URL}/v1/identities").mock(
        return_value=httpx_response(201, identity_payload),
    )
    client = _create_client(base_url=BASE_URL, token=AUTH_TOKEN)
    payload = {
        "name": "billing-bot",
        "type": "service",
        "scopes": ["relayauth:identity:read:*"],
        "roles": ["role_admin"],
        "metadata": {"team": "ops"},
        "workspaceId": "ws_123",
    }

    created = await _call_create_identity(client, "org_123", payload)

    assert _to_mapping(created) == identity_payload
    assert route.called
    request = route.calls.last.request
    assert request.method == "POST"
    assert request.headers["authorization"] == f"Bearer {AUTH_TOKEN}"
    assert request.headers["content-type"].startswith("application/json")
    assert json.loads(request.content.decode("utf-8")) == {"orgId": "org_123", **payload}


@pytest.mark.asyncio
@respx.mock
async def test_client_get_identity(identity_payload: dict[str, Any]) -> None:
    route = respx.get(f"{BASE_URL}/v1/identities/agent_123").mock(
        return_value=httpx_response(200, identity_payload),
    )
    client = _create_client(base_url=BASE_URL, token=AUTH_TOKEN)

    identity = await _call_get_identity(client, "agent_123")

    assert _to_mapping(identity) == identity_payload
    assert route.called
    request = route.calls.last.request
    assert request.method == "GET"
    assert request.headers["authorization"] == f"Bearer {AUTH_TOKEN}"


@pytest.mark.asyncio
@respx.mock
async def test_client_issue_token() -> None:
    token_pair = {
        "accessToken": "access_token_123",
        "refreshToken": "refresh_token_123",
        "accessTokenExpiresAt": "2026-03-25T11:00:00.000Z",
        "refreshTokenExpiresAt": "2026-04-01T10:00:00.000Z",
        "tokenType": "Bearer",
    }
    route = respx.post(f"{BASE_URL}/v1/tokens").mock(
        return_value=httpx_response(201, token_pair),
    )
    client = _create_client(base_url=BASE_URL, token=AUTH_TOKEN)

    issued = await _call_issue_token(
        client,
        "agent_123",
        {
            "scopes": ["relayauth:identity:read:*", "relayauth:token:manage:*"],
            "audience": ["relay-api", "worker-runtime"],
            "expiresIn": 3600,
        },
    )

    assert _to_mapping(issued) == token_pair
    assert route.called
    request = route.calls.last.request
    assert request.method == "POST"
    assert request.headers["authorization"] == f"Bearer {AUTH_TOKEN}"
    assert json.loads(request.content.decode("utf-8")) == {
        "identityId": "agent_123",
        "scopes": ["relayauth:identity:read:*", "relayauth:token:manage:*"],
        "audience": ["relay-api", "worker-runtime"],
        "expiresIn": 3600,
    }


@pytest.mark.asyncio
@respx.mock
async def test_client_revoke_token() -> None:
    route = respx.post(f"{BASE_URL}/v1/tokens/revoke").mock(
        return_value=httpx_response(204, None),
    )
    client = _create_client(base_url=BASE_URL, token=AUTH_TOKEN)

    result = await _call_revoke_token(client, "tok_123")

    assert result is None
    assert route.called
    request = route.calls.last.request
    assert request.method == "POST"
    assert request.headers["authorization"] == f"Bearer {AUTH_TOKEN}"
    assert json.loads(request.content.decode("utf-8")) == {"tokenId": "tok_123"}


def httpx_response(status_code: int, payload: Any) -> Any:
    import httpx

    if payload is None:
        return httpx.Response(status_code=status_code)

    return httpx.Response(status_code=status_code, json=payload)
