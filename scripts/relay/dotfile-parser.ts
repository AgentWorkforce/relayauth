import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import ignore, { type Ignore } from "ignore";

export interface DotfilePermissions {
  agentName: string;
  projectDir: string;
  ignored: Ignore;
  readonly: Ignore;
  ignoredPatterns: string[];
  readonlyPatterns: string[];
}

function cleanPatterns(content: string): string[] {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
}

function loadPatterns(matcher: Ignore, filePath: string): string[] {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf8");
  matcher.add(content);
  return cleanPatterns(content);
}

export function hasDotfiles(projectDir: string): boolean {
  return fs.readdirSync(projectDir).some((entry) => entry === ".agentignore" ||
    entry === ".agentreadonly" ||
    /^\.[^.].*\.agentignore$/.test(entry) ||
    /^\.[^.].*\.agentreadonly$/.test(entry));
}

export function discoverAgents(projectDir: string): string[] {
  const agents = new Set<string>();
  for (const entry of fs.readdirSync(projectDir)) {
    const match = entry.match(/^\.(.+)\.(agentignore|agentreadonly)$/);
    if (match) {
      agents.add(match[1]);
    }
  }
  return [...agents].sort((a, b) => a.localeCompare(b));
}

export function parseDotfiles(projectDir: string, agentName: string): DotfilePermissions {
  const resolvedProjectDir = path.resolve(projectDir);
  const ignored = ignore();
  const readonly = ignore();

  const ignoredPatterns = [
    ...loadPatterns(ignored, path.join(resolvedProjectDir, ".agentignore")),
    ...loadPatterns(ignored, path.join(resolvedProjectDir, `.${agentName}.agentignore`)),
  ];
  const readonlyPatterns = [
    ...loadPatterns(readonly, path.join(resolvedProjectDir, ".agentreadonly")),
    ...loadPatterns(readonly, path.join(resolvedProjectDir, `.${agentName}.agentreadonly`)),
  ];

  return {
    agentName,
    projectDir: resolvedProjectDir,
    ignored,
    readonly,
    ignoredPatterns,
    readonlyPatterns,
  };
}

export function isIgnored(relativePath: string, perms: DotfilePermissions): boolean {
  return perms.ignored.ignores(relativePath);
}

export function isReadonly(relativePath: string, perms: DotfilePermissions): boolean {
  if (isIgnored(relativePath, perms)) {
    return false;
  }
  return perms.readonly.ignores(relativePath);
}

function parseArgs(argv: string[]): { command: "parse" | "discover"; projectDir: string; agentName?: string } {
  const args = [...argv];
  let command: "parse" | "discover" = "parse";
  let projectDir = process.cwd();
  let agentName: string | undefined;

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--discover") {
      command = "discover";
    } else if (arg === "--project-dir") {
      projectDir = args.shift() ?? "";
    } else if (arg === "--agent") {
      agentName = args.shift() ?? "";
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!projectDir) {
    throw new Error("--project-dir requires a value");
  }
  if (command === "parse" && !agentName) {
    throw new Error("--agent requires a value");
  }

  return { command, projectDir, agentName };
}

function main(): void {
  const { command, projectDir, agentName } = parseArgs(process.argv.slice(2));
  if (command === "discover") {
    console.log(JSON.stringify({
      projectDir: path.resolve(projectDir),
      hasDotfiles: hasDotfiles(projectDir),
      agents: discoverAgents(projectDir),
    }, null, 2));
    return;
  }

  const parsed = parseDotfiles(projectDir, agentName!);
  console.log(JSON.stringify({
    projectDir: parsed.projectDir,
    agentName: parsed.agentName,
    hasDotfiles: hasDotfiles(projectDir),
    discoveredAgents: discoverAgents(projectDir),
    ignoredPatterns: parsed.ignoredPatterns,
    readonlyPatterns: parsed.readonlyPatterns,
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`relay dotfile-parser error: ${message}`);
    process.exit(1);
  }
}
