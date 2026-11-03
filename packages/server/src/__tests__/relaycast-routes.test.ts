import assert from "node:assert/strict";
import test from "node:test";

import {
  createCredentialTagSigner,
  encodeArWorkspaceId,
  isArWorkspaceId,
  parseArCredential,
  parseCredentialKeyring,
} from "../lib/credential-keyring.js";
import { RelaycastPushError, type RelaycastWorkspaceKeyPusher } from "../lib/relaycast.js";
import {
  createTestApp,
  createTestRequest,
  seedPlainApiKey,
} from "./test-helpers.js";

const KEYRING_JSON =
  '{"current":"b","keys":{"a":"keyring-secret-alpha-0123456789","b":"keyring-secret-bravo-0123456789"}}';
const RELAYCAST_BINDINGS = {
  RELAYAUTH_RELAYCAST_CREDENTIAL_KEYRING: KEYRING_JSON,
  RELAYAUTH_RELAYCAST_URL: "http://relaycast.internal",
  RELAYAUTH_RELAYCAST_INTERNAL_SECRET: "relaycast-internal-secret-0123456789",
};
const WORKSPACE_ID = "1749835200000000001";
const ADMIN_SCOPE = "relayauth:relaycast:manage:*";

type PushCall = {
  workspaceId: string;
  input: { apiKey: string; keyGeneration?: number; graceMs?: number };
};

function recordingPusher(
  respond?: (workspaceId: string, input: PushCall["input"]) => {
    workspaceId: string;
    apiKeyGeneration: number;
    created: boolean;
  },
): { pusher: RelaycastWorkspaceKeyPusher; calls: PushCall[] } {
  const calls: PushCall[] = [];
  const pusher: RelaycastWorkspaceKeyPusher = {
    async pushWorkspaceKey(workspaceId, input) {
      calls.push({ workspaceId, input });
      return (
        respond?.(workspaceId, input) ?? {
          workspaceId,
          apiKeyGeneration: input.keyGeneration ?? 0,
          created: true,
        }
      );
    },
  };
  return { pusher, calls };
}

async function seedAdminKey(app: ReturnType<typeof createTestApp>, scopes = [ADMIN_SCOPE]) {
  return seedPlainApiKey(app, { orgId: "org_test", name: "relaycast-admin", scopes });
}

function signer() {
  return createCredentialTagSigner(parseCredentialKeyring(KEYRING_JSON));
}

test("relaycast routes reject missing and insufficient credentials", async () => {
  const { pusher } = recordingPusher();
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: pusher });
  try {
    const missing = await app.request(
      createTestRequest("POST", "/v1/relaycast/workspaces", { workspace_id: WORKSPACE_ID }),
    );
    assert.equal(missing.status, 401);

    const { key: otherKey } = await seedAdminKey(app, ["relayauth:api-key:manage:*"]);
    const denied = await app.request(
      createTestRequest(
        "POST",
        "/v1/relaycast/workspaces",
        { workspace_id: WORKSPACE_ID },
        { "x-api-key": otherKey },
      ),
    );
    assert.equal(denied.status, 403);
  } finally {
    await app.close();
  }
});

test("relaycast routes answer 503 when issuance is not configured or partially configured", async () => {
  for (const bindings of [
    {},
    { RELAYAUTH_RELAYCAST_CREDENTIAL_KEYRING: KEYRING_JSON },
    {
      RELAYAUTH_RELAYCAST_CREDENTIAL_KEYRING: KEYRING_JSON,
      RELAYAUTH_RELAYCAST_URL: "http://relaycast.internal",
    },
  ]) {
    const { pusher, calls } = recordingPusher();
    const app = createTestApp(bindings, { relaycastKeyPusher: pusher });
    try {
      const { key } = await seedAdminKey(app);
      const response = await app.request(
        createTestRequest(
          "POST",
          "/v1/relaycast/workspaces",
          { workspace_id: WORKSPACE_ID },
          { "x-api-key": key },
        ),
      );
      assert.equal(response.status, 503);
      const body = (await response.json()) as { code?: string };
      assert.equal(body.code, "relaycast_not_configured");
      assert.equal(calls.length, 0, "a misconfigured deployment must never push a key");
    } finally {
      await app.close();
    }
  }
});

test("POST /v1/relaycast/workspaces mints an ar_ws_ key for a caller-supplied snowflake and pushes it at generation 1", async () => {
  const { pusher, calls } = recordingPusher();
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: pusher });
  try {
    const { key } = await seedAdminKey(app);
    const response = await app.request(
      createTestRequest(
        "POST",
        "/v1/relaycast/workspaces",
        { workspace_id: WORKSPACE_ID },
        { "x-api-key": key },
      ),
    );
    assert.equal(response.status, 201);
    const body = (await response.json()) as {
      workspace_id: string;
      api_key: string;
      api_key_generation: number;
    };
    assert.equal(body.workspace_id, WORKSPACE_ID);
    assert.equal(body.api_key_generation, 1);

    const parsed = parseArCredential(body.api_key);
    assert.equal(parsed?.kind, "workspace");
    assert.equal(parsed?.workspaceId, WORKSPACE_ID);
    assert.equal(await signer().verify(body.api_key), true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.workspaceId, WORKSPACE_ID);
    assert.equal(calls[0]?.input.apiKey, body.api_key);
    assert.equal(calls[0]?.input.keyGeneration, 1);
  } finally {
    await app.close();
  }
});

