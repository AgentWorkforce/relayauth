import type { Action, Policy, PolicyCondition } from "@relayauth/types";
import { parseScope } from "@relayauth/sdk";

import { writeAuditEntry } from "./audit-logger.js";
import { listPolicies } from "./policies.js";
import { listIdentityRoles } from "./role-assignments.js";
import type {
  IdentityBudget,
  IdentityBudgetUsage,
  StoredIdentity,
} from "../durable-objects/identity-do.js";
import type { AuthStorage } from "../storage/index.js";
import { resolveAuthStorage } from "../storage/index.js";

type EvaluationContext = {
  identityId?: string;
  ip?: string;
  timestamp?: string;
  workspaceId?: string;
};

type PolicyApplication = {
  id: string;
  effect: Policy["effect"];
  priority: number;
  scopes: string[];
  workspaceId?: string;
};

export type EvaluationResult = {
  effectiveScopes: string[];
  appliedPolicies: PolicyApplication[];
  deniedScopes: string[];
};

export type AccessDecision = {
  allowed: boolean;
  reason: string;
  matchedPolicy?: string;
};

type ScopeDecision = {
  effect: Policy["effect"];
  policies: Policy[];
};

type PolicyEvaluationStorageSource = D1Database | AuthStorage;

const WEEKDAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const MANAGE_IMPLIES = new Set<Action>(["read", "write", "create", "delete"]);

export async function evaluatePermissions(
  storageSource: PolicyEvaluationStorageSource,
  identityId: string,
  orgId: string,
  context: EvaluationContext = {},
): Promise<EvaluationResult> {
  const storage = resolveAuthStorage(storageSource);
  const identity = await getIdentity(storage, identityId, orgId);
  if (!identity || identity.orgId !== orgId || identity.status !== "active") {
    return {
      effectiveScopes: [],
      appliedPolicies: [],
      deniedScopes: [],
    };
  }

  const evaluationContext = createEvaluationContext(identity, context);
  const [roles, policies] = await Promise.all([
    listIdentityRoles(storage, identity.id),
    listPolicies(storage, identity.orgId, evaluationContext.workspaceId),
  ]);

  return evaluatePermissionsWithData(identity, roles, policies, evaluationContext);
}

function evaluatePermissionsWithData(
  identity: StoredIdentity,
  roles: { scopes: string[] }[],
  policies: Policy[],
  context: EvaluationContext,
): EvaluationResult {
  const roleScopes = roles.flatMap((role) => role.scopes);
  const mergedScopes = mergeScopes(identity.scopes, roleScopes);

  const applicablePolicies = policies.filter((policy) =>
    policy.conditions.every((condition) => evaluateCondition(condition, context)),
  );

  const outcome = applyPoliciesDetailed(mergedScopes, applicablePolicies);

  return {
    effectiveScopes: outcome.effectiveScopes,
    appliedPolicies: outcome.appliedPolicies,
    deniedScopes: outcome.deniedScopes,
  };
}

export async function getEffectiveScopes(
  storageSource: PolicyEvaluationStorageSource,
  identityId: string,
  orgId: string,
  context: EvaluationContext = {},
): Promise<string[]> {
  const result = await evaluatePermissions(storageSource, identityId, orgId, context);
  return result.effectiveScopes;
}

