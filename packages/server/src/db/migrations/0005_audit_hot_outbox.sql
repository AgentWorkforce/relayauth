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
  created_at TEXT NOT NULL,
  available_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  archived_at TEXT,
  last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_outbox_pending
  ON audit_outbox (archived_at, available_at, created_at, id);
