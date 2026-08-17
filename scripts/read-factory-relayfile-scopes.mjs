#!/usr/bin/env node

import { readFile } from 'node:fs/promises'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('Factory scope source path is required')

const source = await readFile(sourcePath, 'utf8')
const match = source.match(
  /export const FACTORY_RELAYFILE_SCOPES\s*=\s*\[([\s\S]*?)\]\s*as const/u,
)
if (!match) throw new Error('FACTORY_RELAYFILE_SCOPES export was not found')

const scopes = [...match[1].matchAll(/^\s*'([^']+)',?\s*$/gmu)].map((entry) => entry[1])
if (scopes.length === 0 || new Set(scopes).size !== scopes.length) {
  throw new Error('FACTORY_RELAYFILE_SCOPES must be non-empty and unique')
}
if (!scopes.every((scope) => /^relayfile:fs:(read|write):\/[^:]+$/u.test(scope))) {
  throw new Error('FACTORY_RELAYFILE_SCOPES contains a non-filesystem or malformed scope')
}
if (
  !scopes.includes('relayfile:fs:read:/github/**') ||
  !scopes.includes('relayfile:fs:write:/github/**')
) {
  throw new Error('Factory scopes must retain read/write access at /github/**')
}
if (scopes.some((scope) => scope.includes('/github/repos/**'))) {
  throw new Error('/github/repos/** is invalid for a RelayAuth path-token batch')
}

process.stdout.write(JSON.stringify(scopes))
