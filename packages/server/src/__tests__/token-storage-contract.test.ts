import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const tokenRoutesSource = readFileSync(new URL("../routes/tokens.ts", import.meta.url), "utf8");
const storageInterfaceSource = readFileSync(new URL("../storage/interface.ts", import.meta.url), "utf8");

test("token routes use the public storage contract instead of raw SQL storage", () => {
  assert.doesNotMatch(tokenRoutesSource, /\bstorage\.DB\b/);
  assert.doesNotMatch(tokenRoutesSource, /\bSqlBackedStorage\b/);
  assert.doesNotMatch(tokenRoutesSource, /\bgetSqlStorage\b/);
});

test("TokenStorage owns the complete issued-token hot-path contract", () => {
  assert.match(storageInterfaceSource, /\bpersistIssued\(token: IssuedTokenRecord\): Promise<void>/);
  assert.match(
    storageInterfaceSource,
    /\bpersistIssuedPairWithAudit\(input: IssuedTokenPairAudit\): Promise<void>/,
  );
  assert.match(
    storageInterfaceSource,
    /\bpersistIssuedWithAudit\(input: IssuedTokenAudit\): Promise<void>/,
  );
  assert.match(
    storageInterfaceSource,
    /\brotateIssuedPairWithAudit\(input: IssuedTokenRotationAudit\): Promise<void>/,
  );
  assert.match(storageInterfaceSource, /\bgetById\(tokenId: string\): Promise<StoredTokenRecord \| null>/);
  assert.match(storageInterfaceSource, /\blistActiveByIdentityId\(identityId: string\): Promise<StoredTokenRecord\[]>/);
  assert.match(storageInterfaceSource, /\blistActiveBySessionId\(sessionId: string\): Promise<StoredTokenRecord\[]>/);
});
