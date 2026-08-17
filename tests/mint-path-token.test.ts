import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const repoRoot = path.resolve(import.meta.dirname, '..')
const script = path.join(repoRoot, 'scripts/mint-path-token.sh')
const delegationNotAfter = '2099-01-01T00:00:00.000Z'
const expectedScopes = [
  'relayfile:fs:read:/linear/issues/**',
  'relayfile:fs:write:/linear/issues/**',
  'relayfile:fs:read:/github/**',
  'relayfile:fs:write:/github/**',
]

test('Factory path-token dry-run reads the source contract without minting', async (t) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'relayauth-path-token-source-'))
  t.after(async () => await rm(fixtureDir, { recursive: true, force: true }))
  const sourcePath = path.join(fixtureDir, 'relayfile-cloud-mount-client.ts')
  await writeFile(sourcePath, factorySource(expectedScopes))

  const { stdout, stderr } = await execFileAsync(script, [
    '--dry-run',
    '--factory-source', sourcePath,
    '--delegation-not-after', delegationNotAfter,
  ], { cwd: repoRoot })

  assert.equal(stderr, '')
  const request = JSON.parse(stdout.slice(stdout.indexOf('{'))) as Record<string, unknown>
  assert.equal(request.workspaceId, 'rw_7ccfea89')
  assert.equal(request.agentName, 'agent-relay-factory')
  assert.deepEqual(request.scopes, expectedScopes)
  assert.deepEqual(request.paths, ['/github/**', '/linear/issues/**'])
  assert.deepEqual(request.audience, ['relayfile'])
  assert.equal(request.expiresIn, 3_600)
  assert.equal(request.refreshTokenTtlSeconds, 90 * 24 * 60 * 60)
  assert.equal(request.delegationNotAfter, delegationNotAfter)
})

test('Factory path-token dry-run rejects the invalid github repos batch path', async (t) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'relayauth-path-token-invalid-'))
  t.after(async () => await rm(fixtureDir, { recursive: true, force: true }))
  const sourcePath = path.join(fixtureDir, 'relayfile-cloud-mount-client.ts')
  await writeFile(sourcePath, factorySource([
    'relayfile:fs:read:/github/repos/**',
    'relayfile:fs:write:/github/repos/**',
  ]))

  await assert.rejects(
    execFileAsync(script, [
      '--dry-run',
      '--factory-source', sourcePath,
      '--delegation-not-after', delegationNotAfter,
    ], { cwd: repoRoot }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(String((error as Error & { stderr?: string }).stderr), /retain read\/write access at \/github\/\*\*/u)
      return true
    },
  )
})

test('Factory path-token operator script is valid Bash', async () => {
  await execFileAsync('bash', ['-n', script], { cwd: repoRoot })
})

const factorySource = (scopes: string[]): string => `
export const FACTORY_RELAYFILE_SCOPES = [
${scopes.map((scope) => `  '${scope}',`).join('\n')}
] as const
`
