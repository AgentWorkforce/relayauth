-- Single-use attestation finalize capabilities.
-- The plaintext finalize key is returned once and is never persisted.

CREATE TABLE IF NOT EXISTS attestation_grants (
  jti TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  sponsor_chain_json TEXT NOT NULL,
  repo TEXT NOT NULL,
  task_ref TEXT,
  session_ref TEXT,
  not_after TEXT NOT NULL,
  finalize_key_hash TEXT NOT NULL CHECK (length(finalize_key_hash) = 64),
  redeemed_at TEXT,
  late INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attestation_grants_org_not_after
  ON attestation_grants (org_id, not_after);
