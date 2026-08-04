-- Keep audit history intentionally short unless an organization explicitly
-- opts into a longer window. SQLite cannot alter a column default in place,
-- so rebuild this small configuration table while preserving every override.
CREATE TABLE audit_retention_config_v2 (
  org_id TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT 2
);

INSERT INTO audit_retention_config_v2 (org_id, retention_days)
SELECT org_id, retention_days
FROM audit_retention_config;

DROP TABLE audit_retention_config;

ALTER TABLE audit_retention_config_v2 RENAME TO audit_retention_config;
