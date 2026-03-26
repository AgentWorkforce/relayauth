import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { discoverAgents, hasDotfiles, isIgnored, isReadonly, parseDotfiles } from "./dotfile-parser.ts";

export interface CompiledDotfiles {
  workspace: string;
  agentName: string;
  ignoredPatterns: string[];
  readonlyPatterns: string[];
  ignoredPaths: string[];
  readonlyPaths: string[];
  readwritePaths: string[];
  acl: Record<string, string[]>;
  scopes: string[];
  summary: {
    ignored: number;
    readonly: number;
    readwrite: number;
  };
}

function normalizeAclDir(relativeDir: string): string {
  if (relativeDir === "." || relativeDir === "") {
    return "/";
  }
  const normalized = `/${relativeDir}`.replace(/\/+/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function addRule(map: Map<string, Set<string>>, aclDir: string, rule: string): void {
  const existing = map.get(aclDir) ?? new Set<string>();
  existing.add(rule);
  map.set(aclDir, existing);
}

function addScope(scopes: Set<string>, action: "read" | "write", relativePath: string): void {
  const normalized = `/${relativePath.replace(/\\/g, "/")}`;
  scopes.add(`relayfile:fs:${action}:${normalized}`);
}

function walkProjectFiles(
  projectDir: string,
  callback: (relativePath: string, isDirectory: boolean) => void,
  currentDir = projectDir,
): void {
  const entries = fs.readdirSync(currentDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === ".relay") {
      continue;
    }

    const fullPath = path.join(currentDir, entry.name);
    const relativePath = path.relative(projectDir, fullPath).replace(/\\/g, "/");
    callback(relativePath, entry.isDirectory());
    if (entry.isDirectory()) {
      walkProjectFiles(projectDir, callback, fullPath);
    }
  }
}

export function compileDotfiles(projectDir: string, agentName: string, workspace: string): CompiledDotfiles {
  const perms = parseDotfiles(projectDir, agentName);
  const aclMap = new Map<string, Set<string>>();
  const scopes = new Set<string>();
  const ignoredPaths: string[] = [];
  const readonlyPaths: string[] = [];
  const readwritePaths: string[] = [];

  walkProjectFiles(path.resolve(projectDir), (relativePath, isDirectory) => {
    if (isDirectory) {
      return;
    }

    if (isIgnored(relativePath, perms)) {
      ignoredPaths.push(relativePath);
      addRule(aclMap, normalizeAclDir(path.dirname(relativePath)), `deny:agent:${agentName}`);
      return;
    }

    addScope(scopes, "read", relativePath);
    if (isReadonly(relativePath, perms)) {
      readonlyPaths.push(relativePath);
      return;
    }

    readwritePaths.push(relativePath);
    addScope(scopes, "write", relativePath);
  });

  const acl: Record<string, string[]> = {};
  for (const [aclDir, rules] of aclMap.entries()) {
    acl[aclDir] = [...rules].sort();
  }

  return {
    workspace,
    agentName,
    ignoredPatterns: perms.ignoredPatterns,
    readonlyPatterns: perms.readonlyPatterns,
    ignoredPaths: ignoredPaths.sort(),
    readonlyPaths: readonlyPaths.sort(),
    readwritePaths: readwritePaths.sort(),
    acl,
    scopes: [...scopes].sort(),
    summary: {
      ignored: ignoredPaths.length,
      readonly: readonlyPaths.length,
      readwrite: readwritePaths.length,
    },
  };
}

function parseArgs(argv: string[]): { projectDir: string; agentName: string; workspace: string } {
  const args = [...argv];
  let projectDir = process.cwd();
  let agentName = "";
  let workspace = "";

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--project-dir") {
      projectDir = args.shift() ?? "";
    } else if (arg === "--agent") {
      agentName = args.shift() ?? "";
    } else if (arg === "--workspace") {
      workspace = args.shift() ?? "";
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!projectDir) {
    throw new Error("--project-dir requires a value");
  }
  if (!agentName) {
    throw new Error("--agent requires a value");
  }
  if (!workspace) {
    throw new Error("--workspace requires a value");
  }

  return { projectDir, agentName, workspace };
}

function main(): void {
  const { projectDir, agentName, workspace } = parseArgs(process.argv.slice(2));
  console.log(JSON.stringify({
    hasDotfiles: hasDotfiles(projectDir),
    discoveredAgents: discoverAgents(projectDir),
    compiled: compileDotfiles(projectDir, agentName, workspace),
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`relay dotfile-compiler error: ${message}`);
    process.exit(1);
  }
}
