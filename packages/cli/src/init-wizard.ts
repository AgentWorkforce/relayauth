import { access, readFile } from "node:fs/promises";
import path from "node:path";

import { generateScopes } from "@relayauth/sdk";
import type { OpenAPISpec } from "@relayauth/sdk";

export type SupportedFramework = "hono" | "express" | "nextjs";

export interface DetectedOpenAPISpec {
  path: string;
  format: "json" | "yaml";
  spec: OpenAPISpec;
}

export interface GenerateConfigOptions {
  serverUrl: string;
  framework: SupportedFramework;
  openAPISpec?: OpenAPISpec | null;
  serviceName?: string;
}

export interface GenerateScaffoldOptions extends GenerateConfigOptions {}

export interface ScaffoldFile {
  path: string;
  content: string;
}

const FRAMEWORK_PACKAGES: Array<[SupportedFramework, string]> = [
  ["hono", "hono"],
  ["express", "express"],
  ["nextjs", "next"],
];

const OPENAPI_LOCATIONS = [
  "openapi.json",
  "openapi.yaml",
  "openapi.yml",
  "swagger.json",
  "swagger.yaml",
  "swagger.yml",
  "api/openapi.json",
  "api/openapi.yaml",
  "api/openapi.yml",
  "spec/openapi.json",
  "spec/openapi.yaml",
  "spec/openapi.yml",
  "specs/openapi.json",
  "specs/openapi.yaml",
  "specs/openapi.yml",
  "docs/openapi.json",
  "docs/openapi.yaml",
  "docs/openapi.yml",
  "openapi/openapi.json",
  "openapi/openapi.yaml",
  "openapi/openapi.yml",
] as const;

export async function detectFramework(
  cwd: string,
): Promise<SupportedFramework | null> {
  const packageJsonPath = path.join(cwd, "package.json");
  if (!(await fileExists(packageJsonPath))) {
    return null;
  }

  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dependencyNames = new Set([
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
  ]);

  for (const [framework, packageName] of FRAMEWORK_PACKAGES) {
    if (dependencyNames.has(packageName)) {
      return framework;
    }
  }

  return null;
}

export async function detectOpenAPISpec(
  cwd: string,
): Promise<DetectedOpenAPISpec | null> {
  for (const relativePath of OPENAPI_LOCATIONS) {
    const absolutePath = path.join(cwd, relativePath);
    if (!(await fileExists(absolutePath))) {
      continue;
    }

    const source = await readFile(absolutePath, "utf8");
    const format = relativePath.endsWith(".json") ? "json" : "yaml";
    const spec =
      format === "json"
        ? (JSON.parse(source) as OpenAPISpec)
        : parseYamlOpenAPISpec(source);

    return {
      path: absolutePath,
      format,
      spec,
    };
  }

  return null;
}

export function generateConfig(options: GenerateConfigOptions): string {
  const scopeDefinitions = options.openAPISpec
    ? generateScopes(options.openAPISpec, options.serviceName)
    : [];
  const scopes = scopeDefinitions.map((definition) => definition.scope);

  return [
    "export default {",
    `  serverUrl: ${JSON.stringify(options.serverUrl)},`,
    `  adapter: ${JSON.stringify(options.framework)},`,
    `  scopes: ${formatStringArray(scopes, 2)},`,
    "} as const;",
    "",
  ].join("\n");
}

export function generateMiddleware(framework: SupportedFramework): string {
  switch (framework) {
    case "hono":
      return [
        'import type { Hono } from "hono";',
        'import { relayAuth, requireScope } from "@relayauth/sdk";',
        "",
        "const RELAYAUTH_SERVER_URL = process.env.RELAYAUTH_SERVER_URL;",
        "if (!RELAYAUTH_SERVER_URL) {",
        '  throw new Error("Missing required environment variable: RELAYAUTH_SERVER_URL");',
        "}",
        "",
        "export function registerRelayAuth(app: Hono): void {",
        "  app.use(",
        '    "*",',
        "    relayAuth({",
        "      issuer: RELAYAUTH_SERVER_URL,",
        "      jwksUrl: `${RELAYAUTH_SERVER_URL}/.well-known/jwks.json`,",
        "    }),",
        "  );",
        "}",
        "",
        "export const requireRelayScope = requireScope;",
        "",
      ].join("\n");
    case "express":
      return [
        'import type { Express } from "express";',
        'import { relayAuthExpress, requireScopeExpress } from "@relayauth/sdk";',
        "",
        "const RELAYAUTH_SERVER_URL = process.env.RELAYAUTH_SERVER_URL;",
        "if (!RELAYAUTH_SERVER_URL) {",
        '  throw new Error("Missing required environment variable: RELAYAUTH_SERVER_URL");',
        "}",
        "",
        "export function registerRelayAuth(app: Express): void {",
        "  app.use(",
        "    relayAuthExpress({",
        "      issuer: RELAYAUTH_SERVER_URL,",
        "      jwksUrl: `${RELAYAUTH_SERVER_URL}/.well-known/jwks.json`,",
        "    }),",
        "  );",
        "}",
        "",
        "export const requireRelayScope = requireScopeExpress;",
        "",
      ].join("\n");
    case "nextjs":
      return [
        'import { NextResponse } from "next/server";',
        'import type { NextRequest } from "next/server";',
        'import { TokenVerifier } from "@relayauth/sdk";',
        "",
        "const RELAYAUTH_SERVER_URL = process.env.RELAYAUTH_SERVER_URL;",
        "if (!RELAYAUTH_SERVER_URL) {",
        '  throw new Error("Missing required environment variable: RELAYAUTH_SERVER_URL");',
        "}",
        "",
        "const verifier = new TokenVerifier({",
        "  jwksUrl: `${RELAYAUTH_SERVER_URL}/.well-known/jwks.json`,",
        "  issuer: RELAYAUTH_SERVER_URL,",
        "});",
        "",
        "export async function middleware(request: NextRequest) {",
        '  const authorization = request.headers.get("authorization");',
        "  const token = authorization?.replace(/^Bearer\\s+/i, \"\");",
        "",
        "  if (!token || !(await verifier.verifyOrNull(token))) {",
        '    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });',
        "  }",
        "",
        "  return NextResponse.next();",
        "}",
        "",
        "export const config = {",
        '  matcher: ["/api/:path*"],',
        "};",
        "",
      ].join("\n");
  }
}

