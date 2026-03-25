from __future__ import annotations


_MANAGE_IMPLIES = frozenset({"read", "write", "create", "delete"})


def _parse_scope(raw: str) -> tuple[str, str, str, str]:
    if not isinstance(raw, str) or not raw or raw.strip() != raw or any(char.isspace() for char in raw):
        raise ValueError("invalid scope")

    parts = raw.split(":")
    if len(parts) == 3:
        plane, resource, action = parts
        path = "*"
    elif len(parts) == 4:
        plane, resource, action, path = parts
    else:
        raise ValueError("invalid scope")

    if not all(parts):
        raise ValueError("invalid scope")

    if path == "":
        raise ValueError("invalid scope")

    if plane == "relayfile" and resource == "fs":
        path = _normalize_fs_path(path)

    return plane, resource, action, path


def _normalize_fs_path(path: str) -> str:
    if path == "*":
        return path

    if not path.startswith("/") or "\\" in path or "**" in path:
        raise ValueError("invalid scope")

    wildcard_index = path.find("*")
    if wildcard_index != -1 and not path.endswith("/*"):
        raise ValueError("invalid scope")

    if path.endswith("/*") and "*" in path[:-2]:
        raise ValueError("invalid scope")

    if path.endswith("/*"):
        base_path = path[:-2] or "/"
    else:
        base_path = path

    normalized = "/".join(segment for segment in base_path.split("/") if segment)
    normalized = f"/{normalized}" if normalized else "/"
    if ".." in normalized.split("/"):
        raise ValueError("invalid scope")

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
    return any(_match_parsed_scope(requested, _parse_scope(candidate)) for candidate in granted)
