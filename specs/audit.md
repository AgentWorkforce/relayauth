# Audit Log Specification

## Purpose

This document defines the relayauth audit logging model, entry schema, action
trigger rules, D1 storage contract, query behavior, retention, export formats,
and webhook delivery semantics.

The audit log is the accountability plane for relayauth. It records
security-relevant events across token issuance and validation, identity
lifecycle changes, scope evaluation, RBAC changes, and signing key operations.
Every event must remain attributable to an organization, an acting identity,
and through the sponsor chain to a human sponsor.

This specification is normative for:

- `AuditAction` values and their trigger conditions
- `AuditEntry` field definitions and validation rules
- D1 `audit_logs` table shape and indexes
- audit query filters and cursor pagination
- retention configuration and cleanup behavior
- JSON and CSV export formats
- audit webhook payloads and delivery guarantees

## Canonical Types

The shared public types are:

```ts
export type AuditAction =
  | "token.issued"
  | "token.refreshed"
  | "token.revoked"
  | "token.validated"
  | "identity.created"
  | "identity.updated"
  | "identity.suspended"
  | "identity.retired"
  | "scope.checked"
  | "scope.denied"
  | "role.assigned"
  | "role.removed"
  | "policy.created"
  | "policy.updated"
  | "policy.deleted"
  | "key.rotated";

export interface AuditEntry {
  id: string;
  action: AuditAction;
  identityId: string;
  orgId: string;
  workspaceId?: string;
  plane?: string;
  resource?: string;
  result: "allowed" | "denied" | "error";
  metadata?: Record<string, string>;
  ip?: string;
  userAgent?: string;
  timestamp: string;
  createdAt?: string;
}

export interface AuditQuery {
  identityId?: string;
  action?: AuditAction;
  orgId?: string;
  workspaceId?: string;
  plane?: string;
  result?: "allowed" | "denied";
  from?: string;
  to?: string;
  cursor?: string;
  limit?: number;
}
```

The specification below defines the normative semantics for these shapes.

## Audit Entry Schema

Every persisted audit record must conform to the `AuditEntry` contract plus the
storage rules in this document.

### Field Definitions

| Field | Type | Required | Rules |
| --- | --- | --- | --- |
| `id` | `string` | Yes | Unique audit event identifier. Must match `^aud_[A-Za-z0-9_-]+$`. Immutable. |
| `action` | `AuditAction` | Yes | Must be one of the 16 action values defined in this spec. |
| `identityId` | `string` | Yes | Acting agent identity. Must match `^agent_[A-Za-z0-9_-]+$`. For system-initiated maintenance actions, use the relayauth system identity reserved by the implementation. |
| `orgId` | `string` | Yes | Owning organization. Must match `^org_[A-Za-z0-9_-]+$`. Every query and retention decision is scoped by `orgId`. |
| `workspaceId` | `string` | No | Workspace context when the action is workspace-bound. Must match `^ws_[A-Za-z0-9_-]+$` when present. |
| `plane` | `string` | No | Plane involved in the event. Usually `relayauth`, `relaycast`, `relayfile`, or `cloud`. Custom planes are allowed if the deployment allows them elsewhere. |
| `resource` | `string` | No | Resource or target the action touched. Examples: `token:tok_123`, `channel:#billing`, `policy:pol_abc`, `key:ra_2026_03_access_a1b2c3`. |
| `result` | `"allowed" \| "denied" \| "error"` | Yes | Outcome of the logged action. `allowed` means success or grant, `denied` means a policy or authorization refusal, `error` means execution failed after the action was attempted. |
| `metadata` | `Record<string, string>` | No | Flat string map for action-specific detail. Keys and values must be strings. Nested JSON must be string-encoded by the producer. |
| `ip` | `string` | No | Source IP as observed by the edge or API server. Preserve the canonical client IP after trusted proxy processing. |
| `userAgent` | `string` | No | Raw `User-Agent` header or SDK identifier when available. |
| `timestamp` | `string` | Yes | Event time in ISO 8601 UTC with millisecond precision, for example `2026-03-24T17:04:05.123Z`. |
| `createdAt` | `string` | No | Database insertion time in ISO 8601 UTC. Present in exports and query responses. Useful for compliance and forensic analysis to distinguish when an event occurred (`timestamp`) from when it was recorded, especially under delayed ingestion. |

### Required Event Semantics

