import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(currentDir, "../../../../");

const paths = {
  devVarsTemplate: path.join(repoRoot, ".dev.vars.example"),
  seedScript: path.join(repoRoot, "scripts/seed-dev-data.ts"),
  tokenScript: path.join(repoRoot, "scripts/generate-dev-token.sh"),
  wranglerConfig: path.join(repoRoot, "wrangler.toml"),
};

async function readRequiredFile(filePath: string, label: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      assert.fail(`${label} is missing at ${filePath}`);
    }
    throw error;
  }
}

function decodeJwtPart(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("seed data script creates valid test identities", async () => {
  const source = await readRequiredFile(paths.seedScript, "Seed data script");

  assert.match(
    source,
    /\b(?:D1Database|db\.prepare|db\.batch|db\.exec|env\.DB|\.prepare\(|\.batch\(|\.exec\()/,
    "Seed script should interact with D1",
  );
  assert.match(
    source,
    /INSERT\s+INTO\s+organizations\b/i,
    "Seed script should create a test organization",
  );
  assert.match(
    source,
    /INSERT\s+INTO\s+workspaces\b/i,
    "Seed script should create a test workspace",
  );
  assert.match(
    source,
    /INSERT\s+INTO\s+identities\b/i,
    "Seed script should create test identities",
  );
  assert.match(source, /\borg_[A-Za-z0-9_-]+\b/, "Seed script should use valid org IDs");
  assert.match(source, /\bws_[A-Za-z0-9_-]+\b/, "Seed script should use valid workspace IDs");

  const identityIds = [...source.matchAll(/\bagent_[A-Za-z0-9_-]+\b/g)].map((match) => match[0]);
  assert.ok(identityIds.length > 0, "Seed script should include at least one test agent identity");
  assert.equal(
    identityIds.every((id) => /^agent_[A-Za-z0-9_-]+$/.test(id)),
    true,
    "Seed identities should use valid agent ID format",
  );

  assert.match(
    source,
    /(?:status\s*[:=]\s*["']active["']|["']active["'])/,
    "Seed identities should include an active status",
  );
  assert.match(
    source,
    /console\.(?:log|info|table)\(/,
    "Seed script should print the created IDs for local development",
  );
});

test("dev token generator produces valid JWT structure", async () => {
  await access(paths.tokenScript);

  const token = execFileSync("bash", [paths.tokenScript], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();

  const parts = token.split(".");
  assert.equal(parts.length, 3, "Generated token should be a three-part JWT");

  const [encodedHeader, encodedPayload, signature] = parts;
  const header = decodeJwtPart(encodedHeader);
  const payload = decodeJwtPart(encodedPayload);

  assert.deepEqual(header, { alg: "HS256", typ: "JWT", kid: "dev-key" });
  assert.match(signature, /^[A-Za-z0-9_-]+$/, "JWT signature should be base64url encoded");

  const expectedSignature = crypto
    .createHmac("sha256", "dev-secret")
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest("base64url");
  assert.equal(signature, expectedSignature, "JWT should be signed with the dev secret");

  assert.equal(payload.sub, "agent_dev_admin");
  assert.equal(payload.org, "org_test");
  assert.equal(payload.wks, "ws_test");
  assert.deepEqual(payload.scopes, ["*"]);
  assert.equal(payload.iss, "relayauth:dev");
  assert.deepEqual(payload.aud, ["relayauth"]);
  assert.equal(typeof payload.iat, "number");
  assert.equal(typeof payload.exp, "number");
  assert.equal((payload.exp as number) > (payload.iat as number), true);
  assert.equal(typeof payload.jti, "string");
  assert.equal((payload.jti as string).length > 0, true);
});

// Wrangler binding tests removed — Cloudflare-specific config belongs in cloud repo.
// See: AgentWorkforce/cloud/packages/relayauth/wrangler.toml

test(".dev.vars template has all required env vars", async () => {
  const source = await readRequiredFile(paths.devVarsTemplate, ".dev.vars template");

  assert.match(source, /^SIGNING_KEY=/m, "Template should include SIGNING_KEY");
  assert.match(source, /^SIGNING_KEY_ID=/m, "Template should include SIGNING_KEY_ID");
  assert.match(source, /^INTERNAL_SECRET=/m, "Template should include INTERNAL_SECRET");
});
