export type IdentityStatus = "active" | "suspended" | "retired";

export type IdentityType = "agent" | "human" | "service";

export type SponsorBinding =
  | {
      mode: "legacy";
    }
  | {
      mode: "oidc";
      issuer: string;
      subject: string;
      issuedAt: number;
      tokenId?: string;
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
}

export interface SponsorProof {
  sponsorId: string;
  sponsorProof: string;
  expiresAt: string;
}