- An audit entry must be appended exactly once for a completed event emission.
- Audit entries are immutable after insert.
- `timestamp` records when the audited event happened, not when the row was
  exported or queried.
- `orgId` and `identityId` must always be present, even when `workspaceId`,
  `plane`, or `resource` are absent.
- Producers must prefer `result: "error"` over dropping the event when the
  business operation reached execution but failed.
- Producers must prefer `result: "denied"` for policy refusals, scope misses,
  suspended identities, expired tokens, and revoked tokens.

### Metadata Conventions

`metadata` is intentionally extensible. The following keys are reserved and
should be used where applicable:

| Key | Used By | Meaning |
| --- | --- | --- |
| `tokenId` | `token.*`, `scope.*` | Token `jti` involved in the request |
| `refreshTokenId` | `token.refreshed` | Refresh token `jti` consumed |
| `newTokenId` | `token.issued`, `token.refreshed` | Newly minted token `jti` |
| `sponsorId` | all | Human sponsor ID at the head of the chain |
| `sponsorChain` | all | JSON-encoded array of sponsor chain IDs |
| `parentIdentityId` | `identity.created` | Parent agent ID when a sub-agent is created |
| `parentTokenId` | delegated token actions | Parent token used for delegation |
| `scope` | `scope.checked`, `scope.denied` | Scope string evaluated |
| `matchedScope` | `scope.checked` | Effective granted scope that satisfied the check |
| `roleName` | `role.assigned`, `role.removed` | Role name affected |
| `policyId` | `policy.*` | Policy identifier |
| `keyId` | `key.rotated` | Key identifier rotated in or out |
| `reason` | revocation, suspension, deny, error | Human-readable explanation |
| `ttlSeconds` | `token.issued`, `token.refreshed` | Access token TTL in seconds |
| `budgetRemaining` | budget-related checks | Remaining behavioral budget snapshot |
| `requestId` | all request-bound events | Request correlation ID |
| `actorType` | admin mutations | `agent`, `human`, or `system` as serialized text |

Reserved keys must not be repurposed with different semantics.

## AuditAction Trigger Rules

Each `AuditAction` value has a single canonical meaning.

### Token Actions

#### `token.issued`

Emit when relayauth successfully mints a new access token or refresh token.

- Typical `result`: `allowed`
- `resource`: `token:<new jti>`
- Recommended metadata:
  `newTokenId`, `parentTokenId`, `ttlSeconds`, `sponsorChain`
- Do not emit for failed issuance attempts. Failed issuance is represented by
  the initiating admin or API action elsewhere if that surface is audited.

#### `token.refreshed`

Emit when a valid refresh token is exchanged for a new access token, and
optionally a rotated refresh token if rotation is enabled.

- Typical `result`: `allowed`
- `resource`: `token:<new access jti>`
- Recommended metadata:
  `refreshTokenId`, `newTokenId`, `ttlSeconds`, `sponsorChain`

#### `token.revoked`

Emit when a token is explicitly revoked by API, CLI, admin console, logout, or
bulk revocation workflow.

- Typical `result`: `allowed`
- `resource`: `token:<revoked jti>` or `token:*` for bulk revocation
- Recommended metadata:
  `tokenId`, `reason`, `requestId`

#### `token.validated`

Emit when a token is presented to relayauth middleware or edge validation logic
and the token is checked for signature, expiry, audience, revocation, and basic
shape validity.

- Typical `result`: `allowed` or `denied`
- `resource`: token target or request resource if known
- Recommended metadata:
  `tokenId`, `reason`, `sponsorChain`, `requestId`
- `denied` reasons include invalid signature, expired token, wrong audience,
  revoked token, malformed claims, or suspended identity
- High-volume action

### Identity Actions

#### `identity.created`

Emit when a new agent identity is created.

- Typical `result`: `allowed`
- `resource`: `identity:<identityId>`
- Recommended metadata:
  `parentIdentityId`, `sponsorId`, `sponsorChain`, `requestId`
- Root agent creation omits `parentIdentityId`

#### `identity.updated`

Emit when mutable identity properties change, including name, description,
scopes, behavioral budget, sponsor metadata, or workspace assignment.

- Typical `result`: `allowed`
- `resource`: `identity:<identityId>`
- Recommended metadata:
  `reason`, `requestId`

#### `identity.suspended`

Emit when an identity is suspended manually or automatically due to policy or
budget enforcement.

