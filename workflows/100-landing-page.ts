/**
 * 100-landing-page.ts
 *
 * Domain 12: Docs & Landing
 * relayauth.dev landing page (Astro + Tailwind)
 *
 * Depends on: all
 * Run: agent-relay run workflows/100-landing-page.ts
 */

import { workflow } from '@agent-relay/sdk/workflows';

const ROOT = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYCAST = '/Users/khaliqgant/Projects/AgentWorkforce/relaycast';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('100-landing-page')
  .description('relayauth.dev landing page (Astro + Tailwind)')
  .pattern('dag')
  .channel('wf-relayauth-100')
  .maxConcurrency(5)
  .timeout(1_800_000)

  .agent('architect', {
    cli: 'claude',
    preset: 'lead',
    role: 'Design landing page structure and content, fix issues',
    cwd: ROOT,
  })
  .agent('scaffold-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Scaffold Astro + Tailwind project for landing page',
    cwd: ROOT,
  })
  .agent('page-dev', {
    cli: 'codex',
    preset: 'worker',
    role: 'Write landing page components and content',
    cwd: ROOT,
  })
  .agent('reviewer', {
    cli: 'claude',
    preset: 'reviewer',
    role: 'Review landing page for quality, messaging, and completeness',
    cwd: ROOT,
  })

  // ── Phase 1: Read + Plan ─────────────────────────────────────────

  .step('read-architecture', {
    type: 'deterministic',
    command: `cat ${ROOT}/specs/architecture.md`,
    captureOutput: true,
  })

  .step('read-readme', {
    type: 'deterministic',
    command: `cat ${ROOT}/README.md`,
    captureOutput: true,
  })

  .step('read-sdk-exports', {
    type: 'deterministic',
    command: `cat ${ROOT}/packages/sdk/src/index.ts`,
    captureOutput: true,
  })

  .step('plan-landing', {
    agent: 'architect',
    dependsOn: ['read-architecture', 'read-readme', 'read-sdk-exports'],
    task: `Plan the relayauth.dev landing page.

Architecture:
{{steps.read-architecture.output}}

README:
{{steps.read-readme.output}}

Write plan to ${ROOT}/docs/100-landing-plan.md:
Sections:
1. Hero: "Auth for the agent era" — tagline, install command, CTA
2. Problem: why agents need purpose-built auth
3. Features: scoped tokens, RBAC, audit, cross-plane identity
4. Architecture: visual diagram of Relay ecosystem
5. Quick start: 3-step code example
6. SDK support: TypeScript, Go, Python
7. Self-host or hosted: wrangler deploy vs relayauth.dev
8. Footer: GitHub, docs, npm
Tech: Astro + Tailwind in packages/landing/. Keep under 30 lines.`,
    verification: { type: 'exit_code' },
  })

  // ── Phase 2: Scaffold + Implement (parallel) ────────────────────

  .step('scaffold-astro', {
    agent: 'scaffold-dev',
    dependsOn: ['plan-landing'],
    task: `Scaffold the Astro + Tailwind landing page project.

Plan:
{{steps.plan-landing.output}}

Create ${ROOT}/packages/landing/:
1. package.json: name "relayauth-landing", scripts: { dev, build, preview }
   deps: astro, @astrojs/tailwind, tailwindcss
2. astro.config.mjs: Astro with Tailwind integration
3. tailwind.config.mjs: dark theme, brand colors (indigo/violet)
4. tsconfig.json: extends ../../tsconfig.base.json
5. src/layouts/Layout.astro: HTML shell with meta tags, font, Tailwind
6. public/favicon.svg: simple shield icon (inline SVG)`,
    verification: { type: 'exit_code' },
  })

  .step('write-landing-page', {
    agent: 'page-dev',
    dependsOn: ['plan-landing', 'scaffold-astro'],
    task: `Write the landing page content and components.

Plan:
{{steps.plan-landing.output}}

README (for content):
{{steps.read-readme.output}}

Create these files in ${ROOT}/packages/landing/src/:
1. pages/index.astro: main landing page using Layout, all sections
2. components/Hero.astro: tagline, npm install command, CTA buttons
3. components/Features.astro: 4-feature grid (tokens, RBAC, audit, cross-plane)
4. components/CodeExample.astro: quick start code block with syntax highlighting
5. components/Footer.astro: links to GitHub, docs, npm

Use Tailwind classes. Dark background, bright accents.
Keep the page focused and concise — max 200 lines per component.`,
    verification: { type: 'exit_code' },
  })

  .step('verify-files', {
    type: 'deterministic',
    dependsOn: ['write-landing-page'],
    command: `test -f ${ROOT}/packages/landing/package.json && echo "package.json OK" || echo "package.json MISSING"; test -f ${ROOT}/packages/landing/src/pages/index.astro && echo "index.astro OK" || echo "index.astro MISSING"; test -f ${ROOT}/packages/landing/src/components/Hero.astro && echo "Hero OK" || echo "Hero MISSING"`,
    captureOutput: true,
    failOnError: false,
  })

  // ── Phase 3: Verify + Review + Fix ───────────────────────────────

  .step('build-check', {
    type: 'deterministic',
    dependsOn: ['verify-files'],
    command: `cd ${ROOT}/packages/landing && npm install 2>&1 | tail -5 && npx astro check 2>&1 | tail -20; echo "EXIT: $?"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('review', {
    agent: 'reviewer',
    dependsOn: ['build-check'],
    task: `Review the landing page.

Build check:
{{steps.build-check.output}}

Read the landing page files. Check:
1. All sections from plan are implemented
2. Messaging is clear and compelling for developers
3. Code examples are correct
4. Tailwind classes are consistent
5. Responsive design (mobile-friendly)
6. No placeholder text remaining
List issues to fix.`,
    verification: { type: 'exit_code' },
  })

  .step('fix-and-verify', {
    agent: 'architect',
    dependsOn: ['review'],
    task: `Fix all issues from the review.

Reviewer feedback:
{{steps.review.output}}

Build check:
{{steps.build-check.output}}

Fix all issues. Then run:
cd ${ROOT}/packages/landing && npx astro check`,
    verification: { type: 'exit_code' },
  })

  
    // LANDING PAGE FRAMING (from architecture spec):
    // Hero: Your agents have keys to everything. Do you know what they are doing?
    // Three panels: Scope, Trace, Revoke
    // 3-line code example: createAgent with sponsor + scopes + budget, protect route, revoke
    // Works with any framework + logo row: relaycast, relayfile, LangChain, CrewAI, AutoGen
    // 3.2M procurement fraud story as Why this matters section
    // Sponsor chain differentiator: Every action traces back to a human
    // Budget enforcement: Agents that go rogue get suspended automatically

  .onError('retry', { maxRetries: 1, retryDelayMs: 10_000 })
  .run({
    cwd: ROOT,
    onEvent: (e: any) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n100 Landing Page: ${result.status}`);
}

main().catch(console.error);
