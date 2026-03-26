import assert from "node:assert/strict";
import test from "node:test";

import { seedAclEntries } from "../acl.js";

test("seedAclEntries writes relayfile ACL marker files", async () => {
  const calls: Array<{ input: URL; init: RequestInit | undefined }> = [];
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    calls.push({ input: new URL(String(input)), init });
    return new Response(null, { status: 200 });
  }) as typeof fetch;

  try {
    await seedAclEntries(
      "workspace-a",
      {
        "/": ["agent:root:read"],
        "/src": ["agent:dev:write"],
      },
      "http://127.0.0.1:8080/",
      "token-123",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.input.pathname, "/v1/workspaces/workspace-a/fs/file");
  assert.equal(calls[0]?.input.searchParams.get("path"), "/.relayfile.acl");
  assert.equal(calls[1]?.input.searchParams.get("path"), "/src/.relayfile.acl");
  assert.equal((calls[0]?.init?.headers as Record<string, string>)?.authorization, "Bearer token-123");

  const firstBody = JSON.parse(String(calls[0]?.init?.body));
  assert.deepEqual(firstBody, {
    content: JSON.stringify({ semantics: { permissions: ["agent:root:read"] } }),
    encoding: "utf-8",
  });
});

test("seedAclEntries surfaces relayfile API failures", async () => {
  const originalFetch = globalThis.fetch;

  globalThis.fetch = (async () => new Response("boom", { status: 500 })) as typeof fetch;

  try {
    await assert.rejects(
      () => seedAclEntries("workspace-a", { "/src": ["agent:dev:write"] }, "http://relayfile", "token"),
      /failed to seed ACL for \/src: HTTP 500 boom/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
