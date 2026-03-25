from __future__ import annotations

import json
from typing import Any
from urllib.parse import quote, urljoin

import httpx

from .errors import InsufficientScopeError, RelayAuthError, TokenExpiredError, TokenRevokedError
from .types import AgentIdentity, TokenPair


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

    if status == 403 and error_code == "insufficient_scope":
        return InsufficientScopeError(
            _get_string(payload, "required") or "unknown",
            _get_string_list(payload, "actual"),
        )
    if status == 401 and error_code == "token_expired":
        return TokenExpiredError()
    if status == 401 and error_code == "token_revoked":
        return TokenRevokedError()
    return RelayAuthError(message, error_code, status)


class RelayAuthClient:
    def __init__(self, options: dict[str, Any] | None = None, **kwargs: Any) -> None:
        self.options = _normalize_client_options(options, **kwargs)

    async def create_identity(self, org_id: str, input: dict[str, Any] | None = None, **kwargs: Any) -> AgentIdentity:
        payload = dict(input or {})
        payload.update(kwargs)
        payload = {"orgId": org_id, **payload}
        data = await self._request("/v1/identities", method="POST", body=payload)
        return AgentIdentity.from_dict(data)

    async def get_identity(self, identity_id: str) -> AgentIdentity:
        data = await self._request(f"/v1/identities/{quote(identity_id, safe='')}")
        return AgentIdentity.from_dict(data)

    async def issue_token(
        self,
        identity_id: str,
        options: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> TokenPair:
        payload = dict(options or {})
        payload.update(kwargs)
        payload = {"identityId": identity_id, **payload}
        data = await self._request("/v1/tokens", method="POST", body=payload)
        return TokenPair.from_dict(data)

    async def revoke_token(self, token_id: str) -> None:
        await self._request("/v1/tokens/revoke", method="POST", body={"tokenId": token_id})
        return None

    async def query_audit(self, query: dict[str, Any] | None = None, **kwargs: Any) -> dict[str, Any]:
        params = dict(query or {})
        params.update(kwargs)
        data = await self._request("/v1/audit", query=params)
        entries = data.get("entries") if isinstance(data, dict) else None
        next_cursor = data.get("nextCursor") if isinstance(data, dict) else None
        result: dict[str, Any] = {"entries": entries if isinstance(entries, list) else []}
        if isinstance(next_cursor, str) and next_cursor:
            result["cursor"] = next_cursor
        return result

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
