#!/usr/bin/env -S npx tsx

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

type WorkerEnvironment = "production" | "dev" | "staging";

type SeedIdentity = {
  id: string;
  name: string;
  type: "agent" | "human" | "service";
  status: "active";
  scopes: string[];
  metadata: Record<string, string>;
};

type SeedData = {
  orgId: string;
  workspaceId: string;
  identities: SeedIdentity[];
};

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "..");
const wranglerConfigPath = path.join(repoRoot, "wrangler.toml");

export const DEV_SEED_DATA: SeedData = {
  orgId: "org_test",
  workspaceId: "ws_test",
  identities: [
    {
      id: "agent_test",
      name: "RelayAuth Test Agent",
      type: "agent",
      status: "active",
      scopes: ["*"],
      metadata: {
        workspaceId: "ws_test",
        profile: "admin",
        seededBy: "scripts/seed-dev-data.ts",
      },
    },
    {
      id: "agent_observer",
      name: "RelayAuth Observer Agent",
      type: "agent",
      status: "active",
      scopes: ["relayauth:identity:read:*", "relayauth:token:read:*"],
      metadata: {
        workspaceId: "ws_test",
        profile: "observer",
        seededBy: "scripts/seed-dev-data.ts",
      },
    },
    {
      id: "service_seed_runner",
      name: "RelayAuth Seed Service",
      type: "service",
      status: "active",
      scopes: ["relayauth:token:create:*"],
      metadata: {
        workspaceId: "ws_test",
        profile: "automation",
        seededBy: "scripts/seed-dev-data.ts",
      },
    },
    {
      id: "human_dev",
      name: "RelayAuth Dev User",
      type: "human",
      status: "active",
      scopes: ["relayauth:identity:read:*", "relayauth:token:read:*", "relayauth:token:create:*"],
      metadata: {
        workspaceId: "ws_test",
        profile: "developer",
        seededBy: "scripts/seed-dev-data.ts",
      },
    },
  ],
};

function quoteSql(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function jsonSql(value: unknown): string {
  return quoteSql(JSON.stringify(value));
}

function buildSqlStatements(seedData: SeedData = DEV_SEED_DATA): string[] {
  const timestamp = new Date().toISOString();
  const organizationName = "RelayAuth Dev Org";
  const workspaceName = "RelayAuth Dev Workspace";

  const statements = [
    `CREATE TABLE IF NOT EXISTS organizations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      org_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS identities (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      org_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      scopes TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_active_at TEXT,
      suspended_at TEXT,
      suspend_reason TEXT
    )`,
    `INSERT INTO organizations (id, name, created_at, updated_at)
     VALUES (${quoteSql(seedData.orgId)}, ${quoteSql(organizationName)}, ${quoteSql(timestamp)}, ${quoteSql(timestamp)})
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       updated_at = excluded.updated_at`,
    `INSERT INTO workspaces (id, name, org_id, created_at, updated_at)
     VALUES (${quoteSql(seedData.workspaceId)}, ${quoteSql(workspaceName)}, ${quoteSql(seedData.orgId)}, ${quoteSql(timestamp)}, ${quoteSql(timestamp)})
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       org_id = excluded.org_id,
       updated_at = excluded.updated_at`,
  ];

  for (const identity of seedData.identities) {
    statements.push(
      `INSERT INTO identities (id, name, type, org_id, status, scopes, metadata, created_at, updated_at, last_active_at, suspended_at, suspend_reason)
       VALUES (
         ${quoteSql(identity.id)},
         ${quoteSql(identity.name)},
         ${quoteSql(identity.type)},
         ${quoteSql(seedData.orgId)},
         ${quoteSql(identity.status)},
         ${jsonSql(identity.scopes)},
         ${jsonSql(identity.metadata)},
         ${quoteSql(timestamp)},
         ${quoteSql(timestamp)},
         NULL,
         NULL,
         NULL
       )
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         type = excluded.type,
         org_id = excluded.org_id,
         status = excluded.status,
         scopes = excluded.scopes,
         metadata = excluded.metadata,
         updated_at = excluded.updated_at,
         last_active_at = excluded.last_active_at,
         suspended_at = excluded.suspended_at,
         suspend_reason = excluded.suspend_reason`,
    );
  }

  return statements;
}

export async function seedDevData(
  db: D1Database,
  seedData: SeedData = DEV_SEED_DATA,
): Promise<SeedData> {
  const statements = buildSqlStatements(seedData).map((sql) => db.prepare(sql));
  await db.batch(statements);
  return seedData;
}

function parseDatabaseName(configSource: string, environment: WorkerEnvironment): string {
  const pattern =
    environment === "production"
      ? /\[\[d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"/
      : new RegExp(String.raw`\[\[env\.${environment}\.d1_databases\]\][\s\S]*?database_name\s*=\s*"([^"]+)"`);

  const match = configSource.match(pattern);
  if (!match) {
    throw new Error(`Could not resolve database_name for environment "${environment}" from wrangler.toml.`);
  }

  return match[1];
}

async function runCliSeed(environment: WorkerEnvironment, remote: boolean): Promise<void> {
  const configSource = await readFile(wranglerConfigPath, "utf8");
  const databaseName = parseDatabaseName(configSource, environment);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "relayauth-seed-"));
  const sqlFilePath = path.join(tempDir, "seed.sql");
  const sqlSource = `${buildSqlStatements().join(";\n")};\n`;

  await writeFile(sqlFilePath, sqlSource, "utf8");

  const args = ["wrangler", "d1", "execute", databaseName, "--config", wranglerConfigPath];
  if (environment !== "production") {
    args.push("--env", environment);
  }
  args.push(remote ? "--remote" : "--local", "--file", sqlFilePath);

  const result = spawnSync("npx", args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  await rm(tempDir, { recursive: true, force: true });

  if (result.status !== 0) {
    throw new Error(`wrangler d1 execute failed with exit code ${result.status ?? 1}`);
  }
}

function parseArgs(argv: string[]): { environment: WorkerEnvironment; remote: boolean } {
  let environment: WorkerEnvironment = "dev";
  let remote = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--remote") {
      remote = true;
      continue;
    }

    if (arg === "--env") {
      const value = argv[index + 1];
      if (value !== "production" && value !== "dev" && value !== "staging") {
        throw new Error(`Unsupported environment "${value ?? ""}". Use production, dev, or staging.`);
      }
      environment = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      console.log("Usage: npx tsx scripts/seed-dev-data.ts [--env production|dev|staging] [--remote]");
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { environment, remote };
}

async function main(): Promise<void> {
  const { environment, remote } = parseArgs(process.argv.slice(2));

  await runCliSeed(environment, remote);

  console.log(`Seeded ${environment} ${remote ? "remote" : "local"} D1 database with dev records.`);
  console.table(
    DEV_SEED_DATA.identities.map((identity) => ({
      orgId: DEV_SEED_DATA.orgId,
      workspaceId: DEV_SEED_DATA.workspaceId,
      identityId: identity.id,
      type: identity.type,
      scopes: identity.scopes.join(", "),
    })),
  );
}

const isDirectRun = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
