#!/usr/bin/env node

import { runInitCommand } from "./commands/init.js";

const [command, ...argv] = process.argv.slice(2);

try {
  switch (command) {
    case "init":
      process.exitCode = await runInitCommand(argv);
      break;
    case undefined:
      console.log("relayauth CLI");
      console.log("Available commands: init");
      break;
    default:
      console.error(`Unknown command: ${command}`);
      console.error("Available commands: init");
      process.exitCode = 1;
      break;
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(message);
  process.exitCode = 1;
}
