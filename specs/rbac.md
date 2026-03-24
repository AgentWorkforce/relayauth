# RBAC Specification

## Purpose

This document defines the relayauth Role-Based Access Control (RBAC) model.
RBAC sits on top of the scope capability model defined in
`specs/scope-format.md`.

The model has three layers:

1. Scopes define the raw operations an identity may perform.
2. Roles bundle scopes into named assignments.
3. Policies apply conditional allow or deny rules at authorization time.

This specification is normative for:

- role and policy object shape
- field constraints
- built-in roles
- inheritance and resolution order
- conflict handling
- effective permission calculation
- runtime authorization checks

The system goal is strict least privilege with deterministic evaluation.
Explicit deny always wins. Workspace-level configuration may narrow
organization-level grants, but it may not override an organization-level deny.
Direct scopes may narrow role-based grants, but they may not broaden the
effective permissions boundary established above them.

## Core Model

### Terms

| Term | Meaning |
| --- | --- |
| `scope` | A normalized capability string in the form `{plane}:{resource}:{action}` or `{plane}:{resource}:{action}:{path}` |
| `role` | A named bundle of scopes bound to an organization and optionally a workspace |
| `policy` | A conditional rule with `allow` or `deny` effect, scoped to one or more scopes |
| `direct scope` | A scope assigned directly to an identity rather than through a role |
| `effective permissions` | The final set of scopes an identity may exercise after inheritance, narrowing, and policy evaluation |
| `applicable policy` | A policy whose org/workspace binding, scope match, and condition checks all match the authorization request |

### Design Principles

- Every permission decision must be deterministic.
- Every request starts from implicit deny.
- Policy evaluation is deny-first and priority-ordered.
- Lower levels narrow higher levels.
- Sub-agent delegation must remain a strict intersection of parent capability.
- Role assignment and policy creation must not allow privilege escalation.

## Roles

### Canonical Type

The shared type is:

```ts
export interface Role {
  id: string;
  name: string;
  description: string;
  scopes: string[];
  orgId: string;
  workspaceId?: string;
  builtIn: boolean;
  createdAt: string;
}
```

### Field Definition

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Unique role identifier. Recommended format: `role_<opaque>` |
| `name` | `string` | Yes | Human-readable stable role name. Unique within `(orgId, workspaceId)` |
| `description` | `string` | Yes | Short explanation of role purpose |
| `scopes` | `string[]` | Yes | Non-empty array of valid scope strings. Duplicates must be removed at write time |
| `orgId` | `string` | Yes | Owning organization. Must match the role storage namespace |
| `workspaceId` | `string` | No | If present, role is workspace-scoped. If absent, role is organization-scoped |
| `builtIn` | `boolean` | Yes | `true` for system-defined roles, `false` for custom roles |
| `createdAt` | `string` | Yes | ISO 8601 UTC timestamp |

### Role Constraints

