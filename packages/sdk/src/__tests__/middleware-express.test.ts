import assert from "node:assert/strict";
import test from "node:test";
import type { RelayAuthTokenClaims } from "@relayauth/types";

import { RelayAuthError, TokenExpiredError } from "../errors.js";
import { TokenVerifier, type VerifyOptions } from "../verify.js";

type RelayAuthExpressOptions = VerifyOptions & {
  onError?: (error: Error, req: MockRequest, res: MockResponse) => void | Promise<void>;
};

type ExpressMiddlewareModule = {
  relayAuthExpress: (
    options?: RelayAuthExpressOptions,
  ) => (req: MockRequest, res: MockResponse, next: NextSpy) => void | Promise<void>;
  requireScopeExpress: (
    scope: string,
  ) => (req: MockRequest, res: MockResponse, next: NextSpy) => void | Promise<void>;
};

type ErrorBody = {
  error: string;
  code?: string;
};

type MockRequest = {
  headers: {
    authorization?: string;
  };
  identity?: RelayAuthTokenClaims;
};

type MockResponse = {
  statusCode?: number;
  jsonBody?: unknown;
  statusCalls: number[];
  jsonCalls: unknown[];
  status: (code: number) => MockResponse;
  json: (body: unknown) => MockResponse;
};

type NextSpy = (() => void) & {
  callCount: number;
};

const jwksUrl = "https://relay.example.test/.well-known/jwks.json";
const issuer = "https://relay.example.test";
const audience = ["relayauth-sdk", "relay-api"];

async function loadExpressMiddleware(): Promise<ExpressMiddlewareModule> {
  let moduleRecord: Record<string, unknown>;
  const modulePath = "../middleware/express.js";

  try {
    moduleRecord = (await import(modulePath)) as Record<string, unknown>;
  } catch (error) {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    assert.fail(`Expected Express middleware module at ../middleware/express.js: ${message}`);
  }

  assert.equal(
    typeof moduleRecord.relayAuthExpress,
    "function",
    "middleware module should export relayAuthExpress()",
  );
  assert.equal(
    typeof moduleRecord.requireScopeExpress,
    "function",
    "middleware module should export requireScopeExpress()",
  );

  return moduleRecord as unknown as ExpressMiddlewareModule;
}

function createClaims(overrides: Partial<RelayAuthTokenClaims> = {}): RelayAuthTokenClaims {
  const now = Math.floor(Date.now() / 1000);

  return {
    sub: "agent_sdk_express",
    org: "org_sdk_express",
    wks: "ws_sdk_express",
    scopes: ["relayauth:read:*"],
    sponsorId: "user_sdk_express",
    sponsorChain: ["user_sdk_express", "svc_gateway"],
    token_type: "access",
    iss: issuer,
    aud: [...audience],
    exp: now + 3600,
    iat: now - 60,
    jti: "jti_sdk_express",
    ...overrides,
  };
}

function createMockRequest(authorization?: string): MockRequest {
  return {
    headers: authorization ? { authorization } : {},
  };
}

function createMockResponse(): MockResponse {
  const response: MockResponse = {
    statusCalls: [],
    jsonCalls: [],
    status(code) {
      response.statusCode = code;
      response.statusCalls.push(code);
      return response;
    },
    json(body) {
      response.jsonBody = body;
      response.jsonCalls.push(body);
      return response;
    },
  };

  return response;
}

function createNextSpy(): NextSpy {
  const next = (() => {
    next.callCount += 1;
  }) as NextSpy;

  next.callCount = 0;

  return next;
}

function mockVerifierVerify(
  t: test.TestContext,
  implementation: (this: TokenVerifier, token: string) => Promise<RelayAuthTokenClaims>,
): void {
  const originalVerify = TokenVerifier.prototype.verify;

  TokenVerifier.prototype.verify = implementation;

  t.after(() => {
    TokenVerifier.prototype.verify = originalVerify;
  });
}

function assertErrorJson(response: MockResponse, status: number, body: ErrorBody): void {
  assert.equal(response.statusCode, status);
  assert.deepEqual(response.statusCalls, [status]);
  assert.deepEqual(response.jsonBody, body);
  assert.deepEqual(response.jsonCalls, [body]);
}

test(
  "relayAuthExpress() extracts Bearer tokens, calls TokenVerifier.verify(), and stores identity claims",
  { concurrency: false },
  async (t) => {
    const { relayAuthExpress } = await loadExpressMiddleware();
    const claims = createClaims({
      sub: "agent_express_success",
      scopes: ["relayauth:read:*", "relayauth:admin:*"],
    });
    let verifyCalls = 0;
    let receivedToken: string | undefined;
    let receivedOptions: VerifyOptions | undefined;

    mockVerifierVerify(t, async function (token) {
      verifyCalls += 1;
      receivedToken = token;
      receivedOptions = this.options;
      return claims;
    });

    const middleware = relayAuthExpress({ jwksUrl, issuer, audience });
    const req = createMockRequest("Bearer success-token");
    const res = createMockResponse();
    const next = createNextSpy();

    await middleware(req, res, next);

    assert.equal(verifyCalls, 1);
    assert.equal(receivedToken, "success-token");
    assert.deepEqual(receivedOptions, { jwksUrl, issuer, audience });
    assert.deepEqual(req.identity, claims);
    assert.equal(next.callCount, 1);
    assert.equal(res.statusCode, undefined);
    assert.equal(res.jsonBody, undefined);
  },
);

