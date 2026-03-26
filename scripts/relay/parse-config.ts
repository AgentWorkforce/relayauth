import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseRelayConfig, type RelayConfig } from "../../packages/core/src/index.ts";

export { parseRelayConfig, type RelayConfig } from "../../packages/core/src/index.ts";

function printSummary(config: RelayConfig): void {
  console.log(`Workspace: ${config.workspace}`);
  console.log(`Agents: ${config.agents.length}`);
  for (const agent of config.agents) {
    console.log(`- ${agent.name}: ${agent.scopes.length} scope(s)`);
    for (const scope of agent.scopes) {
      console.log(`  ${scope}`);
    }
  }
  console.log(`ACL entries: ${Object.keys(config.acl).length}`);
}

function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const fileArg = args.find((arg) => !arg.startsWith("--"));
  const config = parseRelayConfig(fileArg ?? "relay.yaml");

  if (json) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  printSummary(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`relay parse-config error: ${message}`);
    process.exit(1);
  }
}