- `name` must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`.
- `name` length must be between 3 and 64 characters.
- Names prefixed with `relayauth-` are reserved for built-in roles.
- `scopes` must contain only valid scopes from the scope specification.
- Role creation must fail if any scope exceeds the creating actor's effective
  administrative authority.
- Workspace-scoped roles may only reference scopes valid for that workspace
  context.
- Built-in roles cannot be renamed, deleted, or mutated.
- Custom roles can be updated, but updates must be revalidated as though the
  role were created fresh.

### Scope Semantics in Roles

- Role scopes are a union set.
- Duplicate scopes are semantically ignored.
- Wildcards in role scopes behave exactly as defined in the scope format spec.
- `manage` in a role scope expands during matching as defined in the scope spec.
- Role scopes are grants, not denials. Deny behavior belongs only to policies.

### Role Binding

#### Organization-Scoped Role

`workspaceId` omitted.

Use for:

- global administrative roles
- org-wide read-only roles
- roles that should be available in every workspace

An organization-scoped role is eligible in every workspace belonging to the
same `orgId`.

#### Workspace-Scoped Role

`workspaceId` present.

Use for:

- environment-specific deploy roles
- team-specific operational roles
- narrower roles for production vs staging

A workspace-scoped role is eligible only in the referenced workspace.

### Built-In Roles

Every organization must have these three built-in roles at creation time.

#### `relayauth-admin`

Full administrative control over relayauth-managed resources.

```text
relayauth:identity:manage:*
relayauth:token:manage:*
relayauth:role:manage:*
relayauth:policy:manage:*
relayauth:audit:read:*
relayauth:admin:manage:*
relayauth:scope:read:*
```

Rules:

- org-scoped only
- `builtIn: true`
- cannot be deleted or altered

#### `relayauth-developer`

Broad operational access across product planes, without RBAC administration.

```text
relaycast:*:*:*
relayfile:*:*:*
cloud:*:*:*
relayauth:identity:read:*
relayauth:token:create:*
relayauth:token:read:*
relayauth:scope:read:*
```

Rules:

- org-scoped only
- `builtIn: true`
- does not include `relayauth:role:manage:*` or `relayauth:policy:manage:*`

#### `relayauth-read-only`

Read-only access across planes.

```text
relaycast:*:read:*
relayfile:*:read:*
cloud:*:read:*
relayauth:*:read:*
```

Rules:

- org-scoped only
- `builtIn: true`
- cannot create, mutate, delete, run, send, or invoke resources unless those
  actions are also represented as `read` in the target plane, which they are
  not in the current scope spec

## Policies

### Canonical Types

The shared types are:

```ts
export type PolicyEffect = "allow" | "deny";

export type PolicyConditionType = "time" | "ip" | "identity" | "workspace";

export interface PolicyCondition {
  type: PolicyConditionType;
  operator: "eq" | "neq" | "in" | "not_in" | "gt" | "lt" | "matches";
  value: string | string[];
}

