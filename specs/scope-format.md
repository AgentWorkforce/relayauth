# Scope Format Specification

## Purpose

This document defines the relayauth scope string format, parsing rules, matching
behavior, comparison semantics, built-in templates, and validation rules.

Scopes are the capability model for the Agent Relay ecosystem. They describe
what an identity is allowed to do, on which resource, and optionally within
which constrained path or target.

The canonical scope shape is:

```text
{plane}:{resource}:{action}:{path?}
```

A scope may contain either 3 segments or 4 segments. The fourth segment is an
optional path or constraint segment. If the fourth segment is omitted, it is
semantically equivalent to `*`.

## Scope Structure

### Segment Overview

| Segment | Required | Meaning | Examples |
| --- | --- | --- | --- |
| `plane` | Yes | Product or authority plane | `relaycast`, `relayfile`, `cloud`, `relayauth` |
| `resource` | Yes | Resource type inside the plane | `channel`, `fs`, `workflow`, `token`, `identity` |
| `action` | Yes | Operation permitted on the resource | `read`, `write`, `create`, `delete`, `manage`, `run`, `send`, `invoke` |
| `path` | No | Optional constraint, instance target, or path-like selector | `*`, `/src/api/*`, `#billing`, `runner-prod` |

### Examples

```text
relaycast:channel:read
relaycast:channel:send:#billing
relayfile:fs:read:/docs/*
relayfile:fs:write:/src/api/handlers/*
cloud:workflow:run
relayauth:identity:manage:*
```

## Grammar

The grammar below is normative for parsing. Validation rules later in this
document apply after parsing.

```bnf
scope          ::= scope3 | scope4
scope3         ::= plane ":" resource ":" action
scope4         ::= plane ":" resource ":" action ":" path

plane          ::= identifier | "*"
resource       ::= identifier | "*"
action         ::= "read"
                 | "write"
                 | "create"
                 | "delete"
                 | "manage"
                 | "run"
                 | "send"
                 | "invoke"
                 | "*"

identifier     ::= alpha ( alpha | digit | "-" )*
alpha          ::= "a" | "b" | "c" | "d" | "e" | "f" | "g"
                 | "h" | "i" | "j" | "k" | "l" | "m" | "n"
                 | "o" | "p" | "q" | "r" | "s" | "t" | "u"
                 | "v" | "w" | "x" | "y" | "z"
digit          ::= "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9"

path           ::= "*" | path-char , { path-char }
path-char      ::= any visible non-whitespace UTF-8 character except ":"
```

All identifiers (plane names, resource names) MUST be lowercase ASCII. Uppercase
characters are not permitted. Identifiers MUST NOT end with a hyphen; the regex
`^[a-z][a-z0-9]*(-[a-z0-9]+)*$` captures this constraint.

### Parsing Rules

1. A scope string must contain either 2 or 3 `:` separators.
2. The parser must split on `:` into exactly 3 or 4 segments.
3. Empty segments are not allowed.
4. The parser must preserve the original input string as `raw`.
5. If the path segment is omitted, implementations must normalize it to `*`
   for matching and comparison.

### Canonical Parsed Shape

The parsed form aligns with the shared types:

```ts
interface ParsedScope {
  plane: Plane | "*";
  resource: string;
  action: Action;
  path: string;
  raw: string;
}
```

## Segment Semantics

### `plane`

`plane` identifies the top-level authority domain. Current built-in values are:

- `relaycast`
- `relayfile`
- `cloud`
- `relayauth`

`*` matches any plane.

Parsers must reject unknown plane values unless the implementation is explicitly
configured to allow custom planes. In the public relayauth specification, the
four built-in planes above are the only valid plane values.

### `resource`

`resource` identifies the entity class within a plane.

Examples:

- `channel` in `relaycast`
- `fs` in `relayfile`
- `workflow` in `cloud`
- `identity`, `token`, `role`, `policy`, `audit`, `admin`, `scope`, `apikey`
  in `relayauth`

`resource` is intentionally extensible per plane. relayauth validates resource
syntax generically and does not require a single global enum for all resource
names in this document.

`*` matches any resource.

### `action`

`action` identifies the operation allowed on the resource.

Allowed values:

- `read`
- `write`
- `create`
- `delete`
- `manage`
- `run`
- `send`
- `invoke`
- `*`

`*` matches any action.

#### `manage` Action Expansion

