# Audit Log Design Specification

## Overview

The audit log captures every security-relevant event in relayauth: token operations, identity lifecycle changes, scope checks, RBAC mutations, and key management. Every entry traces through the sponsor chain to a human. Logs are stored in D1, queryable via API, exportable, and optionally forwarded via webhooks.

---

## Audit Entry Format

Every audit event produces an `AuditEntry`:

| Field         | Type                              | Required | Description                                                    |
|---------------|-----------------------------------|----------|----------------------------------------------------------------|
| `id`          | `string`                          | Yes      | Unique identifier, prefixed `aud_` (e.g., `aud_abc123`)       |
| `action`      | `AuditAction`                     | Yes      | The event type (see Actions below)                             |
| `identityId`  | `string`                          | Yes      | The agent identity that triggered the event (`agent_xxxx`)     |
| `orgId`       | `string`                          | Yes      | Organization the event belongs to (`org_xxxx`)                 |
| `workspaceId` | `string`                          | No       | Workspace context, if applicable (`ws_xxxx`)                   |
| `plane`       | `string`                          | No       | Target plane (e.g., `relaycast`, `relayfile`, `cloud`)         |
| `resource`    | `string`                          | No       | Specific resource acted upon (e.g., `channel:#billing`)        |
| `result`      | `"allowed" \| "denied" \| "error"` | Yes      | Outcome of the operation                                       |
| `metadata`    | `Record<string, string>`          | No       | Arbitrary key-value pairs for additional context                |
| `ip`          | `string`                          | No       | Source IP address of the request                                |
| `userAgent`   | `string`                          | No       | User-Agent header from the request                             |
| `timestamp`   | `string`                          | Yes      | ISO 8601 timestamp with millisecond precision                  |

### Metadata conventions

The `metadata` field carries action-specific context. Common keys:

| Key              | Used by                        | Description                                      |
|------------------|--------------------------------|--------------------------------------------------|
| `tokenId`        | `token.*`                      | The `jti` of the token involved                  |
| `sponsorChain`   | All                            | JSON-encoded sponsor chain array                 |
| `scope`          | `scope.checked`, `scope.denied`| The scope string that was evaluated              |
| `roleName`       | `role.assigned`, `role.removed`| Name of the role                                 |
| `policyId`       | `policy.*`                     | ID of the policy involved                        |
| `keyId`          | `key.rotated`                  | ID of the rotated signing key                    |
| `reason`         | `identity.suspended`, `token.revoked` | Human-readable reason for the action      |
| `parentIdentity` | `identity.created`             | Parent agent ID for sub-agent creation           |
| `ttl`            | `token.issued`                 | Token TTL in seconds                             |
| `budgetAction`   | `scope.checked`                | Budget remaining after action                    |

---

## Audit Actions

| Action               | Fires when                                                              | Typical result     |
|----------------------|-------------------------------------------------------------------------|--------------------|
| `token.issued`       | A new access or refresh token is created                                | `allowed`          |
| `token.refreshed`    | A refresh token is exchanged for a new access token                     | `allowed`          |
| `token.revoked`      | A token is explicitly revoked (single or bulk)                          | `allowed`          |
| `token.validated`    | A token is presented for validation at the edge                         | `allowed`/`denied` |
| `identity.created`   | A new agent identity is registered                                      | `allowed`          |
| `identity.updated`   | An agent's properties are modified (scopes, budget, etc.)               | `allowed`          |
| `identity.suspended` | An agent is suspended (manual, budget exceeded, or policy violation)     | `allowed`          |
| `identity.retired`   | An agent is permanently retired                                         | `allowed`          |
| `scope.checked`      | A scope is evaluated during an authorization decision                   | `allowed`/`denied` |
| `scope.denied`       | A scope check fails (logged separately for fast deny-only queries)      | `denied`           |
| `role.assigned`      | A role is assigned to an identity in a workspace                        | `allowed`          |
| `role.removed`       | A role is removed from an identity                                      | `allowed`          |
| `policy.created`     | A new authorization policy is created                                   | `allowed`          |
| `policy.updated`     | An existing policy is modified                                          | `allowed`          |
| `policy.deleted`     | A policy is deleted                                                     | `allowed`          |
| `key.rotated`        | A signing key is rotated                                                | `allowed`          |

### High-volume vs. admin actions

