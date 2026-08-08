-- Durable, queryable snapshots of identity and token lineage.
--
-- These rows intentionally do not reference identities or tokens with foreign
-- keys: lineage remains available as a historical record if an operational
-- identity or token is later removed.

CREATE TABLE IF NOT EXISTS identity_lineages (
  identity_id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_identity_lineages_org_workspace
  ON identity_lineages (org_id, workspace_id, identity_id);

CREATE TABLE IF NOT EXISTS identity_lineage_members (
  identity_id TEXT NOT NULL,
  chain_position INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  PRIMARY KEY (identity_id, chain_position)
);

CREATE INDEX IF NOT EXISTS idx_identity_lineage_members_principal
  ON identity_lineage_members (principal_id, identity_id);

CREATE TABLE IF NOT EXISTS token_lineages (
  token_id TEXT PRIMARY KEY,
  issued_token_id TEXT NOT NULL,
  identity_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  token_type TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_token_lineages_identity_created
  ON token_lineages (identity_id, created_at, token_id);

CREATE TABLE IF NOT EXISTS token_lineage_members (
  token_id TEXT NOT NULL,
  chain_position INTEGER NOT NULL,
  principal_id TEXT NOT NULL,
  PRIMARY KEY (token_id, chain_position)
);

CREATE INDEX IF NOT EXISTS idx_token_lineage_members_principal
  ON token_lineage_members (principal_id, token_id);

-- Backfill pre-existing identities, then ensure every later identity creation
-- records the same relational lineage in its owning transaction.
INSERT OR IGNORE INTO identity_lineages (
  identity_id,
  org_id,
  workspace_id,
  sponsor_id,
  created_at
)
SELECT id, org_id, workspace_id, sponsor_id, created_at
FROM identities;

INSERT OR IGNORE INTO identity_lineage_members (
  identity_id,
  chain_position,
  principal_id
)
SELECT
  identities.id,
  CAST(json_each.key AS INTEGER),
  json_each.value
FROM identities
CROSS JOIN json_each(identities.sponsor_chain_json)
WHERE json_valid(identities.sponsor_chain_json)
  AND json_type(identities.sponsor_chain_json) = 'array'
  AND json_each.type = 'text';

CREATE TRIGGER IF NOT EXISTS identities_record_lineage_after_insert
AFTER INSERT ON identities
BEGIN
  INSERT OR IGNORE INTO identity_lineages (
    identity_id,
    org_id,
    workspace_id,
    sponsor_id,
    created_at
  )
  VALUES (
    NEW.id,
    NEW.org_id,
    NEW.workspace_id,
    NEW.sponsor_id,
    NEW.created_at
  );

  INSERT OR IGNORE INTO identity_lineage_members (
    identity_id,
    chain_position,
    principal_id
  )
  SELECT
    NEW.id,
    CAST(json_each.key AS INTEGER),
    json_each.value
  FROM json_each(NEW.sponsor_chain_json)
  WHERE json_valid(NEW.sponsor_chain_json)
    AND json_type(NEW.sponsor_chain_json) = 'array'
    AND json_each.type = 'text';
END;
