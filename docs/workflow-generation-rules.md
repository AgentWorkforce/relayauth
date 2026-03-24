# Workflow Generation Rules

> THE reference for generating all relayauth workflows (002-100).
> Every workflow generator MUST follow these rules exactly.

---

## 1. File Naming and Structure

### File path
```
workflows/{NNN}-{kebab-name}.ts
```
- `NNN` = zero-padded 3-digit number (002, 011, 099)
- `{kebab-name}` = lowercase kebab-case matching the manifest name

### Boilerplate

```typescript
/**
 * {NNN}-{kebab-name}.ts
 *
 * Domain {D}: {Domain Name}
 * {One-line description from manifest}
 *
 * Depends on: {comma-separated list of prerequisite workflow numbers}
 * Run: agent-relay run workflows/{NNN}-{kebab-name}.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('{NNN}-{kebab-name}')
  .description('{description}')
  .pattern('{dag|pipeline|hub-spoke}')
  .channel('wf-relayauth-{NNN}')
  .maxConcurrency({4 or 5})
  .timeout({timeout_ms})

  // ... agents, steps ...

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n{NNN} {Title}: ${result.status}`);
}

main().catch(console.error);
```

### Constants
- `ROOT` — always `/Users/khaliqgant/Projects/AgentWorkforce/relayauth`
- `RELAYCAST` — always `/Users/khaliqgant/Projects/AgentWorkforce/relaycast`
- `RELAYFILE` — always `/Users/khaliqgant/Projects/AgentWorkforce/relayfile`

### Timeouts
- Small workflow (spec, config): `900_000` (15 min)
- Standard feature workflow: `1_200_000` (20 min)
- Large implementation: `1_800_000` (30 min)
- E2E workflows: `1_200_000` (20 min)

---

## 2. Agent Pattern (MANDATORY)

Every workflow MUST define exactly this agent mix:

### a) Claude Lead (1 per workflow)
```typescript
.agent('architect', {
  cli: 'claude',
  preset: 'lead',
  role: '{role description}',
  cwd: ROOT,
})
```
- Designs approach, makes architecture decisions
- Reads reviewer feedback and fixes issues
- Runs final verification
- Names: `architect`, `lead`, `fixer`, `integrator`

### b) Codex Worker(s) (1-3 per workflow)
```typescript
.agent('implementer', {
  cli: 'codex',
  preset: 'worker',
  role: '{role description}',
  cwd: ROOT,
})
```
- Writes code, tests, configs to disk
- Gets all context injected via `{{steps.X.output}}`
- Never discovers files on its own
- Names: `implementer`, `test-writer`, `dev`, `scaffolder`, `migration-writer`

### c) Claude Reviewer (1 per workflow)
```typescript
.agent('reviewer', {
  cli: 'claude',
  preset: 'reviewer',
  role: '{role description}',
  cwd: ROOT,
})
```
- Reviews implementation after codex workers finish
- Checks against spec, patterns, consistency
- Provides actionable feedback for the architect
- Names: `reviewer`

### Hard Rules
| Rule | Rationale |
|------|-----------|
| NEVER use codex as lead or reviewer | Codex is a code-writing tool, not an evaluator |
| NEVER use claude with `preset: 'worker'` | Claude is for reasoning; codex is for writing code |
| ALWAYS include a reviewer step between implementation and final fix | Catches issues before the architect's fix pass |
| Architect and reviewer are ALWAYS different `.agent()` definitions | They serve distinct roles even though both use claude |

### Agent Naming Convention
| Name pattern | CLI | Preset | Used for |
|---|---|---|---|
| `architect` / `lead` | claude | lead | Design, fix, integrate |
| `implementer` / `dev` / `scaffolder` | codex | worker | Write code to disk |
| `test-writer` | codex | worker | Write test files |
| `migration-writer` | codex | worker | Write DB migrations |
| `reviewer` | claude | reviewer | Review implementation |
| `fixer` / `integrator` | claude | lead | Fix issues (same as architect) |

---

## 3. TDD Structure (MANDATORY for Feature Workflows)

Every feature workflow (not spec/config workflows) MUST follow TDD:

### Phase 1: Read + Test
1. **Deterministic read steps** — read all files the workers will need
2. **Test-writer step** (codex worker) — writes failing tests based on spec
3. **Verify tests exist** (deterministic) — `test -f {path} && echo OK || echo MISSING`

### Phase 2: Implement
1. **Implementer step(s)** (codex workers, parallel if independent) — write code to make tests pass
2. **Verify files exist** (deterministic) — check all expected files materialized

### Phase 3: Verify + Review + Fix
1. **Run tests** (deterministic) — `cd ${ROOT} && npx tsx --test {test-file}`
2. **Run typecheck** (deterministic) — `cd ${ROOT} && npx turbo typecheck`
3. **Review** (claude reviewer) — reads test output + implementation, provides feedback
4. **Fix** (claude lead/architect) — addresses reviewer feedback, re-runs tests

### TDD Step Dependencies (DAG)
```
read-* ─┬─► write-tests ──► verify-tests-exist ──► implement-* ──► verify-files
        │                                              │
        └──────────────────────────────────────────────┘
                                                       │
        run-tests ◄────────────────────────────────────┘
            │
        typecheck
            │
        review
            │
        fix-and-verify