- **High-volume**: `token.validated`, `scope.checked`, `scope.denied` — generated on every request. These are written in batches (see Storage).
- **Admin actions**: All others — lower volume, written immediately.

---

## Storage

### D1 Table Schema

```sql
CREATE TABLE audit_log (
  id          TEXT PRIMARY KEY,
  action      TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  org_id      TEXT NOT NULL,
  workspace_id TEXT,
  plane       TEXT,
  resource    TEXT,
  result      TEXT NOT NULL CHECK (result IN ('allowed', 'denied', 'error')),
  metadata    TEXT,          -- JSON-encoded Record<string, string>
  ip          TEXT,
  user_agent  TEXT,
  timestamp   TEXT NOT NULL, -- ISO 8601
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
```

### Indexes

```sql
-- Primary query patterns
CREATE INDEX idx_audit_org_ts         ON audit_log (org_id, timestamp DESC);
CREATE INDEX idx_audit_identity_ts    ON audit_log (identity_id, timestamp DESC);
CREATE INDEX idx_audit_action_ts      ON audit_log (org_id, action, timestamp DESC);
CREATE INDEX idx_audit_result_ts      ON audit_log (org_id, result, timestamp DESC);
CREATE INDEX idx_audit_workspace_ts   ON audit_log (org_id, workspace_id, timestamp DESC);
CREATE INDEX idx_audit_plane_ts       ON audit_log (org_id, plane, timestamp DESC);

-- Retention cleanup
CREATE INDEX idx_audit_org_created    ON audit_log (org_id, created_at);
```

### Write strategy

- **Admin actions**: Written synchronously via `INSERT` on the request path.
- **High-volume actions** (`token.validated`, `scope.checked`, `scope.denied`): Buffered in the Identity Durable Object and flushed to D1 in batches (every 5 seconds or 100 entries, whichever comes first). This keeps write load manageable while maintaining near-real-time availability.

---

## Retention

Retention is configurable per organization.

| Setting            | Default | Minimum | Maximum  |
|--------------------|---------|---------|----------|
| `retentionDays`    | 90      | 7       | 365      |

### Configuration

```typescript
interface OrgAuditConfig {
  retentionDays: number;     // Default: 90
  webhookUrl?: string;       // Optional webhook endpoint
  webhookEvents?: AuditAction[]; // Filter which actions trigger webhooks (default: all)
  webhookSecret?: string;    // HMAC-SHA256 signing secret for webhook payloads
}
```

### Cleanup

A scheduled Cron Trigger runs daily and deletes expired entries:

```sql
DELETE FROM audit_log
WHERE org_id = ?
  AND created_at < datetime('now', '-' || ? || ' days')
LIMIT 10000;
```

Deletion runs in batches of 10,000 rows to avoid D1 timeout limits. The job loops until no more rows match.

---

## Query Semantics

### Filters

The `AuditQuery` interface defines all supported filters:

| Filter        | Type          | Behavior                                |
|---------------|---------------|-----------------------------------------|
| `identityId`  | `string`      | Exact match on `identity_id`            |
| `action`      | `AuditAction` | Exact match on `action`                 |
| `orgId`       | `string`      | Exact match on `org_id` (required)      |
| `workspaceId` | `string`      | Exact match on `workspace_id`           |
| `plane`       | `string`      | Exact match on `plane`                  |
| `result`      | `string`      | Exact match: `"allowed"` or `"denied"`  |
| `from`        | `string`      | ISO 8601 lower bound (inclusive)        |
| `to`          | `string`      | ISO 8601 upper bound (exclusive)        |

All filters are AND-combined. `orgId` is always required (enforced at the API layer) to ensure queries are scoped to an organization.

### Pagination

- **Cursor-based** using the `cursor` parameter (opaque, base64-encoded `timestamp:id` pair).
- `limit` controls page size. Default: 50. Maximum: 1000.
- Response includes `nextCursor` if more results exist; `null` otherwise.

### Sorting

Results are always sorted by `timestamp DESC` (most recent first). No other sort orders are supported — this matches the index structure and the primary use case (investigating recent activity).

### Response format

```typescript
interface AuditQueryResponse {
  entries: AuditEntry[];
  nextCursor: string | null;
  total?: number; // Only included if requested via `includeTotal=true` (expensive)
}
```

---

## Export

