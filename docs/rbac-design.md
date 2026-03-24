# RBAC Specification

## Purpose

This document defines the Role-Based Access Control (RBAC) system for relayauth.
RBAC layers named roles and conditional policies on top of the scope-based
capability model. Together, scopes define what is possible; roles bundle scopes
into assignable units; policies add contextual allow/deny rules evaluated at
authorization time.

## Roles

### Role Format

A role is a named bundle of scopes bound to an organization and optionally to a
workspace.

```ts
interface Role {
  id: string;              // "role_xxxx" — unique identifier
  name: string;            // human-readable, unique within org+workspace
  description: string;     // purpose of this role
  scopes: string[];        // array of scope strings (4-segment normalized)
  orgId: string;           // owning organization
  workspaceId?: string;    // if set, role is workspace-scoped; otherwise org-wide
  builtIn: boolean;        // true for system-defined roles
  createdAt: string;       // ISO 8601 timestamp
}
```

### Naming Rules

- Role names must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$` (lowercase kebab-case).
- Maximum length: 64 characters.
- Names prefixed with `relayauth-` are reserved for built-in roles.
- Role names must be unique within their org+workspace combination.

### Org vs Workspace Binding

- **Org-scoped role** (`workspaceId` omitted): available to all workspaces in the
  org. Useful for cross-workspace roles like `admin` or `read-only`.
- **Workspace-scoped role** (`workspaceId` set): available only within that
  workspace. Useful for team-specific roles like `billing-developer`.

When a workspace-scoped role and an org-scoped role share the same name, the
workspace-scoped role takes precedence for identities in that workspace.

### Built-in Roles

The following roles are created automatically for every organization and cannot
be deleted or renamed. Their scopes can be viewed but not modified.

| Role Name | Scope Summary | Description |
| --- | --- | --- |
| `relayauth-admin` | `relayauth:*:manage:*`, `relayauth:*:read:*` | Full administrative access to relayauth resources. Can manage identities, roles, policies, tokens, and audit logs. |
| `relayauth-developer` | `relaycast:*:*:*`, `relayfile:*:*:*`, `cloud:*:*:*`, `relayauth:token:create:*`, `relayauth:token:read:*`, `relayauth:identity:read:*`, `relayauth:scope:read:*` | Full access to product planes. Can create tokens and read identities, but cannot manage RBAC configuration. |
| `relayauth-read-only` | `relaycast:*:read:*`, `relayfile:*:read:*`, `cloud:*:read:*`, `relayauth:*:read:*` | Read-only access across all planes. Cannot create, modify, or delete any resource. |

Built-in roles have `builtIn: true` and are org-scoped (no `workspaceId`).

### Custom Roles

Organizations can create custom roles with any valid subset of scopes. Custom
roles:

- Must have `builtIn: false`.
- May be org-scoped or workspace-scoped.
- May reference any valid scope string (validated against the scope spec).
- May not contain scopes that exceed the creating identity's own effective
  permissions (enforced at creation time).

## Policies

### Policy Format

A policy is a conditional rule evaluated at authorization time to allow or deny
access to scopes.

```ts
interface Policy {
  id: string;                    // "pol_xxxx" — unique identifier
  name: string;                  // human-readable name
  effect: "allow" | "deny";     // whether this policy grants or blocks access
  scopes: string[];              // scopes this policy applies to
  conditions: PolicyCondition[]; // all conditions must match for policy to apply
  priority: number;              // 0-1000, higher = evaluated first
  orgId: string;                 // owning organization
  workspaceId?: string;          // if set, applies only within that workspace
  createdAt: string;             // ISO 8601 timestamp
}
```

### Policy Conditions

Conditions narrow when a policy applies. All conditions in a policy must match
(AND logic). If a policy has no conditions, it applies unconditionally.

```ts
type PolicyConditionType = "time" | "ip" | "identity" | "workspace";

