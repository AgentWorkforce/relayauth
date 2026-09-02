-- Persist the minting agent name on each token lineage row so
-- workspace+agentName revocation can resolve the ORIGINAL minted identity even
-- when a path token was minted with an agentId that diverges from its
-- agentName. Path tokens have no persisted identity row, so their agent name is
-- otherwise unqueryable and revoke-by-{workspaceId, agentName} would 404.

ALTER TABLE token_lineages ADD COLUMN agent_name TEXT;

CREATE INDEX IF NOT EXISTS idx_token_lineages_workspace_agent
  ON token_lineages (org_id, workspace_id, agent_name);

-- Backfill from the identities table where a durable identity still exists.
-- Transient path-token identities have no row, so their pre-existing lineages
-- stay NULL and remain resolvable only by the reconstructed identity id
-- (the prior behavior); newly minted tokens carry agent_name directly.
UPDATE token_lineages
SET agent_name = (
  SELECT identities.name
  FROM identities
  WHERE identities.id = token_lineages.identity_id
)
WHERE agent_name IS NULL;
