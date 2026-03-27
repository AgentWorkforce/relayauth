import type { Role } from "@relayauth/types";
import { matchScope } from "@relayauth/sdk";
import { Hono, type Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  createRole,
  deleteRole,
  getRole,
  isRoleEngineError,
  listRoles,
  updateRole,
} from "../engine/roles.js";
import { authenticateAndAuthorize } from "../lib/auth.js";

type CreateRoleRequest = {
  name?: string;
  description?: string;
  scopes?: string[];
  workspaceId?: string;
};

type UpdateRoleRequest = Partial<Pick<Role, "name" | "description" | "scopes">>;

const roles = new Hono<AppEnv>();

roles.post("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const body = await parseJsonObjectBody<CreateRoleRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const role = await createRole(c.get("storage"), {
      name: body.name ?? "",
      description: body.description ?? "",
      scopes: Array.isArray(body.scopes) ? body.scopes : [],
      orgId: auth.claims.org,
      ...(typeof body.workspaceId === "string" ? { workspaceId: body.workspaceId } : {}),
    });

    return c.json(role, 201);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.get("/", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const workspaceId = normalizeOptionalString(c.req.query("workspaceId"));
  const builtIn = parseBooleanQuery(c.req.query("builtIn"));

  try {
    const data = await listRoles(c.get("storage"), auth.claims.org, workspaceId);
    return c.json(
      {
        data: builtIn === undefined ? data : data.filter((role) => role.builtIn === builtIn),
      },
      200,
    );
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.get("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:read:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const role = await getRole(c.get("storage"), id);
    if (!role || role.orgId !== auth.claims.org) {
      return c.json({ error: "role_not_found" }, 404);
    }

    return c.json(role, 200);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.patch("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const id = c.req.param("id").trim();
  const body = await parseJsonObjectBody<UpdateRoleRequest>(c.req.raw);
  if (!body) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const updates = sanitizeRoleUpdate(body);
  if (Object.keys(updates).length === 0) {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  try {
    const existing = await getRole(c.get("storage"), id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "role_not_found" }, 404);
    }

    const role = await updateRole(c.get("storage"), id, updates);
    return c.json(role, 200);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

roles.delete("/:id", async (c) => {
  const auth = await authenticateAndAuthorize(
    c.req.header("authorization"),
    c.env.SIGNING_KEY,
    "relayauth:role:manage:*",
    matchScope,
  );
  if (!auth.ok) {
    return c.json({ error: auth.error, code: auth.code }, auth.status);
  }

  const id = c.req.param("id").trim();

  try {
    const existing = await getRole(c.get("storage"), id);
    if (!existing || existing.orgId !== auth.claims.org) {
      return c.json({ error: "role_not_found" }, 404);
    }

    await deleteRole(c.get("storage"), id);
    return c.body(null, 204);
  } catch (error) {
    return handleRoleError(c, error);
  }
});

export default roles;

function sanitizeRoleUpdate(body: UpdateRoleRequest): UpdateRoleRequest {
  const updates: UpdateRoleRequest = {};

  if (typeof body.name === "string") {
    updates.name = body.name.trim();
  }

  if (typeof body.description === "string") {
    updates.description = body.description.trim();
  }

  if ("scopes" in body) {
    updates.scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((scope): scope is string => typeof scope === "string")
      : [];
  }

  return updates;
}

async function parseJsonObjectBody<T>(request: Request): Promise<T | null> {
  const body = await request.json<T>().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return null;
  }

  return body;
}

function handleRoleError(c: Context<AppEnv>, error: unknown): Response {
  if (isRoleEngineError(error)) {
    return c.json({ error: error.message }, error.status as 400 | 403 | 404 | 409);
  }

  const message = error instanceof Error ? error.message : "internal_error";
  return c.json({ error: message }, 500);
}

function parseBooleanQuery(value: string | undefined): boolean | undefined {
  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  return undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim();
  return normalized.length > 0 ? normalized : undefined;
}
