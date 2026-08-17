import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
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
    'relayfile:fs:read:/github/**',
    'relayfile:fs:write:/github/**',
    'relayfile:fs:read:/github/repos/**',
  ]))

  await assert.rejects(
    execFileAsync(script, [
      '--dry-run',
      '--factory-source', sourcePath,
      '--delegation-not-after', delegationNotAfter,
    ], { cwd: repoRoot }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(String((error as Error & { stderr?: string }).stderr), /github\/repos\/\*\* is invalid/u)
      return true
    },
  )
})

test('Factory scope extraction rejects an unparsed non-literal entry', async (t) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'relayauth-path-token-nonliteral-'))
  t.after(async () => await rm(fixtureDir, { recursive: true, force: true }))
  const sourcePath = path.join(fixtureDir, 'relayfile-cloud-mount-client.ts')
  await writeFile(sourcePath, `
const computedScope = 'relayfile:fs:read:/linear/issues/**'
export const FACTORY_RELAYFILE_SCOPES = [
  'relayfile:fs:read:/github/**',
  'relayfile:fs:write:/github/**',
  computedScope,
] as const
`)

  await assert.rejects(
    execFileAsync(script, [
      '--dry-run',
      '--factory-source', sourcePath,
      '--delegation-not-after', delegationNotAfter,
    ], { cwd: repoRoot }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.match(String((error as Error & { stderr?: string }).stderr), /non-literal entry/u)
      return true
    },
  )
})

test('Factory path-token dry-run canonicalizes an equivalent delegation timestamp', async (t) => {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), 'relayauth-path-token-time-'))
  t.after(async () => await rm(fixtureDir, { recursive: true, force: true }))
  const sourcePath = path.join(fixtureDir, 'relayfile-cloud-mount-client.ts')
  await writeFile(sourcePath, factorySource(expectedScopes))

  const { stdout } = await execFileAsync(script, [
    '--dry-run',
    '--factory-source', sourcePath,
    '--delegation-not-after', '2099-01-01T01:00:00+01:00',
  ], { cwd: repoRoot })
  const request = JSON.parse(stdout.slice(stdout.indexOf('{'))) as Record<string, unknown>

  assert.equal(request.delegationNotAfter, delegationNotAfter)
})

test('an ambiguous GitHub secret failure preserves the unrevoked pair for retry', async (t) => {
  const harness = await createMintHarness(t, { githubAccessSecretFails: true })

  let caught: unknown
  try {
    await execFileAsync(script, [
      '--factory-source', harness.sourcePath,
      '--delegation-not-after', harness.delegationNotAfter,
      '--to-gh-secret', 'AgentWorkforce/factory-cloud',
    ], { cwd: repoRoot, env: harness.env })
  } catch (error) {
    caught = error
  }
  assert.ok(caught instanceof Error)
  const commandError = caught as Error & { code?: number, stderr?: string }
  assert.equal(commandError.code, 2)
  const stderr = String(commandError.stderr)
  assert.match(stderr, /do not deploy until both secret updates are retried/u)
  assert.doesNotMatch(stderr, /relay_pa_/u)
  const recoveryDirectory = stderr.match(/credential recovery files retained in (.+) \(directory mode/u)?.[1]
  assert.ok(recoveryDirectory)
  const accessToken = await readFile(path.join(recoveryDirectory, 'access-token'), 'utf8')
  const refreshToken = await readFile(path.join(recoveryDirectory, 'refresh-token'), 'utf8')
  assert.match(accessToken, /^relay_pa_[^\n]+$/u)
  assert.match(refreshToken, /^relay_pa_[^\n]+$/u)

  assert.deepEqual((await readFile(harness.ghLog, 'utf8')).trim().split('\n'), [
    'FACTORY_RELAYAUTH_REFRESH_TOKEN',
    'FACTORY_RELAYAUTH_ACCESS_TOKEN',
    'FACTORY_RELAYAUTH_ACCESS_TOKEN',
    'FACTORY_RELAYAUTH_ACCESS_TOKEN',
  ])
  assert.equal((await readFile(harness.curlLog, 'utf8')).trim(), 'mint')
})

test('a partial file install is removed and its unpublished session is revoked', async (t) => {
  const harness = await createMintHarness(t, { fileRefreshInstallFails: true })
  const target = path.join(harness.root, 'target')

  await assert.rejects(
    execFileAsync(script, [
      '--factory-source', harness.sourcePath,
      '--delegation-not-after', harness.delegationNotAfter,
      '--to-file', target,
    ], { cwd: repoRoot, env: harness.env }),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      const commandError = error as Error & { code?: number, stderr?: string }
      assert.equal(commandError.code, 2)
      assert.match(String(commandError.stderr), /revoking the unpublished session/u)
      return true
    },
  )

  await assert.rejects(readFile(path.join(target, 'access-token')), /ENOENT/u)
  await assert.rejects(readFile(path.join(target, 'refresh-token')), /ENOENT/u)
  assert.deepEqual((await readFile(harness.curlLog, 'utf8')).trim().split('\n'), ['mint', 'revoke'])
})

test('Factory path-token operator script is valid Bash', async () => {
  await execFileAsync('bash', ['-n', script], { cwd: repoRoot })
})

const factorySource = (scopes: string[]): string => `
export const FACTORY_RELAYFILE_SCOPES = [
${scopes.map((scope) => `  '${scope}',`).join('\n')}
] as const
`

