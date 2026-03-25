from __future__ import annotations


_MANAGE_IMPLIES = frozenset({"read", "write", "create", "delete"})


def _parse_scope(raw: str) -> tuple[str, str, str, str] | None:
    if not isinstance(raw, str) or not raw or raw.strip() != raw or any(char.isspace() for char in raw):
        return None

    parts = raw.split(":")
    if len(parts) == 3:
        plane, resource, action = parts
        path = "*"
    elif len(parts) == 4:
        plane, resource, action, path = parts
    else:
        return None

    if not all(parts):
        return None

    if path == "":
        return None

    if plane == "relayfile" and resource == "fs":
        normalized = _normalize_fs_path(path)
        if normalized is None:
            return None
        path = normalized

    return plane, resource, action, path


def _normalize_fs_path(path: str) -> str | None:
    if path == "*":
        return path

    if not path.startswith("/") or "\\" in path or "**" in path:
        return None

    wildcard_index = path.find("*")
    if wildcard_index != -1 and not path.endswith("/*"):
        return None

    if path.endswith("/*") and "*" in path[:-2]:
        return None

    if path.endswith("/*"):
        base_path = path[:-2] or "/"
    else:
        base_path = path

    normalized = "/".join(segment for segment in base_path.split("/") if segment)
    normalized = f"/{normalized}" if normalized else "/"
    if ".." in normalized.split("/"):
        return None

    if path.endswith("/*"):
        if normalized == "/":
            return "/*"
        return f"{normalized}/*"

    return normalized


def _match_action(requested: str, granted: str) -> bool:
    if granted in {"*", requested}:
        return True
    return granted == "manage" and requested in _MANAGE_IMPLIES


def _match_path(requested: tuple[str, str, str, str], granted: tuple[str, str, str, str]) -> bool:
    requested_path = requested[3]
    granted_path = granted[3]

    if granted_path in {"*", requested_path}:
        return True

    if requested[0] != "relayfile" or requested[1] != "fs":
        return False

    if not granted_path.endswith("/*"):
        return False

    return requested_path.startswith(granted_path[:-1])


def _match_parsed_scope(
    requested: tuple[str, str, str, str],
    granted: tuple[str, str, str, str],
) -> bool:
    granted_plane, granted_resource, granted_action, _ = granted
    requested_plane, requested_resource, requested_action, _ = requested

    if granted_plane not in {"*", requested_plane}:
        return False

    if granted_resource not in {"*", requested_resource}:
        return False

    if not _match_action(requested_action, granted_action):
        return False

    return _match_path(requested, granted)


def match_scope(required: str, granted: list[str]) -> bool:
    if not granted:
        return False

    requested = _parse_scope(required)
    if requested is None:
        return False
    for candidate in granted:
        parsed = _parse_scope(candidate)
        if parsed is not None and _match_parsed_scope(requested, parsed):
            return True
    return False
