import type { Policy, PolicyCondition, PolicyEffect } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";

type PolicyRow = {
  id?: string;
  name?: string;
  effect?: PolicyEffect;
  scopes?: string | string[];
  scopes_json?: string | string[];
  conditions?: string | PolicyCondition[];
  conditions_json?: string | PolicyCondition[];
  priority?: number;
  orgId?: string;
  org_id?: string;
  workspaceId?: string | null;
  workspace_id?: string | null;
  createdAt?: string;
  created_at?: string;
  deletedAt?: string | null;
  deleted_at?: string | null;
};

export type CreatePolicyInput = {
  name: string;
  effect: PolicyEffect;
  scopes: string[];
  conditions: PolicyCondition[];
  priority: number;
  orgId: string;
  workspaceId?: string;
};

export type UpdatePolicyInput = Partial<
  Pick<Policy, "name" | "effect" | "scopes" | "conditions" | "priority">
>;

class PolicyEngineError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "PolicyEngineError";
  }
}

const POLICY_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const POLICY_EFFECTS = new Set<PolicyEffect>(["allow", "deny"]);
const POLICY_CONDITION_TYPES = new Set<PolicyCondition["type"]>([
  "time",
  "ip",
  "identity",
  "workspace",
]);
const POLICY_CONDITION_OPERATORS = new Set<PolicyCondition["operator"]>([
  "eq",
  "neq",
  "in",
  "not_in",
  "gt",
  "lt",
  "matches",
]);
const WEEKDAYS = new Set(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const ISO_8601_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const TIME_OF_DAY_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const IPV4_PATTERN =
  /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?:\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/;
const IPV6_PATTERN = /^[0-9a-f:]+$/i;

const SELECT_POLICY_COLUMNS = `
  SELECT
    id,
    name,
    effect,
    scopes,
    scopes_json,
    conditions,
    conditions_json,
    priority,
    org_id AS orgId,
    workspace_id AS workspaceId,
    created_at AS createdAt,
    deleted_at AS deletedAt
  FROM policies
`;

export async function createPolicy(db: D1Database, input: CreatePolicyInput): Promise<Policy> {
  const orgId = normalizeRequiredString(input.orgId, "orgId is required", "invalid_policy_input");
  const name = validatePolicyName(input.name);
  const effect = validatePolicyEffect(input.effect);
  const scopes = validatePolicyScopes(input.scopes);
  const conditions = validatePolicyConditions(input.conditions);
  const priority = validatePolicyPriority(input.priority);
  const workspaceId = normalizeOptionalString(input.workspaceId);

  const duplicate = await findPolicyByName(db, orgId, name, workspaceId);
  if (duplicate) {
    throw new PolicyEngineError(
      `Policy '${name}' already exists in this scope`,
      "policy_name_conflict",
      409,
    );
  }

  const policy: Policy = {
    id: createPolicyId(),
    name,
    effect,
    scopes,
    conditions,
    priority,
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt: new Date().toISOString(),
  };

  await db
    .prepare(`
      INSERT INTO policies (
        id,
        name,
        effect,
        scopes,
        scopes_json,
        conditions,
        conditions_json,
        priority,
        org_id,
        workspace_id,
        created_at,
        deleted_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      policy.id,
      policy.name,
      policy.effect,
      JSON.stringify(policy.scopes),
      JSON.stringify(policy.scopes),
      JSON.stringify(policy.conditions),
      JSON.stringify(policy.conditions),
      policy.priority,
      policy.orgId,
      policy.workspaceId ?? null,
      policy.createdAt,
      null,
    )
    .run();

  return policy;
}

export async function getPolicy(db: D1Database, id: string): Promise<Policy | null> {
  const policyId = normalizeOptionalString(id);
  if (!policyId) {
    return null;
  }

  const row = await db
    .prepare(`
      ${SELECT_POLICY_COLUMNS}
      WHERE id = ? AND deleted_at IS NULL
      LIMIT 1
    `)
    .bind(policyId)
    .first<PolicyRow>();

  return hydratePolicy(row);
}

export async function listPolicies(
  db: D1Database,
  orgId: string,
  workspaceId?: string,
): Promise<Policy[]> {
  const normalizedOrgId = normalizeRequiredString(
    orgId,
    "orgId is required",
    "invalid_policy_input",
  );
  const normalizedWorkspaceId = normalizeOptionalString(workspaceId);

  const query = normalizedWorkspaceId
    ? {
        sql: `
          ${SELECT_POLICY_COLUMNS}
          WHERE org_id = ?
            AND deleted_at IS NULL
            AND (workspace_id = ? OR workspace_id IS NULL)
          ORDER BY priority DESC, id ASC
        `,
        params: [normalizedOrgId, normalizedWorkspaceId],
      }
    : {
        sql: `
          ${SELECT_POLICY_COLUMNS}
          WHERE org_id = ?
            AND deleted_at IS NULL
          ORDER BY priority DESC, id ASC
        `,
        params: [normalizedOrgId],
      };

  const result = await db.prepare(query.sql).bind(...query.params).all<PolicyRow>();
  return (result.results ?? [])
    .map(hydratePolicy)
    .filter((policy): policy is Policy => policy !== null)
    .filter((policy) =>
      policy.orgId === normalizedOrgId
      && (normalizedWorkspaceId === undefined
        || policy.workspaceId === undefined
        || policy.workspaceId === normalizedWorkspaceId),
    );
}

export async function updatePolicy(
  db: D1Database,
  id: string,
  updates: UpdatePolicyInput,
  existingPolicy?: Policy,
): Promise<Policy> {
  const policyId = normalizeRequiredString(id, "policyId is required", "invalid_policy_input");
  const current = existingPolicy ?? await getExistingPolicy(db, policyId);

  const nextName = updates.name === undefined ? current.name : validatePolicyName(updates.name);
  const nextEffect =
    updates.effect === undefined ? current.effect : validatePolicyEffect(updates.effect);
  const nextScopes =
    updates.scopes === undefined ? current.scopes : validatePolicyScopes(updates.scopes);
  const nextConditions =
    updates.conditions === undefined
      ? current.conditions
      : validatePolicyConditions(updates.conditions);
  const nextPriority =
    updates.priority === undefined ? current.priority : validatePolicyPriority(updates.priority);

  if (nextName !== current.name) {
    const duplicate = await findPolicyByName(db, current.orgId, nextName, current.workspaceId);
    if (duplicate && duplicate.id !== current.id) {
      throw new PolicyEngineError(
        `Policy '${nextName}' already exists in this scope`,
        "policy_name_conflict",
        409,
      );
    }
  }

  await db
    .prepare(`
      UPDATE policies
      SET name = ?, effect = ?, scopes = ?, scopes_json = ?, conditions = ?, conditions_json = ?, priority = ?
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
    `)
    .bind(
      nextName,
      nextEffect,
      JSON.stringify(nextScopes),
      JSON.stringify(nextScopes),
      JSON.stringify(nextConditions),
      JSON.stringify(nextConditions),
      nextPriority,
      current.id,
      current.orgId,
    )
    .run();

  return {
    ...current,
    name: nextName,
    effect: nextEffect,
    scopes: nextScopes,
    conditions: nextConditions,
    priority: nextPriority,
  };
}

export async function deletePolicy(db: D1Database, id: string, existingPolicy?: Policy): Promise<void> {
  const policy = existingPolicy ?? await getExistingPolicy(
    db,
    normalizeRequiredString(id, "policyId is required", "invalid_policy_input"),
  );

  await db
    .prepare(`
      UPDATE policies
      SET deleted_at = ?
      WHERE id = ? AND org_id = ? AND deleted_at IS NULL
    `)
    .bind(new Date().toISOString(), policy.id, policy.orgId)
    .run();
}

export function isPolicyEngineError(error: unknown): error is PolicyEngineError {
  return error instanceof PolicyEngineError;
}

async function getExistingPolicy(db: D1Database, id: string): Promise<Policy> {
  const policy = await getPolicy(db, id);
  if (!policy) {
    throw new PolicyEngineError("Policy not found", "policy_not_found", 404);
  }

  return policy;
}

async function findPolicyByName(
  db: D1Database,
  orgId: string,
  name: string,
  workspaceId?: string,
): Promise<Policy | null> {
  const result = await db
    .prepare(`
      ${SELECT_POLICY_COLUMNS}
      WHERE org_id = ? AND name = ? AND deleted_at IS NULL
      ORDER BY id ASC
    `)
    .bind(orgId, name)
    .all<PolicyRow>();

  const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
  return (result.results ?? [])
    .map(hydratePolicy)
    .filter((policy): policy is Policy => policy !== null)
    .find((policy) =>
      normalizedWorkspaceId === undefined
        ? policy.workspaceId === undefined
        : policy.workspaceId === normalizedWorkspaceId,
    ) ?? null;
}

function hydratePolicy(row: PolicyRow | null): Policy | null {
  if (!row) {
    return null;
  }

  const id = normalizeOptionalString(row.id);
  const name = normalizeOptionalString(row.name);
  const effect = row.effect;
  const orgId = normalizeOptionalString(row.orgId) ?? normalizeOptionalString(row.org_id);
  const createdAt = normalizeOptionalString(row.createdAt) ?? normalizeOptionalString(row.created_at);
  const deletedAt = normalizeOptionalString(row.deletedAt) ?? normalizeOptionalString(row.deleted_at);

  if (!id || !name || !effect || !orgId || !createdAt || deletedAt) {
    return null;
  }

  const scopes = parseStringArrayColumn(row.scopes_json ?? row.scopes);
  const conditions = parseConditionsColumn(row.conditions_json ?? row.conditions);
  const workspaceId = normalizeOptionalString(row.workspaceId) ?? normalizeOptionalString(row.workspace_id);
  const priority = typeof row.priority === "number" ? row.priority : Number(row.priority);

  if (!POLICY_EFFECTS.has(effect) || !Number.isInteger(priority)) {
    return null;
  }

  return {
    id,
    name,
    effect,
    scopes,
    conditions,
    priority,
    orgId,
    ...(workspaceId ? { workspaceId } : {}),
    createdAt,
  };
}

function validatePolicyName(raw: string): string {
  const name = normalizeRequiredString(raw, "name is required", "invalid_policy_input");

  if (name.length < 3 || name.length > 64) {
    throw new PolicyEngineError(
      "policy name must be between 3 and 64 characters",
      "invalid_policy_input",
      400,
    );
  }

  if (!POLICY_NAME_PATTERN.test(name)) {
    throw new PolicyEngineError("policy name must be kebab-case", "invalid_policy_input", 400);
  }

  return name;
}

function validatePolicyEffect(value: PolicyEffect): PolicyEffect {
  if (!POLICY_EFFECTS.has(value)) {
    throw new PolicyEngineError(
      "policy effect must be allow or deny",
      "invalid_policy_input",
      400,
    );
  }

  return value;
}

function validatePolicyScopes(value: string[]): string[] {
  if (!Array.isArray(value)) {
    throw new PolicyEngineError("scopes must be a non-empty array", "invalid_policy_input", 400);
  }

  const scopes = Array.from(
    new Set(
      value
        .filter((scope): scope is string => typeof scope === "string")
        .map((scope) => scope.trim())
        .filter(Boolean),
    ),
  );

  if (scopes.length === 0) {
    throw new PolicyEngineError("scopes must be a non-empty array", "invalid_policy_input", 400);
  }

  for (const scope of scopes) {
    try {
      parseScope(scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : "invalid scope";
      throw new PolicyEngineError(message, "invalid_scope", 400);
    }
  }

  return scopes;
}

function validatePolicyConditions(value: PolicyCondition[]): PolicyCondition[] {
  if (!Array.isArray(value)) {
    throw new PolicyEngineError("conditions must be an array", "invalid_policy_input", 400);
  }

  return value.map((condition) => validatePolicyCondition(condition));
}

function validatePolicyCondition(value: PolicyCondition): PolicyCondition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyEngineError("invalid policy condition", "invalid_policy_input", 400);
  }

  const type = value.type;
  const operator = value.operator;
  if (!POLICY_CONDITION_TYPES.has(type)) {
    throw new PolicyEngineError("invalid policy condition type", "invalid_policy_input", 400);
  }

  if (!POLICY_CONDITION_OPERATORS.has(operator)) {
    throw new PolicyEngineError("invalid policy condition operator", "invalid_policy_input", 400);
  }

  const normalizedValue =
    typeof value.value === "string"
      ? value.value.trim()
      : Array.isArray(value.value)
        ? value.value
            .filter((entry): entry is string => typeof entry === "string")
            .map((entry) => entry.trim())
            .filter(Boolean)
        : null;

  if (normalizedValue === null) {
    throw new PolicyEngineError("invalid policy condition value", "invalid_policy_input", 400);
  }

  validateConditionValue(type, operator, normalizedValue);

  return {
    type,
    operator,
    value: normalizedValue,
  };
}

function validateConditionValue(
  type: PolicyCondition["type"],
  operator: PolicyCondition["operator"],
  value: string | string[],
): void {
  switch (type) {
    case "time":
      validateTimeCondition(operator, value);
      return;
    case "ip":
      validateIpCondition(operator, value);
      return;
    case "identity":
    case "workspace":
      validateStringMatchCondition(type, operator, value);
      return;
    default:
      throw new PolicyEngineError("invalid policy condition type", "invalid_policy_input", 400);
  }
}

function validateTimeCondition(
  operator: PolicyCondition["operator"],
  value: string | string[],
): void {
  if (operator === "matches") {
    if (typeof value !== "string" || value.length === 0) {
      throw new PolicyEngineError("time matches conditions require a string value", "invalid_policy_input", 400);
    }
    return;
  }

  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value) || value.length === 0 || !value.every((entry) => WEEKDAYS.has(entry))) {
      throw new PolicyEngineError(
        "time in/not_in conditions require weekday arrays",
        "invalid_policy_input",
        400,
      );
    }
    return;
  }

  if (!["eq", "neq", "gt", "lt"].includes(operator)) {
    throw new PolicyEngineError("unsupported time condition operator", "invalid_policy_input", 400);
  }

  if (typeof value !== "string" || !isValidTimeValue(value)) {
    throw new PolicyEngineError(
      "time conditions require an ISO 8601 UTC timestamp or HH:MM value",
      "invalid_policy_input",
      400,
    );
  }
}

function validateIpCondition(
  operator: PolicyCondition["operator"],
  value: string | string[],
): void {
  if (operator === "gt" || operator === "lt") {
    throw new PolicyEngineError("unsupported ip condition operator", "invalid_policy_input", 400);
  }

  if (operator === "in" || operator === "not_in") {
    const values = Array.isArray(value) ? value : [value];
    if (values.length === 0 || !values.every((entry) => isValidIpOrCidr(entry))) {
      throw new PolicyEngineError("ip in/not_in conditions require IP or CIDR values", "invalid_policy_input", 400);
    }
    return;
  }

  if (typeof value !== "string" || !isValidIpOrCidr(value)) {
    throw new PolicyEngineError("ip conditions require an IP or CIDR string", "invalid_policy_input", 400);
  }
}

function validateStringMatchCondition(
  type: "identity" | "workspace",
  operator: PolicyCondition["operator"],
  value: string | string[],
): void {
  if (operator === "gt" || operator === "lt") {
    throw new PolicyEngineError(
      `unsupported ${type} condition operator`,
      "invalid_policy_input",
      400,
    );
  }

  if (operator === "in" || operator === "not_in") {
    if (!Array.isArray(value) || value.length === 0) {
      throw new PolicyEngineError(
        `${type} in/not_in conditions require a non-empty string array`,
        "invalid_policy_input",
        400,
      );
    }
    return;
  }

  if (typeof value !== "string" || value.length === 0) {
    throw new PolicyEngineError(
      `${type} conditions require a non-empty string value`,
      "invalid_policy_input",
      400,
    );
  }
}

function validatePolicyPriority(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 1000) {
    throw new PolicyEngineError(
      "priority must be an integer between 0 and 1000",
      "invalid_policy_input",
      400,
    );
  }

  return value;
}

function isValidTimeValue(value: string): boolean {
  if (TIME_OF_DAY_PATTERN.test(value)) {
    return true;
  }

  return ISO_8601_UTC_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function isValidIpOrCidr(value: string): boolean {
  const [ip, rawPrefix] = value.split("/", 2);
  if (!ip || !isValidIpAddress(ip)) {
    return false;
  }

  if (rawPrefix === undefined) {
    return true;
  }

  const prefix = Number(rawPrefix);
  if (!Number.isInteger(prefix)) {
    return false;
  }

  return ip.includes(":") ? prefix >= 0 && prefix <= 128 : prefix >= 0 && prefix <= 32;
}

function isValidIpAddress(value: string): boolean {
  if (IPV4_PATTERN.test(value)) {
    return true;
  }

  if (!value.includes(":") || !IPV6_PATTERN.test(value)) {
    return false;
  }

  // Reject multiple :: groups (e.g. ::1::2)
  const doubleColonCount = value.split("::").length - 1;
  if (doubleColonCount > 1) {
    return false;
  }

  const parts = value.split(":");
  if (parts.length < 3 || parts.length > 8) {
    return false;
  }

  // Without ::, must have exactly 8 groups
  if (doubleColonCount === 0 && parts.length !== 8) {
    return false;
  }

  for (const part of parts) {
    if (part.length === 0) {
      continue;
    }

    if (part.length > 4 || !/^[0-9a-f]{1,4}$/i.test(part)) {
      return false;
    }
  }

  return true;
}

function normalizeRequiredString(value: unknown, message: string, code: string): string {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    throw new PolicyEngineError(message, code, 400);
  }

  return normalized;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function parseStringArrayColumn(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseConditionsColumn(value: unknown): PolicyCondition[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is PolicyCondition => typeof entry === "object" && entry !== null)
      .map((entry) => ({ ...entry }));
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed)
      ? parsed
          .filter((entry): entry is PolicyCondition => typeof entry === "object" && entry !== null)
          .map((entry) => ({ ...entry }))
      : [];
  } catch {
    return [];
  }
}

function createPolicyId(): string {
  return `pol_${crypto.randomUUID().replace(/-/g, "")}`;
}
