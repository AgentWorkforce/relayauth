from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any


def _string_list(value: Any) -> list[str]:
    if value is None:
        return []
    return [str(item) for item in value]


def _string_map(value: Any) -> dict[str, str]:
    if not value:
        return {}
    return {str(key): str(entry) for key, entry in dict(value).items()}


def _optional_string(value: Any) -> str | None:
    if value is None:
        return None
    return str(value)


def _optional_number(value: Any) -> int | float | None:
    if value is None:
        return None
    if isinstance(value, bool):
        raise TypeError("boolean is not a valid number")
    if isinstance(value, (int, float)):
        return value
    raise TypeError("value must be numeric")


@dataclass(slots=True)
class TokenBudget:
    maxActionsPerHour: int | float | None = None
    maxCostPerDay: int | float | None = None
    remaining: int | float | None = None

    @classmethod
    def from_dict(cls, value: Any) -> TokenBudget | None:
        if value is None:
            return None
        data = dict(value)
        return cls(
            maxActionsPerHour=_optional_number(data.get("maxActionsPerHour")),
            maxCostPerDay=_optional_number(data.get("maxCostPerDay")),
            remaining=_optional_number(data.get("remaining")),
        )


@dataclass(slots=True)
class Claims:
    sub: str
    org: str
    wks: str
    scopes: list[str]
    sponsorId: str
    sponsorChain: list[str]
    token_type: str
    iss: str
    aud: list[str]
    exp: int
    iat: int
    jti: str
    nbf: int | None = None
    sid: str | None = None
    meta: dict[str, str] = field(default_factory=dict)
    parentTokenId: str | None = None
    budget: TokenBudget | None = None

    @classmethod
    def from_dict(cls, value: Any) -> Claims:
        data = dict(value)
        return cls(
            sub=str(data["sub"]),
            org=str(data["org"]),
            wks=str(data["wks"]),
            scopes=_string_list(data.get("scopes")),
            sponsorId=str(data["sponsorId"]),
            sponsorChain=_string_list(data.get("sponsorChain")),
            token_type=str(data["token_type"]),
            iss=str(data["iss"]),
            aud=_string_list(data.get("aud")),
            exp=int(data["exp"]),
            iat=int(data["iat"]),
            jti=str(data["jti"]),
            nbf=None if data.get("nbf") is None else int(data["nbf"]),
            sid=_optional_string(data.get("sid")),
            meta=_string_map(data.get("meta")),
            parentTokenId=_optional_string(data.get("parentTokenId")),
            budget=TokenBudget.from_dict(data.get("budget")),
        )


@dataclass(slots=True)
class TokenPair:
    accessToken: str
    refreshToken: str
    accessTokenExpiresAt: str
    refreshTokenExpiresAt: str
    tokenType: str

    @classmethod
    def from_dict(cls, value: Any) -> TokenPair:
        data = dict(value)
        return cls(
            accessToken=str(data["accessToken"]),
            refreshToken=str(data["refreshToken"]),
            accessTokenExpiresAt=str(data["accessTokenExpiresAt"]),
            refreshTokenExpiresAt=str(data["refreshTokenExpiresAt"]),
            tokenType=str(data["tokenType"]),
        )


@dataclass(slots=True)
class AgentIdentity:
    id: str
    name: str
    type: str
    orgId: str
    status: str
    scopes: list[str]
    roles: list[str]
    metadata: dict[str, str]
    createdAt: str
    updatedAt: str

    @classmethod
    def from_dict(cls, value: Any) -> AgentIdentity:
        data = dict(value)
        return cls(
            id=str(data["id"]),
            name=str(data["name"]),
            type=str(data["type"]),
            orgId=str(data["orgId"]),
            status=str(data["status"]),
            scopes=_string_list(data.get("scopes")),
            roles=_string_list(data.get("roles")),
            metadata=_string_map(data.get("metadata")),
            createdAt=str(data["createdAt"]),
            updatedAt=str(data["updatedAt"]),
        )