export interface Policy {
  id: string;
  name: string;
  effect: PolicyEffect;
  scopes: string[];
  conditions: PolicyCondition[];
  priority: number;
  orgId: string;
  workspaceId?: string;
  createdAt: string;
}
```

### Field Definition

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Unique policy identifier. Recommended format: `pol_<opaque>` |
| `name` | `string` | Yes | Human-readable policy name. Unique within `(orgId, workspaceId)` |
| `effect` | `"allow" \| "deny"` | Yes | Determines whether the policy grants or blocks matching requests |
| `scopes` | `string[]` | Yes | Non-empty array of valid scope strings this policy governs |
| `conditions` | `PolicyCondition[]` | Yes | All conditions must match for policy applicability |
| `priority` | `number` | Yes | Integer from `0` to `1000`, inclusive |
| `orgId` | `string` | Yes | Owning organization |
| `workspaceId` | `string` | No | If present, applies only in that workspace |
| `createdAt` | `string` | Yes | ISO 8601 UTC timestamp |

### Policy Constraints

- `name` should follow the same kebab-case rule as roles.
- `priority` must be an integer.
- `scopes` must not be empty.
- `conditions` may be empty. An empty condition list means the policy is
  unconditional once scope and binding match.
- Policies are data, not code. Evaluation must not require arbitrary execution.
- Policy creation must fail if the author lacks authority to manage the covered
  scopes. Specifically, the author must hold the `manage` action (or the
  specific action being governed) for every scope the policy targets. An actor
  with `relayauth:policy:manage:*` may create or modify policies only for
  scopes they independently hold. This prevents a policy-manager from creating
  deny policies that block scopes above their own privilege level.

### Effect Semantics

#### `deny`

- Immediately blocks the request if the policy applies.
- Overrides any matching allow policy, role grant, or direct scope.
- Is the primary mechanism for guardrails such as production protection,
  network restrictions, or suspension.

#### `allow`

- Signals that the request is permitted by policy if the policy applies.
- Does not override an applicable deny.
- Does not create capability outside the inherited scope boundary.
  Policy allows may grant access only within the identity's inherited boundary.
  This is not configurable. There is no opt-in mechanism for policy-allow as a
  grant source, because such a mechanism would allow any actor with
  policy-creation authority to escalate their own privileges.

This rule preserves least privilege and closes the privilege-escalation path
that would exist if policies could grant scopes beyond the inherited boundary.

## Policy Conditions

Policy conditions are evaluated with logical AND within a single policy.
Different policies are evaluated independently.

### Condition Evaluation Rules

- If any condition in a policy fails, the policy does not apply.
- `value` type must match the chosen operator.
- Unknown condition types or operators must cause policy validation failure.
- Comparisons are case-sensitive unless stated otherwise.

### Time-Based Conditions

Time conditions constrain when a policy is active.

Supported operators:

- `eq`
- `neq`
- `gt`
- `lt`
- `in`
- `not_in`
- `matches`

#### Value Formats and Sub-Types

Each time condition value must conform to exactly one of these formats. The
format is determined by the value shape — implementations must validate the
value against the applicable format at policy creation time:

| Format | Shape | Valid Operators | Compared Against |
| --- | --- | --- | --- |
| Full timestamp | ISO 8601 UTC (`2026-03-24T17:00:00Z`) | `eq`, `neq`, `gt`, `lt` | Request timestamp |
| Time-of-day | `HH:MM` 24-hour UTC (`09:00`, `17:00`) | `eq`, `neq`, `gt`, `lt` | UTC time-of-day extracted from request timestamp |
| Weekday set | Array of lowercase day abbreviations (`["mon", "tue"]`) | `in`, `not_in` | UTC weekday extracted from request timestamp |
| Pattern | Implementation-defined string (e.g., RFC 3339 recurring window) | `matches` | Request timestamp |

Normative interpretation:

- `gt` and `lt` compare against the request evaluation timestamp in UTC.
- If using hour/minute values, implementations compare the UTC time-of-day.
- If using weekday sets, implementations compare the UTC weekday.
- `matches` may be used for implementation-defined validated patterns, such as
  RFC 3339 recurring window encodings. If unsupported, creation must fail rather
  than silently ignore the condition.
- A value that does not match any recognized format must cause policy validation
  failure at creation time.

Examples:

```json
{ "type": "time", "operator": "gt", "value": "09:00" }
{ "type": "time", "operator": "lt", "value": "17:00" }
{ "type": "time", "operator": "in", "value": ["mon", "tue", "wed", "thu", "fri"] }
```

### IP-Based Conditions

IP conditions constrain the request source network.

Supported operators:

- `eq`
- `neq`
- `in`
- `not_in`
- `matches`

Note: `gt` and `lt` are intentionally excluded for IP conditions because
numeric comparison of IP addresses is rarely meaningful for access control.
CIDR-based membership (`in`, `not_in`) is the correct mechanism for range
matching.

Value formats:

- individual IPv4 or IPv6 address
- CIDR range
- array of addresses and/or CIDR ranges

Normative interpretation:

- `eq` and `neq` apply to exact normalized IP equality.
- `in` and `not_in` apply membership against a provided set of IPs or CIDRs.
- `matches` may be used for an implementation-provided IP or CIDR expression
  matcher, but only if its grammar is documented and validated at write time.

Examples:

```json
{ "type": "ip", "operator": "in", "value": ["10.0.0.0/8", "192.168.1.0/24"] }
{ "type": "ip", "operator": "not_in", "value": ["203.0.113.0/24"] }
{ "type": "ip", "operator": "eq", "value": "203.0.113.7" }
```

### Identity-Based Conditions

Identity conditions target a specific agent or set of agents.

Supported operators:

- `eq`
- `neq`
- `in`
- `not_in`
- `matches`

Value formats:

- identity ID such as `agent_8x2k`
- array of identity IDs
- validated pattern if `matches` is used

Normative interpretation:

- the compared value is the effective request identity ID
- identity conditions do not inspect sponsor chain by default
- sponsor-chain-aware conditions are out of scope for the current shared type

Examples:

```json
{ "type": "identity", "operator": "eq", "value": "agent_prod_deployer" }
{ "type": "identity", "operator": "in", "value": ["agent_a", "agent_b"] }
```

### Workspace-Based Conditions

Workspace conditions constrain a policy to one or more workspaces within the
same organization.

Supported operators:

- `eq`
- `neq`
- `in`
- `not_in`
- `matches`

Examples:

```json
{ "type": "workspace", "operator": "eq", "value": "ws_prod" }
{ "type": "workspace", "operator": "not_in", "value": ["ws_prod", "ws_finance"] }
```

## Inheritance Chain

The effective grant boundary is resolved in this order:

1. organization roles
2. workspace roles
3. direct scopes

This chain is paired with policies at organization and workspace level.

### Role Assignment Model

Role assignments are stored separately from the identity record. Each assignment
binds an identity to a role within a specific context:

```ts
interface RoleAssignment {
  identityId: string;
  roleId: string;
  orgId: string;
  workspaceId?: string;  // present for workspace-scoped assignments
  assignedAt: string;
}
```

The `loadAssignedOrgRoles` and `loadAssignedWorkspaceRoles` functions in the
pseudocode query this assignment table. An identity's `roles` array (if present
on the identity record) is a convenience denormalization of org-level
assignments only. Workspace-level role assignments are always resolved through
the assignment table using the `workspaceId` from the authorization request.

### Organization Roles

Organization roles define the baseline reusable grants available across the org.
If an identity is assigned one or more org roles, the union of those scopes
enters the inherited grant boundary.

### Workspace Roles

Workspace roles add workspace-specific scopes for the current workspace only.
They are unioned with applicable organization role scopes.

### Direct Scopes

Direct scopes are attached to the identity record itself.
They are intended for narrowly tailored exceptions or targeted reductions.

Normative rule:

- direct scopes are constrained to the maximum org/workspace boundary permitted
  for that identity. At write time, assigning a direct scope that exceeds the
  identity's role-derived boundary must fail.
- at resolution time, direct scopes are unioned with role-derived scopes. Since
  write-time validation guarantees they fall within the role boundary, this
  union cannot produce a scope set exceeding the boundary.
- if an identity's roles are later reduced, direct scopes that now exceed the
  new boundary must be treated as ineffective (filtered out during resolution)
  until explicitly revalidated.

For relayauth, the effective grant boundary is defined as:

```text
roleBoundary = union(orgRoleScopes, workspaceRoleScopes)
validDirectScopes = filterWithinBoundary(directScopes, roleBoundary)
grantBoundary = union(roleBoundary, validDirectScopes)
```

Note: `filterWithinBoundary` removes any direct scope not covered by the role
boundary. This ensures direct scopes can never broaden permissions beyond what
roles grant, while still allowing targeted additions within the role boundary.

This is then reduced by:

- parent delegation intersection, if the identity was delegated
- policy denies
- system suspension or retirement state

### Delegated Identities

If an identity or token was created through delegation:

```text
delegatedBoundary = intersect(parentEffectiveScopes, requestedChildScopes)
```

Rules:

- a child may never gain a scope the parent lacks
- child expiry may not exceed parent expiry
- child budget may not exceed parent budget
- any attempted escalation must fail issuance and emit an audit event

## Conflict Resolution

Conflict handling is strict and deterministic.

### Primary Rules

1. Explicit deny wins.
2. Organization-level deny policies always take precedence over workspace-level
   allow policies, regardless of numeric priority. This is enforced by
   evaluating org-level denies in a separate pass before workspace policies
   (see the `authorize()` pseudocode).
3. Higher priority is evaluated before lower priority within the same level.
4. If two applicable policies have the same priority, `deny` is evaluated before
   `allow`.
5. If no applicable allow or grant covers the request, the result is deny.
6. Direct scopes cannot override any deny policy.

### Priority Rules

- Higher numeric `priority` means higher precedence.
- Recommended default is `500`.
- Reserved system guardrail policies should use `1000`.
- Low-importance informational allow policies can use values below `500`.

### Tie Handling

When two applicable policies have equal priority and equal effect:

- stable ordering by `id` is recommended for audit reproducibility
- the final authorization outcome must still be the same because equal-effect
  policies do not conflict

## Effective Permission Calculation

Effective permission calculation produces the identity's resolved grant set
before checking a specific request.

### Inputs

The calculation requires:

- `orgId`
- `workspaceId`
- assigned org role IDs
- assigned workspace role IDs
- direct scopes
- applicable org policies
- applicable workspace policies
- delegated parent scope set, if any
- identity lifecycle state such as `active`, `suspended`, or `retired`

### Output

The output is:

- `effectiveScopes`: normalized scope set that may be exercised
- `effectiveDenies`: applicable deny policies relevant to future checks
- `decisionContext`: metadata for audit, including matched roles and policies

### Pseudocode: Effective Scope Resolution

This function computes the pre-request grant boundary. When called from
`authorize()`, `requestContext` is the `AuthorizationRequest` object. When
called outside of a specific request (e.g., for display or pre-computation),
callers must provide a synthetic `requestContext` with at minimum
`timestamp`, `identityId`, and `workspaceId`. Any condition that references a
missing attribute evaluates to false (see Runtime Safety).

```text
function computeEffectivePermissions(identity, workspaceId, requestContext):
  if identity.state in ["suspended", "retired", "deleted"]:
    return {
      effectiveScopes: [],
      effectiveDenies: ["system-lifecycle-deny"],
      decisionContext: { reason: identity.state }
    }

  orgRoles = loadAssignedOrgRoles(identity.id, identity.orgId)
  workspaceRoles = loadAssignedWorkspaceRoles(identity.id, identity.orgId, workspaceId)

  orgRoleScopes = unionScopes(orgRoles[].scopes)
  workspaceRoleScopes = unionScopes(workspaceRoles[].scopes)
  directScopes = normalizeScopes(identity.directScopes)

  roleBoundary = unionScopes(orgRoleScopes, workspaceRoleScopes)
  validDirectScopes = filterWithinBoundary(directScopes, roleBoundary)
  grantBoundary = unionScopes(roleBoundary, validDirectScopes)

  if identity.parentEffectiveScopes exists:
    grantBoundary = intersectScopes(grantBoundary, identity.parentEffectiveScopes)

  applicablePolicies = loadPolicies(identity.orgId, workspaceId)

  matchedDenyPolicies = []

  for policy in applicablePolicies:
    if not conditionsMatch(policy.conditions, requestContext):
      continue
    if policy.effect != "deny":
      continue
    matchedDenyPolicies.append(policy)

  effectiveScopes = subtractDeniedScopes(grantBoundary, matchedDenyPolicies[].scopes)

  return {
    effectiveScopes: normalizeAndCompress(effectiveScopes),
    effectiveDenies: matchedDenyPolicies,
    decisionContext: {
      orgRoles: orgRoles[].id,
      workspaceRoles: workspaceRoles[].id,
      denyPolicies: matchedDenyPolicies[].id
    }
  }
