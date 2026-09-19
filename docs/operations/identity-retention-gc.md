# Identity retention GC and the storage capacity guardrail

Operating guide for the identity row retention sweep and the capacity guardrail
added alongside it. Both ship **off**, and this document is mostly about what
has to be true before turning either on.

## Why this exists

A caller was building every identity name to be unique by construction, so
every token mint created a brand new identity row. A production database
reached **1,090,235 identities** — 1,088,501 of them in a single organization —
at **5.53 GB** of a 10 GB per-database cap, growing 25,000–37,000 rows/day and
never shrinking, 45 days after being reset empty. `POST /v1/identities` degraded
to 1000–3700 ms wall at 10–33 ms CPU (pure storage wait), and requests that
exceeded the caller's 15 s timeout killed agent runs outright.

The caller-side fix closes the tap. This is the drain for what is already
stored, and the standing safety net if inflow ever regresses. **Neither
substitutes for the other.**

## The thing to understand first: deleting rows does not shrink the database

`auto_vacuum` is `0` — no migration has ever set it — so a delete moves pages to
the freelist and leaves the file byte-identical.

Measured on a replica of the real schema: deleting 90% of identities left
`page_count` unchanged at 47,279. 28,123 pages moved to the freelist; the file
size did not move at all. Later inserts reused those pages, so `page_count`
stayed flat. Only `VACUUM` shrank it — 47,279 → 22,066 pages, 193 MB → 90 MB —
and hosted backends do not expose `VACUUM`.

**Consequence:** GC caps growth at the current high-water mark. It will not
bring 5.53 GB down. Everything below follows from that.

### Row weight, measured

Built the real schema (0001 + 0008) in a scratch SQLite and loaded 100k
realistic identities:

| Component | Bytes/identity |
| --- | --- |
| `identities` table | 0.97 KB |
| its four indexes | 0.25 KB |
| `identity_lineages` + `identity_lineage_members` + indexes | 0.58 KB |
| **total** | **1.94 KB** |

Extrapolated, the 1.09M rows are ≈2.1 GB of the 5.53 GB. Identity-row GC alone
reclaims ~64% of that (~1.35 GB of freelist), because lineage is retained by
design. `token_lineages` (one row per mint, same cardinality), `tokens`, and
audit account for most of the rest.

## What the sweep deletes

`scanStaleIdentitiesWindow` / `pruneStaleIdentitiesWindow` /
`countStaleIdentitiesBatch` in `packages/server/src/engine/retention-gc.ts`.
Same bounded scan/prune window contract as the existing token and audit sweeps,
so they inherit the stable-evidence invariants and fit the same scheduler shape.

An identity is eligible only when **all** of these hold:

1. Its organization has an `identity_retention_config` row with `enabled = 1`
   and a `retention_days` between 1 and 3650. No row, `enabled = 0`, or a
   malformed window means **never sweep**. There is deliberately no implicit
   default — unlike audit retention, which has one.
2. `created_at` predates the window, compared against a `YYYY-MM-DD` cutoff the
   same conservative way audit retention does: a row on the boundary day is kept
   up to a day longer rather than deleted early.