### Endpoints

```
GET /v1/orgs/{orgId}/audit/export?format=json&from=...&to=...
GET /v1/orgs/{orgId}/audit/export?format=csv&from=...&to=...
```

### JSON export

Returns a newline-delimited JSON (NDJSON) stream. Each line is one `AuditEntry` serialized as JSON. This format supports streaming and is easy to ingest into log aggregation tools.

```
{"id":"aud_abc","action":"token.issued","identityId":"agent_8x2k",...}
{"id":"aud_def","action":"scope.checked","identityId":"agent_8x2k",...}
```

Content-Type: `application/x-ndjson`

### CSV export

Header row followed by one row per entry. `metadata` is JSON-encoded in a single column.

```csv
id,action,identity_id,org_id,workspace_id,plane,resource,result,metadata,ip,user_agent,timestamp
aud_abc,token.issued,agent_8x2k,org_acme,ws_prod,,,allowed,"{""tokenId"":""tok_xyz""}",1.2.3.4,sdk/1.0,2024-03-24T12:00:00.000Z
```

Content-Type: `text/csv`

### Export constraints

- Maximum time range per export: 30 days.
- Exports exceeding 100,000 rows return a `202 Accepted` with a download URL that becomes available asynchronously.
- Exports require `admin` or `auditor` role.

---

## Webhook Notifications

Organizations can configure a webhook URL to receive real-time audit event notifications.

### Configuration

Set via the org audit config (see Retention section). The `webhookEvents` filter allows subscribing to specific action types.

### Payload

```typescript
interface AuditWebhookPayload {
  type: "audit.event";
  entry: AuditEntry;
  deliveryId: string;     // Unique delivery ID for idempotency
  timestamp: string;      // Delivery timestamp
}
```

### Delivery

- **Method**: `POST` to the configured `webhookUrl`.
- **Signature**: `X-RelayAuth-Signature` header containing `sha256=<HMAC-SHA256(payload, webhookSecret)>`.
- **Content-Type**: `application/json`.
- **Timeout**: 10 seconds per delivery attempt.
- **Retries**: 3 attempts with exponential backoff (10s, 60s, 300s).
- **Failure handling**: After 3 consecutive failures, the webhook is marked as `degraded`. After 50 consecutive failures, it is disabled and an alert is sent to org admins.

### Batching

High-volume events (`token.validated`, `scope.checked`, `scope.denied`) are batched into a single webhook delivery every 10 seconds to avoid overwhelming receivers:

```typescript
interface AuditWebhookBatchPayload {
  type: "audit.event.batch";
  entries: AuditEntry[];
  deliveryId: string;
  timestamp: string;
}
```

---

## API Endpoints Summary

| Method | Path                                  | Description                  |
|--------|---------------------------------------|------------------------------|
| GET    | `/v1/orgs/{orgId}/audit`              | Query audit log              |
| GET    | `/v1/orgs/{orgId}/audit/export`       | Export audit log             |
| GET    | `/v1/orgs/{orgId}/audit/config`       | Get org audit configuration  |
| PUT    | `/v1/orgs/{orgId}/audit/config`       | Update org audit config      |
| POST   | `/v1/orgs/{orgId}/audit/config/test`  | Send a test webhook delivery |

---

## Sponsor Chain Tracing

Every audit entry includes the full sponsor chain in `metadata.sponsorChain`. This enables:

1. **Forward tracing**: "What did agents sponsored by `user_jane` do?" — query by sponsor in metadata.
2. **Reverse tracing**: "Who authorized `agent_8x2k`?" — read the sponsor chain from any entry.
3. **Sub-agent attribution**: When `agent_A` spawns `agent_B`, both entries link back through the chain to the human sponsor.

The query API supports a `sponsorId` convenience filter that searches within `metadata.sponsorChain`:

```sql
-- Implemented as: metadata LIKE '%"user_jane"%' with index scan on org + timestamp
```

For production scale, a separate `audit_sponsor` junction table may be introduced:

```sql
CREATE TABLE audit_sponsor (
  audit_id   TEXT NOT NULL REFERENCES audit_log(id),
  sponsor_id TEXT NOT NULL,
  PRIMARY KEY (audit_id, sponsor_id)
);
CREATE INDEX idx_sponsor_lookup ON audit_sponsor (sponsor_id, audit_id);
```
