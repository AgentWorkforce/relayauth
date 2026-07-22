-- Bound scheduled retention queries by their expiry/creation columns.
CREATE INDEX IF NOT EXISTS idx_tokens_expires_at
  ON tokens (expires_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs (created_at);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_created_at
  ON audit_logs (org_id, created_at);