```

---

## 4. Step Patterns

### Deterministic Steps (file reads, commands)
```typescript
.step('read-{name}', {
  type: 'deterministic',
  command: `cat ${ROOT}/{path}`,
  captureOutput: true,
})
```

### Agent Steps (codex workers)
```typescript
.step('implement-{name}', {
  agent: 'implementer',
  dependsOn: ['read-existing', 'write-tests'],
  task: `{task description with injected context}

Existing code:
{{steps.read-existing.output}}

Tests to pass:
{{steps.write-tests.output}}

Write the implementation to ${ROOT}/{path}.`,
  verification: { type: 'exit_code' },
})
```

### File Verification Gates
```typescript
.step('verify-files', {
  type: 'deterministic',
  dependsOn: ['implement-feature', 'implement-helper'],
  command: `test -f ${ROOT}/packages/server/src/engine/feature.ts && echo "feature.ts OK" || echo "feature.ts MISSING"; test -f ${ROOT}/packages/server/src/__tests__/feature.test.ts && echo "test OK" || echo "test MISSING"`,
  captureOutput: true,
  failOnError: false,
})
```

### Test Execution
```typescript
.step('run-tests', {
  type: 'deterministic',
  dependsOn: ['verify-files'],
  command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/{feature}.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
  captureOutput: true,
  failOnError: false,
})
```

### Typecheck
```typescript
.step('typecheck', {
  type: 'deterministic',
  dependsOn: ['run-tests'],
  command: `cd ${ROOT} && npx turbo typecheck 2>&1 | tail -20; echo "EXIT: $?"`,
  captureOutput: true,
  failOnError: false,
})
```

### Hard Rules
| Rule | Rationale |
|------|-----------|
| ALWAYS pre-read files in deterministic steps | Codex workers cannot discover files reliably |
| Inject content via `{{steps.X.output}}` | Workers need full context in their task prompt |
| ALWAYS verify file materialization after implementation | Catches write failures early |
| Use `exit_code` verification for all codex worker steps | Codex should always exit cleanly |
| Task prompts: 10-20 lines max | Longer prompts confuse codex; break into sub-tasks |
| `maxConcurrency`: 4-5 | Balances parallelism with resource limits |
| 3-4 phases max per workflow | Keeps workflows focused and debuggable |
| `failOnError: false` on verification/test gates | Allows the fix step to handle failures |
| `captureOutput: true` on all deterministic steps | Enables `{{steps.X.output}}` injection |

---

## 5. Test Patterns

### File locations
| Type | Path |
|---|---|
| Server unit tests | `packages/server/src/__tests__/{feature}.test.ts` |
| SDK unit tests | `packages/sdk/src/__tests__/{feature}.test.ts` |
| Types tests | `packages/types/src/__tests__/{feature}.test.ts` |
| E2E tests | `scripts/e2e.ts` or `packages/server/src/__tests__/e2e/{domain}.test.ts` |

### Test framework
- `node:test` for test runner (`describe`, `it`, `before`, `after`)
- `node:assert/strict` for assertions
- NO jest, NO mocha, NO vitest

### Test file template
```typescript
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createTestApp, generateTestToken, generateTestIdentity } from './test-helpers.js';

