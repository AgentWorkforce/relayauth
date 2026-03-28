/**
 * 059-python-sdk-reorg-and-contracts.ts
 *
 * Reorganize relayauth's Python SDK to match relayfile's structure
 * and add contract surface checks for TS ↔ Python parity.
 *
 * Current: packages/python-sdk/relayauth/
 * Target:  packages/sdk/python/src/relayauth/
 *
 * Also:
 * - Move TS SDK: packages/sdk/ → packages/sdk/typescript/
 * - Add scripts/check-contract-surface.sh (same pattern as relayfile)
 * - Add CI workflow to run contract checks on every PR
 *
 * Reference: /Users/khaliqgant/Projects/AgentWorkforce-relayfile/scripts/check-contract-surface.sh
 *
 * Run: agent-relay run workflows/059-python-sdk-reorg-and-contracts.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce-relayfile';

async function main() {
  const result = await workflow('relayauth-python-sdk-reorg')
    .description('Reorganize relayauth SDKs + add contract parity checks')
    .pattern('linear')
    .channel('wf-relayauth-sdk')
    .maxConcurrency(2)
    .timeout(3_600_000)

    .agent('architect', { cli: 'claude', role: 'Plans the reorg and contract checks' })
    .agent('builder', { cli: 'codex', preset: 'worker', role: 'Executes the reorg' })
    .agent('reviewer', { cli: 'claude', role: 'Verifies parity and structure' })

    .step('plan', {
      agent: 'architect',
      task: `Plan the SDK reorganization for relayauth.

Read the current layout:
- ${ROOT}/packages/sdk/package.json — TS SDK (@relayauth/sdk)
- ${ROOT}/packages/sdk/src/index.ts — TS exports
- ${ROOT}/packages/sdk/src/client.ts — RelayAuthClient
- ${ROOT}/packages/types/src/ — shared types (@relayauth/types)
- ${ROOT}/packages/python-sdk/relayauth/ — Python SDK
- ${ROOT}/packages/python-sdk/relayauth/types.py — Python types
- ${ROOT}/packages/python-sdk/relayauth/client.py — Python client
- ${ROOT}/packages/python-sdk/relayauth/verifier.py — token verifier
- ${ROOT}/packages/python-sdk/relayauth/scopes.py — scope checker

Read relayfile's structure for reference:
- ${RELAYFILE}/packages/sdk/typescript/ — TS SDK layout
- ${RELAYFILE}/packages/sdk/python/ — Python SDK layout
- ${RELAYFILE}/scripts/check-contract-surface.sh — contract checker

Plan the migration:

1. **Move TS SDK**: packages/sdk/ → packages/sdk/typescript/
   - Update package.json, tsconfig.json paths
   - Update all imports in other packages that reference @relayauth/sdk
   - Update turbo.json, root package.json workspace paths

2. **Move Python SDK**: packages/python-sdk/ → packages/sdk/python/
   - Update pyproject.toml paths
   - Keep the same module name (relayauth)

3. **Contract surface check script**: scripts/check-contract-surface.sh
   - Compare TS SDK exports vs Python SDK exports
   - Check: every public class in TS has a Python equivalent
   - Check: RelayAuthClient methods match between TS and Python
   - Check: types.py covers all types exported from @relayauth/types
   - Check: ScopeChecker, TokenVerifier exist in both
   - Check: middleware (hono/express in TS → fastapi/flask in Python?)

4. **CI workflow**: .github/workflows/contract.yml
   - Runs check-contract-surface.sh on every PR
   - Fails if parity is broken

5. **Identify gaps**: What's in TS but missing from Python?
   - Middleware (hono, express) → Python equivalents?
   - OpenAPI scope generation
   - A2A agent card utilities

Output: migration plan, file moves, contract checks to implement.
Keep under 80 lines. End with PLAN_COMPLETE.`,
      verification: { type: 'output_contains', value: 'PLAN_COMPLETE' },
      timeout: 300_000,
    })

    .step('reorg', {
      agent: 'builder',
      dependsOn: ['plan'],
      task: `Execute the SDK reorganization.

Plan: {{steps.plan.output}}

Working in ${ROOT} on branch feat/sdk-reorg.

1. **Create new structure**:
   mkdir -p packages/sdk/typescript packages/sdk/python

2. **Move TS SDK**:
   - Move packages/sdk/src → packages/sdk/typescript/src
   - Move packages/sdk/package.json → packages/sdk/typescript/package.json
   - Move packages/sdk/tsconfig.json → packages/sdk/typescript/tsconfig.json
   - Move packages/sdk/node_modules if exists
   - Update workspace references in root package.json/turbo.json

3. **Move Python SDK**:
   - Move packages/python-sdk/* → packages/sdk/python/
   - Update pyproject.toml if paths changed

4. **Fix imports**: grep for any "@relayauth/sdk" imports in other packages
   that need path updates (the npm package name stays the same, just the
   directory moved)

5. **Create contract checks**: scripts/check-contract-surface.sh
   Based on ${RELAYFILE}/scripts/check-contract-surface.sh but adapted for relayauth:
   
   TS checks (packages/sdk/typescript/src/):
   - require_pattern "RelayAuthClient" in client.ts or index.ts
   - require_pattern "TokenVerifier" in verify.ts or index.ts
   - require_pattern "ScopeChecker" in scopes.ts or index.ts
   - require_pattern "AgentIdentity" in types (from @relayauth/types)
   - require_pattern "RelayAuthTokenClaims"
   - require_pattern "CreateIdentityInput"
   - require_pattern "TokenPair"
   - require_pattern "AuditEntry"
   
   Python checks (packages/sdk/python/relayauth/):
   - require_pattern "RelayAuthClient" in client.py
   - require_pattern "TokenVerifier" in verifier.py
   - require_pattern "ScopeChecker" in scopes.py
   - require_pattern "AgentIdentity" in types.py
   - require_pattern "RelayAuthTokenClaims" or "TokenClaims" in types.py
   - require_pattern "CreateIdentityInput" in types.py
   - require_pattern "TokenPair" in types.py
   - require_pattern "AuditEntry" in types.py

6. **Create CI workflow**: .github/workflows/contract.yml
   - Runs on PR to main
   - Executes scripts/check-contract-surface.sh
   - Fails if any check fails

7. **Build check**: make sure TS still compiles, Python tests still pass

8. Commit and push:
   git checkout -b feat/sdk-reorg
   HUSKY=0 git add -A
   HUSKY=0 git -c core.hooksPath=/dev/null commit --no-verify -m "refactor: reorganize SDKs into packages/sdk/{typescript,python}

   Matches relayfile's SDK structure for consistency.
   - packages/sdk/ → packages/sdk/typescript/
   - packages/python-sdk/ → packages/sdk/python/
   - Added scripts/check-contract-surface.sh for TS ↔ Python parity
   - Added .github/workflows/contract.yml CI check"
   git push origin feat/sdk-reorg

End with REORG_COMPLETE.`,
      verification: { type: 'output_contains', value: 'REORG_COMPLETE' },
      timeout: 900_000,
    })

    .step('verify-parity', {
      agent: 'reviewer',
      dependsOn: ['reorg'],
      task: `Verify the SDK reorg and contract parity.

Working in ${ROOT} on branch feat/sdk-reorg.

1. **Structure check**:
   - packages/sdk/typescript/src/ exists with client.ts, index.ts, etc.
   - packages/sdk/python/relayauth/ exists with client.py, types.py, etc.
   - packages/python-sdk/ is GONE (fully moved)

2. **Run contract checks**:
   bash scripts/check-contract-surface.sh
   Should pass with all checks green.

3. **Parity audit** — compare exports:
   TS (grep export from packages/sdk/typescript/src/index.ts):
   vs
   Python (grep class/def from packages/sdk/python/relayauth/__init__.py):
   
   List any gaps (TS has it, Python doesn't).

4. **Build check**:
   cd packages/sdk/typescript && npx tsc --noEmit
   cd packages/sdk/python && python -m pytest tests/ (if deps available)

5. **Import check**: grep -rn "@relayauth/sdk" packages/ — all still resolve?

Fix any issues found. Keep under 50 lines. End with VERIFY_COMPLETE.`,
      verification: { type: 'output_contains', value: 'VERIFY_COMPLETE' },
      timeout: 300_000,
    })

    .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
    .run({ cwd: ROOT });

  console.log('Relayauth SDK reorg complete:', result.status);
}

main().catch(e => { console.error(e); process.exitCode = 1; });
