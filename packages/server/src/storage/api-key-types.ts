export type StoredApiKey = {
  id: string;
  orgId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  createdAt: string;
  updatedAt: string;
  lastUsedAt?: string;
  revokedAt?: string | null;
};

export type CreateApiKeyInput = {
  orgId: string;
  name: string;
  prefix: string;
  keyHash: string;
  scopes: string[];
  createdAt?: string;
  updatedAt?: string;
};

export type ListApiKeysOptions = {
  limit?: number;
  cursorId?: string;
  includeRevoked?: boolean;
};
