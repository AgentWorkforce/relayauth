from __future__ import annotations

import dataclasses
import json
from typing import Any
from urllib.parse import quote, urljoin

import httpx

from .errors import (
    IdentityNotFoundError,
    IdentitySuspendedError,
    InsufficientScopeError,
    InvalidScopeError,
    RelayAuthError,
    TokenExpiredError,
    TokenRevokedError,
)
from .types import (
    AgentIdentity,
    AuditEntry,
    AuditQuery,
    CreateIdentityInput,
    RelayAuthTokenClaims,
    Role,
    TokenPair,
)


def _normalize_base_url(base_url: str) -> str:
    return base_url if base_url.endswith("/") else f"{base_url}/"


def _normalize_client_options(options: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
    if options is None:
        merged = dict(kwargs)
    elif isinstance(options, dict):
        merged = {**options, **kwargs}
    else:
        raise TypeError("options must be a dict or None")

    base_url = merged.get("base_url", merged.get("baseUrl"))
    if not base_url:
        raise TypeError("base_url is required")

    return {
        "base_url": str(base_url),
        "api_key": merged.get("api_key", merged.get("apiKey")),
        "token": merged.get("token"),
    }


def _get_string(value: Any, key: str) -> str | None:
    if not isinstance(value, dict):
        return None
    entry = value.get(key)
    return entry if isinstance(entry, str) else None


def _get_string_list(value: Any, key: str) -> list[str]:
    if not isinstance(value, dict):
        return []
    entry = value.get(key)
    return entry if isinstance(entry, list) and all(isinstance(item, str) for item in entry) else []


def _parse_json(value: str) -> Any:
    try:
        return json.loads(value)
    except json.JSONDecodeError:
        return None


def _create_request_error(status: int, payload: Any) -> RelayAuthError:
    error_code = _get_string(payload, "error") or "request_failed"
    message = _get_string(payload, "message") or f"Request failed with status {status}"

    if status == 400 and error_code == "invalid_scope":
        return InvalidScopeError(_get_string(payload, "scope") or "unknown")
    if status == 403 and error_code == "insufficient_scope":
        return InsufficientScopeError(
            _get_string(payload, "required") or "unknown",
            _get_string_list(payload, "actual"),
        )
    if status == 403 and error_code == "identity_suspended":
        return IdentitySuspendedError(_get_string(payload, "identityId") or "unknown")
    if status == 401 and error_code == "token_expired":
        return TokenExpiredError()
    if status == 401 and error_code == "token_revoked":
        return TokenRevokedError()
    if status == 404 and error_code == "identity_not_found":
        return IdentityNotFoundError(_get_string(payload, "identityId") or "unknown")
    return RelayAuthError(message, error_code, status)


def _merge_payload(input_value: Any = None, **kwargs: Any) -> dict[str, Any]:
    if input_value is None:
        return dict(kwargs)
    if isinstance(input_value, dict):
        return {**input_value, **kwargs}
    if dataclasses.is_dataclass(input_value):
        return {**dataclasses.asdict(input_value), **kwargs}
    if hasattr(input_value, "__dict__"):
        return {**vars(input_value), **kwargs}
    raise TypeError("input must be a dict, dataclass-like object, or None")


def _map_identity_page(data: Any) -> dict[str, Any]:
    payload = data if isinstance(data, dict) else {}
    entries = payload.get("data")
    result: dict[str, Any] = {
        "identities": [
            AgentIdentity.from_dict(entry) for entry in entries if isinstance(entry, dict)
        ]
        if isinstance(entries, list)
        else [],
    }
    cursor = _get_string(payload, "cursor")
    if cursor:
        result["cursor"] = cursor
    return result


def _map_audit_page(data: Any) -> dict[str, Any]:
    payload = data if isinstance(data, dict) else {}
    entries = payload.get("entries")
    result: dict[str, Any] = {
        "entries": [
            AuditEntry.from_dict(entry) for entry in entries if isinstance(entry, dict)
        ]
        if isinstance(entries, list)
        else [],
    }
    cursor = _get_string(payload, "nextCursor") or _get_string(payload, "cursor")
    if cursor:
        result["cursor"] = cursor
    return result


def _map_roles(data: Any) -> list[Role]:
    if not isinstance(data, dict):
        return []
    entries = data.get("data")
    if not isinstance(entries, list):
        return []
    return [Role.from_dict(entry) for entry in entries if isinstance(entry, dict)]


class RelayAuthClient:
    def __init__(self, options: dict[str, Any] | None = None, **kwargs: Any) -> None:
        self.options = _normalize_client_options(options, **kwargs)

    async def create_identity(
        self,
        org_id: str,
        input: CreateIdentityInput | dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> AgentIdentity:
        payload = _merge_payload(input, **kwargs)
        payload = {"orgId": org_id, **payload}
        data = await self._request("/v1/identities", method="POST", body=payload)
        return AgentIdentity.from_dict(data)

    async def get_identity(self, identity_id: str) -> AgentIdentity:
        data = await self._request(f"/v1/identities/{quote(identity_id, safe='')}")
        return AgentIdentity.from_dict(data)

    async def list_identities(
        self,
        org_id: str,
        options: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        params = _merge_payload(options, **kwargs)
        params = {"orgId": org_id, **params}
        data = await self._request("/v1/identities", query=params)
        return _map_identity_page(data)

    async def issue_token(
        self,
        identity_id: str,
        options: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> TokenPair:
        payload = _merge_payload(options, **kwargs)
        payload = {"identityId": identity_id, **payload}
        data = await self._request("/v1/tokens", method="POST", body=payload)
        return TokenPair.from_dict(data)

    async def refresh_token(self, refresh_token: str) -> TokenPair:
        data = await self._request(
            "/v1/tokens/refresh",
            method="POST",
            body={"refreshToken": refresh_token},
        )
        return TokenPair.from_dict(data)

    async def revoke_token(self, token_id: str) -> None:
        await self._request("/v1/tokens/revoke", method="POST", body={"tokenId": token_id})
        return None

    async def introspect_token(self, token: str) -> RelayAuthTokenClaims | None:
        data = await self._request("/v1/tokens/introspect", query={"token": token})
        if not isinstance(data, dict):
            return None
        return RelayAuthTokenClaims.from_dict(data)

    async def query_audit(
        self,
        query: AuditQuery | dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        params = _merge_payload(query, **kwargs)
        data = await self._request("/v1/audit", query=params)
        return _map_audit_page(data)

    async def get_identity_activity(
        self,
        identity_id: str,
        options: AuditQuery | dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> dict[str, Any]:
        params = _merge_payload(options, **kwargs)
        data = await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}/activity",
            query=params,
        )
        return _map_audit_page(data)

    async def export_audit(
        self,
        query: AuditQuery | dict[str, Any],
        format: str,
    ) -> str:
        payload = _merge_payload(query, format=format)
        result = await self._request(
            "/v1/audit/export",
            method="POST",
            body=payload,
            response_type="text",
        )
        return str(result)

    async def create_role(self, org_id: str, input: dict[str, Any] | None = None, **kwargs: Any) -> Role:
        payload = _merge_payload(input, **kwargs)
        payload = {"orgId": org_id, **payload}
        data = await self._request("/v1/roles", method="POST", body=payload)
        return Role.from_dict(data)

    async def get_role(self, role_id: str) -> Role:
        data = await self._request(f"/v1/roles/{quote(role_id, safe='')}")
        return Role.from_dict(data)

    async def list_roles(self, org_id: str) -> list[Role]:
        data = await self._request("/v1/roles", query={"orgId": org_id})
        return _map_roles(data)

    async def update_role(self, role_id: str, updates: dict[str, Any] | None = None, **kwargs: Any) -> Role:
        payload = _merge_payload(updates, **kwargs)
        data = await self._request(
            f"/v1/roles/{quote(role_id, safe='')}",
            method="PATCH",
            body=payload,
        )
        return Role.from_dict(data)

    async def delete_role(self, role_id: str) -> None:
        await self._request(f"/v1/roles/{quote(role_id, safe='')}", method="DELETE")
        return None

    async def assign_role(self, identity_id: str, role_id: str) -> None:
        await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}/roles",
            method="POST",
            body={"roleId": role_id},
        )
        return None

    async def remove_role(self, identity_id: str, role_id: str) -> None:
        await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}/roles/{quote(role_id, safe='')}",
            method="DELETE",
        )
        return None

    async def update_identity(
        self,
        identity_id: str,
        updates: CreateIdentityInput | dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> AgentIdentity:
        payload = _merge_payload(updates, **kwargs)
        data = await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}",
            method="PATCH",
            body=payload,
        )
        return AgentIdentity.from_dict(data)

    async def suspend_identity(self, identity_id: str, reason: str) -> AgentIdentity:
        data = await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}/suspend",
            method="POST",
            body={"reason": reason},
        )
        return AgentIdentity.from_dict(data)

    async def reactivate_identity(self, identity_id: str) -> AgentIdentity:
        data = await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}/reactivate",
            method="POST",
        )
        return AgentIdentity.from_dict(data)

    async def retire_identity(self, identity_id: str) -> AgentIdentity:
        data = await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}/retire",
            method="POST",
        )
        return AgentIdentity.from_dict(data)

    async def delete_identity(self, identity_id: str) -> None:
        await self._request(
            f"/v1/identities/{quote(identity_id, safe='')}",
            method="DELETE",
            headers={"X-Confirm-Delete": "true"},
        )
        return None

    async def _request(
        self,
        path: str,
        *,
        method: str = "GET",
        body: Any = None,
        headers: dict[str, str] | None = None,
        query: dict[str, Any] | None = None,
        response_type: str = "json",
    ) -> Any:
        url = urljoin(_normalize_base_url(self.options["base_url"]), path.lstrip("/"))

        request_headers: dict[str, str] = dict(headers or {})
        if self.options.get("token"):
            request_headers["authorization"] = f"Bearer {self.options['token']}"
        if self.options.get("api_key"):
            request_headers["x-api-key"] = str(self.options["api_key"])

        request_body: str | None = None
        if body is not None:
            request_headers["content-type"] = "application/json"
            request_body = json.dumps(body)

        params = {key: value for key, value in (query or {}).items() if value is not None}

        async with httpx.AsyncClient() as client:
            response = await client.request(
                method,
                url,
                params=params,
                headers=request_headers,
                content=request_body,
            )

        text = response.text
        payload = _parse_json(text) if text else None

        if response.status_code >= 400:
            raise _create_request_error(response.status_code, payload)

        if not text:
            return None
        if response_type == "text":
            return text
        return payload