interface PolicyCondition {
  type: PolicyConditionType;
  operator: "eq" | "neq" | "in" | "not_in" | "gt" | "lt" | "matches";
  value: string | string[];
}
```

#### Condition Types

| Type | Description | Valid Operators | Value Format |
| --- | --- | --- | --- |
| `time` | Current UTC time | `gt`, `lt` | ISO 8601 time string (`"09:00"`, `"17:00"`) or day (`"monday"`) |
| `ip` | Request source IP | `eq`, `neq`, `in`, `not_in`, `matches` | IP address, CIDR range, or array of either |
| `identity` | Agent identity ID | `eq`, `neq`, `in`, `not_in` | Identity ID string or array |
| `workspace` | Workspace ID | `eq`, `neq`, `in`, `not_in` | Workspace ID string or array |

#### Condition Examples

```json
// Only during business hours (UTC)
{ "type": "time", "operator": "gt", "value": "09:00" }
{ "type": "time", "operator": "lt", "value": "17:00" }

// Block access from outside the corporate CIDR
{ "type": "ip", "operator": "not_in", "value": ["10.0.0.0/8", "172.16.0.0/12"] }

// Apply only to a specific agent
{ "type": "identity", "operator": "eq", "value": "agent_8x2k" }
```

### Priority

- Range: 0 to 1000 (inclusive).
- Higher priority policies are evaluated first.
- Within the same priority, deny policies are evaluated before allow policies.
- Default priority for new policies: 500.
- Built-in system policies (e.g., org-level deny-all for suspended identities)
  use priority 1000 and cannot be overridden.

### Org vs Workspace Binding

Like roles, policies can be org-scoped or workspace-scoped:

- **Org-scoped policy**: applies to all workspaces. Cannot be overridden by
  workspace-scoped allow policies (deny takes precedence).
- **Workspace-scoped policy**: applies only within that workspace.

## Evaluation Order

### Authorization Request

An authorization request contains:

```ts
interface AuthorizationRequest {
  identityId: string;       // the agent requesting access
  requestedScope: string;   // the scope being checked
  orgId: string;            // organization context
  workspaceId: string;      // workspace context
  ip?: string;              // source IP (if available)
  timestamp: string;        // current UTC time
}
```

### Evaluation Algorithm

The evaluation follows a **deny-first, priority-ordered** model:

```
1. COLLECT applicable policies
   a. Gather all org-scoped policies for orgId
   b. Gather all workspace-scoped policies for orgId + workspaceId
   c. Filter to policies whose scopes match the requestedScope
   d. Filter to policies whose conditions all evaluate to true

2. SORT by priority descending, then effect (deny before allow within same priority)

3. EVALUATE in order
   a. If a deny policy matches → DENY (stop, return denial reason)
   b. If an allow policy matches → mark as policy-allowed

4. CHECK role-based scopes (if no policy explicitly denied)
   a. Resolve identity's assigned roles
   b. Expand roles to their constituent scopes
   c. Union role scopes with any direct scopes on the identity
   d. Check if requestedScope is matched by the effective scope set

5. DECIDE
   a. If step 3 produced a deny → DENY
   b. If the effective scope set (step 4) covers the requestedScope → ALLOW
   c. Otherwise → DENY (implicit deny — no matching permission)