- Typical `result`: `allowed`
- `resource`: `identity:<identityId>`
- Recommended metadata:
  `reason`, `budgetRemaining`, `requestId`

#### `identity.retired`

Emit when an identity is permanently retired and may no longer authenticate.

- Typical `result`: `allowed`
- `resource`: `identity:<identityId>`
- Recommended metadata:
  `reason`, `requestId`

### Scope Actions

#### `scope.checked`

Emit for every authorization evaluation of a requested scope against the
identity's effective permissions and applicable policies.

- Typical `result`: `allowed`, `denied`, or `error`
- `plane` should match the requested scope plane
- `resource` should identify the protected target when known
- Recommended metadata:
  `scope`, `matchedScope`, `tokenId`, `budgetRemaining`, `reason`, `requestId`
- Emit even when the check denies access
- High-volume action

#### `scope.denied`

Emit as a companion event when a scope evaluation results in denial and fast
deny-only searching is needed.

- Required `result`: `denied`
- `plane` should match the requested scope plane
- `resource` should identify the denied target when known
- Recommended metadata:
  `scope`, `tokenId`, `reason`, `requestId`
- This event is redundant by design and exists for operational query speed
- High-volume action

### RBAC Actions

#### `role.assigned`

Emit when a role is assigned to an identity in an org or workspace.

- Typical `result`: `allowed`
- `resource`: `role:<roleName>`
- Recommended metadata:
  `roleName`, `requestId`

#### `role.removed`

Emit when a role assignment is removed from an identity.

- Typical `result`: `allowed`
- `resource`: `role:<roleName>`
- Recommended metadata:
  `roleName`, `requestId`

#### `policy.created`

Emit when a new RBAC policy is created.

- Typical `result`: `allowed`
- `resource`: `policy:<policyId>`
- Recommended metadata:
  `policyId`, `requestId`

#### `policy.updated`

Emit when an existing RBAC policy is modified.

- Typical `result`: `allowed`
- `resource`: `policy:<policyId>`
- Recommended metadata:
  `policyId`, `requestId`

#### `policy.deleted`

Emit when a policy is deleted.

- Typical `result`: `allowed`
- `resource`: `policy:<policyId>`
- Recommended metadata:
  `policyId`, `requestId`

### Key Management Action

#### `key.rotated`

Emit when a signing key is rotated into active service, demoted to grace, or
retired from signing use.

- Typical `result`: `allowed`
- `resource`: `key:<keyId>`
- Recommended metadata:
  `keyId`, `reason`, `requestId`

## Storage Contract

Audit records are stored in Cloudflare D1. The table name is `audit_logs`.

### D1 Table DDL

