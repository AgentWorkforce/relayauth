/**
 * 113-relay-run.ts
 *
 * Build "relay run <agent-cli>" — single command to launch any agent
 * on the relay with FUSE-mounted VFS and dotfile permissions.
 *
 * Team pattern: claude lead + 2 codex workers via channel.
 * 3 phases: context → build team → verify+fix.
 *
 * Run: agent-relay run workflows/113-relay-run.ts
 */

const { workflow } = require('@agent-relay/sdk/workflows');

const RELAYAUTH = '/Users/khaliqgant/Projects/AgentWorkforce/relayauth';
const RELAYFILE = '/Users/khaliqgant/Projects/AgentWorkforce/relayfile';

async function main() {
const result = await workflow('113-relay-run')
  .description('Build "relay run claude" — launch agent on the relay with FUSE mount and dotfile permissions')
  .pattern('dag')
  .channel('wf-relay-run')
  .maxConcurrency(4)
  .timeout(3_600_000)

  .agent('lead', {
    cli: 'claude',
    preset: 'lead',
    role: 'Designs relay run flow, assigns work to cmd-impl and lifecycle-impl via #wf-relay-run, reviews output',
    cwd: RELAYAUTH,
  })
  .agent('cmd-impl', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implements cmd_run() and relay scan in relay.sh',
    cwd: RELAYAUTH,
  })
  .agent('lifecycle-impl', {
    cli: 'codex',
    preset: 'worker',
    role: 'Implements mount lifecycle, cleanup, multi-agent tracking, and e2e test',
    cwd: RELAYAUTH,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 1: Read context
  // ═══════════════════════════════════════════════════════════════

  .step('read-context', {
    type: 'deterministic',
    command: `echo "=== RELAY.SH ===" && cat ${RELAYAUTH}/scripts/relay/relay.sh && echo "=== SPEC ===" && head -50 ${RELAYAUTH}/specs/work-on-the-relay.md && echo "=== RFC ===" && cat ${RELAYAUTH}/specs/rfc-dotfile-permissions.md && echo "=== DEV TOKEN ===" && cat ${RELAYAUTH}/scripts/generate-dev-token.sh && echo "=== DOTFILE PARSER ===" && head -40 ${RELAYAUTH}/scripts/relay/dotfile-parser.ts`,
    captureOutput: true,
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 2: Lead + workers concurrently
  // ═══════════════════════════════════════════════════════════════

  .step('lead-coordinate', {
    agent: 'lead',
    dependsOn: ['read-context'],
    task: `Lead the "relay run" implementation. Workers: cmd-impl, lifecycle-impl.

CONTEXT:
{{steps.read-context.output}}

Design and assign:

**cmd-impl** gets: Add cmd_run() to relay.sh
- Usage: relay run <agent-cli> [--agent name] [-- extra-args]
- Flow: ensure services up → provision → mint token → FUSE mount → spawn agent
- Agent's cwd = .relay/workspace-{agent-name}/
- Set env: RELAYFILE_TOKEN, RELAY_WORKSPACE, RELAY_AGENT_NAME
- Zero-config: if no relay.yaml, discover agents from dotfiles
- On agent exit: unmount, cleanup

**lifecycle-impl** gets: Mount lifecycle + e2e test
- .relay/mounts.json tracking (agent, pid, dir per mount)
- cleanup_mounts() called on relay down
- SIGINT/SIGTERM trap in cmd_run
- "relay mounts" command (list active)
- "relay unmount [name|--all]" command
- e2e-relay-run.sh test script

Post detailed specs to #wf-relay-run with file paths and function signatures.
Review worker output. Fix integration between the two workers' changes.`,
  })

  .step('cmd-impl-work', {
    agent: 'cmd-impl',
    dependsOn: ['read-context'],
    task: `Join #wf-relay-run. lead will post your assignment.
Add the cmd_run() function to ${RELAYAUTH}/scripts/relay/relay.sh as directed.
IMPORTANT: Write changes to disk, do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  .step('lifecycle-impl-work', {
    agent: 'lifecycle-impl',
    dependsOn: ['read-context'],
    task: `Join #wf-relay-run. lead will post your assignment.
Add mount lifecycle management and e2e test to ${RELAYAUTH}/scripts/relay/ as directed.
IMPORTANT: Write changes to disk, do NOT output code to stdout.`,
    verification: { type: 'exit_code' },
  })

  // ═══════════════════════════════════════════════════════════════
  // PHASE 3: Verify + fix
  // ═══════════════════════════════════════════════════════════════

  .step('verify', {
    type: 'deterministic',
    dependsOn: ['lead-coordinate'],
    command: `echo "=== CMD_RUN EXISTS ===" && grep -c "cmd_run" ${RELAYAUTH}/scripts/relay/relay.sh && echo "=== LIFECYCLE ===" && grep -c "cleanup_mounts\|relay mounts\|relay unmount" ${RELAYAUTH}/scripts/relay/relay.sh && echo "=== E2E TEST ===" && test -f ${RELAYAUTH}/scripts/relay/e2e-relay-run.sh && echo "EXISTS" || echo "MISSING" && echo "=== RELAY HELP ===" && bash ${RELAYAUTH}/scripts/relay/relay.sh help 2>&1 | head -20 && echo "VERIFY_DONE"`,
    captureOutput: true,
    failOnError: false,
  })

  .step('fix-and-finalize', {
    agent: 'lead',
    dependsOn: ['verify'],
    task: `Verify and fix relay run implementation.

VERIFY:
{{steps.verify.output}}

If anything is missing, fix it directly in ${RELAYAUTH}/scripts/relay/relay.sh.
Ensure "run" appears in the help text and main case statement.
Test: bash ${RELAYAUTH}/scripts/relay/relay.sh help

Summarize: what commands were added, the full "relay run" flow.`,
    verification: { type: 'exit_code' },
  })

  .onError('retry', { maxRetries: 2, retryDelayMs: 10_000 })
  .run({
    cwd: RELAYAUTH,
    onEvent: (e) => console.log(`[${e.type}] ${e.stepName ?? e.step ?? ''} ${e.error ?? ''}`.trim()),
  });

console.log(`\n113 Relay Run: ${result.status}`);
}

main().catch(console.error);