```

### Key Rules

1. **Explicit deny always wins.** A deny policy at any level overrides any allow
   policy or role grant, regardless of priority differences (deny at priority 100
   still beats allow at priority 900).
2. **Policies are evaluated before roles.** Policies can block access even if a
   role would grant it.
3. **Implicit deny is the default.** If no policy or role grants access, the
   request is denied.
4. **Suspended identities are always denied.** A system-level deny policy at
   priority 1000 blocks all scopes for suspended identities.

## Inheritance: Org -> Workspace -> Agent

Permissions are resolved through a three-level hierarchy. Each level can narrow
but never broaden the level above it.

### Level 1: Organization

- Org-scoped roles define the maximum permission boundary for the org.
- Org-scoped deny policies apply globally to all workspaces.
- The org admin can set org-wide constraints (e.g., "no agent may delete
  production resources").

### Level 2: Workspace

- Workspace-scoped roles further narrow permissions within a workspace.
- Workspace-scoped policies add workspace-specific rules.
- A workspace cannot grant scopes beyond what the org allows.

### Level 3: Agent (Identity)

- An identity has directly assigned scopes and assigned roles.
- The identity's effective permissions are the intersection of:
  - What the org permits (org roles + org policies)
  - What the workspace permits (workspace roles + workspace policies)
  - What the identity is granted (direct scopes + role scopes)

### Inheritance Rules

1. **Narrowing only.** A workspace policy cannot override an org-level deny.
   A workspace role cannot grant scopes not available at the org level.
2. **Deny propagates down.** An org-level deny applies to all workspaces and
   all identities within those workspaces.
3. **Roles compose via union.** If an identity has multiple roles, the effective
   scopes are the union of all role scopes.
4. **Policies compose via evaluation order.** Multiple policies interact through
   the priority-ordered deny-first algorithm above.

### Inheritance Diagram

```
Organization (org_acme)
├── Org Roles: [relayauth-admin, relayauth-developer, relayauth-read-only, custom-org-role]
├── Org Policies: [deny-delete-prod, business-hours-only]
│
├── Workspace (ws_staging)
│   ├── Workspace Roles: [staging-deployer]
│   ├── Workspace Policies: [allow-all-ips]
│   │
│   ├── agent_abc (roles: [relayauth-developer, staging-deployer])
│   │   └── effective = union(developer scopes, staging-deployer scopes)
│   │       MINUS org deny policies MINUS workspace deny policies
│   │
│   └── agent_def (roles: [relayauth-read-only])
│       └── effective = read-only scopes
│           MINUS org deny policies MINUS workspace deny policies
│
└── Workspace (ws_prod)
    ├── Workspace Roles: [prod-operator]
    ├── Workspace Policies: [restrict-to-vpn, deny-write-after-hours]
    │
    └── agent_ghi (roles: [relayauth-developer, prod-operator])
        └── effective = union(developer scopes, prod-operator scopes)
            MINUS org deny policies MINUS workspace deny policies
