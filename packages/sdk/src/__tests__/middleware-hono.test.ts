import assert from "node:assert/strict";
import { test, onTestFinished } from "vitest";
import type { RelayAuthTokenClaims } from "@relayauth/types";
import { Hono, type MiddlewareHandler } from "hono";

import { RelayAuthError, TokenExpiredError } from "../errors.js";
import { TokenVerifier, type VerifyOptions } from "../verify.js";

type RelayAuthMiddlewareOptions = VerifyOptions & {
  onError?: (error: Error) => Response | Promise<Response> | void | Promise<void>;
};

type HonoMiddlewareModule = {
  relayAuth: (options?: RelayAuthMiddlewareOptions) => MiddlewareHandler;
  requireScope: (scope: string) => MiddlewareHandler;
};

type ErrorBody = {
  error: string;
  code?: string;
};

const jwksUrl = "https://relay.example.test/.well-known/jwks.json";
const issuer = "https://relay.example.test";
const audience = ["relayauth-sdk", "relay-api"];

async function loadHonoMiddleware(): Promise<HonoMiddlewareModule> {
  let moduleRecord: Record<string, unknown>;

  try {
    moduleRecord = (await import("../middleware/hono.js")) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected Hono middleware module at ../middleware/hono.js: ${message}`);
  }

  assert.equal(typeof moduleRecord.relayAuth, "function", "middleware module should export relayAuth()");
  assert.equal(typeof moduleRecord.requireScope, "function", "middleware module should export requireScope()");

  return moduleRecord as unknown as HonoMiddlewareModule;
}

function createClaims(overrides: Partial<RelayAuthTokenClaims> = {}): RelayAuthTokenClaims {
  const now = Math.floor(Date.now() / 1000);

  return {
    sub: "agent_sdk_hono",
    org: "org_sdk_hono",
    wks: "ws_sdk_hono",
    scopes: ["relayauth:read:*"],
    sponsorId: "user_sdk_hono",
    sponsorChain: ["user_sdk_hono", "svc_gateway"],
    token_type: "access",
    iss: issuer,
    aud: [...audience],
    exp: now + 3600,
    iat: now - 60,
    jti: "jti_sdk_hono",
    ...overrides,
  };
}

function mockVerifierVerify(
  implementation: (this: TokenVerifier, token: string) => Promise<RelayAuthTokenClaims>,
): void {
  const originalVerify = TokenVerifier.prototype.verify;

  TokenVerifier.prototype.verify = implementation;

  onTestFinished(() => {
    TokenVerifier.prototype.verify = originalVerify;
  });
}

async function assertJsonResponse<T>(
  response: Response,
  status: number,
  assertion: (body: T) => void | Promise<void>,
): Promise<void> {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  await assertion((await response.json()) as T);
}

test(
  "relayAuth() extracts Bearer tokens, calls TokenVerifier.verify(), and stores identity claims",
  async () => {
    const { relayAuth } = await loadHonoMiddleware();
    const claims = createClaims({
      sub: "agent_relay_auth_success",
      scopes: ["relayauth:read:*", "relayauth:admin:*"],
    });
    let verifyCalls = 0;
    let receivedToken: string | undefined;
    let receivedOptions: VerifyOptions | undefined;

    mockVerifierVerify(async function (token) {
      verifyCalls += 1;
      receivedToken = token;
      receivedOptions = this.options;
      return claims;
    });

    const app = new Hono();

    app.use(
      "/api/*",
      relayAuth({
        jwksUrl,
        issuer,
        audience,
      }),
    );
    app.get("/api/me", (c) => {
      const identity = c.get("identity") as RelayAuthTokenClaims | undefined;

      return c.json({
        sub: identity?.sub,
        scopes: identity?.scopes,
      });
    });

    const response = await app.request("/api/me", {
      headers: {
        Authorization: "Bearer success-token",
      },
    });

    await assertJsonResponse<{
      sub?: string;
      scopes?: string[];
    }>(response, 200, (body) => {
      assert.equal(body.sub, claims.sub);
      assert.deepEqual(body.scopes, claims.scopes);
    });

    assert.equal(verifyCalls, 1);
    assert.equal(receivedToken, "success-token");
    assert.deepEqual(receivedOptions, { jwksUrl, issuer, audience });
  },
);

test(
  "relayAuth() returns a 401 JSON error when the Authorization header is missing",
  async () => {
    const { relayAuth } = await loadHonoMiddleware();
    let verifyCalls = 0;

    mockVerifierVerify(async function () {
      verifyCalls += 1;
      return createClaims();
    });

    const app = new Hono();

    app.use("/api/*", relayAuth({ jwksUrl, issuer, audience }));
    app.get("/api/me", (c) => c.json({ ok: true }));

    const response = await app.request("/api/me");

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(typeof body.error, "string");
      assert.equal(body.error.length > 0, true);
      assert.equal(typeof body.code, "string");
    });

    assert.equal(verifyCalls, 0);
  },
);

test(
  "relayAuth() returns a 401 JSON error when TokenVerifier.verify() rejects the token",
  async () => {
    const { relayAuth } = await loadHonoMiddleware();

    mockVerifierVerify(async function () {
      throw new RelayAuthError("Invalid access token", "invalid_token", 401);
    });

    const app = new Hono();

    app.use("/api/*", relayAuth({ jwksUrl, issuer, audience }));
    app.get("/api/me", (c) => c.json({ ok: true }));

    const response = await app.request("/api/me", {
      headers: {
        Authorization: "Bearer invalid-token",
      },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.error, "Invalid access token");
      assert.equal(body.code, "invalid_token");
    });
  },
);

test(
  "relayAuth() returns a 401 JSON error when TokenVerifier.verify() throws TokenExpiredError",
  async () => {
    const { relayAuth } = await loadHonoMiddleware();

    mockVerifierVerify(async function () {
      throw new TokenExpiredError();
    });

    const app = new Hono();

    app.use("/api/*", relayAuth({ jwksUrl, issuer, audience }));
    app.get("/api/me", (c) => c.json({ ok: true }));

    const response = await app.request("/api/me", {
      headers: {
        Authorization: "Bearer expired-token",
      },
    });

    await assertJsonResponse<ErrorBody>(response, 401, (body) => {
      assert.equal(body.error, "Token has expired");
      assert.equal(body.code, "token_expired");
    });
  },
);

test(
  "requireScope(scope) returns 403 without the required scope and calls next() when the scope is present",
  async () => {
    const { relayAuth, requireScope } = await loadHonoMiddleware();
    let routeHits = 0;

    mockVerifierVerify(async function (token) {
      if (token === "admin-token") {
        return createClaims({
          sub: "agent_admin_scope",
          scopes: ["relayauth:read:*", "relayauth:admin:*"],
        });
      }

      return createClaims({
        sub: "agent_missing_scope",
        scopes: ["relayauth:read:*"],
      });
    });

    const app = new Hono();

    app.use("/api/*", relayAuth({ jwksUrl, issuer, audience }));
    app.use("/api/admin/*", requireScope("relayauth:admin:*"));
    app.get("/api/admin/stats", (c) => {
      routeHits += 1;
      return c.json({ ok: true });
    });

    const forbiddenResponse = await app.request("/api/admin/stats", {
      headers: {
        Authorization: "Bearer member-token",
      },
    });

    await assertJsonResponse<ErrorBody>(forbiddenResponse, 403, (body) => {
      assert.equal(typeof body.error, "string");
      assert.equal(body.code, "insufficient_scope");
    });

    const allowedResponse = await app.request("/api/admin/stats", {
      headers: {
        Authorization: "Bearer admin-token",
      },
    });

    await assertJsonResponse<{ ok: boolean }>(allowedResponse, 200, (body) => {
      assert.equal(body.ok, true);
    });

    assert.equal(routeHits, 1);
  },
);

test(
  "relayAuth() and requireScope() compose correctly across nested Hono route groups",
  async () => {
    const { relayAuth, requireScope } = await loadHonoMiddleware();

    mockVerifierVerify(async function (token) {
      if (token === "admin-token") {
        return createClaims({
          sub: "agent_admin_composed",
          scopes: ["relayauth:read:*", "relayauth:admin:*"],
        });
      }

      return createClaims({
        sub: "agent_member_composed",
        scopes: ["relayauth:read:*"],
      });
    });

    const app = new Hono();

    app.use("/api/*", relayAuth({ jwksUrl, issuer, audience }));
    app.use("/api/admin/*", requireScope("relayauth:admin:*"));
    app.get("/api/profile", (c) => {
      const identity = c.get("identity") as RelayAuthTokenClaims | undefined;
      return c.json({ sub: identity?.sub });
    });
    app.get("/api/admin/stats", (c) => c.json({ ok: true }));

    const profileResponse = await app.request("/api/profile", {
      headers: {
        Authorization: "Bearer member-token",
      },
    });
    const adminResponse = await app.request("/api/admin/stats", {
      headers: {
        Authorization: "Bearer admin-token",
      },
    });

    await assertJsonResponse<{ sub?: string }>(profileResponse, 200, (body) => {
      assert.equal(body.sub, "agent_member_composed");
    });
    await assertJsonResponse<{ ok: boolean }>(adminResponse, 200, (body) => {
      assert.equal(body.ok, true);
    });
  },
);

test(
  "relayAuth(options) passes verification options to TokenVerifier and supports a custom onError handler",
  async () => {
    const { relayAuth } = await loadHonoMiddleware();
    let handledError: Error | undefined;
    let receivedOptions: VerifyOptions | undefined;

    mockVerifierVerify(async function () {
      receivedOptions = this.options;
      throw new RelayAuthError("Invalid access token", "invalid_token", 401);
    });

    const app = new Hono();

    app.use(
      "/api/*",
      relayAuth({
        jwksUrl,
        issuer,
        audience,
        onError: (error) => {
          handledError = error;
          return Response.json(
            {
              error: "custom_auth_failure",
              detail: error.message,
            },
            { status: 418 },
          );
        },
      }),
    );
    app.get("/api/me", (c) => c.json({ ok: true }));

    const response = await app.request("/api/me", {
      headers: {
        Authorization: "Bearer custom-error-token",
      },
    });

    await assertJsonResponse<{
      error: string;
      detail: string;
    }>(response, 418, (body) => {
      assert.equal(body.error, "custom_auth_failure");
      assert.equal(body.detail, "Invalid access token");
    });

    assert.ok(handledError instanceof RelayAuthError);
    assert.deepEqual(receivedOptions, { jwksUrl, issuer, audience });
  },
);
