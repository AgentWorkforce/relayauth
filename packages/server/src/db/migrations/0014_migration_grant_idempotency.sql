-- Idempotency receipts for POST /v1/migration-grants.
--
-- A grant's id is random and its plan digest covers that id, so a create whose
-- response is lost would otherwise leave a live grant the caller cannot find.
-- Every create now carries a caller-chosen, high-entropy Idempotency-Key. The
-- raw key is never stored: key_hash is a domain-separated SHA-256 over the
-- caller's org, the caller's subject and the key, so the same raw key used by
-- another caller or in another org hashes to an unrelated value and is simply
-- absent. request_fingerprint is a SHA-256 over the canonical pre-grant
-- request (key id, audience, notAfter, canonical plan and pairs, everything
-- except the generated grant id). The receipt, the grant and its one
-- migration_grant.created audit row commit in a single transaction.
--
-- Like migration_grants, receipts sit outside the audit retention lifecycle:
-- no foreign-key cascades and no TTL/retention processing. A receipt is
-- written once and never updated or deleted.

CREATE TABLE IF NOT EXISTS migration_grant_idempotency_receipts (
  org_id TEXT NOT NULL CHECK (length(org_id) > 0),
  key_hash TEXT NOT NULL CHECK (
    length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'
  ),
  caller_id TEXT NOT NULL CHECK (length(caller_id) > 0),
  request_fingerprint TEXT NOT NULL CHECK (
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  grant_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, key_hash)
);