3. `last_active_at` is unset or equally stale.
4. **No live token references it.** A token is live while it is `active` and
   either has no expiry at all or expires at or after the grace cutoff (default
   60 s, matching the verifier's accepted clock skew). A `NULL` `expires_at` is
   treated as live: its liveness is unknowable from storage, so it fails safe.
   The indefinite durable token class needs no special case — its far-future
   expiry satisfies the same comparison.
5. **It sponsors no surviving identity in its own organization,** so a sweep can
   never orphan a live sponsor chain. A sponsor chain therefore unwinds one
   level per sweep rather than all at once.
6. It is not pinned by `metadata.retention = "keep"`. Metadata that does not
   parse retains the row — an unreadable opt-out is indistinguishable from an
   opt-out that is present.

Status is deliberately **not** part of this. The sprawl rows stay `active`
forever because nothing retires them; age plus the absence of live tokens is
what makes a row collectable.

The full predicate is re-asserted inside the `DELETE`, so a row that gained a
live token, gained a sponsored child, or was pinned between the scan and the
mutation survives — and a rowid reused by an unrelated row is never swept on
evidence gathered before that row existed.

### What it deliberately does not do

- **It does not revoke.** The predicate has already established that no active,
  unexpired token references the row.
- **It does not touch lineage.** Migration 0008 records lineage without foreign
  keys precisely so it survives as the historical record of an identity that is
  no longer operational, and 0010 persists the agent name on `token_lineages` so
  workspace-agent revocation keeps resolving path tokens afterwards. Both are
  covered by tests.
- **It writes no per-row audit event.** 1.09M of them would re-inflate the
  database this is meant to drain. Emit one summary per sweep instead.

### Drain math

1.09M rows at 1,000-row windows is ~1,090 sweeps. Inflow is 25–37k/day, so the
drain has to clear more than 37k/day to make progress. One sweep per cron minute
scans ~1.44M rows/day and clears the backlog in roughly a day of sustained cron.

The scheduler owns cursor persistence and **must keep a separate identity cursor
from the token and audit ones.**

## The capacity guardrail

`packages/server/src/engine/storage-capacity.ts`, surfaced at
`GET /v1/stats/storage` (behind the existing `relayauth:stats:read` scope) and
as a structured `relayauth.storage.capacity` console line at `warn`/`critical`.

Two design points worth knowing:

- **A caller-supplied `sizeBytes` is first-class, not a fallback.** `PRAGMA
  page_count` is rejected on Cloudflare D1 (`not authorized: SQLITE_AUTH
  [code: 7500]`, measured against the pinned production database), where the
  real size signal is the write metadata returned on every query. The pragma
  probe is the convenience path for Node/better-sqlite3 consumers and reports
  unavailability rather than throwing.
- **Freelist bytes are reported separately.** Per the section above, a 5.5 GB
  database with 3 GB of freelist is healthy but looks identical to a genuinely
  full one if you only read the size. `effectiveUsedRatio` is the size net of
  reclaimable space; `usedRatio` is what the hard cap actually measures.

`storage_capacity_samples` holds one row (`id = 'current'`) so the sweep that
can observe the size and the request path that wants to act on it can share it —
they do not share an isolate on every runtime.

### Bindings (all optional; absent means off)

| Binding | Default | Effect |
| --- | --- | --- |
| `RELAYAUTH_STORAGE_CAPACITY_BYTES` | unset | Unset leaves the guardrail entirely off. Set to the backend's real per-database cap. |
| `RELAYAUTH_STORAGE_CAPACITY_WARN_RATIO` | `0.70` | Ratio at which the guardrail warns. |
| `RELAYAUTH_STORAGE_CAPACITY_CRITICAL_RATIO` | `0.85` | Ratio at which it escalates. Raised to meet `warn` if set below it, since an inverted pair would make `critical` unreachable. |
| `RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO` | unset | Unset means never shed. |

Every setting fails safe: absent, empty, or malformed leaves the feature off or
falls back to the protective default, with a warning logged.

### Identity-create shedding

At or above `RELAYAUTH_STORAGE_CAPACITY_SHED_RATIO` (measured net of freelist),
`POST /v1/identities` answers with the existing `StorageCapacityExhaustedError`
envelope — 503, `Retry-After: 30`, `retryable: true` — instead of running into
the hard write failure. It writes nothing, so a caller that retries after the
wait is not duplicating a committed identity.

It **fails open** at every uncertainty: shedding unset, capacity unset, no
sample, or a sample older than 15 minutes. A stale gauge means nobody is
sampling; that is not evidence the database is full, and rejecting live traffic
on an unrefreshed number would be worse than the cliff it softens.

## Runbook

### Before enabling anything: the V2 measurement (BLOCKING)

**Do not enable retention for any organization, and do not drain, until this has
been measured on a staging database.**

The open question is whether the hosted backend's *reported and billed* size
tracks the high-water mark (`page_count`) or live bytes. It decides whether GC
alone can ever get a database back under its cap or whether an export→import is
mandatory. Measure it — do not infer it, and do not run it against production.

Procedure, on a **staging** database only:

1. Seed or identify at least ~100k deletable identity rows.
2. Record the starting size from the platform's own reporting — for D1, the
   `meta.size_after` returned on a query, not a pragma (pragmas are rejected).
3. Enable retention for that staging org and run enough sweeps to delete a
   large, known fraction (10k+ rows at minimum; the more the clearer).
4. Record `meta.size_after` again, plus the platform's dashboard/billing size if
   it is reported separately.
5. Compare:
   - **Size unchanged** → reported size tracks the high-water mark. GC caps
     growth but cannot reduce the existing 5.53 GB; getting under the cap
     requires an export→import into a fresh database.
   - **Size dropped roughly in proportion to rows deleted** → reported size
     tracks live bytes. GC alone is sufficient and no migration is needed.

Record the result here when it is known.

### Enabling retention for an organization

1. Confirm the V2 measurement above has been done.
2. **Dry-run first.** `countStaleIdentitiesBatch` deletes nothing and is bounded
   by rows scanned rather than matches found, so it reports exactly what the
   equivalent sweep would delete.
3. Insert the config row explicitly — `enabled` defaults to `0`, so a row
   inserted without it changes nothing:

   ```sql
   INSERT INTO identity_retention_config (org_id, retention_days, enabled)
   VALUES ('org_example', 7, 1);
   ```

4. Schedule the sweep on the same cron as the token/audit sweeps, with its own
   cursor. **Do not assume those sweeps are already scheduled in production** —
   that is unverified. Identity GC stays inert until something schedules it.
5. Watch `relayauth.storage.capacity` and `GET /v1/stats/storage`.

To pin individual identities against retention, set
`metadata.retention = "keep"` on them.

### Disabling

Set `enabled = 0` for the organization, or delete its config row. Either makes
every identity in it ineligible immediately.

## Known limits and deliberate omissions

- **Export→import is out of scope and not automated.** Finding 6 means GC alone
  will not bring 5.53 GB down. Whether to migrate the production database into a
  fresh one is an operator decision, and this change neither performs nor
  automates it.
- **`PRAGMA auto_vacuum = INCREMENTAL` is not settable on D1** — same
  `SQLITE_AUTH` wall as `page_count` — so nothing here depends on it. If it
  turns out to be settable at database-creation time through some other channel,
  that is an operator action on a *future* database, not code in this change.
  It cannot be enabled on an existing database without a `VACUUM`.
- **`idx_identities_org_name` is deliberately still non-unique.** Making it
  unique would let `findDuplicate` settle the concurrent-create race instead of
  being a TOCTOU check, but it requires deduping the 1.09M existing rows first,
  and the caller-side fix currently in flight assumes today's non-unique index.
  **Sequence it after both this change and the caller fix have landed**, not
  alongside either.
- **No storage-contract change.** These are engine functions over the same plain
  `prepare()` executor shape the existing GC uses. `IdentityStorage` and
  `AuthStorage` are untouched, so no adapter update is required; the route reads
  a SQL executor by optional duck-typing and degrades to the reported-size path
  when there is none.