describe('{FeatureName}', () => {
  let app: ReturnType<typeof createTestApp>;

  before(() => {
    app = createTestApp();
  });

  it('should {expected behavior}', async () => {
    // Arrange
    const token = generateTestToken({ sub: 'agent_test', scopes: ['relaycast:*:*:*'] });

    // Act
    const res = await app.request('/v1/{endpoint}', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ /* ... */ }),
    });

    // Assert
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.id, 'agent_test');
  });
});
```

### Test helpers (from `test-helpers.ts`)
| Helper | Purpose |
|---|---|
| `createTestApp()` | Returns Hono app with mocked bindings |
| `generateTestToken(claims)` | Creates a signed JWT for testing |
| `generateTestIdentity(overrides)` | Creates an `AgentIdentity` fixture |
| `mockD1()` | In-memory D1 mock |
| `mockKV()` | In-memory KV mock |
| `mockDO()` | Durable Object stub mock |
| `assertJsonResponse(res, status, check)` | Response assertion shorthand |
| `createTestRequest(method, path, body?, headers?)` | Request builder |

### TDD rules
- Tests are written BEFORE implementation (by `test-writer` agent)
- Each test file tests ONE module/feature
- Tests should fail when first written (no implementation yet)
- Implementation step's goal: make the tests pass
- E2E tests run at the end of each domain

---

## 6. Dependency Management

### JSDoc declaration
Every workflow file's JSDoc comment MUST include:
```typescript
/**
 * Depends on: 001, 003, 011
 */