export function generateScaffold(
  options: GenerateScaffoldOptions,
): ScaffoldFile[] {
  const middlewarePath =
    options.framework === "nextjs"
      ? "middleware.ts"
      : "src/middleware/relayauth.ts";

  return [
    {
      path: "relayauth.config.ts",
      content: generateConfig(options),
    },
    {
      path: middlewarePath,
      content: generateMiddleware(options.framework),
    },
  ];
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function formatStringArray(values: string[], indentLevel: number): string {
  if (values.length === 0) {
    return "[]";
  }

  const indent = "  ".repeat(indentLevel);
  const closingIndent = "  ".repeat(Math.max(indentLevel - 1, 0));
  return `[\n${values.map((value) => `${indent}${JSON.stringify(value)},`).join("\n")}\n${closingIndent}]`;
}

function parseYamlOpenAPISpec(source: string): OpenAPISpec {
  const parsed = parseYamlObject(source);

  if (!isOpenAPISpec(parsed)) {
    throw new Error("Invalid OpenAPI spec");
  }

  return parsed;
}

function parseYamlObject(source: string): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  const stack: Array<{ indent: number; value: Record<string, unknown> }> = [
    { indent: -1, value: root },
  ];
  // When we see "key:" with no value, we don't know yet if it's an object or
  // array. We record it here and decide when we see the first child line.
  let pending: {
    parent: Record<string, unknown>;
    key: string;
    indent: number;
  } | null = null;
  // Active array collector: set when we confirm a pending key starts an array.
  let activeArray: {
    parent: Record<string, unknown>;
    key: string;
    indent: number;
    items: unknown[];
  } | null = null;

  for (const rawLine of source.split(/\r?\n/)) {
    const uncommented = stripYamlComment(rawLine);
    if (uncommented.trim().length === 0) {
      continue;
    }

    const indent = rawLine.length - rawLine.trimStart().length;
    const line = uncommented.trim();

    // If we have a pending key, the first non-empty child tells us its type.
    if (pending && indent > pending.indent) {
      if (line.startsWith("- ")) {
        // It's an array
        activeArray = {
          parent: pending.parent,
          key: pending.key,
          indent: pending.indent,
          items: [parseYamlScalar(line.slice(2).trim())],
        };
        pending = null;
        continue;
      }
      // It's an object — commit the nested object and continue normally
      const nested: Record<string, unknown> = {};
      pending.parent[pending.key] = nested;
      stack.push({ indent: pending.indent, value: nested });
      pending = null;
      // Fall through to process this line as a key-value in the new object
    } else if (pending) {
      // Same or lesser indent with no children — empty object
      pending.parent[pending.key] = {};
      pending = null;
    }

    // Collect array items
    if (activeArray) {
      if (line.startsWith("- ") && indent > activeArray.indent) {
        activeArray.items.push(parseYamlScalar(line.slice(2).trim()));
        continue;
      }
      // Array is done
      activeArray.parent[activeArray.key] = activeArray.items;
      activeArray = null;
    }

    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      continue; // skip unsupported lines gracefully
    }

    const key = unquote(line.slice(0, separatorIndex).trim());
    const remainder = line.slice(separatorIndex + 1).trim();

    while (indent <= stack[stack.length - 1]!.indent) {
      stack.pop();
    }

    const parent = stack[stack.length - 1]!.value;
    if (remainder.length === 0) {
      // Defer: could be object or array
      pending = { parent, key, indent };
      continue;
    }

    parent[key] = parseYamlScalar(remainder);
  }

  // Flush any remaining pending/active state
  if (pending) {
    pending.parent[pending.key] = {};
  }
  if (activeArray) {
    activeArray.parent[activeArray.key] = activeArray.items;
  }

  return root;
}

function stripYamlComment(line: string): string {
  let inSingleQuote = false;
  let inDoubleQuote = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (character === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (character === "#" && !inSingleQuote && !inDoubleQuote) {
      return line.slice(0, index);
    }
  }

  return line;
}

function parseYamlScalar(value: string): unknown {
  const normalized = value.trim();
  if (
    (normalized.startsWith('"') && normalized.endsWith('"')) ||
    (normalized.startsWith("'") && normalized.endsWith("'"))
  ) {
    return unquote(normalized);
  }

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  if (normalized === "null") {
    return null;
  }

  if (/^-?\d+(?:\.\d+)?$/.test(normalized)) {
    return Number(normalized);
  }

  return normalized;
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function isOpenAPISpec(value: unknown): value is OpenAPISpec {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as {
    info?: { title?: unknown };
    paths?: unknown;
  };

  return (
    !!candidate.info &&
    typeof candidate.info.title === "string" &&
    !!candidate.paths &&
    typeof candidate.paths === "object"
  );
}
