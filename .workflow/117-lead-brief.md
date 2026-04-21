# RelayAuth Observer — Implementation Brief (step: lead-plan)

Goal: live SSE feed of auth events + Next.js dashboard at `packages/observer`.

## 1. Event bus (new file)
Create `packages/server/src/lib/events.ts` exporting a singleton `EventEmitter`-like
bus (`emit(type, payload)`, `subscribe(handler) → unsubscribe`). Use a plain
`Set<(ev) => void>` — no deps. Export `ObserverEvent` union type.
Expose through `AppEnv.Variables` as `observer` OR import singleton directly
(prefer singleton — avoids plumbing through every handler).

## 2. Emit call sites (exact)

**`packages/server/src/lib/auth.ts`** — modify `verifyToken()`:
- On success (just before `return payload;` at end of function): `emit("token.verified", { sub, org, scopes, exp })`.
- On every `return null;` branch (invalid parts / bad alg / bad sig / expired / bad claims): `emit("token.invalid", { reason })`. Pass a distinct reason per branch (`"bad_signature"`, `"expired"`, `"malformed_claims"`, etc.) so the UI can show why.

**`packages/server/src/lib/auth.ts`** — modify `authenticateAndAuthorize()`:
- After the `matchScopeFn(requiredScope, auth.claims.scopes)` call:
  - True → `emit("scope.check", { agent: claims.sub, requestedScope, grantedScopes: claims.scopes, result: "allowed" })`.
  - False / throw → `emit("scope.denied", { agent: claims.sub, requestedScope, grantedScopes: claims.scopes, reason: "no_matching_scope" })`.

**`packages/server/src/routes/identities.ts`** — POST `/` handler (line 413):
- After `const createdIdentity = await storage.identities.create(storedIdentity);` (line 466): `emit("identity.created", { id: createdIdentity.id, name, type, orgId: auth.claims.org, scopes, sponsorId })`.

**Budget alert**: there is no current enforcement path. Add a stub emit inside `loadOrgBudget` consumer at line 447 — if `budget?.limit` and org usage crosses threshold (read from `storage.identities` if cheap, else punt). **Workers: skip budget.alert if it requires new storage APIs — emit only from existing data.** Mark as TODO in code.

## 3. SSE endpoint
New route `packages/server/src/routes/observer.ts`:
- `GET /v1/observer/events` → `text/event-stream`, subscribes to bus, writes `data: <json>\n\n` per event, heartbeats every 15s. Accept `?types=` filter (CSV) and `?orgId=` filter.
- `GET /v1/observer/health` → `{ status: "ok", subscribers: N }`.
- Register in `server.ts` via `app.route("/v1/observer", observer)`.

## 4. PUBLIC_PATHS additions (server.ts lines 18–22)
Add both to the Set:
```
"/v1/observer/events",
"/v1/observer/health",
```
`isPublicPath()` does `PUBLIC_PATHS.has(path)` — exact-match hits both. No prefix logic needed. (Do NOT make all `/v1/observer/*` public — leaves room for future authenticated admin endpoints.) CORS middleware runs before the auth middleware so it already applies.

## 5. Demo script endpoints
`scripts/observer-demo.ts` (tsx, uses `scripts/generate-dev-token.sh` pattern).
Three real endpoints that go through `authenticateAndAuthorize` and thus emit `scope.check` / `scope.denied`:
1. `POST /v1/identities` — scope `relayauth:identity:manage:*` (identities.ts:189/229 for update — use POST at line 413 for create). Creates a fresh agent → also emits `identity.created`.
2. `GET /v1/roles` — scope `relayauth:role:read:*` (roles.ts:67).
3. `POST /v1/policies` — scope `relayauth:policy:manage:*` (policies.ts:29).

For the denied demo: generate a token with ONLY `relayauth:identity:read:*` and hit `POST /v1/policies` → `scope.denied` event fires.

## 6. Observer dashboard (Next.js) — gotchas
`packages/observer/` currently has empty `src/{app,components,lib,types}` dirs. Workers must create `package.json`, `next.config.js`, `tsconfig.json`, `postcss.config.js`, `tailwind.config.ts` from scratch.

- **No sibling Next.js** in the workspace — `packages/landing` is Astro 4.16 + tailwind 3.4. **Pin `tailwindcss@^3.4.17`** to match landing (avoid v4 churn). Use `next@^14` (app router) to match Node 22 setup in CI.
- **No shared tsconfig base** — each package has its own. Do not `extends` anything; write a standalone `tsconfig.json` with `"moduleResolution": "bundler"`, `"jsx": "preserve"`.
- **Workspace is npm workspaces** (root package.json `workspaces: ["packages/*", ...]`). New deps go in `packages/observer/package.json`, not root. Name: `@relayauth/observer`, `private: true`.
- **Turbo `dev` task is `persistent: true`** (turbo.json) — add `dev` script `next dev -p 3101` to observer package.json so `npm run dev` picks it up.
- **SSE client**: use native `EventSource` in a client component; server URL from `NEXT_PUBLIC_RELAYAUTH_URL` (default `http://localhost:8787`). Do NOT proxy through a Next route — direct connect is simpler and the endpoint is public.
- **`ALLOWED_ORIGINS` env** must include `http://localhost:3101` for the dashboard, or leave unset (fallback echoes `*`).

## 7. Out of scope for workers
- Persistent event history (design doc Open Q #2). Emit only; no DB writes.
- WebSocket support.
- Observer auth (local-only for now).

OWNER_DECISION: COMPLETE
REASON: Brief answers all four required questions with concrete file paths and line numbers.
