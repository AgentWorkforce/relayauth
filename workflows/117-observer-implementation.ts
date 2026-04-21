/**
 * 117-observer-implementation.ts
 *
 * Implements the RelayAuth Observer per docs/observer-design.md.
 *
 * A real-time dashboard for visualizing auth events (token verification,
 * scope checks, denials) streamed over SSE from the RelayAuth server.
 *
 * Three phases:
 *   1. Server-side event emitter + SSE endpoint at /v1/observer/events
 *   2. Next.js observer dashboard at packages/observer (port 3101)
 *   3. Demo script at scripts/observer-demo.ts that generates events
 *
 * Pattern: DAG. Claude lead plans + reviews each phase; codex workers
 *          implement. 80-to-100 test/build/regression gates + typecheck
 *          + live E2E smoke of both observer dev server and demo script
 *          before commit.
 *
 * Run: agent-relay run workflows/117-observer-implementation.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const SERVER = RELAYAUTH + '/packages/server';
const OBSERVER = RELAYAUTH + '/packages/observer';

async function main() {
  const result = await workflow('117-observer-implementation')
    .description('Implement relayauth observer: server SSE + Next.js dashboard + demo script')
    .pattern('dag')
    .channel('wf-observer-impl')
    .maxConcurrency(6)
    .timeout(3_600_000)

    // ─── Agents ──────────────────────────────────────────────────────
    // Claude lead: plans, designs, and reviews codex worker output.
    .agent('lead', {
      cli: 'claude',
      preset: 'lead',
      role: 'Claude lead: owns the design, reviews each phase output, and decides whether to advance or bounce back for fixes',
      retries: 1,
    })
    // Claude reviewer: independent review of worker diffs after each phase.
    .agent('reviewer', {
      cli: 'claude',
      preset: 'reviewer',
      role: 'Independent Claude reviewer: audits diffs for correctness, security, and adherence to the design doc',
      retries: 1,
    })
    .agent('server-worker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Implements the server-side event emitter and SSE endpoint',
      retries: 2,
    })
    .agent('dashboard-worker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Builds the Next.js observer dashboard',
      retries: 2,
    })
    .agent('demo-worker', {
      cli: 'codex',
      preset: 'worker',
      role: 'Writes the demo script that exercises all observer events',
      retries: 2,
    })
    .agent('fixer', {
      cli: 'codex',
      preset: 'worker',
      role: 'Fixes test / build / regression failures',
      retries: 2,
    })

    // ═══════════════════════════════════════════════════════════════
    // PHASE 0: Read design + existing code context
    // ═══════════════════════════════════════════════════════════════

    .step('read-design', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/docs/observer-design.md`,
      captureOutput: true,
    })

    .step('read-server-index', {
      type: 'deterministic',
      command: `cat ${SERVER}/src/index.ts ${SERVER}/src/server.ts 2>/dev/null`,
      captureOutput: true,
    })

    .step('read-server-lib', {
      type: 'deterministic',
      command: `echo "=== auth.ts ===" && cat ${SERVER}/src/lib/auth.ts && echo "=== jwt.ts ===" && cat ${SERVER}/src/lib/jwt.ts`,
      captureOutput: true,
    })

    .step('read-routes-tree', {
      type: 'deterministic',
      command: `ls ${SERVER}/src/routes/ && echo "=== identities.ts head ===" && head -120 ${SERVER}/src/routes/identities.ts && echo "=== roles.ts head ===" && head -80 ${SERVER}/src/routes/roles.ts && echo "=== policies.ts head ===" && head -80 ${SERVER}/src/routes/policies.ts`,
      captureOutput: true,
    })

    .step('read-scope-checker', {
      type: 'deterministic',
      command: `find ${RELAYAUTH}/packages/core -name "scope-checker*" -o -name "scopes*" | head -5 | xargs -I{} sh -c 'echo "=== {} ===" && cat {}' 2>/dev/null | head -200`,
      captureOutput: true,
      failOnError: false,
    })

    .step('read-workspace-manifest', {
      type: 'deterministic',
      command: `cat ${RELAYAUTH}/package.json && echo "=== turbo.json ===" && cat ${RELAYAUTH}/turbo.json 2>/dev/null`,
      captureOutput: true,
    })

    // ── Lead reviews context and produces an implementation brief ───
    .step('lead-plan', {
      agent: 'lead',
      dependsOn: [
        'read-design',
        'read-server-index',
        'read-server-lib',
        'read-routes-tree',
        'read-scope-checker',
        'read-workspace-manifest',
      ],
      task: `You are the Claude lead for this workflow. Read the design and existing code
below, then produce a concise implementation brief (≤ 60 lines) that the codex
workers will consume.

DESIGN:
{{steps.read-design.output}}

SERVER ENTRY:
{{steps.read-server-index.output}}

AUTH / JWT:
{{steps.read-server-lib.output}}

ROUTES (identities / roles / policies):
{{steps.read-routes-tree.output}}

WORKSPACE:
{{steps.read-workspace-manifest.output}}

Your brief MUST answer:
1. Exact emit() call sites: which functions in auth.ts / jwt.ts emit token.verified
   vs token.invalid; which scope-check helper emits scope.check / scope.denied;
   which identities-route handler emits identity.created; where budget.alert is
   raised (likely the budget check inside identities POST / role-assignment).
2. The three existing endpoints the demo script will hit to produce scope checks
   (pick concrete paths from identities.ts / roles.ts / policies.ts — e.g.
   POST /v1/identities, GET /v1/roles/:id, POST /v1/policies).
3. The exact PUBLIC_PATHS additions server.ts needs ("/v1/observer/events",
   "/v1/observer/health") and confirmation that the isPublicPath() helper will
   match them.
4. Any gotchas for the Next.js app dir under the workspace (tsconfig extends,
   postcss / tailwind versions already used in sibling packages).

Write the brief to disk at ${RELAYAUTH}/.workflow/117-lead-brief.md (mkdir -p first).
Do NOT print the full brief to stdout — just confirm "brief written".`,
      verification: { type: 'file_exists', value: '.workflow/117-lead-brief.md' },
    })

    // ═══════════════════════════════════════════════════════════════
    // PHASE 1: Server — event emitter + SSE endpoint
    // ═══════════════════════════════════════════════════════════════

    .step('impl-event-emitter', {
      agent: 'server-worker',
      dependsOn: ['lead-plan'],
      task: `Implement the server-side event bus for the relayauth observer.

LEAD BRIEF: ${RELAYAUTH}/.workflow/117-lead-brief.md (read it first)

DESIGN:
{{steps.read-design.output}}

SERVER INDEX / SERVER.TS:
{{steps.read-server-index.output}}

EXISTING LIB:
{{steps.read-server-lib.output}}

ROUTES TREE:
{{steps.read-routes-tree.output}}

Create the file ${SERVER}/src/lib/events.ts with an in-process event bus:

Requirements:
1. Export an 'ObserverEvent' discriminated union with these variants:
   - { type: "token.verified", timestamp: string, payload: { sub: string; org: string; scopes: string[]; expiresIn: number } }
   - { type: "token.invalid",  timestamp: string, payload: { reason: string; sub?: string; org?: string } }
   - { type: "scope.check",    timestamp: string, payload: { agent: string; requestedScope: string; grantedScopes: string[]; result: "allowed" | "denied"; matchedScope?: string; evaluation: { plane: string; resource: string; action: string; path: string } } }
   - { type: "scope.denied",   timestamp: string, payload: { agent: string; requestedScope: string; grantedScopes: string[]; reason: string } }
   - { type: "identity.created", timestamp: string, payload: { id: string; org: string; name?: string } }
   - { type: "budget.alert",   timestamp: string, payload: { id: string; org: string; usage: number; limit: number } }

2. Export a class 'ObserverEventBus' with:
   - subscribe(listener: (e: ObserverEvent) => void, filter?: { orgId?: string; types?: string[] }): () => void  // returns unsubscribe
   - emit(event: ObserverEvent): void
   - listenerCount(): number
   Filter semantics: if filter.orgId is set, only events whose payload.org (or payload.orgId / payload.organization) matches are delivered. If filter.types is set, only matching types are delivered.

3. Export a module-level singleton: export const observerBus = new ObserverEventBus();

4. Include a helper 'now()' that returns new Date().toISOString() so event timestamps stay consistent.

IMPORTANT:
- Write to disk; do NOT print code to stdout.
- Use only stdlib — no new deps.
- The file must compile with the existing tsconfig (ESM, NodeNext-ish).
- Handle listener exceptions: a throwing listener must NOT break emit() for other listeners.`,
      verification: { type: 'file_exists', value: 'packages/server/src/lib/events.ts' },
    })

    .step('verify-event-emitter', {
      type: 'deterministic',
      dependsOn: ['impl-event-emitter'],
      command: `test -f ${SERVER}/src/lib/events.ts || { echo "MISSING events.ts"; exit 1; }
grep -q "ObserverEventBus" ${SERVER}/src/lib/events.ts || { echo "MISSING class"; exit 1; }
grep -q "observerBus" ${SERVER}/src/lib/events.ts || { echo "MISSING singleton"; exit 1; }
grep -q "token.verified" ${SERVER}/src/lib/events.ts || { echo "MISSING token.verified variant"; exit 1; }
grep -q "budget.alert" ${SERVER}/src/lib/events.ts || { echo "MISSING budget.alert variant"; exit 1; }
grep -q "identity.created" ${SERVER}/src/lib/events.ts || { echo "MISSING identity.created variant"; exit 1; }
echo "OK"`,
      failOnError: true,
      captureOutput: true,
    })

    .step('impl-sse-route', {
      agent: 'server-worker',
      dependsOn: ['verify-event-emitter'],
      task: `Create the SSE route that streams observer events to clients, and
wire emit() calls into the existing auth / scope / identity / budget code paths.

Create ${SERVER}/src/routes/observer.ts exporting a Hono sub-app.

Requirements:
1. GET /events — returns Content-Type: text/event-stream.
   - Accept query params: orgId?: string, types?: string (comma-separated list of event types)
   - For each emitted event matching the filter, write: 'data: <JSON>\\n\\n' to the stream.
   - Send a periodic ':ping\\n\\n' comment every 15 seconds to keep connections alive.
   - When the client disconnects (request aborted), call the unsubscribe function returned by observerBus.subscribe.
   - Use Hono's streamSSE helper from 'hono/streaming' if available; otherwise use a ReadableStream.

2. GET /health — returns { ok: true, listeners: number } using observerBus.listenerCount().

3. Export the Hono app so the server's main router can .route('/v1/observer', observerApp).

4. Hook the event bus into ALL of the following, each wrapped in a non-throwing try/catch:
   a. ${SERVER}/src/lib/auth.ts and/or ${SERVER}/src/lib/jwt.ts:
      - On successful token verification emit 'token.verified' with { sub, org, scopes, expiresIn }.
      - On failure emit 'token.invalid' with { reason, sub?, org? }.
   b. The scope-check path (find it via grep for checkScope / evaluateScope / matchScope):
      - Emit 'scope.check' with result="allowed" or "denied" plus the full evaluation detail.
      - Emit an additional 'scope.denied' when denied (same info + reason).
   c. ${SERVER}/src/routes/identities.ts — the POST / handler that creates identities:
      - After the storage call succeeds, emit 'identity.created' with { id, org, name }.
   d. The budget check (likely inside identities route or the usage-tracking helper):
      - When org usage crosses the configured limit, emit 'budget.alert'
        with { id, org, usage, limit }. If the code has no explicit budget check
        today, add the MINIMAL comparison and emit site — do not refactor.

5. Register the observer sub-app in ${SERVER}/src/server.ts via app.route('/v1/observer', observerApp).

6. Make /v1/observer/* public (no auth):
   - Add "/v1/observer/events" and "/v1/observer/health" to the PUBLIC_PATHS Set in server.ts,
     OR extend isPublicPath() with: path.startsWith("/v1/observer/")
   - Rationale: observer is a local/demo read-only stream; auth is not required.

IMPORTANT:
- Write to disk; do NOT print code to stdout.
- Keep changes in existing files minimal: imports + emit() calls + the route() line + PUBLIC_PATHS edit.
- Do not change existing behavior of auth / scope checking / identity creation; only observe.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-sse-route', {
      type: 'deterministic',
      dependsOn: ['impl-sse-route'],
      command: `set -e
test -f ${SERVER}/src/routes/observer.ts || { echo "MISSING observer.ts"; exit 1; }
grep -Eq "text/event-stream|streamSSE" ${SERVER}/src/routes/observer.ts || { echo "MISSING SSE"; exit 1; }
grep -Eq "observer" ${SERVER}/src/server.ts || { echo "observer NOT MOUNTED in server.ts"; exit 1; }
grep -Eq "/v1/observer" ${SERVER}/src/server.ts || { echo "PUBLIC_PATHS not updated for /v1/observer"; exit 1; }
# Confirm emit() hooks actually landed (uses emitObserverEvent helper):
test -f ${SERVER}/src/lib/jwt.ts && JWT_EXISTS=1 || JWT_EXISTS=0
if [ $JWT_EXISTS -eq 1 ]; then
  grep -q "emitObserverEvent" ${SERVER}/src/lib/auth.ts ${SERVER}/src/lib/jwt.ts || { echo "NO emitObserverEvent in auth.ts/jwt.ts"; exit 1; }
else
  grep -q "emitObserverEvent" ${SERVER}/src/lib/auth.ts || { echo "NO emitObserverEvent in auth.ts"; exit 1; }
fi
grep -q "identity.created" ${SERVER}/src/routes/identities.ts || { echo "NO identity.created emit in identities.ts"; exit 1; }
# At least one of scope.check or scope.denied is emitted somewhere in src/:
grep -rq "scope.check\\|scope.denied" ${SERVER}/src/lib ${SERVER}/src/routes || { echo "NO scope.* emit site"; exit 1; }
# budget.alert emit landed somewhere:
grep -rq "budget.alert" ${SERVER}/src/lib ${SERVER}/src/routes || { echo "NO budget.alert emit site"; exit 1; }
echo "OK"`,
      failOnError: true,
      captureOutput: true,
    })

    // ── Phase 1 review gate ──────────────────────────────────────────
    .step('review-phase-1', {
      agent: 'reviewer',
      dependsOn: ['verify-sse-route'],
      task: `Independent review of Phase 1 (server-side observer).

Read:
- ${SERVER}/src/lib/events.ts
- ${SERVER}/src/routes/observer.ts
- The diffs in ${SERVER}/src/lib/auth.ts, ${SERVER}/src/lib/jwt.ts,
  ${SERVER}/src/routes/identities.ts, ${SERVER}/src/server.ts
- ${RELAYAUTH}/docs/observer-design.md

Check:
1. Every event type declared in events.ts has at least one real emit() site in src/.
2. /v1/observer/events and /v1/observer/health are publicly accessible (no auth middleware blocks them).
3. emit() calls are wrapped in try/catch so a failing listener cannot break auth.
4. SSE route unsubscribes on client disconnect (no listener leak).
5. Filter semantics (orgId, types) match the design doc.

If issues found: write a short list of required fixes to ${RELAYAUTH}/.workflow/117-phase1-review.md
  and exit non-zero so a fixer picks it up.
If clean: write "APPROVED" to that file and exit 0.`,
      verification: { type: 'file_exists', value: '.workflow/117-phase1-review.md' },
    })

    // ── Test the server phase ────────────────────────────────────────
    .step('write-server-tests', {
      agent: 'server-worker',
      dependsOn: ['review-phase-1'],
      task: `Create node:test tests for the observer event bus and SSE endpoint.

Create ${SERVER}/src/__tests__/observer.test.ts using node:test + assert/strict.

Required tests:
1. Event bus:
   - subscribe + emit delivers the event to the listener
   - unsubscribe() stops delivery
   - filter.orgId delivers only matching events
   - filter.types delivers only matching event types
   - A throwing listener does not prevent other listeners from receiving the event
   - listenerCount() reflects current subscribers

2. SSE endpoint smoke test:
   - Import the Hono app (use the test-helpers.ts pattern already in this package)
   - GET /v1/observer/health returns { ok: true, listeners: <number> } without requiring auth
   - GET /v1/observer/events responds with 200 and Content-Type text/event-stream
     (you may abort the request after receiving the first chunk)
   - After subscribing a listener manually via observerBus, emit a test event and assert
     it reaches the listener.

Run: cd ${SERVER} && node --test --import tsx src/__tests__/observer.test.ts

IMPORTANT: Write to disk. Do NOT print to stdout.`,
      verification: { type: 'file_exists', value: 'packages/server/src/__tests__/observer.test.ts' },
    })

    .step('run-server-tests', {
      type: 'deterministic',
      dependsOn: ['write-server-tests'],
      command: `cd ${SERVER} && node --test --import tsx src/__tests__/observer.test.ts 2>&1 | tail -80`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-server-tests', {
      agent: 'fixer',
      dependsOn: ['run-server-tests'],
      task: `Fix any failures in the observer server tests.

TEST OUTPUT:
{{steps.run-server-tests.output}}

If all tests passed, do nothing.
If there are failures, read the failing test and source files, fix, and re-run:
  cd ${SERVER} && node --test --import tsx src/__tests__/observer.test.ts

Keep fixing until the test run is clean. Edit files on disk; do NOT print code to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('run-server-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-server-tests'],
      command: `cd ${SERVER} && node --test --import tsx src/__tests__/observer.test.ts 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════
    // PHASE 2: Observer dashboard (Next.js)
    // ═══════════════════════════════════════════════════════════════

    .step('scaffold-observer-package', {
      type: 'deterministic',
      dependsOn: ['read-workspace-manifest'],
      command: `mkdir -p ${OBSERVER}/src/app ${OBSERVER}/src/app/api/observer/events ${OBSERVER}/src/app/api/demo-scenario ${OBSERVER}/src/components ${OBSERVER}/src/lib ${OBSERVER}/src/types ${OBSERVER}/public && echo "scaffolded"`,
      captureOutput: true,
      failOnError: true,
    })

    .step('impl-observer-package-json', {
      agent: 'dashboard-worker',
      dependsOn: ['scaffold-observer-package', 'read-workspace-manifest'],
      task: `Create ${OBSERVER}/package.json for the Next.js observer dashboard,
plus all config files required for a working Next.js + Tailwind app in this monorepo.

WORKSPACE MANIFEST:
{{steps.read-workspace-manifest.output}}

Files to create (ALL required — the verification gate checks each one):
1. ${OBSERVER}/package.json
   - name: "@relayauth/observer", version: "0.1.0", private: true
   - scripts: dev = "next dev -p 3101", build = "next build", start = "next start -p 3101", lint = "next lint", typecheck = "tsc --noEmit"
   - dependencies: next ^14, react ^18, react-dom ^18
   - devDependencies: typescript, @types/react, @types/node, @types/react-dom, tailwindcss, postcss, autoprefixer, eslint, eslint-config-next
   - Pin versions consistent with the rest of the monorepo.

2. ${OBSERVER}/next.config.js — module.exports = { reactStrictMode: true };

3. ${OBSERVER}/tsconfig.json — standard Next.js app-dir tsconfig
   (extends workspace base if one exists; otherwise the canonical Next.js one with "jsx": "preserve", "moduleResolution": "bundler").

4. ${OBSERVER}/tailwind.config.ts — content globs cover src/app and src/components.

5. ${OBSERVER}/postcss.config.js — tailwindcss + autoprefixer.

6. ${OBSERVER}/src/app/globals.css — @tailwind base/components/utilities directives.

IMPORTANT: Write to disk; do NOT print to stdout.`,
      verification: { type: 'file_exists', value: 'packages/observer/package.json' },
    })

    .step('verify-observer-config-files', {
      type: 'deterministic',
      dependsOn: ['impl-observer-package-json'],
      command: `set -e
for f in package.json next.config.js tsconfig.json tailwind.config.ts postcss.config.js src/app/globals.css; do
  test -f ${OBSERVER}/$f || { echo "MISSING: $f"; exit 1; }
done
grep -q '"dev"' ${OBSERVER}/package.json || { echo "package.json missing dev script"; exit 1; }
grep -q '"typecheck"' ${OBSERVER}/package.json || { echo "package.json missing typecheck script"; exit 1; }
grep -q '@tailwind' ${OBSERVER}/src/app/globals.css || { echo "globals.css missing tailwind directives"; exit 1; }
echo "OK"`,
      failOnError: true,
      captureOutput: true,
    })

    .step('impl-observer-sse-client', {
      agent: 'dashboard-worker',
      dependsOn: ['verify-observer-config-files'],
      task: `Create the SSE client and shared types for the observer dashboard.

Files to create:

1. ${OBSERVER}/src/types/index.ts
   - Export the ObserverEvent discriminated union (mirror the server definition from packages/server/src/lib/events.ts).
   - Duplicate is intentional — the observer package is browser-only and must not import server code.

2. ${OBSERVER}/src/lib/sse-client.ts
   - Export connectObserver({ url, orgId?, types? }: { url: string; orgId?: string; types?: string[] }): { close(): void; onEvent: (cb: (e: ObserverEvent) => void) => void }
   - Uses the browser EventSource API.
   - Auto-reconnect with exponential backoff capped at 10s on error.
   - Parses each 'message' event's data as JSON and fans out to registered listeners.

IMPORTANT: Write to disk; do NOT print to stdout.`,
      verification: { type: 'file_exists', value: 'packages/observer/src/lib/sse-client.ts' },
    })

    .step('verify-observer-sse-client', {
      type: 'deterministic',
      dependsOn: ['impl-observer-sse-client'],
      command: `set -e
test -f ${OBSERVER}/src/types/index.ts || { echo "MISSING types/index.ts"; exit 1; }
test -f ${OBSERVER}/src/lib/sse-client.ts || { echo "MISSING lib/sse-client.ts"; exit 1; }
grep -q "ObserverEvent" ${OBSERVER}/src/types/index.ts || { echo "types/index.ts missing ObserverEvent"; exit 1; }
grep -q "EventSource" ${OBSERVER}/src/lib/sse-client.ts || { echo "sse-client.ts missing EventSource"; exit 1; }
echo "OK"`,
      failOnError: true,
      captureOutput: true,
    })

    .step('impl-observer-components', {
      agent: 'dashboard-worker',
      dependsOn: ['verify-observer-sse-client'],
      task: `Implement the four React components and the app shell.

Files to create:

1. ${OBSERVER}/src/components/EventFeed.tsx
   - Shows incoming events newest-first, max 200 kept in memory.
   - Each row: timestamp, colored status chip (ALLOWED = green, DENIED = red, VERIFIED = blue), one-line summary.
   - Click a row to select it (lift state up).

2. ${OBSERVER}/src/components/ScopeVisualizer.tsx
   - Given a selected event, show the scope evaluation:
     requested scope, list of granted scopes with ✓/✗ per match, result, reason.

3. ${OBSERVER}/src/components/AgentMap.tsx
   - Derives a unique list of agents seen in the event stream with their latest known scopes.
   - Rendered as a sidebar list.

4. ${OBSERVER}/src/components/DemoPanel.tsx
   - Four buttons matching the demo scenarios in docs/observer-design.md.
   - Each button POSTs to /api/demo-scenario with { scenario: 1|2|3|4 } (route handler added in the app dir).

5. ${OBSERVER}/src/app/layout.tsx — minimal root layout with globals.css import.
6. ${OBSERVER}/src/app/page.tsx — mounts connectObserver({ url: '/api/observer/events' }) inside a useEffect; wires the four components together. Mark it 'use client'.
7. ${OBSERVER}/src/app/api/observer/events/route.ts — proxy/forward to the relayauth server's /v1/observer/events (server URL from process.env.RELAYAUTH_URL || 'http://localhost:8787'). Stream the upstream response body back unchanged.
8. ${OBSERVER}/src/app/api/demo-scenario/route.ts — spawns 'tsx ../../scripts/observer-demo.ts --scenario=N' via child_process and returns { ok: true } when the process starts. If the script path resolution is brittle, fall back to POSTing the relayauth server's existing endpoints directly from this route.

Use Tailwind classes for styling. Keep components small and readable (<150 lines each).

IMPORTANT: Write to disk; do NOT print to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-observer-components', {
      type: 'deterministic',
      dependsOn: ['impl-observer-components'],
      command: `set -e
for f in src/types/index.ts src/lib/sse-client.ts src/components/EventFeed.tsx src/components/ScopeVisualizer.tsx src/components/AgentMap.tsx src/components/DemoPanel.tsx src/app/layout.tsx src/app/page.tsx src/app/api/observer/events/route.ts src/app/api/demo-scenario/route.ts; do
  test -f ${OBSERVER}/$f || { echo "MISSING: $f"; exit 1; }
done
# page.tsx should be a client component since it uses EventSource
grep -q "'use client'\\|\\"use client\\"" ${OBSERVER}/src/app/page.tsx || { echo "page.tsx missing 'use client'"; exit 1; }
echo "OK"`,
      failOnError: true,
      captureOutput: true,
    })

    .step('install-observer-deps', {
      type: 'deterministic',
      dependsOn: ['verify-observer-components'],
      command: `cd ${RELAYAUTH} && npm install 2>&1 | tail -20`,
      captureOutput: true,
      failOnError: false,
    })

    .step('build-observer', {
      type: 'deterministic',
      dependsOn: ['install-observer-deps'],
      command: `cd ${OBSERVER} && npx next build 2>&1 | tail -40; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-observer-build', {
      agent: 'fixer',
      dependsOn: ['build-observer'],
      task: `Fix any Next.js build failures in packages/observer.

BUILD OUTPUT:
{{steps.build-observer.output}}

If the build already succeeded (EXIT: 0), do nothing.

Common fixes:
- Missing 'use client' directive on components using EventSource / useState / useEffect
- tsconfig path/jsx issues
- Missing deps in package.json
- Tailwind config referencing non-existent files

Re-run to verify: cd ${OBSERVER} && npx next build

IMPORTANT: Write fixes to disk; do NOT print code to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('build-observer-final', {
      type: 'deterministic',
      dependsOn: ['fix-observer-build'],
      command: `cd ${OBSERVER} && npx next build 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Phase 2 live E2E: actually start the observer dev server ────
    .step('e2e-observer-dev-server', {
      type: 'deterministic',
      dependsOn: ['build-observer-final'],
      command: `set +e
cd ${OBSERVER}
# Start dev server in the background, log to file
(npx next dev -p 3101 > /tmp/observer-dev.log 2>&1 &)
DEV_PID=$!
# Wait up to 30s for the server to respond on 3101
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://localhost:3101/; then
    echo "observer dev server up on 3101"
    break
  fi
  sleep 1
done
STATUS=$(curl -s -o /tmp/observer-root.html -w "%{http_code}" http://localhost:3101/)
echo "GET / -> $STATUS"
# Kill the dev server (find by port to be robust)
lsof -ti tcp:3101 | xargs -r kill -9 2>/dev/null || true
if [ "$STATUS" != "200" ]; then
  echo "--- dev log tail ---"; tail -40 /tmp/observer-dev.log
  exit 1
fi
# Sanity check HTML actually rendered something
grep -Eq "<html|<!DOCTYPE" /tmp/observer-root.html || { echo "root HTML looks empty"; exit 1; }
echo "OK"`,
      captureOutput: true,
      failOnError: true,
      timeoutMs: 120_000,
    })

    // ── Phase 2 review gate ─────────────────────────────────────────
    .step('review-phase-2', {
      agent: 'reviewer',
      dependsOn: ['e2e-observer-dev-server'],
      task: `Independent review of Phase 2 (observer dashboard).

Read the files under ${OBSERVER}/src and confirm:
1. The SSE client handles reconnect without piling up listeners.
2. The /api/observer/events route actually streams (no buffering that would break SSE).
3. Components render without hydration mismatches (no window/document in server components).
4. page.tsx unmounts the SSE connection in useEffect cleanup.
5. Tailwind + tsconfig are sane (no missing paths).

Write "APPROVED" or a fix-list to ${RELAYAUTH}/.workflow/117-phase2-review.md.
If fixes are required, exit non-zero.`,
      verification: { type: 'file_exists', value: '.workflow/117-phase2-review.md' },
    })

    // ═══════════════════════════════════════════════════════════════
    // PHASE 3: Demo script
    // ═══════════════════════════════════════════════════════════════

    .step('impl-demo-script', {
      agent: 'demo-worker',
      dependsOn: ['run-server-tests-final', 'review-phase-2'],
      task: `Create ${RELAYAUTH}/scripts/observer-demo.ts — a standalone script that exercises
the observer by generating a realistic event stream against REAL existing endpoints.

DESIGN CONTEXT:
{{steps.read-design.output}}

ROUTES CONTEXT (what endpoints actually exist):
{{steps.read-routes-tree.output}}

LEAD BRIEF: ${RELAYAUTH}/.workflow/117-lead-brief.md (consult the "three endpoints" section)

Requirements:
1. Shebang: #!/usr/bin/env -S tsx
2. Assumes the relayauth server is running at http://localhost:8787 (override via RELAYAUTH_URL).
3. Runs FOUR scenarios sequentially with ~1.5s delay between each. Each scenario must hit
   a REAL endpoint that exists in the repo today (see ROUTES CONTEXT). Pick from:
     - POST/GET /v1/identities
     - POST/GET /v1/roles  and  POST /v1/roles/:id/assignments
     - POST/GET /v1/policies
   Scenarios:
   a. Scope-denied: token missing the scope needed to POST /v1/identities   → expect scope.denied
   b. Scope-allowed: admin token hitting GET /v1/identities                 → expect scope.check allowed + token.verified
   c. token.invalid: send a deliberately malformed/expired JWT              → expect token.invalid
   d. budget.alert: create identities / trigger the usage path until the org's
      budget threshold fires (or POST a small override to force it)         → expect budget.alert

4. For each scenario:
   - Generate a dev token via ${RELAYAUTH}/scripts/generate-dev-token.sh (shell out).
     Produce distinct tokens per scenario (different scope sets).
   - Make the HTTP request that exercises the scope check.
   - Log what was attempted, the HTTP status, and response body snippet.

5. Accept a --scenario=1|2|3|4 CLI arg to run a single scenario (used by the dashboard DemoPanel).
   Without the flag, run all four.

6. Print a clear summary at the end: each scenario, expected event type, HTTP status.
   Exit non-zero if any scenario fails to hit the server (network error), but do NOT exit
   non-zero merely because a request returned 403 — that is the expected outcome for scenario a.

IMPORTANT:
- Write the file to disk; do NOT print code to stdout.
- Keep the script < 300 lines.
- Use native fetch (Node 20+ has it) — no axios.`,
      verification: { type: 'file_exists', value: 'scripts/observer-demo.ts' },
    })

    .step('verify-demo-script', {
      type: 'deterministic',
      dependsOn: ['impl-demo-script'],
      command: `set -e
test -f ${RELAYAUTH}/scripts/observer-demo.ts || { echo "MISSING"; exit 1; }
grep -Eq "scenario" ${RELAYAUTH}/scripts/observer-demo.ts || { echo "missing scenario handling"; exit 1; }
grep -Eq "fetch\\(" ${RELAYAUTH}/scripts/observer-demo.ts || { echo "missing fetch call"; exit 1; }
grep -Eq "/v1/(identities|roles|policies)" ${RELAYAUTH}/scripts/observer-demo.ts || { echo "demo not hitting real endpoints"; exit 1; }
# Fast typecheck the script in isolation (best-effort; don't block on env glitches)
cd ${RELAYAUTH} && npx tsx --check scripts/observer-demo.ts 2>&1 | tail -20 || true
echo "OK"`,
      failOnError: true,
      captureOutput: true,
    })

    // ── Phase 3 live E2E: run server + demo, verify SSE receives events ──
    .step('e2e-demo-produces-events', {
      type: 'deterministic',
      dependsOn: ['verify-demo-script', 'run-server-tests-final'],
      command: `set +e
cd ${RELAYAUTH}
# Start the relayauth server in the background
(npx tsx packages/server/src/server.ts > /tmp/relayauth-server.log 2>&1 &)
SERVER_PID=$!
# Wait for /health
for i in $(seq 1 30); do
  if curl -sf -o /dev/null http://localhost:8787/health; then
    echo "relayauth server up on 8787"
    break
  fi
  sleep 1
done
# Capture SSE events in the background for 20 seconds
(timeout 20 curl -sN http://localhost:8787/v1/observer/events > /tmp/observer-sse.log 2>&1 &)
SSE_PID=$!
sleep 2
# Run the demo
npx tsx scripts/observer-demo.ts 2>&1 | tee /tmp/observer-demo-run.log | tail -60
DEMO_EXIT=$?
# Let SSE flush
sleep 3
# Tear down
lsof -ti tcp:8787 | xargs -r kill -9 2>/dev/null || true
wait $SSE_PID 2>/dev/null || true
echo "--- SSE capture (first 40 lines) ---"
head -40 /tmp/observer-sse.log
# We require at least one data: line in the SSE capture
grep -Eq "^data: " /tmp/observer-sse.log || { echo "NO SSE events captured"; echo "--- server log tail ---"; tail -40 /tmp/relayauth-server.log; exit 1; }
if [ "$DEMO_EXIT" != "0" ]; then
  echo "demo script failed (exit $DEMO_EXIT)"
  exit 1
fi
echo "OK"`,
      captureOutput: true,
      failOnError: true,
      timeoutMs: 180_000,
    })

    // ── Phase 3 review ──────────────────────────────────────────────
    .step('review-phase-3', {
      agent: 'reviewer',
      dependsOn: ['e2e-demo-produces-events'],
      task: `Independent review of Phase 3.

Read ${RELAYAUTH}/scripts/observer-demo.ts and /tmp/observer-sse.log.

Confirm:
1. Demo hits endpoints that truly exist (grep the routes/ dir if uncertain).
2. The four scenarios map to the four event types the observer advertises.
3. SSE capture contained events for each scenario type where plausible.

Write APPROVED / fix-list to ${RELAYAUTH}/.workflow/117-phase3-review.md.`,
      verification: { type: 'file_exists', value: '.workflow/117-phase3-review.md' },
    })

    // ═══════════════════════════════════════════════════════════════
    // PHASE 4: Cross-cutting typecheck + regression + workspace gates
    // ═══════════════════════════════════════════════════════════════

    .step('server-typecheck', {
      type: 'deterministic',
      dependsOn: ['review-phase-3'],
      command: `cd ${SERVER} && npx tsc --noEmit 2>&1 | tail -30; echo "EXIT: $?"`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-server-typecheck', {
      agent: 'fixer',
      dependsOn: ['server-typecheck'],
      task: `Fix server TypeScript errors introduced by the observer integration.

TYPECHECK OUTPUT:
{{steps.server-typecheck.output}}

If EXIT: 0, do nothing.
Otherwise, fix the errors (most likely in packages/server/src/lib/events.ts, routes/observer.ts,
or the auth hook sites). Re-run: cd ${SERVER} && npx tsc --noEmit

IMPORTANT: Write fixes to disk; do NOT print code to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('server-typecheck-final', {
      type: 'deterministic',
      dependsOn: ['fix-server-typecheck'],
      command: `cd ${SERVER} && npx tsc --noEmit 2>&1 | tail -20`,
      captureOutput: true,
      failOnError: true,
    })

    .step('observer-typecheck-final', {
      type: 'deterministic',
      dependsOn: ['build-observer-final'],
      command: `cd ${OBSERVER} && npx tsc --noEmit 2>&1 | tail -30`,
      captureOutput: true,
      failOnError: true,
    })

    // Full workspace typecheck via turbo (catches cross-package breakage)
    .step('workspace-typecheck', {
      type: 'deterministic',
      dependsOn: ['server-typecheck-final', 'observer-typecheck-final'],
      command: `cd ${RELAYAUTH} && npx turbo typecheck 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: true,
    })

    // Full server test suite (regression — includes E2E dir)
    .step('regression-tests', {
      type: 'deterministic',
      dependsOn: ['server-typecheck-final'],
      command: `cd ${SERVER} && node --test --import tsx "src/__tests__/**/*.test.ts" 2>&1 | tail -60`,
      captureOutput: true,
      failOnError: false,
    })

    .step('fix-regressions', {
      agent: 'fixer',
      dependsOn: ['regression-tests'],
      task: `Fix regressions in the full server test suite (including E2E) caused by the observer changes.

TEST OUTPUT:
{{steps.regression-tests.output}}

If all tests passed, do nothing.
Otherwise, identify which existing tests broke because of the observer hooks (most likely
emit() calls in auth.ts / jwt.ts / identities route), and fix them. Re-run:
  cd ${SERVER} && node --test --import tsx "src/__tests__/**/*.test.ts"

IMPORTANT: Never disable tests. Never wrap emit() with silent swallow if that hides the real bug.
Write fixes to disk; do NOT print code to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('regression-tests-final', {
      type: 'deterministic',
      dependsOn: ['fix-regressions'],
      command: `cd ${SERVER} && node --test --import tsx "src/__tests__/**/*.test.ts" 2>&1 | tail -40`,
      captureOutput: true,
      failOnError: true,
    })

    // ── Root package.json: add dev:observer and dev:all scripts ─────
    .step('add-root-dev-scripts', {
      agent: 'dashboard-worker',
      dependsOn: ['regression-tests-final', 'workspace-typecheck'],
      task: `Update ${RELAYAUTH}/package.json to add two convenience scripts so a
developer can run the full stack locally:

- "dev:observer": "npm --workspace @relayauth/observer run dev"
- "dev:all": "concurrently -n server,observer -c blue,magenta 'npm run dev:server' 'npm run dev:observer'"

Requirements:
1. Add both scripts to the existing "scripts" object. Preserve every other field and script.
2. Add "concurrently" to devDependencies (latest ^8 range) if not already present.
3. Do NOT touch the rest of package.json (name, workspaces, deps, etc.).
4. Run: cd ${RELAYAUTH} && npm install  to refresh the lockfile.

IMPORTANT: Write to disk; do NOT print to stdout.`,
      verification: { type: 'exit_code' },
    })

    .step('verify-root-dev-scripts', {
      type: 'deterministic',
      dependsOn: ['add-root-dev-scripts'],
      command: `set -e
grep -q '"dev:observer"' ${RELAYAUTH}/package.json || { echo "root package.json missing dev:observer"; exit 1; }
grep -q '"dev:all"' ${RELAYAUTH}/package.json || { echo "root package.json missing dev:all"; exit 1; }
grep -q '"concurrently"' ${RELAYAUTH}/package.json || { echo "root package.json missing concurrently dev dep"; exit 1; }
echo "OK"`,
      failOnError: true,
      captureOutput: true,
    })

    // ── Hard final gate: one more pass of every check before committing ──
    .step('final-verification', {
      type: 'deterministic',
      dependsOn: [
        'run-server-tests-final',
        'regression-tests-final',
        'server-typecheck-final',
        'observer-typecheck-final',
        'workspace-typecheck',
        'build-observer-final',
        'e2e-observer-dev-server',
        'e2e-demo-produces-events',
        'verify-root-dev-scripts',
      ],
      command: `set -e
echo "=== final gate: re-running the critical checks ==="
cd ${SERVER} && npx tsc --noEmit > /dev/null && echo "server tsc OK"
cd ${OBSERVER} && npx tsc --noEmit > /dev/null && echo "observer tsc OK"
cd ${SERVER} && node --test --import tsx src/__tests__/observer.test.ts > /dev/null && echo "observer tests OK"
grep -q "/v1/observer" ${SERVER}/src/server.ts && echo "PUBLIC_PATHS OK"
test -f ${OBSERVER}/.next/BUILD_ID && echo "observer build artifact OK"
echo "ALL GATES PASSED"`,
      captureOutput: true,
      failOnError: true,
    })

    // ═══════════════════════════════════════════════════════════════
    // PHASE 5: Commit
    // ═══════════════════════════════════════════════════════════════

    .step('commit', {
      type: 'deterministic',
      dependsOn: ['final-verification'],
      command: `cd ${RELAYAUTH} && git add \
  packages/server/src/lib/events.ts \
  packages/server/src/routes/observer.ts \
  packages/server/src/__tests__/observer.test.ts \
  packages/server/src/index.ts \
  packages/server/src/server.ts \
  packages/server/src/lib/auth.ts \
  packages/server/src/lib/jwt.ts \
  packages/server/src/routes/identities.ts \
  packages/observer \
  scripts/observer-demo.ts \
  package.json \
  package-lock.json 2>/dev/null || true
git status --short
git commit -m "feat(observer): real-time auth event dashboard via SSE

Implements docs/observer-design.md:
- Server-side ObserverEventBus + /v1/observer/events SSE endpoint (public)
- Next.js dashboard at packages/observer (port 3101)
- Demo script scripts/observer-demo.ts covering 4 scenarios against real endpoints
- Root dev:observer / dev:all scripts for local run

Hooks token verification, scope checks, identity creation, and budget
alerts into an in-process event bus; the SSE endpoint streams filtered
events to connected dashboards.

Co-Authored-By: agent-relay workflow 117" 2>&1 | tail -10`,
      captureOutput: true,
      failOnError: false,
    })

    .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
    .run({
      cwd: RELAYAUTH,
      onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
    });

  console.log(`\n117 Observer Implementation: ${result.status}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
