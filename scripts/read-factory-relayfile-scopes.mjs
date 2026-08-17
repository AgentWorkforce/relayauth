#!/usr/bin/env node

import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const sourcePath = process.argv[2]
if (!sourcePath) throw new Error('Factory scope source path is required')

const source = await readFile(sourcePath, 'utf8')
const sourceFile = ts.createSourceFile(
  sourcePath,
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
)
let initializer
for (const statement of sourceFile.statements) {
  if (!ts.isVariableStatement(statement)) continue
  for (const declaration of statement.declarationList.declarations) {
    if (ts.isIdentifier(declaration.name) && declaration.name.text === 'FACTORY_RELAYFILE_SCOPES') {
      if (initializer) throw new Error('FACTORY_RELAYFILE_SCOPES must be declared exactly once')
      initializer = declaration.initializer
    }
  }
}
if (!initializer) throw new Error('FACTORY_RELAYFILE_SCOPES export was not found')
while (
  ts.isAsExpression(initializer) ||
  ts.isSatisfiesExpression(initializer) ||
  ts.isParenthesizedExpression(initializer)
) initializer = initializer.expression
if (!ts.isArrayLiteralExpression(initializer)) {
  throw new Error('FACTORY_RELAYFILE_SCOPES must be a literal array')
}

const scopes = initializer.elements.map((element) => {
  if (!ts.isStringLiteralLike(element)) {
    throw new Error('FACTORY_RELAYFILE_SCOPES contains a non-literal entry')
  }
  return element.text
})
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
