import type { Policy, PolicyCondition, PolicyEffect } from "@relayauth/types";
import { matchScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  createPolicy,
  deletePolicy,
  getPolicy,
  isPolicyEngineError,
  listPolicies,
  updatePolicy,
} from "../engine/policies.js";
import { authenticateAndAuthorize } from "../lib/auth.js";

type CreatePolicyRequest = {
  name?: string;
  effect?: PolicyEffect;
  scopes?: string[];
  conditions?: PolicyCondition[];
  priority?: number;
  workspaceId?: string;
};

type UpdatePolicyRequest = Partial<
  Pick<Policy, "name" | "effect" | "scopes" | "conditions" | "priority">
>;

const policies = new Hono<AppEnv>();

policies.post("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env,
    "relayauth:policy:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const body = await parseJsonObjectBody<CreatePolicyRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const policy = await createPolicy(c.get("storage"), {
      name: body.name ?? "",
      effect: (body.effect ?? "") as PolicyEffect,
      scopes: Array.isArray(body.scopes) ? body.scopes : [],
      conditions: Array.isArray(body.conditions) ? body.conditions : [],
      priority: typeof body.priority === "number" ? body.priority : Number.NaN,
      orgId: auth.claims.org,
      ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
    });

    return c.json(policy, 201);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.get("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env,
    "relayauth:policy:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const workspaceId = normalizeOptionalString(c.req.query("workspaceId"));
  const effect = normalizePolicyEffect(c.req.query("effect"));

  try {
    const data = await listPolicies(c.get("storage"), auth.claims.org, workspaceId);
    return c.json(
      {
        data: effect ? data.filter((policy) => policy.effect === effect) : data,
      },
      200,
    );
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.get("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env,
    "relayauth:policy:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const policy = await getPolicy(c.get("storage"), id);
    if (!policy || policy.orgId !== auth.claims.org) {
      return c.json({ error: "policy_not_found" }, 404);
    }

    return c.json(policy, 200);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.patch("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env,
    "relayauth:policy:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();
  const body = await parseJsonObjectBody<UpdatePolicyRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates = sanitizePolicyUpdate(body);
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const existing = await getPolicy(c.get("storage"), id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "policy_not_found" }, 404);
    }

    const policy = await updatePolicy(c.get("storage"), id, updates, existing);
    return c.json(policy, 200);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

policies.delete("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env,
    "relayauth:policy:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const existing = await getPolicy(c.get("storage"), id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "policy_not_found" }, 404);
    }

    await deletePolicy(c.get("storage"), id, existing);
    return c.body(null, 204);
  } catch (error) {
    return handlePolicyError(c, error);
  }
});

export default policies;

function sanitizePolicyUpdate(body: UpdatePolicyRequest): UpdatePolicyRequest {
  const updates: UpdatePolicyRequest = {};

  if (typeof body.name === "string") {
    updates.name = body.name.trim();
  }

  if (body.effect === "allow" || body.effect === "deny") {
    updates.effect = body.effect;
  }

  if ("scopes" in body) {
    updates.scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
  }

  if ("conditions" in body) {
    updates.conditions = Array.isArray(body.conditions)
      ? body.conditions.filter(
          (condition): condition is PolicyCondition =>
            typeof condition === "object" && condition !== null && !Array.isArray(condition),
        )
      : [];
  }

  if ("priority" in body) {
    updates.priority = typeof body.priority === "number" ? body.priority : Number.NaN;
  }

  return updates;
}

async function parseJsonObjectBody<T>(request: Request): Promise<T | null> {
  const body = await request.json().catch(() => null) as T | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  return body;
}

function handlePolicyError(c: Context<AppEnv>, error: unknown): Response {
  if (isPolicyEngineError(error)) {
    return c.json({ error: error.message }, error.status as 400 | 404 | 409);
  }

  const message = error instanceof Error ? error.message : "internal_error";
  return c.json({ error: message }, 500);
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePolicyEffect(value: string | undefined): PolicyEffect | undefined {
  if (value === "allow" || value === "deny") {
    return value;
  }

  return undefined;
}
