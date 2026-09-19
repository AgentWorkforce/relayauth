-- Per-organization identity retention, plus the persisted capacity sample the
-- storage guardrail reads.
--
-- Identity retention is OFF by default and stays off after an upgrade. Unlike
-- audit retention — which has an implicit two-day default — an absent or
-- disabled config row means "never sweep this organization's identities". An
-- OSS package must not start deleting identities because someone bumped a
-- version, so eligibility requires an explicit `enabled = 1` row. The GC never
-- falls back to `retention_days`' column default; that default only shapes the
-- row an operator inserts without naming a window.
CREATE TABLE IF NOT EXISTS identity_retention_config (
  org_id TEXT PRIMARY KEY,
  retention_days INTEGER NOT NULL DEFAULT 30,
  enabled INTEGER NOT NULL DEFAULT 0
);

-- Single-row gauge of the last observed database size.
--
-- The guardrail cannot read its own size on every host: D1 rejects
-- `PRAGMA page_count` with SQLITE_AUTH, so on that runtime the only real size
-- signal is the write metadata the scheduler observes. Persisting the sample
-- makes it readable from the request path too, which a module-scope cache
-- cannot do when each request builds its app in a fresh isolate.
--
-- `size_bytes` is the high-water mark, not live bytes: deleting rows moves
-- pages to the freelist without shrinking the file. `freelist_bytes` therefore
-- carries the reclaimable headroom that the size alone hides.
CREATE TABLE IF NOT EXISTS storage_capacity_samples (
  id TEXT PRIMARY KEY CHECK (id = 'current'),
  size_bytes INTEGER NOT NULL,
  capacity_bytes INTEGER,
  freelist_bytes INTEGER,
  observed_at TEXT NOT NULL
);