```sql
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL CHECK (
    action IN (
      'token.issued',
      'token.refreshed',
      'token.revoked',
      'token.validated',
      'identity.created',
      'identity.updated',
      'identity.suspended',
      'identity.retired',
      'scope.checked',
      'scope.denied',
      'role.assigned',
      'role.removed',
      'policy.created',
      'policy.updated',
      'policy.deleted',
      'key.rotated'
    )
  ),
  identity_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  plane TEXT,
  resource TEXT,
  result TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'error')),
  metadata_json TEXT,
  ip TEXT,
  user_agent TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

### Column Semantics

- `metadata_json` stores the serialized `metadata` object as a JSON string.
- `timestamp` is the event timestamp supplied by the producer.
- `created_at` is the database insertion time used for operational cleanup and
  lag inspection.
- Implementations may add non-breaking auxiliary tables for export jobs,
  webhook delivery attempts, or sponsor chain acceleration, but this table is
  the canonical audit event store.

### Write Behavior

- Low-volume administrative events should be inserted synchronously.
- High-volume events may be buffered and flushed in small batches.
- Buffered writes must preserve per-batch ordering by `timestamp`, then `id`.
- If buffered writes fail transiently, the system should retry before dropping
  events. Silent loss of audit events is not acceptable.

## Index Strategy

Indexes are optimized for org-scoped recent-first browsing, identity
investigation, action filtering, and retention cleanup.

```sql
CREATE INDEX IF NOT EXISTS idx_audit_logs_org_timestamp
  ON audit_logs (org_id, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_identity_timestamp
  ON audit_logs (org_id, identity_id, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_action_timestamp
  ON audit_logs (org_id, action, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_workspace_timestamp
  ON audit_logs (org_id, workspace_id, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_plane_timestamp
  ON audit_logs (org_id, plane, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_result_timestamp
  ON audit_logs (org_id, result, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (org_id, created_at, id);
```

### Query Pattern Coverage

- `idx_audit_logs_org_timestamp` supports default org activity feeds and date
  range scans.
- `idx_audit_logs_identity_timestamp` supports investigation of a single agent.
- `idx_audit_logs_action_timestamp` supports action-specific searches such as
  all `scope.denied` or `token.revoked` events in an org.
- `idx_audit_logs_workspace_timestamp` supports workspace-scoped admin views.
- `idx_audit_logs_plane_timestamp` supports cross-resource activity in a plane.
- `idx_audit_logs_result_timestamp` supports `allowed` and `denied` dashboards.
- `idx_audit_logs_created_at` supports retention cleanup by org.

**Known trade-off: no composite multi-filter index.** The current indexes each
cover `org_id` plus one additional dimension. Queries combining multiple filters
(e.g., `orgId + action + result + date range`) will use the best single-column
index and scan the remaining predicates in-memory. This is an intentional
trade-off for D1's expected scale — adding composite indexes for every filter
combination would increase write amplification. If query patterns show frequent
multi-filter use at scale, targeted composite indexes should be added.

## Query API

The query API exposes filtered, org-scoped access to audit events.

### Filter Contract

The public `AuditQuery` type is the input contract. The following filters are
supported:

| Filter | Type | Behavior |
| --- | --- | --- |
| `orgId` | `string` | Required at the API layer. Exact match on `org_id`. |
| `identityId` | `string` | Optional exact match on `identity_id`. |
| `action` | `AuditAction` | Optional exact match on `action`. |
| `workspaceId` | `string` | Optional exact match on `workspace_id`. |
| `plane` | `string` | Optional exact match on `plane`. |
| `result` | `"allowed" \| "denied"` | Optional exact match on `result`. Query API does not expose `error` as a filter in the current shared type. |
| `from` | `string` | Optional inclusive lower bound on `timestamp`. Must be ISO 8601 UTC. |
| `to` | `string` | Optional exclusive upper bound on `timestamp`. Must be ISO 8601 UTC. |
| `limit` | `number` | Optional page size. Default `50`. Maximum `1000`. |
| `cursor` | `string` | Optional opaque continuation cursor. |

All supplied filters are combined with logical AND.

### Cursor Pagination

Results are always sorted by `timestamp DESC, id DESC`.

The cursor must encode the last seen sort key pair:

```text
base64url("<timestamp>|<id>")
```

Given a decoded cursor of `cursorTimestamp` and `cursorId`, the next page must
apply this seek condition:

```sql
AND (
  timestamp < :cursorTimestamp
  OR (timestamp = :cursorTimestamp AND id < :cursorId)
)
```

This guarantees stable pagination even when multiple rows share the same
timestamp.

### Query Response Shape

The response shape is:

```ts
interface AuditQueryResponse {
  entries: AuditEntry[];
  nextCursor: string | null;
}
```

`nextCursor` must be `null` when fewer than `limit` rows remain.

If the supplied `cursor` is malformed or cannot be decoded, the implementation
must return HTTP `400` with a descriptive error. It must not silently ignore an
invalid cursor.

### SQL Template

Implementations **must dynamically build the WHERE clause**, including only
clauses for filters that are actually supplied. D1/SQLite's query planner cannot
use indexes through `(:param IS NULL OR column = :param)` patterns — it will
fall back to a full table scan within the `org_id` partition. By emitting only
the relevant equality clauses, the planner can select the best matching index.

A representative dynamic query shape (pseudocode):

```ts
const clauses: string[] = ["org_id = :orgId"];
const params: Record<string, unknown> = { orgId };

if (identityId) { clauses.push("identity_id = :identityId"); params.identityId = identityId; }
if (action)     { clauses.push("action = :action");           params.action = action; }
if (workspaceId){ clauses.push("workspace_id = :workspaceId"); params.workspaceId = workspaceId; }
if (plane)      { clauses.push("plane = :plane");             params.plane = plane; }
if (result)     { clauses.push("result = :result");           params.result = result; }
if (fromTs)     { clauses.push("timestamp >= :fromTs");       params.fromTs = fromTs; }
if (toTs)       { clauses.push("timestamp < :toTs");          params.toTs = toTs; }
if (cursorTimestamp) {
  clauses.push("(timestamp < :cursorTimestamp OR (timestamp = :cursorTimestamp AND id < :cursorId))");
  params.cursorTimestamp = cursorTimestamp;
  params.cursorId = cursorId;
}

const sql = `
  SELECT id, action, identity_id, org_id, workspace_id, plane, resource,
         result, metadata_json, ip, user_agent, timestamp, created_at
  FROM audit_logs
  WHERE ${clauses.join(" AND ")}
  ORDER BY timestamp DESC, id DESC
  LIMIT :limit;
`;
```

Implementations must never use a static SQL template with `IS NULL OR` fallback
patterns — that approach defeats index selection on D1.

## Retention Policy

Retention is configured per organization.

### Configuration

The minimum configuration contract is:

```ts
interface OrgAuditRetentionConfig {
  orgId: string;
  retentionDays: number;
}
```

Rules:

- Default `retentionDays` is `90`.
- Minimum supported value is `7`.
- Maximum supported value is `365`.
- Values outside this range must be rejected at write time.
- Retention applies to all audit actions unless future product policy adds
  per-action overrides.

### Cleanup Job

A scheduled cleanup job must run at least once per day.

For each organization:

1. Read `retentionDays`.
2. Compute the cutoff as `now - retentionDays`.
3. Delete expired rows in bounded batches.
4. Repeat until no expired rows remain for that org.

Representative deletion statement:

```sql
DELETE FROM audit_logs
WHERE id IN (
  SELECT id FROM audit_logs
  WHERE org_id = :orgId
    AND created_at < :cutoff
  LIMIT 10000
);
```

Note: `DELETE ... LIMIT` is a MySQL extension and is **not supported on
Cloudflare D1**. Implementations must use the subquery pattern above to achieve
bounded batch deletes.

Cleanup should operate on `created_at` rather than `timestamp` so delayed event
ingestion does not cause immediately expired inserts. If an implementation wants
event-time retention instead, it must apply that policy consistently and update
this spec with the migration plan.

## Export Formats

Audit data must be exportable as JSON and CSV.

### JSON Export

The JSON export format is newline-delimited JSON (NDJSON).

- Content type: `application/x-ndjson`
- One JSON object per line
- Each object must serialize a full `AuditEntry`
- `metadata` remains an object, not a pre-encoded JSON string

Example:

```json
{"id":"aud_01","action":"token.issued","identityId":"agent_123","orgId":"org_acme","workspaceId":"ws_prod","plane":"relayauth","resource":"token:tok_123","result":"allowed","metadata":{"newTokenId":"tok_123","ttlSeconds":"3600"},"ip":"203.0.113.10","userAgent":"@relayauth/sdk/1.0.0","timestamp":"2026-03-24T17:00:00.000Z","createdAt":"2026-03-24T17:00:00.123Z"}
```

### CSV Export

- Content type: `text/csv; charset=utf-8`
- Header row is required
- One row per audit event
- `metadata` must be JSON-encoded into a single cell
- Timestamps must remain ISO 8601 UTC strings

Required CSV columns, in order:

```text
id,action,identityId,orgId,workspaceId,plane,resource,result,metadata,ip,userAgent,timestamp,createdAt
```

Example:

```csv
id,action,identityId,orgId,workspaceId,plane,resource,result,metadata,ip,userAgent,timestamp,createdAt
aud_01,token.issued,agent_123,org_acme,ws_prod,relayauth,token:tok_123,allowed,"{""newTokenId"":""tok_123"",""ttlSeconds"":""3600""}",203.0.113.10,@relayauth/sdk/1.0.0,2026-03-24T17:00:00.000Z,2026-03-24T17:00:00.123Z
```

### Export Semantics

- Exports must apply the same query filters as the interactive query API.
- Exports must preserve the same sort order: `timestamp DESC, id DESC`.
- Large exports may be streamed directly or materialized asynchronously.
- If asynchronous export is used, the final file format must still be NDJSON or
  CSV exactly as specified above.

## Webhook Payload Format

Organizations may subscribe to audit events through webhooks.

### Configuration Contract

The minimum org-level webhook configuration is:

```ts
interface OrgAuditWebhookConfig {
  orgId: string;
  webhookUrl: string;
  webhookSecret: string;
  webhookEvents?: AuditAction[];
  webhookStatus: "active" | "degraded" | "disabled";
  lastSuccessAt?: string;
  consecutiveFailures: number;
}
```

Rules:

- `webhookUrl` must be HTTPS in production.
- `webhookSecret` is used for HMAC signing.
- If `webhookEvents` is omitted, all audit actions are delivered.
- If `webhookEvents` is present, only matching actions are delivered.

### Payload Shape

Each delivery must send this JSON object:

```ts
interface AuditWebhookPayload {
  type: "audit.event";
  deliveryId: string;
  timestamp: string;
  entry: AuditEntry;
}
```

Example:

```json
{
  "type": "audit.event",
  "deliveryId": "awd_01JQ6W9X9J8M4X2T7F6A1R2B3C",
  "timestamp": "2026-03-24T17:00:05.000Z",
  "entry": {
    "id": "aud_01",
    "action": "scope.denied",
    "identityId": "agent_123",
    "orgId": "org_acme",
    "workspaceId": "ws_prod",
    "plane": "stripe",
    "resource": "orders:approve:ord_987",
    "result": "denied",
    "metadata": {
      "scope": "stripe:orders:approve:\u2264$5000",
      "reason": "requested amount exceeded grant"
    },
    "ip": "203.0.113.10",
    "userAgent": "@relayauth/sdk/1.0.0",
    "timestamp": "2026-03-24T17:00:00.000Z"
  }
}
```

## Webhook Delivery Semantics

- Method: `POST`
- Content type: `application/json`
- Timeout per attempt: `10s`
- Signature header: `X-RelayAuth-Signature`
- Signature format: `sha256=<hex(hmac_sha256(raw_request_body, webhookSecret))>`
- Idempotency header: `X-RelayAuth-Delivery-Id: <deliveryId>`

Retry behavior:

- Deliveries should be attempted at least 3 times after the initial attempt.
- Recommended backoff schedule: `10s`, `60s`, `300s`.
- Any `2xx` response marks the delivery successful.
- Any non-`2xx` response or timeout counts as a failure.

Failure handling:

- Delivery retries must preserve the same `deliveryId` and payload body.
- Implementations must track consecutive failures per org webhook.
- Maximum retry window: 4 attempts total (1 initial + 3 retries). After the
  final retry fails, the delivery is marked as permanently failed.
- Webhook status lifecycle:
  - `active` — webhook is operating normally.
  - `degraded` — 5 or more consecutive delivery failures. Deliveries continue
    but the org should be notified (e.g., via dashboard warning).
  - `disabled` — 50 or more consecutive delivery failures, or manual
    disablement. No further deliveries are attempted until re-enabled.
- When a webhook transitions to `degraded` or `disabled`, an internal
  notification must be surfaced to org admins.
- Failed deliveries must be recorded with their `deliveryId`, target
  `webhookUrl`, failure reason, and attempt count so that orgs can identify
  which events were not successfully delivered.
- Each webhook configuration must expose a `lastSuccessAt` timestamp (ISO 8601
  UTC) indicating the most recent successful delivery. Consumers can compare
  this against their own records to detect delivery gaps.
- The audit event itself must always remain stored in D1 regardless of webhook
  delivery outcome. Webhook delivery is best-effort notification, not the
  source of truth. Consumers can use the query API to backfill any events
  missed during webhook outages.

Ordering and batching:

- At-least-once delivery is required.
- Strict global ordering is not guaranteed.
- Per-org ordering should be preserved where practical, but consumers must not
  depend on exactly-once or perfectly ordered delivery.
- Implementations may batch multiple entries into future webhook variants, but
  the single-event payload above is the canonical v1 contract.

## Operational Notes

- `scope.checked`, `scope.denied`, and `token.validated` are expected to be the
  highest-volume events and should be treated as hot paths.
- Queries must always be org-scoped.
- Sponsor chain traceability should be carried in `metadata.sponsorChain` until
  a dedicated chain table is introduced.
- Export and webhook paths must deserialize `metadata_json` back into
  `metadata: Record<string, string>` before returning payloads externally.

## Summary

This specification defines the full relayauth audit logging contract:

- canonical `AuditEntry` field rules and metadata conventions
- trigger conditions for all 16 `AuditAction` values
- D1 `audit_logs` DDL and index strategy
- org-scoped query filters with cursor pagination
- per-org retention with scheduled cleanup
- NDJSON and CSV export formats
- webhook payload shape and at-least-once delivery semantics