export async function checkAccess(
  storageSource: PolicyEvaluationStorageSource,
  identityId: string,
  orgId: string,
  requestedScope: string,
  context: EvaluationContext = {},
): Promise<AccessDecision> {
  const storage = resolveAuthStorage(storageSource);
  const identity = await getIdentity(storage, identityId, orgId);
  if (!identity) {
    return { allowed: false, reason: "identity_not_found" };
  }

  if (identity.orgId !== orgId) {
    return { allowed: false, reason: "org_mismatch" };
  }

  if (identity.status !== "active") {
    return { allowed: false, reason: `identity_${identity.status}` };
  }

  const evaluationContext = createEvaluationContext(identity, context);
  const budgetState = evaluateBudgetState(identity.budget, identity.budgetUsage);

  if (budgetState === "exceeded") {
    await writeBudgetAudit(storage, identity, requestedScope, "budget.exceeded", "denied");
    return {
      allowed: false,
      reason: "budget_exceeded",
    };
  }

  if (budgetState === "alert") {
    await writeBudgetAudit(storage, identity, requestedScope, "budget.alert", "allowed");
  }

  const [roles, policies] = await Promise.all([
    listIdentityRoles(storage, identity.id),
    listPolicies(storage, identity.orgId, evaluationContext.workspaceId),
  ]);

  const result = evaluatePermissionsWithData(identity, roles, policies, evaluationContext);
  const matchingDecision = resolveRequestPolicyDecisionFromPolicies(
    policies,
    requestedScope,
    evaluationContext,
  );

  if (matchingDecision?.effect === "deny") {
    return {
      allowed: false,
      reason: "policy_denied",
      matchedPolicy: matchingDecision.policies[0]?.id,
    };
  }

  if (scopeMatchesAny(requestedScope, result.effectiveScopes)) {
    return {
      allowed: true,
      reason: "scope_allowed",
    };
  }

  return {
    allowed: false,
    reason: "implicit_deny",
  };
}

function mergeScopes(directScopes: string[], roleScopes: string[]): string[] {
  return dedupeScopes([...directScopes, ...roleScopes]);
}

function applyPolicies(
  scopes: string[],
  policies: Policy[],
  context: EvaluationContext,
): string[] {
  const applicablePolicies = policies.filter((policy) =>
    policy.conditions.every((condition) => evaluateCondition(condition, context)),
  );
  return applyPoliciesDetailed(scopes, applicablePolicies).effectiveScopes;
}

function evaluateCondition(condition: PolicyCondition, context: EvaluationContext): boolean {
  switch (condition.type) {
    case "time":
      return evaluateTimeCondition(condition, context.timestamp);
    case "ip":
      return evaluateIpCondition(condition, context.ip);
    case "identity":
      return evaluateStringCondition(condition, context.identityId);
    case "workspace":
      return evaluateStringCondition(condition, context.workspaceId);
    default:
      return false;
  }
}

function applyPoliciesDetailed(
  scopes: string[],
  policies: Policy[],
): EvaluationResult {
  const dedupedScopes = dedupeScopes(scopes);
  const candidateScopes = dedupeScopes([
    ...dedupedScopes,
    ...policies.flatMap((policy) => policy.scopes),
  ]);

  const appliedPolicies = new Map<string, PolicyApplication>();
  const deniedScopes = new Set<string>();
  const effectiveScopes: string[] = [];

  for (const scope of candidateScopes) {
    const decision = resolveScopeDecision(scope, policies);
    if (decision) {
      for (const policy of decision.policies) {
        appliedPolicies.set(policy.id, toPolicyApplication(policy));
      }

      if (decision.effect === "allow") {
        effectiveScopes.push(scope);
        continue;
      }

      deniedScopes.add(scope);
      continue;
    }

    if (dedupedScopes.includes(scope)) {
      effectiveScopes.push(scope);
    }
  }

  return {
    effectiveScopes: dedupeScopes(effectiveScopes),
    appliedPolicies: [...appliedPolicies.values()].sort((left, right) =>
      right.priority - left.priority || left.id.localeCompare(right.id),
    ),
    deniedScopes: [...deniedScopes].sort((left, right) => left.localeCompare(right)),
  };
}

