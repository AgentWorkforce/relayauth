-- Durable attestation grants and a per-organization append-only ledger.
--
-- These tables intentionally sit outside the audit retention lifecycle. Do not
-- add updated_at columns, foreign-key cascades, or TTL/retention processing.

CREATE TABLE IF NOT EXISTS attestation_grants (
  jti TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  sponsor_chain_json TEXT NOT NULL,
  repo TEXT NOT NULL,
  task_ref TEXT,
  not_after TEXT NOT NULL,
  finalize_key_hash TEXT NOT NULL,
  redeemed_at TEXT,
  late INTEGER NOT NULL DEFAULT 0 CHECK (late IN (0, 1)),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attestation_grants_org_not_after
  ON attestation_grants (org_id, not_after);

CREATE TABLE IF NOT EXISTS attestation_ledger (
  seq INTEGER PRIMARY KEY,
  org_id TEXT NOT NULL,
  org_seq INTEGER NOT NULL,
  entry_type TEXT NOT NULL,
  jti TEXT,
  commit_sha TEXT,
  repo TEXT,
  agent_id TEXT,
  sponsor_id TEXT,
  payload_json TEXT NOT NULL,
  jws TEXT NOT NULL,
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, org_seq),
  UNIQUE (entry_hash)
);

CREATE INDEX IF NOT EXISTS idx_attestation_ledger_org_seq
  ON attestation_ledger (org_id, org_seq);

CREATE TRIGGER IF NOT EXISTS prevent_attestation_ledger_update
BEFORE UPDATE ON attestation_ledger
BEGIN
  SELECT RAISE(ABORT, 'attestation_ledger is append-only');
END;

CREATE TRIGGER IF NOT EXISTS prevent_attestation_ledger_delete
BEFORE DELETE ON attestation_ledger
BEGIN
  SELECT RAISE(ABORT, 'attestation_ledger is append-only');
END;