```

### Intra-domain dependencies
- Workflows within a domain are sequential: 011 → 012 → 013 → ... → 019
- The E2E workflow (020, 030, 040, etc.) depends on ALL workflows in its domain

### Cross-domain dependencies
Follow the manifest's `Depends On` column exactly:
- Domain 2 (Token) depends on Domain 1 (Foundation)
- Domain 3 (Identity) depends on Domain 1
- Domain 4 (Scopes) depends on Domain 2 + Domain 3
- Domain 5 (API) depends on Domain 3 + Domain 4
- Domain 7 (SDK) depends on Domain 2 + Domain 3 + Domain 5
- Domain 9 (Integration) depends on Domain 7
- Domain 10 (Hosted) depends on Domain 5 + Domain 6
- Domain 11 (Testing) depends on all implementation domains

### Runtime dependencies
Workflows do NOT run their dependencies — they assume prior workflows have completed.
Each workflow reads the files created by its dependencies and builds on them.

---

## 7. Swarm Pattern Selection

| Workflow type | Pattern | Rationale |
|---|---|---|
| Feature (most workflows) | `dag` | Parallel reads, sequential test→implement→verify |
| Spec / config | `dag` | Parallel reads, sequential write→review |
| E2E | `pipeline` | Strictly sequential: setup → test → review |
| Large implementation (5+ files) | `dag` | Parallel workers after plan, sequential review |
| Review-only | `pipeline` | Linear: analyze → report |

### Pattern selection rules
- Default to `dag` — it supports both parallel and sequential via `dependsOn`
- Use `pipeline` only when EVERY step depends on the previous step
- Use `hub-spoke` only when a lead must coordinate 4+ independent workers and merge results

---

## 8. Workflow Templates

### Template A: Feature Workflow (TDD)
Use for: API endpoints, engine functions, middleware, SDK methods

```typescript
async function main() {
const result = await workflow('{NNN}-{name}')
  .description('{description}')
  .pattern('dag')
  .channel('wf-relayauth-{NNN}')
  .maxConcurrency(4)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design {feature}, review output, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests for {feature}',
    cwd: ROOT,
  })
  .agent('implementer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement {feature}',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review {feature} for quality, consistency, spec compliance',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Test ─────────────────────────────────────────

  .step('read-spec', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/{relevant-spec}.md`,
    captureOutput: true,
  })

  .step('read-existing', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/{package}/src/{existing-file}.ts`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['read-spec', 'read-existing', 'read-test-helpers'],
    task: `Write tests for {feature}.

Spec:
{{steps.read-spec.output}}

Existing code:
{{steps.read-existing.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write failing tests to ${ROOT}/packages/{package}/src/__tests__/{feature}.test.ts.
Use node:test + node:assert/strict. Import helpers from ./test-helpers.js.
Test: {list of behaviors to test}.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-tests-exist', {
    type: 'deterministic',
    dependsOn: ['write-tests'],
    command: `test -f ${ROOT}/packages/{package}/src/__tests__/{feature}.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Implement ───────────────────────────────────────────

  .step('implement', {
    agent: 'implementer',
    dependsOn: ['verify-tests-exist', 'read-spec', 'read-existing'],
    task: `Implement {feature} to make the tests pass.

Spec:
{{steps.read-spec.output}}

Existing code to extend:
{{steps.read-existing.output}}

Tests to pass:
{{steps.write-tests.output}}

Write to ${ROOT}/packages/{package}/src/{path}.ts.
Export from the package index.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['implement'],
    command: `test -f ${ROOT}/packages/{package}/src/{path}.ts && echo "impl OK" || echo "impl MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/{package}/src/__tests__/{feature}.test.ts 2>&1 | tail -30; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('typecheck', {
    type: 'deterministic',
    dependsOn: ['run-tests'],
    command: `cd ${ROOT} && npx turbo typecheck 2>&1 | tail -20; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['run-tests', 'typecheck'],
    task: `Review the {feature} implementation.

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Read the implementation and tests. Check:
1. Tests cover all spec requirements
2. Implementation matches spec
3. Error handling is correct
4. Types are properly exported
5. Consistent with existing patterns in the codebase

List issues to fix (or confirm all good).`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix issues from the review.

Reviewer feedback:
{{steps.review.output}}

Test results:
{{steps.run-tests.output}}

Typecheck results:
{{steps.typecheck.output}}

Fix all issues. Then run:
cd ${ROOT} && node --test --import tsx packages/{package}/src/__tests__/{feature}.test.ts && npx turbo typecheck`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n{NNN} {Title}: ${result.status}`);
}

main().catch(console.error);
```

### Template B: E2E Workflow
Use for: 020, 030, 040, 050, 058, 068, 075, 082, 090

```typescript
async function main() {
const result = await workflow('{NNN}-{name}')
  .description('{domain} E2E tests')
  .pattern('pipeline')
  .channel('wf-relayauth-{NNN}')
  .maxConcurrency(3)
  .timeout(1_200_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design E2E test scenarios, fix failures',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write E2E test file',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review E2E coverage and results',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Write ────────────────────────────────────────

  .step('read-implementations', {
    type: 'deterministic',
    command: `{cat relevant implementation files}`,
    captureOutput: true,
  })

  .step('read-test-helpers', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`,
    captureOutput: true,
  })

  .step('write-e2e', {
    agent: 'test-writer',
    dependsOn: ['read-implementations', 'read-test-helpers'],
    task: `Write E2E tests for {domain}.

Implementations:
{{steps.read-implementations.output}}

Test helpers:
{{steps.read-test-helpers.output}}

Write to ${ROOT}/packages/server/src/__tests__/e2e/{domain}.test.ts.
Test the full flow: {describe the E2E scenario}.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-e2e-exists', {
    type: 'deterministic',
    dependsOn: ['write-e2e'],
    command: `test -f ${ROOT}/packages/server/src/__tests__/e2e/{domain}.test.ts && echo "OK" || echo "MISSING"`,
    captureOutput: true,
  })

  // ── Phase 2: Run + Review ────────────────────────────────────────

  .step('run-e2e', {
    type: 'deterministic',
    dependsOn: ['verify-e2e-exists'],
    command: `cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/{domain}.test.ts 2>&1 | tail -50; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review-results', {
    agent: 'reviewer',
    dependsOn: ['run-e2e'],
    task: `Review E2E test results.

Results:
{{steps.run-e2e.output}}

Check:
1. All scenarios pass
2. Edge cases covered
3. Proper cleanup between tests
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-failures', {
    agent: 'architect',
    dependsOn: ['review-results'],
    task: `Fix E2E failures.

Results:
{{steps.run-e2e.output}}

Reviewer feedback:
{{steps.review-results.output}}

Fix all issues and re-run:
cd ${ROOT} && node --test --import tsx packages/server/src/__tests__/e2e/{domain}.test.ts`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n{NNN} {Title}: ${result.status}`);
}

main().catch(console.error);
```

### Template C: Spec Workflow
Use for: 002-007 (OpenAPI, token format, scope format, RBAC, audit, error catalog)

```typescript
async function main() {
const result = await workflow('{NNN}-{name}')
  .description('{description}')
  .pattern('dag')
  .channel('wf-relayauth-{NNN}')
  .maxConcurrency(3)
  .timeout(900_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design spec, finalize after review',
    cwd: ROOT,
  })
  .agent('spec-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write the spec document',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review spec for completeness and consistency',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Design ───────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-types', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/types/src/{relevant}.ts`,
    captureOutput: true,
  })

  .step('design-spec', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-types'],
    task: `Design the {spec name}.

Architecture:
{{steps.read-architecture.output}}

Types:
{{steps.read-types.output}}

Write the design outline to ${ROOT}/docs/{spec}-design.md.
Include: structure, sections, key decisions.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Write ───────────────────────────────────────────────

  .step('write-spec', {
    agent: 'spec-writer',
    dependsOn: ['design-spec'],
    task: `Write the full spec.

Design:
{{steps.design-spec.output}}

Architecture:
{{steps.read-architecture.output}}

Types:
{{steps.read-types.output}}

Write to ${ROOT}/specs/{spec-name}.{md|yaml}.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-spec-exists', {
    type: 'deterministic',
    dependsOn: ['write-spec'],
    command: `test -f ${ROOT}/specs/{spec-name}.{md|yaml} && wc -l ${ROOT}/specs/{spec-name}.{md|yaml}`,
    captureOutput: true,
  })

  // ── Phase 3: Review + Finalize ───────────────────────────────────

  .step('review-spec', {
    agent: 'reviewer',
    dependsOn: ['verify-spec-exists'],
    task: `Review the {spec name}.

Read ${ROOT}/specs/{spec-name}.{md|yaml} and check:
1. Completeness — covers all requirements from architecture
2. Consistency — aligns with types package
3. Clarity — unambiguous, implementable
4. No missing edge cases
List issues.`,
    verification: { type: 'exit_code' },
  })

  .step('finalize-spec', {
    agent: 'architect',
    dependsOn: ['review-spec'],
    task: `Finalize the spec.

Reviewer feedback:
{{steps.review-spec.output}}

Address all feedback. Update ${ROOT}/specs/{spec-name}.{md|yaml}.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n{NNN} {Title}: ${result.status}`);
}

main().catch(console.error);
```

### Template D: Large Implementation (Lead + Parallel Workers)
Use for: workflows touching 5+ files or multiple packages

```typescript
async function main() {
const result = await workflow('{NNN}-{name}')
  .description('{description}')
  .pattern('dag')
  .channel('wf-relayauth-{NNN}')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Plan implementation, fix issues',
    cwd: ROOT,
  })
  .agent('test-writer', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write tests',
    cwd: ROOT,
  })
  .agent('impl-a', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement {component A}',
    cwd: ROOT,
  })
  .agent('impl-b', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implement {component B}',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review all implementations',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-spec', { type: 'deterministic', command: `cat ${ROOT}/specs/{...}`, captureOutput: true })
  .step('read-existing', { type: 'deterministic', command: `cat ${ROOT}/packages/{...}`, captureOutput: true })

  .step('plan', {
    agent: 'architect',
    dependsOn: ['read-spec', 'read-existing'],
    task: `Plan the implementation. Write plan to ${ROOT}/docs/{NNN}-plan.md.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Test + Implement (parallel) ─────────────────────────

  .step('write-tests', {
    agent: 'test-writer',
    dependsOn: ['plan'],
    task: `Write tests. Plan: {{steps.plan.output}}. Spec: {{steps.read-spec.output}}.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-a', {
    agent: 'impl-a',
    dependsOn: ['plan', 'read-existing'],
    task: `Implement {A}. Plan: {{steps.plan.output}}. Existing: {{steps.read-existing.output}}.`,
    verification: { type: 'exit_code' },
  })

  .step('implement-b', {
    agent: 'impl-b',
    dependsOn: ['plan', 'read-existing'],
    task: `Implement {B}. Plan: {{steps.plan.output}}. Existing: {{steps.read-existing.output}}.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-tests', 'implement-a', 'implement-b'],
    command: `{verify all files exist}`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('run-tests', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT} && node --test --import tsx packages/{...} 2>&1 | tail -30; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('typecheck', {
    type: 'deterministic',
    dependsOn: ['run-tests'],
    command: `cd ${ROOT} && npx turbo typecheck 2>&1 | tail -20; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['run-tests', 'typecheck'],
    task: `Review all implementations.
Tests: {{steps.run-tests.output}}
Typecheck: {{steps.typecheck.output}}
Check quality, consistency, spec compliance.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix issues. Reviewer: {{steps.review.output}}. Tests: {{steps.run-tests.output}}.
Fix all issues and re-run tests + typecheck.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n{NNN} {Title}: ${result.status}`);
}

main().catch(console.error);
```

---

## 9. Template Selection Guide

| Workflow # | Name | Template |
|---|---|---|
| 002-007 | Specs (OpenAPI, token, scope, RBAC, audit, errors) | C (Spec) |
| 008 | Test helpers complete | D (Large Implementation) |
| 009 | Dev environment | A (Feature) |
| 010 | Contract tests | B (E2E) |
| 011-019 | Token system features | A (Feature) |
| 020 | Token system E2E | B (E2E) |
| 021-029 | Identity lifecycle features | A (Feature) |
| 030 | Identity lifecycle E2E | B (E2E) |
| 031-039 | Scopes & RBAC features | A (Feature) |
| 040 | RBAC E2E | B (E2E) |
| 041-049 | API routes features | A (Feature) |
| 050 | API routes E2E | B (E2E) |
| 051-057 | Audit features | A (Feature) |
| 058 | Audit E2E | B (E2E) |
| 059-067 | SDK features | A (Feature) |
| 068 | SDK E2E | B (E2E) |
| 069-074 | CLI features | A (Feature) |
| 075 | CLI E2E | B (E2E) |
| 076-081 | Integration features | D (Large Implementation) |
| 082 | Integration E2E | B (E2E) |
| 083-087 | Hosted server features | A or D (Feature/Large) |
| 088-089 | Deploy staging/production | A (Feature) |
| 090 | Hosted E2E | B (E2E) |
| 091-093 | Test suites | D (Large Implementation) |
| 094-096 | CI/CD workflows | A (Feature) |
| 097-099 | Docs | C (Spec) |
| 100 | Landing page | D (Large Implementation) |

---

## 10. Common Patterns Reference

### Reading multiple files (parallel deterministic steps)
```typescript
.step('read-types', { type: 'deterministic', command: `cat ${ROOT}/packages/types/src/token.ts`, captureOutput: true })
.step('read-env', { type: 'deterministic', command: `cat ${ROOT}/packages/server/src/env.ts`, captureOutput: true })
.step('read-helpers', { type: 'deterministic', command: `cat ${ROOT}/packages/server/src/__tests__/test-helpers.ts`, captureOutput: true })
```
These run in parallel (no `dependsOn`), injected into later steps.

### Parallel codex workers
```typescript
.step('implement-engine', {
  agent: 'engine-dev',
  dependsOn: ['plan', 'read-existing'],
  task: `...`,
  verification: { type: 'exit_code' },
})
.step('implement-route', {
  agent: 'route-dev',
  dependsOn: ['plan', 'read-existing'],
  task: `...`,
  verification: { type: 'exit_code' },
})
```
Both depend on `plan` but not on each other — they run in parallel.

### Reviewer → Architect fix chain
```typescript
.step('review', {
  agent: 'reviewer',
  dependsOn: ['run-tests', 'typecheck'],
  task: `Review... List issues.`,
  verification: { type: 'exit_code' },
})
.step('fix-and-verify', {
  agent: 'architect',
  dependsOn: ['review'],
  task: `Fix issues from review.
Reviewer feedback: {{steps.review.output}}
Fix and re-run tests.`,
  verification: { type: 'exit_code' },
})
```
This pattern is MANDATORY in every workflow.

### Cross-repo reads (for integration workflows 076-082)
```typescript
.step('read-relaycast-auth', {
  type: 'deterministic',
  command: `cat ${RELAYCAST}/packages/server/src/middleware/auth.ts`,
  captureOutput: true,
})
```

### Export wiring step
After implementing a new module, ensure it's exported:
```typescript
.step('wire-exports', {
  agent: 'implementer',
  dependsOn: ['implement'],
  task: `Add exports to package index.
Read ${ROOT}/packages/{pkg}/src/index.ts and add: export * from './{module}.js';
Write the updated file.`,
  verification: { type: 'exit_code' },
})
```

---

## 11. Anti-Patterns (DO NOT DO)

| Anti-pattern | Correct approach |
|---|---|
| Asking codex to `cat` or `find` files | Pre-read in deterministic steps, inject via `{{steps.X.output}}` |
| Task prompts over 20 lines | Break into architect plan + focused worker tasks |
| Skipping reviewer step | ALWAYS review before final fix |
| Using `preset: 'worker'` with claude | Claude is always `lead` or `reviewer` |
| Using `preset: 'lead'` or `'reviewer'` with codex | Codex is always `worker` |
| Running tests without `failOnError: false` | Test failures should be handled by fix step, not abort the workflow |
| More than 4 phases | Simplify — merge or split into separate workflows |
| `maxConcurrency` > 5 | Resource limits; 4-5 is optimal |
| Hardcoding file contents in task prompts | Read from disk, inject dynamically |
| Missing `captureOutput: true` on deterministic steps | Output won't be available for injection |
| Skipping file verification gates | Catch missing files before tests run |
| Top-level await (no `async function main()` wrapper) | Always wrap in `async function main()` |

---

## 12. Checklist for Generated Workflows

Before considering a workflow complete, verify:

- [ ] File named `workflows/{NNN}-{kebab-name}.ts`
- [ ] JSDoc includes domain, description, and `Depends on:` line
- [ ] `import { workflow } from '@agent-relay/sdk/workflows'`
- [ ] Wrapped in `async function main() { ... } main().catch(console.error)`
- [ ] Has `ROOT`, `RELAYCAST`, `RELAYFILE` constants
- [ ] `.pattern()` matches the template selection guide
- [ ] `.channel('wf-relayauth-{NNN}')`
- [ ] `.maxConcurrency(4)` or `.maxConcurrency(5)`
- [ ] `.timeout()` set appropriately
- [ ] Has exactly 1 claude lead agent
- [ ] Has 1-3 codex worker agents
- [ ] Has exactly 1 claude reviewer agent
- [ ] All deterministic read steps have `captureOutput: true`
- [ ] All codex worker steps have `verification: { type: 'exit_code' }`
- [ ] File verification gates after implementation steps
- [ ] Test/typecheck steps have `failOnError: false`
- [ ] Reviewer step exists between implementation and final fix
- [ ] Fix step injects `{{steps.review.output}}`
- [ ] `.onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })`
- [ ] Console log with workflow number and status at the end
- [ ] Task prompts are 10-20 lines (not longer)
- [ ] No more than 4 phases
