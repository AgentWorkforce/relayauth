/**
 * Relaycast `ar_` credential codec, vendored from `@relaycast/types`
 * (packages/types/src/credentials.ts) and `@relaycast/engine`
 * (packages/engine/src/auth/credentialTags.ts) so RelayAuth can act as the
 * credential authority — holding the tag keyring and minting `ar_ws_`
 * workspace keys — without a runtime dependency on either package.
 *
 * The golden vectors in `__tests__/credential-keyring.test.ts` were generated
 * by those upstream sources; keep this file byte-compatible with them.
 */

export type ArCredentialKind = "workspace" | "agent" | "node" | "observer" | "webhook";

export type ParsedArCredential = {
  kind: ArCredentialKind;
  /** The workspace snowflake, in decimal. */
  workspaceId: string;
  /** The routing tag: key version letter plus 10 base62 characters. */
  tag: string;
  /** The keyring version that signed the tag. */
  keyVersion: string;
};

const AR_KIND_CODES: Readonly<Record<ArCredentialKind, string>> = {
  workspace: "ws",
  agent: "ag",
  node: "nd",
  observer: "ob",
  webhook: "wh",
};

const KIND_BY_CODE = Object.fromEntries(
  Object.entries(AR_KIND_CODES).map(([kind, code]) => [code, kind]),
) as Record<string, ArCredentialKind>;

export const AR_WORKSPACE_ID_LENGTH = 11;
export const AR_TAG_LENGTH = 11;
export const AR_SECRET_LENGTH = 43;
export const AR_CHECKSUM_LENGTH = 6;
/** Secret bytes an `ar_` credential carries. */
export const AR_SECRET_BYTES = 32;

const AR = /^ar_(ws|ag|nd|ob|wh)_([0-9A-Za-z]{11})_([a-z][0-9A-Za-z]{10})_([0-9A-Za-z]{43})([0-9A-Za-z]{6})$/;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const MAX_SNOWFLAKE = (1n << 64n) - 1n;

/** `value` in base62, left-padded with `0` to `width` characters. */
export function base62Encode(value: bigint, width: number): string {
  if (value < 0n) throw new Error("base62 encodes non-negative integers");
  let out = "";
  for (let rest = value; rest > 0n; rest /= 62n) out = BASE62[Number(rest % 62n)] + out;
  if (out.length > width) throw new Error(`Value does not fit ${width} base62 characters`);
  return out.padStart(width, "0");
}

function base62Decode(text: string): bigint {
  let value = 0n;
  for (const char of text) {
    const digit = BASE62.indexOf(char);
    if (digit < 0) throw new Error("Not base62");
    value = value * 62n + BigInt(digit);
  }
  return value;
}

function bytesToBigInt(bytes: Uint8Array): bigint {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return value;
}

/** The 11-character base62 form of a workspace snowflake (decimal, 64-bit). */
export function encodeArWorkspaceId(workspaceId: string): string {
  const value = /^(0|[1-9][0-9]{0,19})$/.test(workspaceId) ? BigInt(workspaceId) : -1n;
  if (value < 0n || value > MAX_SNOWFLAKE) {
    throw new Error(`Workspace id ${JSON.stringify(workspaceId)} is not a 64-bit snowflake`);
  }
  return base62Encode(value, AR_WORKSPACE_ID_LENGTH);
}

/** Whether `workspaceId` is a 64-bit snowflake an `ar_` credential can carry. */
export function isArWorkspaceId(workspaceId: string): boolean {
  try {
    encodeArWorkspaceId(workspaceId);
    return true;
  } catch {
    return false;
  }
}

/** The base62 workspace segment a credential or tag request carries. */
export function isArWorkspaceSegment(segment: string): boolean {
  return /^[0-9A-Za-z]{11}$/.test(segment);
}

