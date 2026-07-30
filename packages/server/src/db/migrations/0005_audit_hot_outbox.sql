-- Bounded operational audit store plus durable archive outbox.
--
-- Platform adapters that archive audit entries atomically enqueue the
-- canonical JSON envelope here. The hot table remains fully indexed for
-- recent operational reads and is trimmed only after archive custody is
-- acknowledged. The historical audit_logs table is intentionally untouched.

CREATE TABLE IF NOT EXISTS audit_hot_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  identity_id TEXT,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  plane TEXT,
  resource TEXT,
  result TEXT NOT NULL,
  metadata_json TEXT,
  ip TEXT,
  user_agent TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_hot_org_timestamp
  ON audit_hot_logs (org_id, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_hot_identity_timestamp
  ON audit_hot_logs (identity_id, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_hot_workspace_timestamp
  ON audit_hot_logs (workspace_id, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_hot_org_action_timestamp
  ON audit_hot_logs (org_id, action, timestamp DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_audit_hot_created_at
  ON audit_hot_logs (created_at, id);

CREATE TABLE IF NOT EXISTS audit_outbox (
  id TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  payload_sha256 TEXT NOT NULL,
  archive_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until TEXT,
  poisoned_at TEXT,
  archived_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_outbox_pending
  ON audit_outbox (
    archived_at,
    poisoned_at,
    available_at,
    lease_until,
    created_at,
    id
  );

-- Compact, bounded historical read index. The immutable event bodies remain
-- in R2 under v1/. Each row points at a minute partition manifest under
-- indexes/v1/ and retains only aggregate/filter metadata in D1.
CREATE TABLE IF NOT EXISTS audit_archive_partitions (
  org_id TEXT NOT NULL,
  partition_minute TEXT NOT NULL,
  index_key TEXT NOT NULL,
  index_sha256 TEXT NOT NULL,
  entry_count INTEGER NOT NULL,
  min_timestamp TEXT NOT NULL,
  max_timestamp TEXT NOT NULL,
  actions_json TEXT NOT NULL,
  identity_ids_json TEXT NOT NULL,
  workspace_ids_json TEXT NOT NULL,
  planes_json TEXT NOT NULL,
  results_json TEXT NOT NULL,
  tokens_issued INTEGER NOT NULL DEFAULT 0,
  tokens_revoked INTEGER NOT NULL DEFAULT 0,
  tokens_refreshed INTEGER NOT NULL DEFAULT 0,
  scope_checks INTEGER NOT NULL DEFAULT 0,
  scope_denials INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, partition_minute)
);

CREATE INDEX IF NOT EXISTS idx_audit_archive_partitions_org_minute
  ON audit_archive_partitions (org_id, partition_minute DESC);