function resolveScopeDecision(scope: string, policies: Policy[]): ScopeDecision | null {
  const overlappingPolicies = policies
    .filter((policy) => policy.scopes.some((policyScope) => scopesOverlap(scope, policyScope)))
    .sort(comparePolicies);

  if (overlappingPolicies.length === 0) {
    return null;
  }

  const highestPriority = overlappingPolicies[0].priority;
  const highestPolicies = overlappingPolicies.filter((policy) => policy.priority === highestPriority);
  const denyPolicies = highestPolicies.filter((policy) => policy.effect === "deny");

  if (denyPolicies.length > 0) {
    return {
      effect: "deny",
      policies: denyPolicies.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  return {
    effect: "allow",
    policies: highestPolicies.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

async function resolveRequestPolicyDecision(
  storageSource: PolicyEvaluationStorageSource,
  identity: StoredIdentity,
  requestedScope: string,
  context: EvaluationContext,
): Promise<ScopeDecision | null> {
  const storage = resolveAuthStorage(storageSource);
  const policies = await listPolicies(storage, identity.orgId, context.workspaceId);
  return resolveRequestPolicyDecisionFromPolicies(policies, requestedScope, context);
}

function resolveRequestPolicyDecisionFromPolicies(
  policies: Policy[],
  requestedScope: string,
  context: EvaluationContext,
): ScopeDecision | null {
  const applicablePolicies = policies.filter((policy) =>
    policy.scopes.some((scope) => scopeMatches(requestedScope, scope))
    && policy.conditions.every((condition) => evaluateCondition(condition, context)),
  );

  return resolveRequestedScopeDecision(applicablePolicies);
}

function resolveRequestedScopeDecision(policies: Policy[]): ScopeDecision | null {
  if (policies.length === 0) {
    return null;
  }

  const ordered = [...policies].sort(comparePolicies);
  const highestPriority = ordered[0].priority;
  const highestPolicies = ordered.filter((policy) => policy.priority === highestPriority);
  const denyPolicies = highestPolicies.filter((policy) => policy.effect === "deny");

  if (denyPolicies.length > 0) {
    return {
      effect: "deny",
      policies: denyPolicies.sort((left, right) => left.id.localeCompare(right.id)),
    };
  }

  return {
    effect: "allow",
    policies: highestPolicies.sort((left, right) => left.id.localeCompare(right.id)),
  };
}

function comparePolicies(left: Policy, right: Policy): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  // Deny-wins: sort deny before allow at equal priority
  if (left.effect !== right.effect) {
    return left.effect === "deny" ? -1 : 1;
  }

  return left.id.localeCompare(right.id);
}

function scopesOverlap(left: string, right: string): boolean {
  try {
    return scopeMatches(left, right) || scopeMatches(right, left);
  } catch {
    return left === right;
  }
}

async function getIdentity(
  storage: AuthStorage,
  identityId: string,
  orgId: string,
): Promise<StoredIdentity | null> {
  const identity = await storage.identities.get(identityId.trim());
  return identity && identity.orgId === orgId.trim() ? identity : null;
}

function createEvaluationContext(
  identity: StoredIdentity,
  context: EvaluationContext,
): EvaluationContext {
  return {
    identityId: context.identityId ?? identity.id,
    ip: normalizeOptionalString(context.ip),
    timestamp: normalizeOptionalString(context.timestamp) ?? new Date().toISOString(),
    workspaceId: context.workspaceId ?? identity.workspaceId,
  };
}

function evaluateTimeCondition(condition: PolicyCondition, rawTimestamp: string | undefined): boolean {
  if (!rawTimestamp) {
    return false;
  }

  const timestamp = new Date(rawTimestamp);
  if (Number.isNaN(timestamp.getTime())) {
    return false;
  }

  const value = condition.value;
  switch (condition.operator) {
    case "eq":
    case "neq":
    case "gt":
    case "lt":
      if (typeof value !== "string") {
        return false;
      }
      return compareTemporalValue(condition.operator, timestamp, value);
    case "in":
    case "not_in":
      if (!Array.isArray(value)) {
        return false;
      }
      return compareWeekdaySet(condition.operator, timestamp, value);
    case "matches":
      return typeof value === "string" && safeRegexTest(value, rawTimestamp);
    default:
      return false;
  }
}

function compareTemporalValue(
  operator: Extract<PolicyCondition["operator"], "eq" | "neq" | "gt" | "lt">,
  timestamp: Date,
  value: string,
): boolean {
  const current = isTimeOfDay(value)
    ? `${padTime(timestamp.getUTCHours())}:${padTime(timestamp.getUTCMinutes())}`
    : timestamp.toISOString();
  const target = value;

  switch (operator) {
    case "eq":
      return current === target;
    case "neq":
      return current !== target;
    case "gt":
      return current > target;
    case "lt":
      return current < target;
  }
}

function compareWeekdaySet(
  operator: Extract<PolicyCondition["operator"], "in" | "not_in">,
  timestamp: Date,
  values: string[],
): boolean {
  const weekday = WEEKDAY_NAMES[timestamp.getUTCDay()];
  const matched = values.includes(weekday);
  return operator === "in" ? matched : !matched;
}

function evaluateIpCondition(condition: PolicyCondition, ip: string | undefined): boolean {
  if (!ip) {
    return false;
  }

  const value = condition.value;
  switch (condition.operator) {
    case "eq":
      return typeof value === "string" && ip === value;
    case "neq":
      return typeof value === "string" && ip !== value;
    case "in":
      return Array.isArray(value) && value.some((entry) => ipMatches(ip, entry));
    case "not_in":
      return Array.isArray(value) && value.every((entry) => !ipMatches(ip, entry));
    case "matches":
      return typeof value === "string" && safeRegexTest(value, ip);
    default:
      return false;
  }
}

function ipMatches(ip: string, candidate: string): boolean {
  if (!candidate.includes("/")) {
    return ip === candidate;
  }

  const [network, prefixText] = candidate.split("/", 2);
  const prefix = Number(prefixText);
  if (!Number.isInteger(prefix)) {
    return false;
  }

  if (ip.includes(":") || network.includes(":")) {
    return matchIpv6Cidr(ip, network, prefix);
  }

  return matchIpv4Cidr(ip, network, prefix);
}

function matchIpv4Cidr(ip: string, network: string, prefix: number): boolean {
  const ipValue = ipv4ToNumber(ip);
  const networkValue = ipv4ToNumber(network);
  if (ipValue === null || networkValue === null || prefix < 0 || prefix > 32) {
    return false;
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipValue & mask) === (networkValue & mask);
}

function matchIpv6Cidr(ip: string, network: string, prefix: number): boolean {
  const ipBytes = ipv6ToBytes(ip);
  const networkBytes = ipv6ToBytes(network);
  if (!ipBytes || !networkBytes || prefix < 0 || prefix > 128) {
    return false;
  }

  let remaining = prefix;
  for (let index = 0; index < 16; index += 1) {
    if (remaining <= 0) {
      return true;
    }

    const bits = Math.min(remaining, 8);
    const mask = bits === 8 ? 0xff : ((0xff << (8 - bits)) & 0xff);
    if ((ipBytes[index] & mask) !== (networkBytes[index] & mask)) {
      return false;
    }
    remaining -= bits;
  }

  return true;
}

function evaluateStringCondition(
  condition: PolicyCondition,
  actual: string | undefined,
): boolean {
  if (!actual) {
    return false;
  }

  const value = condition.value;
  switch (condition.operator) {
    case "eq":
      return typeof value === "string" && actual === value;
    case "neq":
      return typeof value === "string" && actual !== value;
    case "in":
      return Array.isArray(value) && value.includes(actual);
    case "not_in":
      return Array.isArray(value) && !value.includes(actual);
    case "matches":
      return typeof value === "string" && safeRegexTest(value, actual);
    default:
      return false;
  }
}

function evaluateBudgetState(
  budget: IdentityBudget | undefined,
  usage: IdentityBudgetUsage | undefined,
): "ok" | "alert" | "exceeded" {
  if (!budget || !usage) {
    return "ok";
  }

  const percentages: number[] = [];

  if (typeof budget.maxActionsPerHour === "number" && budget.maxActionsPerHour > 0) {
    const ratio = usage.actionsThisHour / budget.maxActionsPerHour;
    if (ratio > 1) {
      return "exceeded";
    }
    percentages.push(ratio);
  }

  if (typeof budget.maxCostPerDay === "number" && budget.maxCostPerDay > 0) {
    const ratio = usage.costToday / budget.maxCostPerDay;
    if (ratio > 1) {
      return "exceeded";
    }
    percentages.push(ratio);
  }

  const threshold = typeof budget.alertThreshold === "number" ? budget.alertThreshold : undefined;
  if (threshold !== undefined && percentages.some((value) => value >= threshold)) {
    return "alert";
  }

  return "ok";
}

async function writeBudgetAudit(
  storage: AuthStorage,
  identity: StoredIdentity,
  requestedScope: string,
  action: "budget.exceeded" | "budget.alert",
  result: "allowed" | "denied",
): Promise<void> {
  await writeAuditEntry(storage, {
    action,
    identityId: identity.id,
    orgId: identity.orgId,
    workspaceId: identity.workspaceId,
    plane: parseScopePlane(requestedScope),
    resource: requestedScope,
    result,
    metadata: {
      sponsorId: identity.sponsorId,
      sponsorChain: JSON.stringify(identity.sponsorChain),
      budgetConfig: JSON.stringify(identity.budget ?? {}),
      actualUsage: JSON.stringify(identity.budgetUsage ?? {}),
      actionAttempted: requestedScope,
    },
  });
}

function parseScopePlane(scope: string): string | undefined {
  try {
    return parseScope(scope).plane;
  } catch {
    return undefined;
  }
}

function scopeMatchesAny(requested: string, granted: string[]): boolean {
  return granted.some((scope) => scopeMatches(requested, scope));
}

function scopeMatches(requested: string, granted: string): boolean {
  const parsedRequested = parseScope(requested);
  const parsedGranted = parseScope(granted);

  if (parsedGranted.plane !== "*" && parsedGranted.plane !== parsedRequested.plane) {
    return false;
  }

  if (parsedGranted.resource !== "*" && parsedGranted.resource !== parsedRequested.resource) {
    return false;
  }

  if (!actionMatches(parsedRequested.action, parsedGranted.action)) {
    return false;
  }

  return pathMatches(parsedRequested.path, parsedGranted.path, parsedRequested.plane, parsedRequested.resource);
}

function actionMatches(requested: Action, granted: Action): boolean {
  if (granted === "*" || granted === requested) {
    return true;
  }

  return granted === "manage" && MANAGE_IMPLIES.has(requested);
}

function pathMatches(
  requestedPath: string,
  grantedPath: string,
  plane: string,
  resource: string,
): boolean {
  if (grantedPath === "*" || grantedPath === requestedPath) {
    return true;
  }

  if (plane === "relayfile" && resource === "fs" && grantedPath.endsWith("/*")) {
    const prefix = grantedPath.slice(0, -1);
    return requestedPath.startsWith(prefix);
  }

  if (!grantedPath.includes("*")) {
    return false;
  }

  // Use non-regex wildcard matching to avoid ReDoS with multiple wildcards
  const segments = grantedPath.split("*");
  let pos = 0;

  // First segment must match at the start
  if (!requestedPath.startsWith(segments[0])) {
    return false;
  }
  pos = segments[0].length;

  // Middle segments must appear in order
  for (let i = 1; i < segments.length - 1; i++) {
    const idx = requestedPath.indexOf(segments[i], pos);
    if (idx === -1) {
      return false;
    }
    pos = idx + segments[i].length;
  }

  // Last segment must match at the end
  const last = segments[segments.length - 1];
  if (!requestedPath.endsWith(last) || requestedPath.length - last.length < pos) {
    return false;
  }

  return true;
}

function dedupeScopes(scopes: string[]): string[] {
  return Array.from(
    new Set(
      scopes
        .filter((scope): scope is string => typeof scope === "string")
        .map((scope) => scope.trim())
        .filter((scope) => scope.length > 0),
    ),
  );
}

function toPolicyApplication(policy: Policy): PolicyApplication {
  return {
    id: policy.id,
    effect: policy.effect,
    priority: policy.priority,
    scopes: [...policy.scopes],
    ...(policy.workspaceId ? { workspaceId: policy.workspaceId } : {}),
  };
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

function parseRecordColumn(value: unknown): Record<string, string> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return Object.fromEntries(
      Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return {};
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

function parseBudgetColumn(value: unknown): IdentityBudget | undefined {
  const parsed = parseObjectColumn(value);
  if (!parsed) {
    return undefined;
  }

  const budget: IdentityBudget = {};
  if (typeof parsed.maxActionsPerHour === "number") {
    budget.maxActionsPerHour = parsed.maxActionsPerHour;
  }
  if (typeof parsed.maxCostPerDay === "number") {
    budget.maxCostPerDay = parsed.maxCostPerDay;
  }
  if (typeof parsed.alertThreshold === "number") {
    budget.alertThreshold = parsed.alertThreshold;
  }
  if (typeof parsed.autoSuspend === "boolean") {
    budget.autoSuspend = parsed.autoSuspend;
  }

  return Object.keys(budget).length > 0 ? budget : undefined;
}

function parseBudgetUsageColumn(value: unknown): IdentityBudgetUsage | undefined {
  const parsed = parseObjectColumn(value);
  if (!parsed) {
    return undefined;
  }

  if (
    typeof parsed.actionsThisHour !== "number"
    || typeof parsed.costToday !== "number"
    || typeof parsed.lastResetAt !== "string"
  ) {
    return undefined;
  }

  return {
    actionsThisHour: parsed.actionsThisHour,
    costToday: parsed.costToday,
    lastResetAt: parsed.lastResetAt,
  };
}

function parseObjectColumn(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  if (typeof value !== "string" || value.trim().length === 0) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function isTimeOfDay(value: string): boolean {
  return /^\d{2}:\d{2}$/.test(value);
}

function padTime(value: number): string {
  return String(value).padStart(2, "0");
}

const MAX_REGEX_PATTERN_LENGTH = 128;
const MAX_REGEX_INPUT_LENGTH = 1024;

// Reject patterns with nested quantifiers (e.g. (a+)+, (a|a)*, (\w+){2,})
// and other catastrophic backtracking constructs
const DANGEROUS_REGEX_PATTERNS = [
  /\+\+|\*\+|\+\*|\*\*/,                           // adjacent quantifiers
  /\{\d+,\}\+|\{\d+,\}\*/,                         // {n,} followed by quantifier
  /\([^)]*[+*][^)]*\)[+*{]/,                       // quantified group containing quantifier
  /\([^)]*\|[^)]*\)[+*{]/,                         // quantified group containing alternation
  /(\.\*){2,}/,                                     // repeated .* sequences
  /\\[bBdDwWsS][+*]\)[+*{]/,                       // quantified group with quantified char class
];

function safeRegexTest(pattern: string, input: string): boolean {
  if (pattern.length > MAX_REGEX_PATTERN_LENGTH) {
    return false;
  }

  if (input.length > MAX_REGEX_INPUT_LENGTH) {
    return false;
  }

  if (DANGEROUS_REGEX_PATTERNS.some((dangerous) => dangerous.test(pattern))) {
    return false;
  }

  try {
    return new RegExp(pattern).test(input);
  } catch {
    return false;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function ipv4ToNumber(value: string): number | null {
  const parts = value.split(".");
  if (parts.length !== 4) {
    return null;
  }

  let result = 0;
  for (const part of parts) {
    const number = Number(part);
    if (!Number.isInteger(number) || number < 0 || number > 255) {
      return null;
    }
    result = (result << 8) + number;
  }

  return result >>> 0;
}

function ipv6ToBytes(value: string): Uint8Array | null {
  const [head, tail] = value.split("::");
  const headParts = head ? head.split(":").filter(Boolean) : [];
  const tailParts = tail ? tail.split(":").filter(Boolean) : [];

  if (value.includes("::")) {
    const missing = 8 - (headParts.length + tailParts.length);
    if (missing < 0) {
      return null;
    }
    const full = [...headParts, ...new Array(missing).fill("0"), ...tailParts];
    return hextetsToBytes(full);
  }

  const full = value.split(":");
  return full.length === 8 ? hextetsToBytes(full) : null;
}

function hextetsToBytes(parts: string[]): Uint8Array | null {
  if (parts.length !== 8) {
    return null;
  }

  const bytes = new Uint8Array(16);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!/^[0-9a-f]{1,4}$/i.test(part)) {
      return null;
    }
    const value = Number.parseInt(part, 16);
    bytes[index * 2] = (value >> 8) & 0xff;
    bytes[index * 2 + 1] = value & 0xff;
  }
  return bytes;
}

export { applyPolicies, evaluateCondition, mergeScopes, scopeMatches, actionMatches, pathMatches, escapeRegExp };
