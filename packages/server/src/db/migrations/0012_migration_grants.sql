-- Migration grants: the authorization record behind
-- POST /v1/tokens/migration-assertion.
--
-- A grant binds one dedicated API key (api_key_id) in one organization to an
-- export plan (plan_digest), one ingest origin (audience), a bounded set of
-- source users (allowed_users_json) and a hard deadline (not_after). Grants
-- are revoked by stamping revoked_at, never deleted. Like the attestation
-- tables, this table sits outside the audit retention lifecycle: do not add
-- foreign-key cascades or TTL/retention processing.

CREATE TABLE IF NOT EXISTS migration_grants (
  grant_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  api_key_id TEXT NOT NULL,
  plan_digest TEXT NOT NULL CHECK (
    length(plan_digest) = 64 AND plan_digest NOT GLOB '*[^0-9a-f]*'
  ),
  audience TEXT NOT NULL,
  allowed_users_json TEXT NOT NULL CHECK (
    json_valid(allowed_users_json)
    AND json_type(allowed_users_json) = 'array'
    AND json_array_length(allowed_users_json) BETWEEN 1 AND 1000
  ),
  not_after TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  revoked_at TEXT
);

-- Grants are read by grant_id (the primary key) on every mint. This index
-- serves the operator question "which grants does this API key hold" when a
-- key is revoked or rotated.
CREATE INDEX IF NOT EXISTS idx_migration_grants_org_api_key
  ON migration_grants (org_id, api_key_id);
