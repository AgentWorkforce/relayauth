# Phase 3 Review — Observer Demo

**Verdict: APPROVED**

## 1. Endpoints exist

All endpoints exercised by `scripts/observer-demo.ts` are real and reachable through `packages/server/src/server.ts`:

| Demo call | Route mount | Handler |
|---|---|---|
| `POST /v1/identities` (scenarios 1 & 4) | `app.route("/v1/identities", identities)` (server.ts:153) | `identities.post("/", ...)` (routes/identities.ts:414) |
| `GET /v1/identities?limit=5` (scenario 2) | same | `identities.get("/", ...)` (routes/identities.ts:127) |
| `GET /v1/roles` (scenario 3) | `app.route("/v1/roles", roles)` (server.ts:157) | `roles.get("/", ...)` (routes/roles.ts:57) |
| `PATCH /v1/identities/:id` (scenario 4 follow-up) | mount above | `identities.patch("/:id", ...)` (routes/identities.ts:186) |
| SSE `/v1/observer/events` (capture target) | `app.route("/v1/observer", observerApp)` (server.ts:155) | `observerApp.get("/events", ...)` (routes/observer.ts:10) |

`/v1/observer/*` is in the `PUBLIC_PATHS` allowlist (server.ts:49), matching the demo's pattern of subscribing without a bearer token.

## 2. Scenario → event-type mapping

The observer event union in `packages/server/src/lib/events.ts` advertises six types: `token.verified`, `token.invalid`, `scope.check`, `scope.denied`, `identity.created`, `budget.alert`. (Worth noting: the prompt said "four event types" but the observer actually advertises six. The four *scenarios* still cover the four headline failure/lifecycle types, which is what matters.)

| Scenario | Demo intent (`expectedEvent`) | Mapping |
|---|---|---|
| 1 — read-only token POSTs `/v1/identities` | `scope.denied` | matches `scope.denied` event variant |
| 2 — admin token GETs `/v1/identities` | `token.verified + scope.check allowed` | matches `token.verified` + `scope.check` (result `allowed`) variants |
| 3 — expired token GETs `/v1/roles` | `token.invalid` | matches `token.invalid` variant (reason `token_expired`) |
| 4 — create budgeted identity then PATCH usage over limit | `budget.alert` | matches `budget.alert` variant |

Mapping is clean. All four expected event types are real members of the `ObserverEvent` discriminated union.

## 3. SSE capture covers each scenario

`/tmp/observer-sse.log` (24 lines, 12 events, single demo run `mo8fguaq-15719` at 09:34:55–09:35:00 UTC) contains:

- **Scenario 1** (`observer-denied-…`): `token.verified` → `scope.check` (denied, requested `relayauth:identity:manage:*`) → `scope.denied` (reason `insufficient_scope`). Lines 1–5. ✓
- **Scenario 2** (`observer-admin-read-…`): `token.verified` → `scope.check` (allowed, matched `relayauth:identity:read:*`). Lines 7–9. ✓ (No `scope.denied`, as expected.)
- **Scenario 3** (`observer-expired-…`): `token.invalid` (reason `token_expired`). Line 11. ✓ (No `token.verified`/`scope.check` follow-up, as expected for a rejected token.)
- **Scenario 4** (`observer-budget-admin-…`): `token.verified` → `scope.check` (allowed) → `identity.created` (the budgeted agent) → second `token.verified` → second `scope.check` (allowed) → `budget.alert` (`usage:2 limit:1`). Lines 13–23. ✓

Every scenario produced its expected event type, plus the supporting `token.verified` / `scope.check` traffic where plausible. Timestamps are monotonically ordered and the agent subjects in the event payloads correspond to the unique `runId`-suffixed `sub` values the demo generated, confirming the log is from a coherent demo execution and not stale fixture data.

## Fix list

None. Phase 3 demo and capture meet the bar.

## Minor observations (non-blocking)

- The expected-event string for scenario 2 is descriptive (`"token.verified + scope.check allowed"`) rather than a single canonical event name; harmless, but a pure event-type label would make programmatic verification slightly cleaner.
- `identity.created` and the secondary `token.verified` / `scope.check` events fire during scenario 4 but aren't called out in the demo's `expectedEvent` metadata. Not a defect — the demo's claim is "budget alert fires," which it does — just noting these aren't asserted on.
- The observer advertises six event types; the prompt's "four event types" framing slightly under-counts the surface area but does not affect the verdict.