```

## Effective Permissions Calculation

### Algorithm

Given an identity, org, and workspace, compute the effective permission set:

```ts
function computeEffectivePermissions(
  identity: AgentIdentity,
  orgId: string,
  workspaceId: string,
  allRoles: Role[],
  allPolicies: Policy[]
): EffectivePermissions {
  // Step 1: Resolve roles
  const assignedRoles = allRoles.filter(r =>
    identity.roles.includes(r.id) &&
    r.orgId === orgId &&
    (r.workspaceId === undefined || r.workspaceId === workspaceId)
  );

  // Step 2: Union all role scopes + direct identity scopes
  const grantedScopes = new Set<string>();
  for (const role of assignedRoles) {
    for (const scope of role.scopes) {
      grantedScopes.add(scope);
    }
  }
  for (const scope of identity.scopes) {
    grantedScopes.add(scope);
  }

  // Step 3: Collect applicable policies
  const applicablePolicies = allPolicies
    .filter(p =>
      p.orgId === orgId &&
      (p.workspaceId === undefined || p.workspaceId === workspaceId)
    )
    .sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority;
      // deny before allow at same priority
      if (a.effect === "deny" && b.effect !== "deny") return -1;
      if (b.effect === "deny" && a.effect !== "deny") return 1;
      return 0;
    });

  // Step 4: Partition into deny and allow policies
  const denyPolicies = applicablePolicies.filter(p => p.effect === "deny");
  const allowPolicies = applicablePolicies.filter(p => p.effect === "allow");

  return {
    grantedScopes: Array.from(grantedScopes),
    denyPolicies,
    allowPolicies,
  };
}
```

### Runtime Authorization Check

At request time, the full check combines effective permissions with policy
condition evaluation:

```ts
function authorize(
  request: AuthorizationRequest,
  effective: EffectivePermissions
): AuthorizationResult {
  // 1. Check deny policies first
  for (const policy of effective.denyPolicies) {
    if (
      scopeMatchesAny(request.requestedScope, policy.scopes) &&
      allConditionsMet(policy.conditions, request)
    ) {
      return { allowed: false, reason: `denied by policy: ${policy.name}` };
    }
  }

  // 2. Check allow policies (may grant scopes beyond roles)
  let policyAllowed = false;
  for (const policy of effective.allowPolicies) {
    if (
      scopeMatchesAny(request.requestedScope, policy.scopes) &&
      allConditionsMet(policy.conditions, request)
    ) {
      policyAllowed = true;
      break;
    }
  }

  // 3. Check role/direct scope grants
  const scopeGranted = scopeMatchesAny(
    request.requestedScope,
    effective.grantedScopes
  );

  // 4. Allow if either policy or scope grants access
  if (policyAllowed || scopeGranted) {
    return { allowed: true };
  }

  // 5. Implicit deny
  return { allowed: false, reason: "no matching permission" };
}
```

### Delegation Constraint

When an agent issues a sub-agent token:

1. The sub-agent's roles must resolve to scopes that are a subset of the
   parent's effective scopes (`isSubsetOf(childScopes, parentScopes)`).
2. The sub-agent cannot be assigned roles that the parent does not effectively
   hold.
3. Deny policies on the parent propagate to the child — the child inherits the
   parent's policy restrictions.
4. Failed escalation attempts are logged as audit events with the full sponsor
   chain.

## Audit Integration

All RBAC operations produce audit events:

| Event | Trigger |
| --- | --- |
| `role.created` | New role created |
| `role.updated` | Role scopes or metadata modified |
| `role.deleted` | Role removed |
| `role.assigned` | Role assigned to an identity |
| `role.unassigned` | Role removed from an identity |
| `policy.created` | New policy created |
| `policy.updated` | Policy conditions, scopes, or effect modified |
| `policy.deleted` | Policy removed |
| `authorization.denied` | Access check resulted in denial |
| `authorization.escalation_blocked` | Sub-agent attempted scope escalation |

Every audit event includes the full sponsor chain, org, workspace, and the
identity that initiated the action.

## API Surface (Summary)

### Role Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/orgs/{orgId}/roles` | Create a role |
| `GET` | `/v1/orgs/{orgId}/roles` | List org roles |
| `GET` | `/v1/orgs/{orgId}/roles/{roleId}` | Get role details |
| `PUT` | `/v1/orgs/{orgId}/roles/{roleId}` | Update a role |
| `DELETE` | `/v1/orgs/{orgId}/roles/{roleId}` | Delete a role |
| `POST` | `/v1/orgs/{orgId}/identities/{identityId}/roles` | Assign role to identity |
| `DELETE` | `/v1/orgs/{orgId}/identities/{identityId}/roles/{roleId}` | Remove role from identity |

### Policy Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/orgs/{orgId}/policies` | Create a policy |
| `GET` | `/v1/orgs/{orgId}/policies` | List policies |
| `GET` | `/v1/orgs/{orgId}/policies/{policyId}` | Get policy details |
| `PUT` | `/v1/orgs/{orgId}/policies/{policyId}` | Update a policy |
| `DELETE` | `/v1/orgs/{orgId}/policies/{policyId}` | Delete a policy |

### Authorization Endpoint

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/authorize` | Check if an identity is authorized for a scope |

## Summary

This specification defines:

- Roles as named, org/workspace-bound bundles of scopes
- Three built-in roles: admin, developer, read-only
- Policies as conditional allow/deny rules with priority ordering
- Deny-first evaluation with implicit deny as the default
- Three-level inheritance: org -> workspace -> agent (narrowing only)
- Effective permissions as the union of role + direct scopes, filtered by policies
- Delegation constraints ensuring sub-agents never exceed parent permissions
- Full audit trail for all RBAC mutations and authorization decisions
