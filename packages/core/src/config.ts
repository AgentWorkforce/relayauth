import fs from "node:fs";
import path from "node:path";

import { parseScope } from "@relayauth/sdk";
import YAML from "yaml";

export interface RelayRole {
  scopes: string[];
}

export interface RelayAgent {
  name: string;
  scopes: string[];
  roles: string[];
}

export type RelayAcl = Record<string, string[]>;

export interface RelayConfig {
  version: "1";
  workspace: string;
  signing_secret: string;
  agents: RelayAgent[];
  acl: RelayAcl;
  roles: Record<string, RelayRole>;
}

function fail(message: string): never {
  throw new Error(message);
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be an object`);
  }

  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(`${label} must be a non-empty string`);
  }

  return value.trim();
}

function asStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) {
    fail(`${label} must be an array of strings`);
  }

  return value.map((entry, index) => asNonEmptyString(entry, `${label}[${index}]`));
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizeScope(scope: string, label: string): string {
  try {
    const parsed = parseScope(scope);
    return parsed.raw === "*"
      ? "*:*:*:*"
      : `${parsed.plane}:${parsed.resource}:${parsed.action}:${parsed.path}`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid scope";
    fail(`${label} is invalid: ${reason}`);
  }
}

function normalizeAclPath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/")) {
    fail(`acl path "${rawPath}" must start with /`);
  }
  if (trimmed.includes("..")) {
    fail(`acl path "${rawPath}" must not contain ..`);
  }

  const normalized = trimmed.replace(/\/+/g, "/");
  return normalized.length > 1 && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function parseRelayConfig(filePath = "relay.yaml"): RelayConfig {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    fail(`relay config not found: ${resolvedPath}`);
  }

  const raw = fs.readFileSync(resolvedPath, "utf8");
  return parseRelayConfigString(raw);
}

export function parseRelayConfigString(raw: string): RelayConfig {
  const parsed = YAML.parse(raw);
  const root = asRecord(parsed, "relay config");

  const version = asNonEmptyString(root.version, "version");
  if (version !== "1") {
    fail(`version must be "1"; received "${version}"`);
  }

  const workspace = asNonEmptyString(root.workspace, "workspace");
  const signing_secret = asNonEmptyString(root.signing_secret, "signing_secret");

  const rolesInput = root.roles ?? {};
  const rolesRecord = asRecord(rolesInput, "roles");
  const roles: Record<string, RelayRole> = {};
  for (const [roleName, roleValue] of Object.entries(rolesRecord)) {
    const role = asRecord(roleValue, `roles.${roleName}`);
    roles[roleName] = {
      scopes: dedupe(
        asStringArray(role.scopes ?? [], `roles.${roleName}.scopes`).map((scope, index) =>
          normalizeScope(scope, `roles.${roleName}.scopes[${index}]`),
        ),
      ),
    };
  }

  if (!Array.isArray(root.agents)) {
    fail("agents must be an array");
  }

  const agents: RelayAgent[] = root.agents.map((agentValue, index) => {
    const agent = asRecord(agentValue, `agents[${index}]`);
    const name = asNonEmptyString(agent.name, `agents[${index}].name`);
    const directScopes = asStringArray(agent.scopes ?? [], `agents[${index}].scopes`).map(
      (scope, scopeIndex) => normalizeScope(scope, `agents[${index}].scopes[${scopeIndex}]`),
    );
    const roleNames = dedupe(asStringArray(agent.roles ?? [], `agents[${index}].roles`));
    const roleScopes = roleNames.flatMap((roleName) => {
      const role = roles[roleName];
      if (!role) {
        fail(`agents[${index}].roles references unknown role "${roleName}"`);
      }
      return role.scopes;
    });

    return {
      name,
      roles: roleNames,
      scopes: dedupe([...directScopes, ...roleScopes]),
    };
  });

  const aclInput = root.acl ?? {};
  const aclRecord = asRecord(aclInput, "acl");
  const acl: RelayAcl = {};
  for (const [rawPath, rulesValue] of Object.entries(aclRecord)) {
    acl[normalizeAclPath(rawPath)] = dedupe(asStringArray(rulesValue, `acl.${rawPath}`));
  }

  return {
    version: "1",
    workspace,
    signing_secret,
    agents,
    acl,
    roles,
  };
}