```

`subtractDeniedScopes` means:

- for each granted scope, remove the portion covered by matching deny scopes
- implementations may keep a parallel deny matcher rather than materializing
  subtraction if wildcard expansion would be expensive

## Runtime Authorization Algorithm

Runtime authorization decides whether a specific requested scope is allowed.

### Authorization Input

```ts
interface AuthorizationRequest {
  identityId: string;
  orgId: string;
  workspaceId: string;
  requestedScope: string;
  timestamp: string;
  ip?: string;
}
```

The `AuthorizationRequest` is the canonical request context passed to both
`authorize()` and `computeEffectivePermissions()`. The `conditionsMatch`
function receives this object and must be able to extract the following fields
for condition evaluation:

- `timestamp` (required): ISO 8601 UTC — used for time conditions
- `ip` (optional): source IP — used for IP conditions
- `identityId` (required): effective identity — used for identity conditions
- `workspaceId` (required): target workspace — used for workspace conditions

### Pseudocode: Authorization Check

The `authorize()` function is the authoritative runtime decision path. It calls
`computeEffectivePermissions()` internally to resolve the grant boundary, then
applies policy denies and checks grant coverage in a single unified flow.

```text
function authorize(request):
  identity = loadIdentity(request.identityId)

  if identity.orgId != request.orgId:
    return deny("org_mismatch")

  if identity.state in ["suspended", "retired", "deleted"]:
    return deny("identity_inactive")

  // Step 1: Compute the effective grant boundary.
  // This resolves roles, direct scopes, delegation intersection,
  // and subtracts unconditional deny policy scopes.
  permissions = computeEffectivePermissions(identity, request.workspaceId, request)

  // Step 2: Load and filter policies applicable to this specific request.
  candidatePolicies = loadPolicies(request.orgId, request.workspaceId)

  applicablePolicies = []
  for policy in candidatePolicies:
    if not anyScopeMatches(policy.scopes, request.requestedScope):
      continue
    if policy.workspaceId exists and policy.workspaceId != request.workspaceId:
      continue
    if not conditionsMatch(policy.conditions, request):
      continue
    applicablePolicies.append(policy)

  // Step 3: Evaluate org-level denies first (they outrank all workspace policies).
  orgDenyPolicies = [p for p in applicablePolicies
                     where p.effect == "deny" and p.workspaceId not exists]
  sort orgDenyPolicies by priority descending, id ascending

  for policy in orgDenyPolicies:
    return deny("org_policy_deny", policy.id)

  // Step 4: Evaluate remaining policies by priority, deny-first.
  remainingPolicies = [p for p in applicablePolicies where p not in orgDenyPolicies]
  sort remainingPolicies by:
    priority descending,
    effect deny before allow,
    id ascending

  for policy in remainingPolicies:
    if policy.effect == "deny":
      return deny("policy_deny", policy.id)

  // Step 5: Check if the requested scope is within the effective grant boundary.
  if anyScopeMatches(permissions.effectiveScopes, request.requestedScope):
    return allow("granted", permissions.decisionContext)

  return deny("implicit_deny")