async function createMintHarness(
  t: Parameters<Parameters<typeof test>[1]>[0],
  options: { githubAccessSecretFails?: boolean, fileRefreshInstallFails?: boolean },
) {
  const root = await mkdtemp(path.join(tmpdir(), 'relayauth-path-token-mint-'))
  t.after(async () => await rm(root, { recursive: true, force: true }))
  const fakeBin = path.join(root, 'bin')
  await execFileAsync('mkdir', ['-p', fakeBin])
  const sourcePath = path.join(root, 'relayfile-cloud-mount-client.ts')
  const curlLog = path.join(root, 'curl.log')
  const ghLog = path.join(root, 'gh.log')
  const curlHelper = path.join(root, 'fake-curl.mjs')
  await writeFile(sourcePath, factorySource(expectedScopes))
  await writeFile(curlHelper, fakeCurlHelper)
  await writeExecutable(path.join(fakeBin, 'curl'), `#!/usr/bin/env bash\nexec node "$FAKE_CURL_HELPER" "$@"\n`)

  if (options.githubAccessSecretFails) {
    await writeExecutable(path.join(fakeBin, 'gh'), `#!/usr/bin/env bash
if [[ "$1" == "api" ]]; then exit 0; fi
if [[ "$1" == "secret" && "$2" == "set" ]]; then
  printf '%s\\n' "$3" >> "$FAKE_GH_LOG"
  if [[ "$3" == "FACTORY_RELAYAUTH_ACCESS_TOKEN" ]]; then exit 1; fi
  exit 0
fi
exit 1
`)
  }
  if (options.fileRefreshInstallFails) {
    await writeExecutable(path.join(fakeBin, 'install'), `#!/usr/bin/env bash
destination="\${!#}"
if [[ "$destination" == */refresh-token ]]; then exit 1; fi
exec /usr/bin/install "$@"
`)
  }

  const { stdout: signingKey } = await execFileAsync('openssl', [
    'genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048',
  ])
  const nowSeconds = Math.floor(Date.now() / 1000)
  const delegationNotAfter = new Date((nowSeconds + 89 * 24 * 60 * 60) * 1000).toISOString()
  return {
    root,
    sourcePath,
    curlLog,
    ghLog,
    delegationNotAfter,
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      TMPDIR: root,
      RELAYAUTH_SIGNING_KEY_PEM: signingKey,
      FAKE_CURL_HELPER: curlHelper,
      FAKE_CURL_LOG: curlLog,
      FAKE_GH_LOG: ghLog,
    },
  }
}

async function writeExecutable(filePath: string, contents: string) {
  await writeFile(filePath, contents)
  await chmod(filePath, 0o755)
}

const fakeCurlHelper = String.raw`
import { appendFile, readFile, writeFile } from 'node:fs/promises'

const args = process.argv.slice(2)
const endpoint = args.find((value) => /^https?:/u.test(value))
const outputPath = args[args.indexOf('-o') + 1]
if (endpoint?.endsWith('/v1/tokens/revoke')) {
  await appendFile(process.env.FAKE_CURL_LOG, 'revoke\n')
  process.stdout.write('204')
  process.exit(0)
}
await appendFile(process.env.FAKE_CURL_LOG, 'mint\n')
const dataArgument = args[args.indexOf('--data-binary') + 1]
const request = JSON.parse(await readFile(dataArgument.slice(1), 'utf8'))
const normalize = (value) => value.replace(/\/\*\*$/u, '/*')
const iat = Math.floor(Date.now() / 1000)
const horizon = Math.floor(Date.parse(request.delegationNotAfter) / 1000)
const accessExp = Math.min(iat + request.expiresIn, horizon)
const refreshExp = Math.min(iat + request.refreshTokenTtlSeconds, horizon)
const sid = 'sess_test_factory_mint'
const meta = {
  tokenClass: 'path',
  agentName: request.agentName,
  delegationNotAfter: request.delegationNotAfter,
  paths: JSON.stringify(request.paths.map(normalize)),
  accessScopes: JSON.stringify(request.scopes.map(normalize)),
  accessAudience: JSON.stringify(['relayfile']),
  refreshTokenTtl: String(request.refreshTokenTtlSeconds),
}
const common = {
  sub: 'agent_' + request.agentName,
  org: 'org_test',
  wks: request.workspaceId,
  sponsorId: 'sponsor_test',
  sponsorChain: ['sponsor_test', 'agent_' + request.agentName],
  iss: 'https://relayauth.dev',
  iat,
  sid,
  meta,
}
const wrap = (claims) => 'relay_pa_' + Buffer.from('{}').toString('base64url') + '.' +
  Buffer.from(JSON.stringify(claims)).toString('base64url') + '.test-signature'
const access = {
  ...common,
  scopes: request.scopes.map(normalize),
  token_type: 'access',
  aud: ['relayfile'],
  exp: accessExp,
  jti: 'access_test',
}
const refresh = {
  ...common,
  scopes: ['relayauth:token:refresh'],
  token_type: 'refresh',
  aud: ['relayauth'],
  exp: refreshExp,
  jti: 'refresh_test',
}
await writeFile(outputPath, JSON.stringify({
  accessToken: wrap(access),
  refreshToken: wrap(refresh),
  accessTokenExpiresAt: new Date(accessExp * 1000).toISOString(),
  refreshTokenExpiresAt: new Date(refreshExp * 1000).toISOString(),
  tokenType: 'Bearer',
  tokenClass: 'relay_pa',
  agentId: 'agent_' + request.agentName,
  agentName: request.agentName,
  workspaceId: request.workspaceId,
  paths: request.paths.map(normalize),
  delegationNotAfter: request.delegationNotAfter,
}))
process.stdout.write('201')
`