test(
  "relayAuthExpress() returns a 401 JSON error when the Authorization header is missing",
  { concurrency: false },
  async (t) => {
    const { relayAuthExpress } = await loadExpressMiddleware();
    let verifyCalls = 0;

    mockVerifierVerify(t, async function () {
      verifyCalls += 1;
      return createClaims();
    });

    const middleware = relayAuthExpress({ jwksUrl, issuer, audience });
    const req = createMockRequest();
    const res = createMockResponse();
    const next = createNextSpy();

    await middleware(req, res, next);

    assert.equal(verifyCalls, 0);
    assert.equal(next.callCount, 0);
    assert.equal(req.identity, undefined);
    assertErrorJson(res, 401, {
      error: "Missing Authorization header",
      code: "missing_authorization",
    });
  },
);

test(
  "relayAuthExpress() returns a 401 JSON error when the Authorization header is invalid",
  { concurrency: false },
  async (t) => {
    const { relayAuthExpress } = await loadExpressMiddleware();
    let verifyCalls = 0;

    mockVerifierVerify(t, async function () {
      verifyCalls += 1;
      return createClaims();
    });

    const middleware = relayAuthExpress({ jwksUrl, issuer, audience });
    const req = createMockRequest("Basic not-a-bearer-token");
    const res = createMockResponse();
    const next = createNextSpy();

    await middleware(req, res, next);

    assert.equal(verifyCalls, 0);
    assert.equal(next.callCount, 0);
    assert.equal(req.identity, undefined);
    assertErrorJson(res, 401, {
      error: "Invalid Authorization header",
      code: "invalid_authorization",
    });
  },
);

test(
  "relayAuthExpress() returns a 401 JSON error when TokenVerifier.verify() throws TokenExpiredError",
  { concurrency: false },
  async (t) => {
    const { relayAuthExpress } = await loadExpressMiddleware();

    mockVerifierVerify(t, async function () {
      throw new TokenExpiredError();
    });

    const middleware = relayAuthExpress({ jwksUrl, issuer, audience });
    const req = createMockRequest("Bearer expired-token");
    const res = createMockResponse();
    const next = createNextSpy();

    await middleware(req, res, next);

    assert.equal(next.callCount, 0);
    assert.equal(req.identity, undefined);
    assertErrorJson(res, 401, {
      error: "Token has expired",
      code: "token_expired",
    });
  },
);

test(
  "requireScopeExpress(scope) returns 403 when the required scope is missing and calls next() when it is present",
  { concurrency: false },
  async () => {
    const { requireScopeExpress } = await loadExpressMiddleware();
    const middleware = requireScopeExpress("relayauth:admin:*");

    const forbiddenReq: MockRequest = {
      headers: {},
      identity: createClaims({
        sub: "agent_missing_scope",
        scopes: ["relayauth:read:*"],
      }),
    };
    const forbiddenRes = createMockResponse();
    const forbiddenNext = createNextSpy();

    await middleware(forbiddenReq, forbiddenRes, forbiddenNext);

    assert.equal(forbiddenNext.callCount, 0);
    assert.equal(forbiddenRes.statusCode, 403);
    assert.deepEqual(forbiddenRes.statusCalls, [403]);
    assert.equal(typeof (forbiddenRes.jsonBody as ErrorBody | undefined)?.error, "string");
    assert.deepEqual(forbiddenRes.jsonBody, {
      error: 'Insufficient scope: requires relayauth:admin:*, has [relayauth:read:*]',
      code: "insufficient_scope",
    });

    const allowedReq: MockRequest = {
      headers: {},
      identity: createClaims({
        sub: "agent_with_scope",
        scopes: ["relayauth:read:*", "relayauth:admin:*"],
      }),
    };
    const allowedRes = createMockResponse();
    const allowedNext = createNextSpy();

    await middleware(allowedReq, allowedRes, allowedNext);

    assert.equal(allowedNext.callCount, 1);
    assert.equal(allowedRes.statusCode, undefined);
    assert.equal(allowedRes.jsonBody, undefined);
  },
);

test(
  "relayAuthExpress(options) passes verification options to TokenVerifier and calls onError(error, req, res)",
  { concurrency: false },
  async (t) => {
    const { relayAuthExpress } = await loadExpressMiddleware();
    let handledError: Error | undefined;
    let handledReq: MockRequest | undefined;
    let handledRes: MockResponse | undefined;
    let receivedOptions: VerifyOptions | undefined;

    mockVerifierVerify(t, async function () {
      receivedOptions = this.options;
      throw new RelayAuthError("Invalid access token", "invalid_token", 401);
    });

    const req = createMockRequest("Bearer custom-error-token");
    const res = createMockResponse();
    const next = createNextSpy();
    const middleware = relayAuthExpress({
      jwksUrl,
      issuer,
      audience,
      onError: (error, request, response) => {
        handledError = error;
        handledReq = request;
        handledRes = response;
      },
    });

    await middleware(req, res, next);

    assert.equal(next.callCount, 0);
    assert.ok(handledError instanceof RelayAuthError);
    assert.equal(handledError?.message, "Invalid access token");
    assert.equal(handledReq, req);
    assert.equal(handledRes, res);
    assert.deepEqual(receivedOptions, { jwksUrl, issuer, audience });
    assertErrorJson(res, 401, {
      error: "Invalid access token",
      code: "invalid_token",
    });
  },
);
