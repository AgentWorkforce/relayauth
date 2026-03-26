import { access, mkdir, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import process from "node:process";

import { generateScopes } from "@relayauth/sdk";

import {
  detectFramework,
  detectOpenAPISpec,
  generateConfig,
  generateMiddleware,
  generateScaffold,
  type ScaffoldFile,
  type SupportedFramework,
} from "../init-wizard.js";

export {
  detectFramework,
  detectOpenAPISpec,
  generateConfig,
  generateMiddleware,
  generateScaffold,
};

interface InitCommandOptions {
  cwd: string;
  framework?: SupportedFramework;
  serverUrl?: string;
  force: boolean;
  yes: boolean;
  help: boolean;
}

interface PlannedFile extends ScaffoldFile {
  absolutePath: string;
  exists: boolean;
}

const SUPPORTED_FRAMEWORKS = new Set<SupportedFramework>([
  "hono",
  "express",
  "nextjs",
]);

export async function runInitCommand(argv: string[] = []): Promise<number> {
  const options = parseInitCommandOptions(argv);
  if (options.help) {
    printInitHelp();
    return 0;
  }

  const framework =
    options.framework ??
    (await detectFramework(options.cwd));
  if (!framework) {
    console.error(
      "Unable to detect a supported framework. Use --framework hono|express|nextjs.",
    );
    return 1;
  }

  const detectedSpec = await detectOpenAPISpec(options.cwd);
  const serverUrl =
    options.serverUrl ??
    process.env.RELAYAUTH_SERVER_URL ??
    process.env.RELAYAUTH_URL ??
    (await promptForServerUrl());

  if (!serverUrl) {
    console.error(
      "A RelayAuth server URL is required. Pass --server-url or set RELAYAUTH_SERVER_URL.",
    );
    return 1;
  }

  const scaffold = generateScaffold({
    serverUrl,
    framework,
    openAPISpec: detectedSpec?.spec,
  });
  const plannedFiles = await buildWritePlan(options.cwd, scaffold);
  const generatedScopeCount = detectedSpec
    ? generateScopes(detectedSpec.spec).length
    : 0;

  printInitSummary({
    cwd: options.cwd,
    framework,
    openapiPath: detectedSpec?.path,
    generatedScopeCount,
    plannedFiles,
  });

  const conflictingFiles = plannedFiles.filter((file) => file.exists);
  if (conflictingFiles.length > 0 && !options.force) {
    console.error("");
    console.error("Refusing to overwrite existing files:");
    for (const file of conflictingFiles) {
      console.error(`- ${path.relative(options.cwd, file.absolutePath)}`);
    }
    console.error("Re-run with --force to overwrite them.");
    return 1;
  }

  if (process.stdin.isTTY && !options.yes) {
    const confirmed = await promptForConfirmation(plannedFiles);
    if (!confirmed) {
      console.error("Init cancelled.");
      return 1;
    }
  }

  for (const file of plannedFiles) {
    await mkdir(path.dirname(file.absolutePath), { recursive: true });
    await writeFile(file.absolutePath, file.content, "utf8");
  }

  console.log("");
  console.log("Created files:");
  for (const file of plannedFiles) {
    console.log(`- ${path.relative(options.cwd, file.absolutePath)}`);
  }

  return 0;
}

function parseInitCommandOptions(argv: string[]): InitCommandOptions {
  const options: InitCommandOptions = {
    cwd: process.cwd(),
    force: false,
    yes: false,
    help: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--cwd") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --cwd");
      }
      options.cwd = path.resolve(value);
      index += 1;
      continue;
    }

    if (argument === "--server-url") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("Missing value for --server-url");
      }
      options.serverUrl = value;
      index += 1;
      continue;
    }

    if (argument === "--framework") {
      const value = argv[index + 1];
      if (!value || !SUPPORTED_FRAMEWORKS.has(value as SupportedFramework)) {
        throw new Error("Invalid value for --framework. Use hono, express, or nextjs.");
      }
      options.framework = value as SupportedFramework;
      index += 1;
      continue;
    }

    if (argument === "--force") {
      options.force = true;
      options.yes = true;
      continue;
    }

    if (argument === "--yes" || argument === "-y") {
      options.yes = true;
      continue;
    }

    if (argument === "--help" || argument === "-h") {
      options.help = true;
      continue;
    }

    throw new Error(`Unknown init option: ${argument}`);
  }

  return options;
}

async function buildWritePlan(
  cwd: string,
  scaffold: ScaffoldFile[],
): Promise<PlannedFile[]> {
  return Promise.all(
    scaffold.map(async (file) => {
      const absolutePath = path.join(cwd, file.path);
      return {
        ...file,
        absolutePath,
        exists: await fileExists(absolutePath),
      };
    }),
  );
}

function printInitSummary(details: {
  cwd: string;
  framework: SupportedFramework;
  openapiPath?: string;
  generatedScopeCount: number;
  plannedFiles: PlannedFile[];
}): void {
  console.log("RelayAuth init");
  console.log(`- project: ${details.cwd}`);
  console.log(`- framework: ${details.framework}`);
  console.log(
    `- openapi: ${details.openapiPath ? path.relative(details.cwd, details.openapiPath) : "not found"}`,
  );
  console.log(`- scopes: ${details.generatedScopeCount}`);
  console.log("- files:");
  for (const file of details.plannedFiles) {
    console.log(
      `  - ${path.relative(details.cwd, file.absolutePath)}${file.exists ? " (overwrite)" : ""}`,
    );
  }
}

async function promptForServerUrl(): Promise<string | undefined> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return undefined;
  }

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question("RelayAuth server URL: ");
    const trimmed = answer.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } finally {
    rl.close();
  }
}

async function promptForConfirmation(files: PlannedFile[]): Promise<boolean> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question(
      `Write ${files.length} file${files.length === 1 ? "" : "s"}? [y/N] `,
    );
    return /^(?:y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

function printInitHelp(): void {
  console.log("Usage: relayauth init [options]");
  console.log("");
  console.log("Options:");
  console.log("  --cwd <path>            Target project directory");
  console.log("  --server-url <url>      RelayAuth server URL");
  console.log("  --framework <name>      hono | express | nextjs");
  console.log("  --yes, -y               Skip confirmation");
  console.log("  --force                 Overwrite generated files");
  console.log("  --help, -h              Show this help");
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}
