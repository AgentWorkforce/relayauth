import type { RelayAuthTokenClaims } from "@relayauth/types";
import type { AppConfig } from "../env.js";
import { resolveIssuer } from "./sign.js";
import { signRs256 } from "./sign-rs256.js";
import {
  resolveCurrentPrivateKeyPem,
  resolveCurrentPublicJwk,
  resolvePublishedSigningKeys,
  SigningKeyConfigError,
  type PublishedSigningKey,
  type SigningKeyEnv,
} from "./signing-keys.js";

/**
 * The session directory search issuer: a second issuer identity with its own
 * signing key, trusted by PostgREST for one RPC and by nothing else. It never
 * shares a key or `iss` with the general issuer, so a token from any other
 * RelayAuth mint path cannot reach the search role. Design:
 * 96BullSessions docs/session-directory-tenant-issuer.md.
 */
export const SESSION_DIRECTORY_SEARCH_MINT_SCOPE =
  "relayauth:assertion:create:session-directory-search";
export const SESSION_DIRECTORY_SEARCH_AUDIENCE = "session-directory-search";
export const SESSION_DIRECTORY_SEARCH_ROLE = "session_directory_search_worker";
export const SESSION_DIRECTORY_SEARCH_TOKEN_TTL_SECONDS = 60;
export const SESSION_DIRECTORY_SEARCH_SUBJECT = "agent_session_directory_search";
export const SESSION_DIRECTORY_SEARCH_TOKEN_CLASS = "session_directory_search";
/** The tenant source for search is always a token that can read History. */
export const SESSION_DIRECTORY_SUBJECT_SCOPE = "rth:read";
const DEFAULT_SUBJECT_AUDIENCES = ["relayhistory"];
/** Token classes that must never stand in for a person reading sessions. */
const REFUSED_SUBJECT_TOKEN_CLASSES = new Set([
  "migration_assertion",
  SESSION_DIRECTORY_SEARCH_TOKEN_CLASS,
]);

type IssuerEnv = Pick<
  AppConfig,
  | "RELAYAUTH_SESSION_DIRECTORY_ISSUANCE"
  | "RELAYAUTH_SESSION_DIRECTORY_ISSUER"
  | "RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM"
  | "RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM_NEXT"
  | "RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM_PREVIOUS"
  | "RELAYAUTH_SESSION_DIRECTORY_SUBJECT_AUDIENCES"
  | "RELAYAUTH_ISSUER"
> & SigningKeyEnv;

export type SessionDirectorySearchClaims = {
  iss: string;
  aud: typeof SESSION_DIRECTORY_SEARCH_AUDIENCE;
  sub: string;
  role: typeof SESSION_DIRECTORY_SEARCH_ROLE;
  app_metadata: { org_id: string; workspace_ids: [string] };
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
};

export function sessionDirectoryIssuanceEnabled(env: Pick<AppConfig, "RELAYAUTH_SESSION_DIRECTORY_ISSUANCE">): boolean {
  return env.RELAYAUTH_SESSION_DIRECTORY_ISSUANCE === "true";
}

/** The issuer's slots, in the shape the general multi-key rules take. */
function issuerKeyEnv(env: IssuerEnv): SigningKeyEnv {
  return {
    RELAYAUTH_SIGNING_KEY_PEM: env.RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM,
    RELAYAUTH_SIGNING_KEY_PEM_NEXT: env.RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM_NEXT,
    RELAYAUTH_SIGNING_KEY_PEM_PREVIOUS: env.RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM_PREVIOUS,
  };
}

export function resolveSessionDirectoryKeys(env: IssuerEnv): Promise<PublishedSigningKey[]> {
  return resolvePublishedSigningKeys(issuerKeyEnv(env));
}

function resolveSessionDirectoryIssuer(env: IssuerEnv): string | undefined {
  return env.RELAYAUTH_SESSION_DIRECTORY_ISSUER?.trim() || undefined;
}

/**
 * Refuse to run with an issuer that overlaps the general one. Called at boot and
 * before every mint, because Worker deployments have no boot step.
 */
