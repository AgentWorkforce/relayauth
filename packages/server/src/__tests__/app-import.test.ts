import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("the application exports import without initializing a Node HTTP adapter", () => {
  const registration = fileURLToPath(new URL(
    "../../../../tests/fixtures/register-node-http-blocker.mjs", import.meta.url,
  ));
  const entrypoint = new URL("../index.ts", import.meta.url).href;
  const result = spawnSync(process.execPath, [
    "--import", "tsx",
    "--import", registration,
    "--input-type=module",
    "--eval", `
      import assert from "node:assert/strict";
      const application = await import(${JSON.stringify(entrypoint)});
      assert.equal(typeof application.createApp, "function");
      assert.equal(typeof application.startServer, "function");
      await assert.rejects(application.startServer({
        get storage() { throw new Error("storage initialized before HTTP adapter resolution"); },
      }), /Node HTTP adapter must not load when importing the application/);
    `,
  ], { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
