import type { AppConfig } from "../env.js";
import { parseCredentialKeyring, type CredentialKeyring } from "./credential-keyring.js";

/**
 * Relaycast credential issuance ("model B"): RelayAuth holds the `ar_`
 * credential tag keyring, mints `ar_ws_` workspace keys, and pushes them into
 * relaycast through its caller-minted internal contract
 * (`POST /internal/workspaces/:id/api-key` with `{api_key, key_generation}`).
 */

export const RELAYCAST_ADMIN_SCOPE = "relayauth:relaycast:manage:*";
export const RELAYCAST_SERVICE_API_KEY_NAME = "bootstrap-relaycast-admin";
const PUSH_TIMEOUT_MS = 10_000;

type RelaycastEnv = Pick<
  AppConfig,
  | "RELAYAUTH_RELAYCAST_CREDENTIAL_KEYRING"
  | "RELAYAUTH_RELAYCAST_URL"
  | "RELAYAUTH_RELAYCAST_INTERNAL_SECRET"
>;

export class RelaycastConfigError extends Error {
  readonly code = "relaycast_not_configured";
  constructor(message: string) {
    super(message);
    this.name = "RelaycastConfigError";
  }
}

export type RelaycastConfig = {
  keyring: CredentialKeyring;
  url: string;
  internalSecret: string;
};

/**
 * The issuance configuration, or `undefined` when no relaycast binding is set
 * at all (the feature is simply off). A partially set or invalid configuration
 * throws — a deployment that asked for the feature must never mint with
 * defaults guessed for it.
 */
export function resolveRelaycastConfig(env: RelaycastEnv): RelaycastConfig | undefined {
  const keyringJson = env.RELAYAUTH_RELAYCAST_CREDENTIAL_KEYRING?.trim();
  const url = env.RELAYAUTH_RELAYCAST_URL?.trim();
  const internalSecret = env.RELAYAUTH_RELAYCAST_INTERNAL_SECRET?.trim();
  if (!keyringJson && !url && !internalSecret) {
    return undefined;
  }

  const missing = [
    ["RELAYAUTH_RELAYCAST_CREDENTIAL_KEYRING", keyringJson],
    ["RELAYAUTH_RELAYCAST_URL", url],
    ["RELAYAUTH_RELAYCAST_INTERNAL_SECRET", internalSecret],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new RelaycastConfigError(
      `relaycast credential issuance is partially configured; missing ${missing.join(", ")}`,
    );
  }

  let keyring: CredentialKeyring;
  try {
    keyring = parseCredentialKeyring(keyringJson!);
  } catch (error) {
    throw new RelaycastConfigError(
      `RELAYAUTH_RELAYCAST_CREDENTIAL_KEYRING is invalid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  try {
    new URL(url!);
  } catch {
    throw new RelaycastConfigError("RELAYAUTH_RELAYCAST_URL is not a valid URL");
  }

  return { keyring, url: url!, internalSecret: internalSecret! };
}

/**
 * Boot-time config check, in the `assertSigningKeyConfig` family: refuse to
 * start when issuance is half-configured rather than serving 503s later.
 * Called before every route resolution too, because Worker deployments have
 * no boot step.
 */
export function assertRelaycastConfig(env: RelaycastEnv): void {
  resolveRelaycastConfig(env);
}

export type RelaycastKeyPushInput = {
  apiKey: string;
  keyGeneration?: number;
  graceMs?: number;
};

export type RelaycastKeyPushResult = {
  workspaceId: string;
  apiKeyGeneration: number;
  /** True when the push created the workspace row in relaycast. */
  created: boolean;
};

/** The effectful boundary a test can replace: pushing a minted key into relaycast. */
export type RelaycastWorkspaceKeyPusher = {
  pushWorkspaceKey(workspaceId: string, input: RelaycastKeyPushInput): Promise<RelaycastKeyPushResult>;
};

/**
 * A failed push, carrying relaycast's own `{code, message}` so the route can
 * pass 4xx answers (e.g. `stale_key_generation` from the generation CAS)
 * through to the caller. Network failures use `relaycast_unreachable` at 502.
 */
export class RelaycastPushError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "RelaycastPushError";
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The production pusher: relaycast's `POST /internal/workspaces/:id/api-key` with the internal-secret bearer. */
export function createRelaycastKeyPusher(
  config: { url: string; internalSecret: string },
  fetchImpl: FetchLike = globalThis.fetch.bind(globalThis),
): RelaycastWorkspaceKeyPusher {
  const base = config.url.replace(/\/+$/, "");
  return {
    async pushWorkspaceKey(workspaceId, input) {
      let response: Response;
      try {
        response = await fetchImpl(
          `${base}/internal/workspaces/${encodeURIComponent(workspaceId)}/api-key`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${config.internalSecret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              api_key: input.apiKey,
              ...(input.keyGeneration === undefined ? {} : { key_generation: input.keyGeneration }),
              ...(input.graceMs === undefined ? {} : { grace_ms: input.graceMs }),
            }),
            signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
          },
        );
      } catch (error) {
        throw new RelaycastPushError(
          `relaycast is unreachable: ${error instanceof Error ? error.message : String(error)}`,
          "relaycast_unreachable",
          502,
        );
      }

      // Relaycast answers the `{ ok, data }` / `{ ok, error: {code, message} }`
      // envelope; tolerate a bare `{workspace_id, api_key_generation}` too.
      const body = (await response.json().catch(() => undefined)) as
        | {
          ok?: boolean;
          data?: { workspace_id?: string; api_key_generation?: number };
          error?: { code?: string; message?: string };
          workspace_id?: string;
          api_key_generation?: number;
        }
        | undefined;

      if (!response.ok || body?.ok === false) {
        const status = response.status >= 400 && response.status < 500 ? response.status : 502;
        throw new RelaycastPushError(
          body?.error?.message ?? `relaycast answered HTTP ${response.status}`,
          body?.error?.code ?? "relaycast_push_failed",
          status,
        );
      }

      const data = body?.data ?? body;
      return {
        workspaceId: data?.workspace_id ?? workspaceId,
        apiKeyGeneration: data?.api_key_generation ?? input.keyGeneration ?? 0,
        created: response.status === 201,
      };
    },
  };
}
