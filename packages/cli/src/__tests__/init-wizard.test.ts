import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  detectFramework,
  detectOpenAPISpec,
  generateConfig,
  generateMiddleware,
  generateScaffold,
} from "../init-wizard.js";
import { runInitCommand } from "../commands/init.js";

async function createProject(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "relayauth-init-wizard-"));

  for (const [relativePath, content] of Object.entries(files)) {
    const absolutePath = path.join(directory, relativePath);
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, content, "utf8");
  }

  return directory;
}

function createOpenAPISpec(title = "Billing API") {
  return {
    openapi: "3.1.0",
    info: {
      title,
    },
    paths: {
      "/invoices": {
        get: {
          summary: "List invoices",
        },
      },
      "/invoices/{id}": {
        delete: {
          summary: "Delete invoice",
        },
      },
    },
  };
}

test("detectFramework(cwd) detects Hono from package.json", async () => {
  const cwd = await createProject({
    "package.json": JSON.stringify({
      name: "hono-app",
      dependencies: {
        hono: "^4.0.0",
      },
    }),
  });

  const framework = await detectFramework(cwd);

  assert.equal(framework, "hono");
});

test("detectFramework(cwd) detects Express from package.json", async () => {
  const cwd = await createProject({
    "package.json": JSON.stringify({
      name: "express-app",
      dependencies: {
        express: "^5.0.0",
      },
    }),
  });

  const framework = await detectFramework(cwd);

  assert.equal(framework, "express");
});

test("detectFramework(cwd) detects Next.js from package.json", async () => {
  const cwd = await createProject({
    "package.json": JSON.stringify({
      name: "next-app",
      dependencies: {
        next: "^15.0.0",
      },
    }),
  });

  const framework = await detectFramework(cwd);

  assert.equal(framework, "nextjs");
});

test("detectOpenAPISpec(cwd) finds openapi.json in the project root", async () => {
  const cwd = await createProject({
    "openapi.json": JSON.stringify(createOpenAPISpec(), null, 2),
  });

  const detected = await detectOpenAPISpec(cwd);

  assert.ok(detected);
  assert.equal(detected.format, "json");
  assert.equal(detected.path, path.join(cwd, "openapi.json"));
  assert.equal(detected.spec.info.title, "Billing API");
  assert.ok(detected.spec.paths["/invoices"]);
});

test("detectOpenAPISpec(cwd) finds openapi.yaml in docs/", async () => {
  const cwd = await createProject({
    "docs/openapi.yaml": [
      'openapi: "3.1.0"',
      "info:",
      '  title: "Docs API"',
      "paths:",
      "  /projects:",
      "    get:",
      '      summary: "List projects"',
    ].join("\n"),
  });

  const detected = await detectOpenAPISpec(cwd);

  assert.ok(detected);
  assert.equal(detected.format, "yaml");
  assert.equal(detected.path, path.join(cwd, "docs/openapi.yaml"));
  assert.equal(detected.spec.info.title, "Docs API");
  assert.deepEqual(detected.spec.paths["/projects"], {
    get: {
      summary: "List projects",
    },
  });
});

test("generateConfig(options) produces relayauth.config.ts content", () => {
  const content = generateConfig({
    serverUrl: "https://auth.example.test",
    framework: "hono",
    openAPISpec: createOpenAPISpec(),
  });

  assert.match(content, /serverUrl: "https:\/\/auth\.example\.test"/);
  assert.match(content, /adapter: "hono"/);
  assert.match(content, /"billing-api:invoices:read"/);
  assert.match(content, /"billing-api:invoices:delete:\/invoices\/\{id\}"/);
  assert.match(content, /export default \{/);
});

test("generateMiddleware(framework) produces framework-specific middleware code", () => {
  const honoCode = generateMiddleware("hono");
  const expressCode = generateMiddleware("express");
  const nextCode = generateMiddleware("nextjs");

  assert.match(honoCode, /from "hono"/);
  assert.match(honoCode, /relayAuth/);
  assert.match(honoCode, /requireScope/);

  assert.match(expressCode, /from "express"/);
  assert.match(expressCode, /relayAuthExpress/);
  assert.match(expressCode, /requireScopeExpress/);

  assert.match(nextCode, /NextRequest/);
  assert.match(nextCode, /NextResponse/);
  assert.match(nextCode, /TokenVerifier/);
  assert.match(nextCode, /export async function middleware/);
});

test("generateScaffold(options) returns the files to create", () => {
  const files = generateScaffold({
    serverUrl: "https://auth.example.test",
    framework: "express",
    openAPISpec: createOpenAPISpec(),
  });

  assert.deepEqual(
    files.map((file) => file.path),
    ["relayauth.config.ts", "src/middleware/relayauth.ts"],
  );
  assert.match(files[0]!.content, /adapter: "express"/);
  assert.match(files[1]!.content, /relayAuthExpress/);
});

test("generated config includes serverUrl, OpenAPI scopes, and the framework adapter", async () => {
  const cwd = await createProject({
    "package.json": JSON.stringify({
      name: "billing-service",
      dependencies: {
        hono: "^4.0.0",
      },
    }),
    "openapi.json": JSON.stringify(createOpenAPISpec(), null, 2),
  });

  const framework = await detectFramework(cwd);
  const detectedSpec = await detectOpenAPISpec(cwd);

  assert.equal(framework, "hono");
  assert.ok(detectedSpec);

  const content = generateConfig({
    serverUrl: "https://relay.example.test",
    framework,
    openAPISpec: detectedSpec.spec,
  });

  assert.match(content, /serverUrl: "https:\/\/relay\.example\.test"/);
  assert.match(content, /adapter: "hono"/);
  assert.match(content, /"billing-api:invoices:read"/);
  assert.match(content, /"billing-api:invoices:delete:\/invoices\/\{id\}"/);
});

test("detectOpenAPISpec(cwd) parses YAML with arrays", async () => {
  const cwd = await createProject({
    "openapi.yaml": [
      'openapi: "3.1.0"',
      "info:",
      '  title: "Array API"',
      "paths:",
      "  /items:",
      "    get:",
      '      summary: "List items"',
      "      parameters:",
      "        - name",
      "        - limit",
    ].join("\n"),
  });

  const detected = await detectOpenAPISpec(cwd);

  assert.ok(detected);
  assert.equal(detected.spec.info.title, "Array API");
  const getOp = detected.spec.paths["/items"]?.get as Record<string, unknown>;
  assert.ok(getOp);
  assert.ok(Array.isArray(getOp.parameters));
  assert.deepEqual(getOp.parameters, ["name", "limit"]);
});

test("runInitCommand refuses to overwrite existing files without --force", async () => {
  const cwd = await createProject({
    "package.json": JSON.stringify({
      name: "test-app",
      dependencies: { hono: "^4.0.0" },
    }),
    "relayauth.config.ts": "// existing config",
  });

  const exitCode = await runInitCommand([
    "--cwd",
    cwd,
    "--server-url",
    "https://auth.example.test",
    "--yes",
  ]);

  assert.equal(exitCode, 1);
});

test("generateMiddleware includes env var guard for all frameworks", () => {
  for (const framework of ["hono", "express", "nextjs"] as const) {
    const code = generateMiddleware(framework);
    assert.match(
      code,
      /Missing required environment variable: RELAYAUTH_SERVER_URL/,
      `${framework} middleware should guard against missing env var`,
    );
  }
});
