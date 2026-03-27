import type { Policy, PolicyCondition, PolicyEffect } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";
import type { AuthStorage, PolicyStorage } from "../storage/index.js";
import { resolvePolicyStorage } from "../storage/index.js";

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

type PolicyStorageSource = D1Database | PolicyStorage | Pick<AuthStorage, "policies">;

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

export async function createPolicy(
  storageSource: PolicyStorageSource,
  input: CreatePolicyInput,
): Promise<Policy> {
  const storage = resolvePolicyStorage(storageSource);
  const orgId = normalizeRequiredString(input.orgId, "orgId is required", "invalid_policy_input");
  const name = validatePolicyName(input.name);
  const effect = validatePolicyEffect(input.effect);
  const scopes = validatePolicyScopes(input.scopes);
  const conditions = validatePolicyConditions(input.conditions);
  const priority = validatePolicyPriority(input.priority);
  const workspaceId = normalizeOptionalString(input.workspaceId);

  const duplicate = await findPolicyByName(storage, orgId, name, workspaceId);
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

  await storage.create(policy);
  return policy;
}

export async function getPolicy(
  storageSource: PolicyStorageSource,
  id: string,
): Promise<Policy | null> {
  const policyId = normalizeOptionalString(id);
  if (!policyId) {
    return null;
  }

  return resolvePolicyStorage(storageSource).get(policyId);
}

export async function listPolicies(
  storageSource: PolicyStorageSource,
  orgId: string,
  workspaceId?: string,
): Promise<Policy[]> {
  const normalizedOrgId = normalizeRequiredString(
    orgId,
    "orgId is required",
    "invalid_policy_input",
  );
  const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
  return resolvePolicyStorage(storageSource).list(normalizedOrgId, normalizedWorkspaceId);
}

export async function updatePolicy(
  storageSource: PolicyStorageSource,
  id: string,
  updates: UpdatePolicyInput,
  existingPolicy?: Policy,
): Promise<Policy> {
  const storage = resolvePolicyStorage(storageSource);
  const policyId = normalizeRequiredString(id, "policyId is required", "invalid_policy_input");
  const current = existingPolicy ?? await getExistingPolicy(storage, policyId);

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
    const duplicate = await findPolicyByName(storage, current.orgId, nextName, current.workspaceId);
    if (duplicate && duplicate.id !== current.id) {
      throw new PolicyEngineError(
        `Policy '${nextName}' already exists in this scope`,
        "policy_name_conflict",
        409,
      );
    }
  }

  return storage.update(current.id, {
    name: nextName,
    effect: nextEffect,
    scopes: nextScopes,
    conditions: nextConditions,
    priority: nextPriority,
  });
}

export async function deletePolicy(
  storageSource: PolicyStorageSource,
  id: string,
  existingPolicy?: Policy,
): Promise<void> {
  const storage = resolvePolicyStorage(storageSource);
  const policy = existingPolicy ?? await getExistingPolicy(
    storage,
    normalizeRequiredString(id, "policyId is required", "invalid_policy_input"),
  );

  await storage.delete(policy.id);
}

export function isPolicyEngineError(error: unknown): error is PolicyEngineError {
  return error instanceof PolicyEngineError;
}

async function getExistingPolicy(storage: PolicyStorage, id: string): Promise<Policy> {
  const policy = await storage.get(id);
  if (!policy) {
    throw new PolicyEngineError("Policy not found", "policy_not_found", 404);
  }

  return policy;
}

async function findPolicyByName(
  storage: PolicyStorage,
  orgId: string,
  name: string,
  workspaceId?: string,
): Promise<Policy | null> {
  const normalizedWorkspaceId = normalizeOptionalString(workspaceId);
  const policies = await storage.list(orgId);
  return policies.find((policy) =>
    policy.name === name
    && (normalizedWorkspaceId === undefined
      ? policy.workspaceId === undefined
      : policy.workspaceId === normalizedWorkspaceId),
  ) ?? null;
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

  return ip.includes(":")
    ? prefix >= 0 && prefix <= 128
    : prefix >= 0 && prefix <= 32;
}

function isValidIpAddress(value: string): boolean {
  return IPV4_PATTERN.test(value) || IPV6_PATTERN.test(value);
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

function createPolicyId(): string {
  return `pol_${crypto.randomUUID().replace(/-/g, "")}`;
}
