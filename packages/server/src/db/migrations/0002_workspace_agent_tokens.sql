ALTER TABLE api_keys
  ADD COLUMN kind TEXT NOT NULL DEFAULT 'api_key';

ALTER TABLE api_keys
  ADD COLUMN workspace_id TEXT;

CREATE INDEX IF NOT EXISTS idx_api_keys_kind_workspace
  ON api_keys (kind, workspace_id, created_at DESC, id DESC);