/** Decode an 11-char base62 workspace segment back to its snowflake. */
export function decodeArWorkspaceSegment(segment: string): string {
  return base62Decode(segment).toString();
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of an ASCII string. */
export function crc32(text: string): number {
  let crc = 0xffffffff;
  for (let i = 0; i < text.length; i += 1) crc = CRC_TABLE[(crc ^ text.charCodeAt(i)) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function arChecksum(body: string): string {
  return base62Encode(BigInt(crc32(body)), AR_CHECKSUM_LENGTH);
}

/**
 * Assemble an `ar_` credential: `ar_<kind>_<wsid>_<tag>_<secret><crc>`. `tag`
 * comes from the deployment keyring ({@link createCredentialTagSigner});
 * `secret` is exactly {@link AR_SECRET_BYTES} bytes.
 */
export function encodeArCredential(args: {
  kind: ArCredentialKind;
  workspaceId: string;
  tag: string;
  secret: Uint8Array;
}): string {
  if (!/^[a-z][0-9A-Za-z]{10}$/.test(args.tag)) throw new Error("A credential tag is a key version letter plus 10 base62 characters");
  if (args.secret.length !== AR_SECRET_BYTES) throw new Error(`A credential secret is ${AR_SECRET_BYTES} bytes`);
  const body = `ar_${AR_KIND_CODES[args.kind]}_${encodeArWorkspaceId(args.workspaceId)}_${args.tag}_`
    + base62Encode(bytesToBigInt(args.secret), AR_SECRET_LENGTH);
  return body + arChecksum(body);
}

/**
 * Parse an `ar_` credential into kind, workspace, tag and key version. Proves
 * only shape and checksum; verify the tag with a {@link CredentialTagSigner}.
 * `legacy` (`rk_live_…`) credentials return `undefined`.
 */
export function parseArCredential(token: string): ParsedArCredential | undefined {
  const ar = AR.exec(token);
  if (!ar) return undefined;
  if (arChecksum(token.slice(0, -AR_CHECKSUM_LENGTH)) !== ar[5]) return undefined;
  const workspace = base62Decode(ar[2]);
  if (workspace > MAX_SNOWFLAKE) return undefined;
  return { kind: KIND_BY_CODE[ar[1]], workspaceId: workspace.toString(), tag: ar[3], keyVersion: ar[3][0] };
}

/** Shortest key secret a keyring accepts. */
const MIN_SECRET_LENGTH = 16;

/**
 * The keys `ar_` credential tags are signed with: one secret per version letter
 * (`a`-`z`) and the version that signs new tags. Credentials outlive key
 * changes, so rotation adds a version and makes it current; it never drops
 * one. Removing a version locks out every credential tagged under it.
 */
export type CredentialKeyring = {
  current: string;
  keys: Readonly<Record<string, string>>;
};

/** Parse a keyring from configuration: `{"current":"b","keys":{"a":"<secret>","b":"<secret>"}}`. */
export function parseCredentialKeyring(json: string): CredentialKeyring {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("The credential keyring is not valid JSON");
  }
  const { current, keys } = (value ?? {}) as { current?: unknown; keys?: unknown };
  if (typeof current !== "string" || !keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new Error('The credential keyring is {"current": "<version>", "keys": {"<version>": "<secret>"}}');
  }
  const entries = Object.entries(keys as Record<string, unknown>);
  for (const [version, secret] of entries) {
    if (!/^[a-z]$/.test(version)) throw new Error(`Credential key version ${JSON.stringify(version)} is not one letter a-z`);
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`Credential key ${version} needs a secret of at least ${MIN_SECRET_LENGTH} characters`);
    }
  }
  if (!Object.hasOwn(keys, current)) throw new Error(`The current credential key version ${JSON.stringify(current)} is not in the keyring`);
  return { current, keys: Object.fromEntries(entries) as Record<string, string> };
}

export type CredentialTagSigner = {
  /** The tag new credentials for `workspaceId` carry. */
  tag(workspaceId: string): Promise<string>;
  /** Every tag a credential for `workspaceId` may carry, the current one first. */
  tags(workspaceId: string): Promise<readonly string[]>;
  /** Whether an `ar_` credential's tag was signed for its workspace by a version in the keyring. */
  verify(token: string): Promise<boolean>;
};

const TAG_BODY_LENGTH = 10;
const TAG_MODULUS = 62n ** BigInt(TAG_BODY_LENGTH);
const encoder = new TextEncoder();

/**
 * Tags from a keyring: `<version><10 base62 of HMAC-SHA256(key, wsid)>`, where
 * `wsid` is the credential's 11-character workspace segment. A gateway
 * verifies a credential's tag with the version it names, so a credential for
 * a workspace this deployment never tagged is refused without a lookup.
 */
export function createCredentialTagSigner(keyring: CredentialKeyring): CredentialTagSigner {
  const keys = new Map<string, Promise<CryptoKey>>();
  for (const [version, secret] of Object.entries(keyring.keys)) {
    if (!/^[a-z]$/.test(version)) throw new Error("A credential key version is one letter a-z");
    if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`Credential key ${version} needs a secret of at least ${MIN_SECRET_LENGTH} characters`);
    }
    keys.set(version, crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]));
  }
  if (!keys.has(keyring.current)) throw new Error("The current credential key version is not in the keyring");
  const versions = [keyring.current, ...[...keys.keys()].filter((version) => version !== keyring.current)];

  const tagFor = async (version: string, wsid: string): Promise<string | undefined> => {
    const key = keys.get(version);
    if (!key) return undefined;
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await key, encoder.encode(wsid)));
    let value = 0n;
    for (const byte of mac.subarray(0, 8)) value = (value << 8n) | BigInt(byte);
    return version + base62Encode(value % TAG_MODULUS, TAG_BODY_LENGTH);
  };

  return {
    tag(workspaceId) {
      return tagFor(keyring.current, encodeArWorkspaceId(workspaceId)) as Promise<string>;
    },
    tags(workspaceId) {
      const wsid = encodeArWorkspaceId(workspaceId);
      return Promise.all(versions.map(async (version) => (await tagFor(version, wsid))!));
    },
    async verify(token) {
      const parsed = parseArCredential(token);
      if (!parsed) return false;
      const expected = await tagFor(parsed.keyVersion, encodeArWorkspaceId(parsed.workspaceId));
      if (!expected) return false;
      let diff = 0;
      for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ parsed.tag.charCodeAt(i);
      return diff === 0;
    },
  };
}

/** Mint a fresh `ar_ws_` workspace key under the keyring's current tag. */
export async function mintArWorkspaceKey(
  signer: CredentialTagSigner,
  workspaceId: string,
): Promise<string> {
  const secret = new Uint8Array(AR_SECRET_BYTES);
  crypto.getRandomValues(secret);
  return encodeArCredential({
    kind: "workspace",
    workspaceId,
    tag: await signer.tag(workspaceId),
    secret,
  });
}
