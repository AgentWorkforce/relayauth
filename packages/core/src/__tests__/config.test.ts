import assert from "node:assert/strict";
import test from "node:test";

import { parseRelayConfigString } from "../config.js";

test("parseRelayConfigString expands role scopes into agents", () => {
  const config = parseRelayConfigString(`
version: "1"
workspace: demo
signing_secret: secret
roles:
  reader:
    scopes:
      - relayfile:fs:read:/src/*
agents:
  - name: agent-a
    scopes:
      - cloud:workflow:run
    roles:
      - reader
acl:
  /src:
    - agent:agent-a:read
`);

  assert.equal(config.workspace, "demo");
  assert.deepEqual(config.agents[0]?.roles, ["reader"]);
  assert.deepEqual(config.agents[0]?.scopes, [
    "cloud:workflow:run:*",
    "relayfile:fs:read:/src/*",
  ]);
  assert.deepEqual(config.acl, { "/src": ["agent:agent-a:read"] });
});

test("parseRelayConfigString normalizes wildcard scopes and ACL paths", () => {
  const config = parseRelayConfigString(`
version: "1"
workspace: demo
signing_secret: secret
agents:
  - name: agent-a
    scopes:
      - "*"
acl:
  /tmp//nested/:
    - team:ops:write
`);

  assert.deepEqual(config.agents[0]?.scopes, ["*:*:*:*"]);
  assert.deepEqual(config.acl, { "/tmp/nested": ["team:ops:write"] });
});

test("parseRelayConfigString rejects unknown roles", () => {
  assert.throws(
    () =>
      parseRelayConfigString(`
version: "1"
workspace: demo
signing_secret: secret
agents:
  - name: agent-a
    scopes: []
    roles:
      - missing
`),
    /unknown role "missing"/,
  );
});

test("parseRelayConfigString rejects invalid scopes", () => {
  assert.throws(
    () =>
      parseRelayConfigString(`
version: "1"
workspace: demo
signing_secret: secret
agents:
  - name: agent-a
    scopes:
      - nope
`),
    /invalid/i,
  );
});
