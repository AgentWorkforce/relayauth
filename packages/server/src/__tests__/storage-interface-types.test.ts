import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";

test("storage/interface type-checks a canonical ApiKeyKind consumer", () => {
  const fixturePath = fileURLToPath(
    new URL("./fixtures/storage-interface-consumer.ts", import.meta.url),
  );
  const configPath = fileURLToPath(
    new URL("../../tsconfig.json", import.meta.url),
  );
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);

  const parsed = ts.parseJsonConfigFileContent(
    config.config,
    ts.sys,
    fileURLToPath(new URL("../..", import.meta.url)),
    { noEmit: true, composite: false },
    configPath,
  );
  const program = ts.createProgram([fixturePath], parsed.options);
  const diagnostics = ts
    .getPreEmitDiagnostics(program)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
    );

  assert.deepEqual(diagnostics, []);
});
