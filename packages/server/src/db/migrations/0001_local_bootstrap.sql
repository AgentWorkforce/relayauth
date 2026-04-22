PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS identities (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'agent',
  org_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  sponsor_chain TEXT NOT NULL DEFAULT '[]',
  sponsor_chain_json TEXT NOT NULL DEFAULT '[]',
  scopes TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  roles TEXT NOT NULL DEFAULT '[]',
  roles_json TEXT NOT NULL DEFAULT '[]',
  budget TEXT,
  budget_json TEXT,
  budget_usage TEXT,
  budget_usage_json TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  metadata TEXT NOT NULL DEFAULT '{}',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_active_at TEXT,
  suspended_at TEXT,
  suspend_reason TEXT
);

CREATE INDEX IF NOT EXISTS idx_identities_org_created
  ON identities (org_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_identities_org_sponsor
  ON identities (org_id, sponsor_id);

CREATE TABLE IF NOT EXISTS roles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  built_in INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_roles_org_name
  ON roles (org_id, name, workspace_id);

CREATE TABLE IF NOT EXISTS policies (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  effect TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  conditions TEXT NOT NULL DEFAULT '[]',
  conditions_json TEXT NOT NULL DEFAULT '[]',
  priority INTEGER NOT NULL DEFAULT 0,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_policies_org_workspace_priority
  ON policies (org_id, workspace_id, priority DESC, id ASC);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  identity_id TEXT,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  plane TEXT,
  resource TEXT,
  result TEXT NOT NULL,
  metadata_json TEXT,
  ip TEXT,
  user_agent TEXT,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_org_timestamp
  ON audit_logs (org_id, timestamp DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_identity_timestamp
  ON audit_logs (identity_id, timestamp DESC);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  workspace_id TEXT,
  identity_id TEXT,
  action TEXT NOT NULL,
  reason TEXT,
  payload TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_events_org_created
  ON audit_events (org_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  token_id TEXT,
  jti TEXT,
  identity_id TEXT NOT NULL,
  session_id TEXT,
  issued_at INTEGER,
  expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_tokens_identity_status
  ON tokens (identity_id, status);

CREATE TABLE IF NOT EXISTS org_budgets (
  org_id TEXT PRIMARY KEY,
  budget TEXT,
  budget_json TEXT,
  default_budget TEXT,
  settings_json TEXT,
  data TEXT
);

CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  org_id TEXT,
  name TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  roles TEXT NOT NULL DEFAULT '[]',
  roles_json TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  workspace_id TEXT,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '[]',
  scopes_json TEXT NOT NULL DEFAULT '[]',
  roles TEXT NOT NULL DEFAULT '[]',
  roles_json TEXT NOT NULL DEFAULT '[]',
  settings TEXT NOT NULL DEFAULT '{}',
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_retention_config (
  org_id TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT 90
);

CREATE TABLE IF NOT EXISTS audit_webhooks (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_webhooks_org_created
  ON audit_webhooks (org_id, created_at DESC, id DESC);