test("POST /v1/relaycast/workspaces allocates a snowflake workspace id when none is supplied", async () => {
  const { pusher, calls } = recordingPusher();
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: pusher });
  try {
    const { key } = await seedAdminKey(app);
    const first = await app.request(
      createTestRequest("POST", "/v1/relaycast/workspaces", {}, { "x-api-key": key }),
    );
    assert.equal(first.status, 201);
    const firstBody = (await first.json()) as { workspace_id: string; api_key: string };
    assert.equal(isArWorkspaceId(firstBody.workspace_id), true);

    const second = await app.request(
      createTestRequest("POST", "/v1/relaycast/workspaces", {}, { "x-api-key": key }),
    );
    const secondBody = (await second.json()) as { workspace_id: string };
    assert.notEqual(firstBody.workspace_id, secondBody.workspace_id);

    assert.equal(calls.every((call) => isArWorkspaceId(call.workspaceId)), true);
  } finally {
    await app.close();
  }
});

test("POST /v1/relaycast/workspaces refuses a workspace id that is not a snowflake", async () => {
  const { pusher, calls } = recordingPusher();
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: pusher });
  try {
    const { key } = await seedAdminKey(app);
    for (const workspaceId of ["ws_abc", "18446744073709551616", "-1", "", 123] as const) {
      const response = await app.request(
        createTestRequest(
          "POST",
          "/v1/relaycast/workspaces",
          { workspace_id: workspaceId },
          { "x-api-key": key },
        ),
      );
      assert.equal(response.status, 400, String(workspaceId));
    }
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test("GET /v1/relaycast/credential-tags/:workspaceId returns every keyring tag, current first, cacheable", async () => {
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: recordingPusher().pusher });
  try {
    const { key } = await seedAdminKey(app);
    const wsid = encodeArWorkspaceId(WORKSPACE_ID);
    const response = await app.request(
      createTestRequest("GET", `/v1/relaycast/credential-tags/${wsid}`, undefined, {
        "x-api-key": key,
      }),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; data: { workspace_id: string; tags: string[] } };
    assert.equal(body.ok, true);
    assert.equal(body.data.workspace_id, WORKSPACE_ID);
    assert.deepEqual(body.data.tags, await signer().tags(WORKSPACE_ID));
    assert.equal(body.data.tags[0]?.[0], "b");
    assert.match(response.headers.get("cache-control") ?? "", /max-age/);
  } finally {
    await app.close();
  }
});

test("GET /v1/relaycast/credential-tags/:workspaceId refuses non-snowflake ids", async () => {
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: recordingPusher().pusher });
  try {
    const { key } = await seedAdminKey(app);
    const response = await app.request(
      createTestRequest("GET", "/v1/relaycast/credential-tags/ws_abc", undefined, {
        "x-api-key": key,
      }),
    );
    assert.equal(response.status, 400);
  } finally {
    await app.close();
  }
});

test("POST /v1/relaycast/workspaces/:id/api-key rotates with the caller's generation and grace", async () => {
  const { pusher, calls } = recordingPusher((workspaceId, input) => ({
    workspaceId,
    apiKeyGeneration: input.keyGeneration ?? 0,
    created: false,
  }));
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: pusher });
  try {
    const { key } = await seedAdminKey(app);
    const response = await app.request(
      createTestRequest(
        "POST",
        `/v1/relaycast/workspaces/${WORKSPACE_ID}/api-key`,
        { key_generation: 2, grace_ms: 60_000 },
        { "x-api-key": key },
      ),
    );
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      workspace_id: string;
      api_key: string;
      api_key_generation: number;
    };
    assert.equal(body.workspace_id, WORKSPACE_ID);
    assert.equal(body.api_key_generation, 2);
    assert.equal(await signer().verify(body.api_key), true);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.input.keyGeneration, 2);
    assert.equal(calls[0]?.input.graceMs, 60_000);
    assert.equal(calls[0]?.input.apiKey, body.api_key);
  } finally {
    await app.close();
  }
});

test("POST /v1/relaycast/workspaces/:id/api-key requires key_generation and a snowflake id", async () => {
  const { pusher, calls } = recordingPusher();
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: pusher });
  try {
    const { key } = await seedAdminKey(app);
    const missingGeneration = await app.request(
      createTestRequest(
        "POST",
        `/v1/relaycast/workspaces/${WORKSPACE_ID}/api-key`,
        {},
        { "x-api-key": key },
      ),
    );
    assert.equal(missingGeneration.status, 400);

    const badId = await app.request(
      createTestRequest(
        "POST",
        "/v1/relaycast/workspaces/ws_abc/api-key",
        { key_generation: 2 },
        { "x-api-key": key },
      ),
    );
    assert.equal(badId.status, 400);
    assert.equal(calls.length, 0);
  } finally {
    await app.close();
  }
});

test("a stale generation push surfaces relaycast's 409 instead of minting success", async () => {
  const { pusher } = recordingPusher(() => {
    throw new RelaycastPushError(
      "key_generation 2 does not beat the stored generation 5",
      "stale_key_generation",
      409,
    );
  });
  const app = createTestApp(RELAYCAST_BINDINGS, { relaycastKeyPusher: pusher });
  try {
    const { key } = await seedAdminKey(app);
    const response = await app.request(
      createTestRequest(
        "POST",
        `/v1/relaycast/workspaces/${WORKSPACE_ID}/api-key`,
        { key_generation: 2 },
        { "x-api-key": key },
      ),
    );
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, "stale_key_generation");
  } finally {
    await app.close();
  }
});
