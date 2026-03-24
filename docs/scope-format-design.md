# Scope Format Design Outline

## Scope String Format

```
{plane}:{resource}:{action}:{path?}
```

A scope is a colon-delimited string with 3 required segments and 1 optional segment:

| Segment    | Required | Description                                      | Examples                          |
| ---------- | -------- | ------------------------------------------------ | --------------------------------- |
| `plane`    | Yes      | The product plane being accessed                 | `relaycast`, `relayfile`, `cloud`, `relayauth` |
| `resource` | Yes      | The resource type within the plane               | `channel`, `fs`, `workflow`, `token`, `identity` |
| `action`   | Yes      | The operation being performed                    | `read`, `write`, `create`, `delete`, `manage`, `run`, `send`, `invoke`, `*` |
| `path`     | No       | Optional constraint or path qualifier            | `*`, `/src/api/*`, `#billing`     |

When `path` is omitted, the scope applies to all paths/instances of that resource. A 3-segment scope `plane:resource:action` is equivalent to `plane:resource:action:*`.

## Wildcard Rules

- `*` matches **any single segment value** in the position where it appears.
- `*` is valid in any segment: plane, resource, action, or path.
- `**` (double-star / globstar) is **not supported**. This keeps matching simple and predictable.
- A scope `relaycast:*:read:*` means "read any resource type in relaycast across all paths."
- A scope `*:*:*:*` is the superscope — matches everything. Should only be used for internal admin.

### Path Wildcards

In the path segment specifically:
- `*` at the end of a path matches any suffix: `relayfile:fs:read:/src/*` matches `/src/api/handler.ts`.
- `*` as the entire path matches all paths: `relaycast:channel:read:*` matches any channel.
- Literal path values match exactly: `relaycast:channel:send:#billing` matches only `#billing`.
- Path wildcards use **prefix matching with trailing `*`**: `/src/api/*` matches `/src/api/` and anything below it.
- Mid-path wildcards are **not supported**: `/src/*/handler.ts` is invalid.

## Path Patterns for Relayfile Scopes

Relayfile scopes use filesystem-style paths:

```
relayfile:fs:read:/docs/*
relayfile:fs:write:/src/api/*
relayfile:fs:delete:/tmp/*
```

Path rules:
- Paths must start with `/`.
- Trailing `*` matches the directory and all descendants.
- Exact paths match a single file or directory: `relayfile:fs:read:/README.md`.
- No `..` traversal allowed — paths must be normalized.
- No symbolic link resolution — paths are matched literally.

## Matching Algorithm

When checking if a **requested scope** is permitted by a set of **granted scopes**:

```
function isScopeGranted(requested: ParsedScope, granted: ParsedScope[]): boolean
```

1. For each granted scope, compare segment-by-segment with the requested scope.
2. A granted segment matches a requested segment if:
   - They are equal, OR
   - The granted segment is `*`.
3. For the path segment, apply prefix matching: granted path `/src/*` matches requested path `/src/api/handler.ts`.
4. A 3-segment granted scope (no path) implicitly matches any path.
5. If **any** granted scope matches all segments, the request is permitted.

### Scope Comparison Operations

| Operation    | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `isSubsetOf` | Every scope in set A is matched by at least one scope in set B     |
| `isSupersetOf` | Every scope in set B is matched by at least one scope in set A   |
| `overlaps`   | At least one scope in set A is matched by at least one scope in B  |

These are used for:
- **Delegation**: child scopes must be `isSubsetOf` parent scopes.
- **Policy evaluation**: checking if an identity's granted scopes cover a required scope.
- **Template comparison**: determining if a template provides sufficient access.

## Scope Templates (Built-in Presets)

Templates are named bundles of scopes for common use cases:

| Template Key          | Name                  | Scopes                          |
| --------------------- | --------------------- | ------------------------------- |
| `relaycast:full`      | Relaycast Full Access | `relaycast:*:*:*`              |
| `relayfile:read-only` | Relayfile Read Only   | `relayfile:fs:read:*`          |

Additional templates to define in the spec:

| Template Key              | Name                        | Scopes                                                  |
| ------------------------- | --------------------------- | ------------------------------------------------------- |
| `relayfile:full`          | Relayfile Full Access       | `relayfile:*:*:*`                                       |
| `cloud:full`              | Cloud Full Access           | `cloud:*:*:*`                                           |
| `cloud:workflow-runner`   | Cloud Workflow Runner       | `cloud:workflow:run:*`, `cloud:workflow:read:*`          |
| `relayauth:admin`         | RelayAuth Admin             | `relayauth:*:manage:*`                                  |
| `relayauth:token-refresh` | Token Refresh Only          | `relayauth:token:refresh`                               |
| `minimal:read-all`        | Read-Only All Planes        | `relaycast:*:read:*`, `relayfile:*:read:*`, `cloud:*:read:*` |

Templates are convenience aliases — they expand to their scope arrays at issuance time. No runtime concept of "template" exists in the token; only expanded scopes appear in JWT claims.

## Scope Validation Rules

A scope string is **valid** if and only if:

1. **Segment count**: 3 or 4 colon-separated segments.
2. **Plane**: must be one of the defined `Plane` values (`relaycast`, `relayfile`, `cloud`, `relayauth`) or `*`.
3. **Resource**: must be a non-empty string of `[a-z][a-z0-9-]*` or `*`.
4. **Action**: must be one of the defined `Action` values (`read`, `write`, `create`, `delete`, `manage`, `run`, `send`, `invoke`) or `*`.
5. **Path** (if present): must be `*`, or a non-empty string. For `relayfile` plane, paths must start with `/` and must not contain `..`. Trailing `*` for prefix matching is permitted.
6. **No empty segments**: `relaycast::read:*` is invalid.
7. **No whitespace**: scope strings must not contain spaces or other whitespace characters.

### Invalid Scope Examples

| Scope                       | Reason                              |
| --------------------------- | ----------------------------------- |
| `badplane:channel:read`     | Invalid plane                       |
| `relaycast:channel:destroy` | Invalid action                      |
| `relaycast::read:*`         | Empty resource segment              |
| `relayfile:fs:read:../etc`  | Path traversal not allowed          |
| `relayfile:fs:read:src`     | Relayfile path must start with `/`  |
| `a:b`                       | Too few segments                    |
| `a:b:c:d:e`                 | Too many segments                   |
| `relaycast:channel:read: `  | Whitespace in path                  |

## Delegation Scope Narrowing

When an agent creates a sub-agent token:
- The child's scopes must be a **strict subset or equal** to the parent's scopes.
- Each child scope must be matched by at least one parent scope (`isSubsetOf`).
- Attempting to grant a scope not covered by the parent is a **hard error** + audit event.
- Wildcard narrowing is allowed: parent `relaycast:*:*:*` can grant child `relaycast:channel:read:*`.
- Path narrowing is allowed: parent `relayfile:fs:write:/src/*` can grant child `relayfile:fs:write:/src/api/*`.

## Open Questions for Spec Writer

1. Should constraint-style paths (e.g., `stripe:orders:approve:<=5000`) be formalized, or kept as opaque strings matched literally?
2. Should we define resource names per plane (e.g., relaycast resources: `channel`, `message`, `workspace`) or leave them open-ended?
3. Case sensitivity: all lowercase enforced, or case-insensitive matching?
   - Recommendation: enforce all-lowercase at validation time.