The `manage` action is a composite action that implies `read`, `write`, `create`,
and `delete`. During matching, a granted scope with `action=manage` covers
requests for `read`, `write`, `create`, or `delete` on the same plane, resource,
and path.

For example, `relayauth:identity:manage:*` grants:
- `relayauth:identity:read:*`
- `relayauth:identity:write:*`
- `relayauth:identity:create:*`
- `relayauth:identity:delete:*`
- `relayauth:identity:manage:*`

`manage` does NOT imply `run`, `send`, or `invoke`.

No other action names are valid in the current public spec.

### `path`

`path` is an optional constraint segment. It can represent:

- a filesystem path for `relayfile`
- a named target such as `#billing`
- an instance identifier such as `runner-prod`
- a wildcard `*`

If omitted, `path` is treated as `*`.

`path` is plane- and resource-sensitive. Its exact semantics depend on the
requested scope family:

- `relayfile:fs:*` uses filesystem-style matching rules
- non-filesystem scopes use literal or full-wildcard matching rules by default

## Wildcard Rules

Wildcard behavior is intentionally small and predictable.

### General Rules

1. `*` matches any single value in the segment where it appears.
2. `*` never crosses segment boundaries.
3. `**` is not supported in any segment.
4. Wildcard matching is case-sensitive.
5. Matching is exact unless a wildcard rule in this document says otherwise.

### Wildcards in Requested Scopes

Wildcards in **granted** scopes expand to cover any value. Wildcards in
**requested** scopes are NOT expanded during matching — they are treated as
the literal value `"*"`. A request for `*:*:*:*` is only satisfied by a grant
that literally covers `*:*:*:*` (e.g., `*:*:*:*` itself). A grant of
`relaycast:*:*:*` does not satisfy a request for `*:channel:read:*` because
`relaycast` does not equal `*`.

### Segment Examples

| Granted Scope | Requested Scope | Result | Reason |
| --- | --- | --- | --- |
| `relaycast:*:read:*` | `relaycast:channel:read:#ops` | Match | `resource=*` and `path=*` |
| `*:fs:read:*` | `relayfile:fs:read:/docs/spec.md` | Match | `plane=*` |
| `relayauth:identity:*:*` | `relayauth:identity:manage:agent_123` | Match | `action=*` |
| `relaycast:channel:send:*` | `relaycast:channel:read:*` | No match | action differs |
| `relaycast:channel:*` | `relaycast:channel:send:#billing` | Match | omitted path implies `*` |

### Path Wildcard Rules

For non-filesystem scopes:

- `path=*` matches any path value
- any non-`*` path must match literally

Examples:

| Granted Scope | Requested Scope | Result |
| --- | --- | --- |
| `relaycast:channel:send:#billing` | `relaycast:channel:send:#billing` | Match |
| `relaycast:channel:send:#billing` | `relaycast:channel:send:#ops` | No match |
| `cloud:runner:invoke:*` | `cloud:runner:invoke:runner-prod` | Match |