export async function assertSessionDirectoryIssuerConfig(env: IssuerEnv): Promise<void> {
  const keys = await resolveSessionDirectoryKeys(env);
  const issuer = resolveSessionDirectoryIssuer(env);
  if (sessionDirectoryIssuanceEnabled(env)) {
    if (!issuer) {
      throw new SigningKeyConfigError(
        "RELAYAUTH_SESSION_DIRECTORY_ISSUER must be set when issuance is enabled",
      );
    }
    if (!resolveCurrentPrivateKeyPem(issuerKeyEnv(env))) {
      throw new SigningKeyConfigError(
        "RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM must be set when issuance is enabled",
      );
    }
  }
  if (issuer && issuer === resolveIssuer(env)) {
    throw new SigningKeyConfigError(
      "RELAYAUTH_SESSION_DIRECTORY_ISSUER must differ from the general issuer",
    );
  }
  if (keys.length === 0) return;
  const generalKids = new Set((await resolvePublishedSigningKeys(env)).map((key) => key.kid));
  if (keys.some((key) => generalKids.has(key.kid))) {
    throw new SigningKeyConfigError(
      "session directory signing keys must not reuse a general RelayAuth signing key",
    );
  }
}

/** Remove exactly one `relay_` prefix, matching RelayHistory's stored tenant ids. */
export function normalizeTenantId(value: string): string {
  return value.startsWith("relay_") ? value.slice("relay_".length) : value;
}

function subjectAudiences(env: IssuerEnv): string[] {
  const configured = (env.RELAYAUTH_SESSION_DIRECTORY_SUBJECT_AUDIENCES ?? "")
    .split(",")
    .map((audience) => audience.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_SUBJECT_AUDIENCES;
}

export type SubjectRefusal = { code: string; error: string };

/**
 * Every tenant value in the issued token comes from this verified subject. The
 * caller's `workspaceId` can only select the subject's own workspace.
 */
export function refuseSubject(
  subject: RelayAuthTokenClaims,
  requestedWorkspaceId: string,
  env: IssuerEnv,
): SubjectRefusal | null {
  if (subject.token_type !== "access") {
    return { code: "subject_not_access_token", error: "Subject must be an access token" };
  }
  const tokenClass = subject.meta?.tokenClass;
  if (tokenClass && REFUSED_SUBJECT_TOKEN_CLASSES.has(tokenClass)) {
    return { code: "subject_class_refused", error: "This token class cannot be exchanged" };
  }
  const audiences = subjectAudiences(env);
  if (!(subject.aud ?? []).some((audience) => audiences.includes(audience))) {
    return { code: "subject_audience_refused", error: "Subject audience is not accepted" };
  }
  if (!(subject.scopes ?? []).includes(SESSION_DIRECTORY_SUBJECT_SCOPE)) {
    return { code: "subject_scope_missing", error: `Subject needs ${SESSION_DIRECTORY_SUBJECT_SCOPE}` };
  }
  const org = typeof subject.org === "string" ? normalizeTenantId(subject.org.trim()) : "";
  const workspace = typeof subject.wks === "string" ? normalizeTenantId(subject.wks.trim()) : "";
  if (!org || !workspace) {
    return { code: "subject_tenant_missing", error: "Subject has no org or workspace" };
  }
  if (normalizeTenantId(requestedWorkspaceId) !== workspace) {
    return { code: "workspace_mismatch", error: "Workspace does not match the subject" };
  }
  return null;
}

export function buildSessionDirectorySearchClaims(
  subject: RelayAuthTokenClaims,
  env: IssuerEnv,
  nowSeconds: number,
  jti: string,
): SessionDirectorySearchClaims {
  const issuer = resolveSessionDirectoryIssuer(env);
  if (!issuer) {
    throw new SigningKeyConfigError("RELAYAUTH_SESSION_DIRECTORY_ISSUER must be set");
  }
  return {
    iss: issuer,
    aud: SESSION_DIRECTORY_SEARCH_AUDIENCE,
    sub: subject.sponsorId ?? subject.sub,
    role: SESSION_DIRECTORY_SEARCH_ROLE,
    app_metadata: {
      org_id: normalizeTenantId(subject.org.trim()),
      workspace_ids: [normalizeTenantId(subject.wks.trim())],
    },
    iat: nowSeconds,
    nbf: nowSeconds,
    // A search token never outlives the token it came from.
    exp: Math.min(nowSeconds + SESSION_DIRECTORY_SEARCH_TOKEN_TTL_SECONDS, subject.exp),
    jti,
  };
}

export async function signSessionDirectorySearchToken(
  claims: SessionDirectorySearchClaims,
  env: IssuerEnv,
): Promise<string> {
  const keyEnv = issuerKeyEnv(env);
  const privateKeyPem = resolveCurrentPrivateKeyPem(keyEnv);
  const publicJwk = await resolveCurrentPublicJwk(keyEnv);
  if (!privateKeyPem || !publicJwk) {
    throw new SigningKeyConfigError("RELAYAUTH_SESSION_DIRECTORY_SIGNING_KEY_PEM must be set");
  }
  return signRs256(claims, privateKeyPem, publicJwk.kid);
}
