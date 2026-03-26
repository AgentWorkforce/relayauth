import process from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRelayConfig,
  seedAcl,
  seedAclEntries,
  type RelayConfig,
} from "../../packages/core/src/index.ts";

export { seedAcl, seedAclEntries, type RelayConfig } from "../../packages/core/src/index.ts";

function parseArgs(argv: string[]): { configPath: string; compiledJsonPath: string; baseUrl: string; token: string } {
  const args = [...argv];
  let configPath = "relay.yaml";
  let compiledJsonPath = "";
  let baseUrl = "http://127.0.0.1:8080";
  let token = "";

  while (args.length > 0) {
    const arg = args.shift()!;
    if (arg === "--config") {
      configPath = args.shift() ?? "";
    } else if (arg === "--compiled-json") {
      compiledJsonPath = args.shift() ?? "";
    } else if (arg === "--base-url") {
      baseUrl = args.shift() ?? "";
    } else if (arg === "--token") {
      token = args.shift() ?? "";
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }

  if (!configPath) {
    throw new Error("--config requires a value");
  }
  if (!baseUrl) {
    throw new Error("--base-url requires a value");
  }
  if (!token) {
    throw new Error("--token requires a value");
  }

  return { configPath, compiledJsonPath, baseUrl, token };
}

async function main(): Promise<void> {
  const { configPath, compiledJsonPath, baseUrl, token } = parseArgs(process.argv.slice(2));

  if (compiledJsonPath) {
    const payload = JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(compiledJsonPath, "utf8"))) as {
      workspace?: string;
      acl?: Record<string, string[]>;
    };
    const workspace = payload.workspace?.trim();
    if (!workspace) {
      throw new Error("compiled ACL JSON is missing workspace");
    }
    const acl = payload.acl ?? {};
    await seedAclEntries(workspace, acl, baseUrl, token);
    console.log(`Seeded ${Object.keys(acl).length} ACL entr${Object.keys(acl).length === 1 ? "y" : "ies"}.`);
    return;
  }

  const config = parseRelayConfig(configPath);
  await seedAcl(config, baseUrl, token);
  console.log(`Seeded ${Object.keys(config.acl).length} ACL entr${Object.keys(config.acl).length === 1 ? "y" : "ies"}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`relay seed-acl error: ${message}`);
    process.exit(1);
  });
}