```

### Notes

- `computeEffectivePermissions()` is called once per authorization request.
  The same `AuthorizationRequest` object is passed as `requestContext` to ensure
  deny evaluation uses identical conditions in both the pre-computation and the
  runtime check.
- Org-level deny policies are evaluated in a separate pass before workspace
  policies to enforce the rule that workspace allows cannot override org denies.
- Allow policies do not appear as a separate grant source. They are subsumed by
  the effective permissions check — a scope must be within the inherited grant
  boundary (after deny subtraction) to be allowed. Allow policies may narrow
  *when* a grant is active (e.g., time/IP windows) by having corresponding deny
  policies for the inverse condition, but they cannot expand the boundary.
- Implementations may short-circuit after the first deny.
- Every authorization result must emit an audit log with matched roles,
  matched policies, decision reason, and sponsor chain context if available.

## Common Role Setups

### Example 1: Basic Engineering Workspace

Organization roles:

- `relayauth-developer`
- `relayauth-read-only`

Workspace roles:

- `backend-deployer`
- `incident-reviewer`

Role definitions:

```text
backend-deployer
- cloud:workflow:run:*
- relayfile:fs:write:/services/backend/*
- relayfile:fs:read:/services/backend/*

incident-reviewer
- relayauth:audit:read:*
- relaycast:channel:read:#incidents
- relaycast:channel:send:#incidents
```

Result:

- normal developers get broad plane access
- only `backend-deployer` identities can write backend service files or run
  deploy workflows

### Example 2: Production Read/Write Split

Organization roles:

- `relayauth-read-only`

Workspace roles in `ws_prod`:

- `prod-operator`
- `prod-observer`

Definitions:

```text
prod-operator
- cloud:workflow:run:prod-*
- relaycast:channel:send:#prod-ops

prod-observer
- cloud:workflow:read:prod-*
- relaycast:channel:read:#prod-ops
```

Result:

- all identities can inspect production if assigned `prod-observer`
- only `prod-operator` can trigger production workflows

### Example 3: Narrow Direct Scope Exception

Identity has role:

- `relayauth-read-only`

Direct scope:

- `relayfile:fs:read:/reports/q1-2026.csv`

Result:

- the identity remains broadly read-only
- it gets one narrow file read exception without needing a new reusable role

## Policy Deny Patterns

### Pattern 1: Block Production Deletes Everywhere

```json
{
  "name": "deny-prod-delete",
  "effect": "deny",
  "scopes": ["cloud:workflow:delete:prod-*", "relayfile:fs:delete:/prod/*"],
  "conditions": [],
  "priority": 900,
  "orgId": "org_acme"
}
```

Use when:

- production deletes should never be possible except through a separate,
  tightly controlled break-glass path

### Pattern 2: Allow Business Hours, Deny After Hours

```json
{
  "name": "deny-after-hours-deploy",
  "effect": "deny",
  "scopes": ["cloud:workflow:run:prod-*"],
  "conditions": [
    { "type": "time", "operator": "lt", "value": "09:00" }
  ],
  "priority": 800,
  "orgId": "org_acme",
  "workspaceId": "ws_prod"
}
```

Combine with:

- a second deny for `gt 17:00`
- or a validated `matches` recurring time-window condition if supported

### Pattern 3: Restrict Sensitive Actions to Corporate Network

```json
{
  "name": "deny-non-corp-ip-for-admin",
  "effect": "deny",
  "scopes": ["relayauth:admin:manage:*", "relayauth:policy:manage:*"],
  "conditions": [
    { "type": "ip", "operator": "not_in", "value": ["10.0.0.0/8", "192.168.0.0/16"] }
  ],
  "priority": 950,
  "orgId": "org_acme"
}
```

### Pattern 4: Freeze a Specific Identity

```json
{
  "name": "deny-agent-8x2k-all",
  "effect": "deny",
  "scopes": ["*:*:*:*"],
  "conditions": [
    { "type": "identity", "operator": "eq", "value": "agent_8x2k" }
  ],
  "priority": 1000,
  "orgId": "org_acme"
}
```

Use when:

- emergency disable is needed before lifecycle state propagates globally

### Pattern 5: Workspace Isolation Guardrail

```json
{
  "name": "deny-finance-outside-workspace",
  "effect": "deny",
  "scopes": ["relayfile:fs:read:/finance/*", "relayfile:fs:write:/finance/*"],
  "conditions": [
    { "type": "workspace", "operator": "neq", "value": "ws_finance" }
  ],
  "priority": 850,
  "orgId": "org_acme"
}
```

## Validation and Safety Rules

### Write-Time Validation

Implementations must reject:

- malformed scopes
- empty role scope arrays
- empty policy scope arrays
- invalid policy priorities
- unknown condition types
- invalid operator/value combinations
- custom roles or policies that exceed the caller's authority
- delegated scope sets that exceed the parent set

### Runtime Safety

Implementations must:

- default to deny on parsing or lookup failure
- audit every deny caused by policy, lifecycle state, or delegation failure
- include enough context to reconstruct the decision path
- treat missing optional request attributes conservatively

Examples:

- if a request attribute required by a condition is missing (e.g., IP is absent
  but a policy has an IP condition), the condition evaluates to **false**. This
  means: a deny policy with an IP condition does not apply if no IP is present
  (the deny requires the condition to match), and an allow policy with an IP
  condition also does not apply. The net effect is that missing attributes
  cause the request to fall through to implicit deny if no other grant covers
  it, which is the safe default.
- if time parsing fails, the safe result is deny

## Audit Requirements

Each authorization decision should emit:

- `identityId`
- `orgId`
- `workspaceId`
- `requestedScope`
- matched role IDs
- matched allow policy IDs
- matched deny policy IDs
- final decision
- decision reason
- timestamp
- sponsor chain, if available in the identity/token context

This supports the architecture requirement that every action traces back to a
human sponsor.

## Summary

This specification defines the full relayauth RBAC model in
`specs/rbac.md`. It includes:

- role fields, constraints, and built-in roles
- policy format, effect semantics, and condition behavior
- time, IP, identity, and workspace condition rules
- inheritance from org roles to workspace roles to direct scopes
- deterministic conflict resolution where explicit deny always wins
- pseudocode for effective permission calculation and runtime authorization
- concrete role and deny-policy examples for common deployments
