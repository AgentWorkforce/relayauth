-- Backfill api_keys.kind = 'workspace_token' for rows minted through
-- /v1/tokens/workspace before the route reliably set the kind / workspace_id
-- fields. Specifically: `cloud-agent-box:<workspaceId>` keys minted by the
-- cloud-web-worker landed with kind='api_key' and workspace_id=NULL even
-- though they were intended to be workspace tokens (relay_ws_* prefix on
-- the key value, scopes scoped to a workspace).
--
-- Without this backfill, /v1/tokens/path's resolveWorkspaceToken returns
-- null for these rows (because kind != 'workspace_token'), and downstream
-- cloud-agent box-warm calls fail with 401 workspace_token_required.
--
-- The workspace id is recoverable from the key name, which has the
-- documented shape `cloud-agent-box:<workspaceId>` (see
-- packages/web/lib/relay-workspaces.ts:mintRelayAuthWorkspaceToken).

UPDATE api_keys
SET kind = 'workspace_token',
    workspace_id = SUBSTR(name, LENGTH('cloud-agent-box:') + 1)
WHERE name LIKE 'cloud-agent-box:%'
  AND kind = 'api_key'
  AND revoked_at IS NULL;