For filesystem scopes, see [Path Pattern Matching](#path-pattern-matching).

## Path Pattern Matching

This section is normative for `relayfile:fs:*` scopes.

### Filesystem Scope Shape

Filesystem scopes use the path segment as a normalized absolute path selector.

Examples:

```text
relayfile:fs:read:/docs/*
relayfile:fs:write:/src/api/*
relayfile:fs:delete:/tmp/build.log
relayfile:fs:create:/tmp/*
```

### Filesystem Matching Rules

1. Filesystem paths must start with `/`.
2. Matching is case-sensitive.
3. A path value of `*` matches every path.
4. A path ending in `/*` is a prefix-directory match.
5. A path without a trailing `*` is an exact match.
6. Mid-segment wildcards are invalid.
7. `**` is invalid.
8. Paths must be normalized before comparison.
9. Path traversal segments such as `..` are invalid.
10. Repeated `/` characters should be normalized or rejected consistently by the
    implementation; relayauth should normalize before evaluation.

### Prefix Match Semantics

`/src/api/*` matches:

- `/src/api/index.ts`
- `/src/api/handlers/user.ts`
- `/src/api/`

`/src/api/*` does not match:

- `/src/api` (no trailing slash — the bare directory name without `/` is not covered)
- `/src/apis/index.ts`
- `/src/ap`
- `/src/apiary/file.ts`

Implementations should treat the `/*` suffix as "the directory itself and any
descendant path with the same normalized prefix followed by `/`".

### Filesystem Examples

| Granted Scope | Requested Scope | Result | Reason |
| --- | --- | --- | --- |
| `relayfile:fs:read:*` | `relayfile:fs:read:/docs/a.md` | Match | global path wildcard |
| `relayfile:fs:read:/docs/*` | `relayfile:fs:read:/docs/a.md` | Match | descendant of `/docs/` |
| `relayfile:fs:read:/docs/*` | `relayfile:fs:read:/docs/nested/b.md` | Match | descendant of `/docs/` |
| `relayfile:fs:read:/docs/*` | `relayfile:fs:read:/docsets/a.md` | No match | prefix boundary differs |
| `relayfile:fs:write:/src/api/user.ts` | `relayfile:fs:write:/src/api/user.ts` | Match | exact file |
| `relayfile:fs:write:/src/api/user.ts` | `relayfile:fs:write:/src/api/admin.ts` | No match | exact file mismatch |

## Matching Algorithm

Authorization answers the question: does a set of granted scopes cover a
requested scope?

### `matches(granted, requested)`

A granted scope matches a requested scope when all normalized segments match.

Normalization step:

1. Parse both scopes.
2. If either scope has no path segment, normalize path to `*`.
3. Reject invalid scopes before attempting to match.

Segment matching step:

1. `plane` matches if granted plane equals requested plane or granted plane is
   `*`.
2. `resource` matches if granted resource equals requested resource or granted
   resource is `*`.
3. `action` matches if granted action equals requested action, or granted action
   is `*`, or granted action is `manage` and requested action is one of `read`,
   `write`, `create`, or `delete`.
4. `path` matches:
   - by filesystem rules for `relayfile:fs:*`
   - otherwise by exact equality or `granted.path === "*"`

The request is authorized if at least one granted scope matches the requested
scope.

### Reference Pseudocode

```ts
const MANAGE_IMPLIES: ReadonlySet<string> = new Set(["read", "write", "create", "delete"]);

function matchAction(granted: string, requested: string): boolean {
  if (granted === "*") return true;
  if (granted === requested) return true;
  if (granted === "manage" && MANAGE_IMPLIES.has(requested)) return true;
  return false;
}

function matchFsPath(granted: string, requested: string): boolean {
  if (granted === "*") return true;
  if (granted === requested) return true;
  if (granted.endsWith("/*")) {
    const prefix = granted.slice(0, -1); // "/src/api/" from "/src/api/*"
    return requested.startsWith(prefix);
  }
  return false;
}

function matches(granted: ParsedScope, requested: ParsedScope): boolean {
  if (!(granted.plane === "*" || granted.plane === requested.plane)) return false;
  if (!(granted.resource === "*" || granted.resource === requested.resource)) return false;
  if (!matchAction(granted.action, requested.action)) return false;

  if (requested.plane === "relayfile" && requested.resource === "fs") {
    return matchFsPath(granted.path, requested.path);
  }

  return granted.path === "*" || granted.path === requested.path;
}
```

## Scope Comparison

Scope comparison is defined over sets of scopes after normalization and
deduplication.

### Normalized Scope Set

Before comparison:

1. Parse every scope.
2. Reject invalid scopes.
3. Normalize omitted path to `*`.
4. Remove exact duplicates.

### `isSubsetOf(a, b)`

`isSubsetOf(a, b)` is true when every scope in set `a` is matched by at least
one scope in set `b`.

This is the primary operation for delegated scope narrowing.

Examples:

| A | B | Result |
| --- | --- | --- |
| `["relaycast:channel:read:#billing"]` | `["relaycast:channel:read:*"]` | `true` |
| `["relayfile:fs:write:/src/api/*"]` | `["relayfile:fs:write:/src/*"]` | `true` |
| `["relayauth:identity:manage:*"]` | `["relayauth:identity:read:*"]` | `false` |
| `["cloud:workflow:run"]` | `["cloud:*:*"]` | `true` |

### `isSupersetOf(a, b)`

`isSupersetOf(a, b)` is equivalent to `isSubsetOf(b, a)`.

It is true when set `a` covers every scope in set `b`.

Examples:

| A | B | Result |
| --- | --- | --- |
| `["relaycast:*:*:*"]` | `["relaycast:channel:read:*"]` | `true` |
| `["relayfile:fs:read:/docs/*"]` | `["relayfile:fs:read:/docs/a.md"]` | `true` |
| `["cloud:workflow:read:*"]` | `["cloud:workflow:run:*"]` | `false` |

### `overlaps(a, b)`

`overlaps(a, b)` is true when at least one scope in `a` matches at least one
scope in `b`, or vice versa through a non-empty shared permission region.

For implementation simplicity, relayauth may define overlap as:

- `exists scopeA in a, scopeB in b such that matches(scopeA, scopeB) or matches(scopeB, scopeA)`

Note: this simplified definition has a known false-negative case. Two scopes
may share a permission region without either matching the other. For example,
`relayfile:fs:*:/src/*` and `relayfile:*:read:/src/*` both cover
`relayfile:fs:read:/src/foo` but neither matches the other. This is accepted
as a trade-off for implementation simplicity.

Examples:

| A | B | Result |
| --- | --- | --- |
| `["relaycast:channel:read:*"]` | `["relaycast:channel:read:#ops"]` | `true` |
| `["relayfile:fs:write:/src/api/*"]` | `["relayfile:fs:write:/src/web/*"]` | `false` |
| `["cloud:*:read:*"]` | `["cloud:workflow:read:*"]` | `true` |
| `["relayauth:token:read:*"]` | `["relayauth:token:manage:*"]` | `false` |

### Delegation Rule

When issuing a child token from a parent token:

1. Child scopes must satisfy `isSubsetOf(childScopes, parentScopes)`.
2. Any requested child scope outside the parent scope set must cause issuance to
   fail.
3. Failed escalation attempts must produce an audit event.

## Built-in Scope Templates

Templates are named bundles of scopes for common issuance workflows.

Templates are expanded to concrete scope arrays during issuance. Tokens do not
store template names; they store only the expanded scopes.

### Currently Defined Templates

| Template Key | Name | Description | Scopes |
| --- | --- | --- | --- |
| `relaycast:full` | Relaycast Full Access | Full access to relaycast resources | `["relaycast:*:*:*"]` |
| `relayfile:read-only` | Relayfile Read Only | Read-only access to relayfile filesystem resources | `["relayfile:fs:read:*"]` |

### Recommended Built-in Templates

These templates should be included to make the template surface usable across
the initial ecosystem.

| Template Key | Name | Description | Scopes |
| --- | --- | --- | --- |
| `relayfile:full` | Relayfile Full Access | Full access to relayfile resources | `["relayfile:*:*:*"]` |
| `cloud:full` | Cloud Full Access | Full access to cloud resources | `["cloud:*:*:*"]` |
| `cloud:workflow-runner` | Cloud Workflow Runner | Read and run workflow capabilities | `["cloud:workflow:read:*", "cloud:workflow:run:*"]` |
| `relayauth:scope-reader` | RelayAuth Scope Reader | Read scope definitions and templates | `["relayauth:scope:read:*"]` |
| `relayauth:token-manager` | RelayAuth Token Manager | Create, read, and manage tokens | `["relayauth:token:create:*", "relayauth:token:read:*", "relayauth:token:manage:*"]` |
| `relayauth:identity-manager` | RelayAuth Identity Manager | Manage identities | `["relayauth:identity:read:*", "relayauth:identity:manage:*"]` |
| `relayauth:admin` | RelayAuth Admin | Broad relayauth administrative access | `["relayauth:*:manage:*", "relayauth:*:read:*"]` |
| `read-all` | Cross-Plane Read Only | Read-only access across built-in planes | `["relaycast:*:read:*", "relayfile:*:read:*", "cloud:*:read:*", "relayauth:*:read:*"]` |

## Validation

A scope is valid only if every rule below passes.

### Syntax Validation

Reject a scope if:

1. It is an empty string.
2. It contains leading or trailing whitespace.
3. It contains any whitespace character within the string.
4. It does not split into exactly 3 or 4 segments.
5. Any segment is empty.
6. It contains `**`.

### Segment Validation

Reject a scope if:

1. `plane` is not one of `relaycast`, `relayfile`, `cloud`, `relayauth`, or `*`.
2. `resource` is not `*` and does not match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`.
3. `action` is not one of `read`, `write`, `create`, `delete`, `manage`,
   `run`, `send`, `invoke`, or `*`.
4. `path` is present but empty.

### Filesystem Path Validation

For `relayfile:fs:*`, reject the scope if:

1. The path is neither `*` nor an absolute path beginning with `/`. Note that
   `*` is the only valid non-`/`-prefixed path for filesystem scopes; it acts
   as a global path wildcard meaning "any path."
2. The path contains `..`.
3. The path contains `**`.
4. The path uses a mid-path wildcard such as `/src/*/api`.
5. The path contains backslash separators if the implementation standardizes on
   POSIX-style matching.
6. The normalized path escapes the logical root.

### Semantic Validation

Reject a scope if:

1. It uses an action that is syntactically valid but nonsensical for the target
   system and the implementation has a stricter resource-action matrix.
2. It depends on an unknown custom plane or resource in a deployment that does
   not allow extensions.
3. It is issued into a token whose audience set cannot consume that plane.

The public relayauth parser may validate syntax generically and leave some
resource-action compatibility checks to higher layers. If a higher layer does
not implement stricter checks, only the syntax and built-in plane/action rules
in this spec are mandatory.

### Invalid Scope Examples

| Scope | Reason |
| --- | --- |
| `` | empty scope |
| ` relaycast:channel:read:*` | leading whitespace |
| `relaycast::read:*` | empty resource segment |
| `other:channel:read:*` | unknown plane |
| `relaycast:channel:destroy:*` | unknown action |
| `relayfile:fs:read:docs/*` | filesystem path must start with `/` |
| `relayfile:fs:read:/src/*/api` | mid-path wildcard not allowed |
| `relayfile:fs:read:/src/**` | `**` not supported |
| `relaycast:channel:read:` | empty path segment |
| `a:b` | too few segments |
| `a:b:c:d:e` | too many segments |

## Edge Cases

### Empty Scope Lists

- An empty scope list grants no permissions.
- Access tokens should not contain an empty `scopes` array.
- `isSubsetOf([], x)` is `true`.
- `isSupersetOf([], x)` is `true` only when `x` is also empty.
- `overlaps([], x)` is always `false`.

### Duplicate Scopes

- Exact duplicate scope strings should be collapsed during normalization.
- Duplicate scopes do not increase permission.
- Duplicate scopes should not cause validation failure by themselves.

Example:

```json
[
  "relaycast:channel:read:*",
  "relaycast:channel:read:*"
]
```

Normalizes to:

```json
[
  "relaycast:channel:read:*"
]
```

### Equivalent Scopes

These scopes are semantically equivalent and should normalize consistently:

```text
relaycast:channel:read
relaycast:channel:read:*
```

Implementations should prefer the 4-segment normalized form internally.

### Conflicting Scopes

In a pure allow-list scope model, there is no concept of an intrinsically
"conflicting" scope pair. A broader scope and a narrower scope may coexist.

Examples:

```json
[
  "relaycast:channel:read:*",
  "relaycast:channel:read:#billing"
]
```

This is redundant but not invalid.

If a higher-level policy engine supports deny rules, conflict resolution belongs
to the policy layer, not the scope syntax layer. Scope strings in this spec are
allow capabilities only.

### Unknown But Well-Formed Resource Names

`relayauth:foobar:read:*` is syntactically well-formed, but an implementation
may reject it semantically if `foobar` is not a recognized resource.

### Omitted Path on Requested Scopes

When checking a required scope such as `cloud:workflow:run`, implementations
must normalize it to `cloud:workflow:run:*` before comparison.

### Full Superscope

`*:*:*:*` is valid under the generic grammar but should be reserved for internal
administration, testing, or bootstrap scenarios. Production issuance paths
should strongly restrict it.

## Implementation Guidance

Implementations should:

1. Parse once, normalize once, and compare normalized scopes.
2. Store normalized 4-segment scopes where practical.
3. Deduplicate before comparison or token issuance.
4. Use `isSubsetOf` for delegation checks.
5. Audit rejected delegation attempts as escalation failures.
6. Keep filesystem matching logic isolated from generic scope matching logic.

Implementations should not:

1. Support `**` or arbitrary glob syntax.
2. Treat path substrings as regex.
3. Ignore case during matching.
4. Permit path traversal in filesystem scopes.

## Summary

This specification defines:

- a 3- or 4-segment scope syntax with canonical normalization to 4 segments
- fixed built-in `plane` and `action` values
- `*` as the only wildcard operator
- special filesystem prefix matching for `relayfile:fs:*`
- set comparison semantics for `isSubsetOf`, `isSupersetOf`, and `overlaps`
- built-in and recommended scope templates
- invalid syntax and semantic edge conditions
- normalization rules for empty, duplicate, equivalent, and overlapping scopes

Artifact produced:

- `specs/scope-format.md`
