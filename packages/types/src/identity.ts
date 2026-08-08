export type IdentityStatus = "active" | "suspended" | "retired";

export type IdentityType = "agent" | "human" | "service";

/**
 * Purpose bound into a verified-human-principal grant.
 *
 * Known values include "identity.create" and "approval"; the server accepts
 * future lowercase, delimiter-separated values without requiring an SDK
 * release.
 */
export type SponsorProofIntent = string;

export type SponsorBinding =
  | {
      mode: "legacy";
    }
  | {
      mode: "oidc";
      issuer: string;
      subject: string;
      iat: number;
      jti?: string;
    };

export interface AgentIdentity {
  id: string;
  name: string;
  type: IdentityType;
  orgId: string;
  status: IdentityStatus;
  scopes: string[];
  roles: string[];
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  /** How the human sponsor was established when this identity was created. */
  sponsorBinding?: SponsorBinding;
  lastActiveAt?: string;
  suspendedAt?: string;
  suspendReason?: string;
}

export interface CreateIdentityInput {
  name: string;
  type?: IdentityType;
  scopes?: string[];
  roles?: string[];
  metadata?: Record<string, string>;
  workspaceId?: string;
  sponsorId?: string;
  /** Short-lived grant returned by POST /v1/sponsors/proof for OIDC-bound orgs. */
  sponsorProof?: string;
}

export interface CreateSponsorProofInput {
  idToken: string;
  intent: SponsorProofIntent;
}

export interface SponsorProof {
  sponsorId: string;
  sponsorProof: string;
  expiresAt: string;
  intent: SponsorProofIntent;
}
