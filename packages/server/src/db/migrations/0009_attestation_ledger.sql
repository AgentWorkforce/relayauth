-- Permanent, per-organization, append-only attestation ledger.
--
-- This table intentionally has no foreign-key cascade, updated_at column, TTL,
-- or retention policy. It must remain outside the audit_logs retention sweep.

CREATE TABLE IF NOT EXISTS attestation_ledger (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  org_id TEXT NOT NULL CHECK (length(org_id) > 0),
  org_seq INTEGER NOT NULL CHECK (org_seq > 0),
  entry_type TEXT NOT NULL CHECK (length(entry_type) > 0),
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  jws TEXT NOT NULL CHECK (length(jws) > 0),
  prev_hash TEXT NOT NULL CHECK (length(prev_hash) = 64),
  entry_hash TEXT NOT NULL CHECK (length(entry_hash) = 64),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, org_seq),
  UNIQUE (org_id, entry_hash)
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
