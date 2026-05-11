ALTER TABLE tokens ADD COLUMN parent_token_id TEXT;

ALTER TABLE tokens ADD COLUMN token_class TEXT NOT NULL DEFAULT 'default';

CREATE INDEX IF NOT EXISTS idx_tokens_parent_token
  ON tokens (parent_token_id, status);
