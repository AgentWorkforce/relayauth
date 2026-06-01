# relayauth

Scoped token issuance and permission enforcement for [relayfile](https://github.com/AgentWorkforce/relayfile). Control exactly what each agent can read, write, and access.

## Why

Agents need access to files. They shouldn't have access to *all* files. Relayauth issues scoped JWT tokens where the VFS paths are the permission boundaries:

```bash
# Code review agent: read PRs, write only reviews
relayfile:fs:read:/github/repos/acme/api/pulls/*
relayfile:fs:write:/github/repos/acme/api/pulls/*/reviews/*

# Support agent: Slack support channel only
relayfile:fs:read:/slack/channels/support/*
relayfile:fs:write:/slack/channels/support/messages/*

# Notion reader: specific pages, read-only
relayfile:fs:read:/notion/pages/product-roadmap/*
relayfile:fs:read:/notion/pages/eng-specs/*
```

No separate ACL config. The filesystem paths *are* the permissions.

## Quick Start

```bash
npm install @relayauth/sdk
```

## Proactive Runtime Token Contract

M1 for the proactive runtime uses a three-step token flow:

```ts
type WorkspaceTokenIssueRequest = {
  workspaceId: string;
  name?: string;
  scopes?: string[];
};

type AgentTokenIssueRequest = {
  agentId: string;
  scopes?: string[];
  audience?: string[];
  expiresIn?: number; // capped to 3600s server-side
};

type PathTokenIssueRequest = {
  agentId: string;
  workspaceId?: string;
  paths: string[];
  scopes?: string[];
  audience?: string[];
  expiresIn?: number;
  ttlSeconds?: number; // capped to 3600s server-side
};

type WorkspacePathTokenIssueRequest = {
  workspaceId: string;
  agentId?: string;
  agentName?: string;
  paths: string[];
  scopes?: string[];
  audience?: string[];
  ttlSeconds?: number; // capped to 3600s server-side
};
```

- `POST /v1/tokens/workspace` returns a long-lived `relay_ws_*` workspace token.
- `POST /v1/tokens/agent` accepts that workspace token via `x-api-key` and returns a short-lived `relay_ag_*` token pair for one `agentId`.
- `POST /v1/tokens/path` accepts that same workspace token via `x-api-key` or `Authorization: Bearer relay_ws_*` and returns a short-lived `relay_pa_*` token pair whose `relayfile:fs:*` scopes are intersected with the requested `paths`.
- `POST /v1/tokens/workspace-path` accepts an org API key plus an explicit `workspaceId` and returns a short-lived `relay_pa_*` token pair directly, without creating or returning a `relay_ws_*` workspace token.
- `POST /v1/tokens/refresh` rotates the current pair and preserves the agent-token lineage. Revoking the parent workspace token invalidates all derived agent tokens.

`paths` uses the same filesystem constraint model as `relayfile:fs:*` scopes: exact paths or trailing-prefix globs such as `/linear/issues/*`. For compatibility, `/linear/issues/**` is normalized to `/linear/issues/*` during issuance.

The TypeScript SDK includes an `AgentTokenSession` helper for transparent agent-token rotation:

```ts
import { AgentTokenSession, RelayAuthClient } from "@relayauth/sdk";

const client = new RelayAuthClient({
  baseUrl: "https://relayauth.example.com",
  apiKey: process.env.RELAY_API_KEY,
});

const session = new AgentTokenSession({
  client,
  agentId: "agent_support_runtime",
  scopes: ["relayauth:role:read:*"],
});

const accessToken = await session.getAccessToken();
```

### Verify a token

```ts
import { TokenVerifier } from "@relayauth/sdk";

const verifier = new TokenVerifier({
  jwksUrl: "https://relayauth.example.com/.well-known/jwks.json",
  issuer: "https://relayauth.dev",
});
const claims = await verifier.verify(token);
// claims.scopes → ["relayfile:fs:read:/github/*", "relayfile:fs:write:/github/*/reviews/*"]
```

### Check if a request is allowed

```ts
import { ScopeChecker } from "@relayauth/core";

const checker = new ScopeChecker(claims.scopes);

checker.check("relayfile:fs:read:/github/repos/acme/api/pulls/42/metadata.json");
// ✅ allowed

checker.check("relayfile:fs:write:/slack/channels/general/messages/reply.json");
// ❌ denied — agent only has GitHub access
```

### Generate a dev token

```bash
RELAYAUTH_SIGNING_KEY_PEM="$(cat private.pem)" \
RELAYAUTH_SUB=review-agent \
RELAYAUTH_SCOPES_JSON='["relayfile:fs:read:/github/*", "relayfile:fs:write:/github/*/reviews/*"]' \
  ./scripts/generate-dev-token.sh
```

### Run the server

```bash
npm install
RELAYAUTH_SIGNING_KEY_PEM="$(cat private.pem)" \
RELAYAUTH_SIGNING_KEY_PEM_PUBLIC="$(cat public.pem)" \
  npm run start
```

## Scope Format

Scopes follow `plane:resource:action:path`:

| Segment | Values | Example |
|---------|--------|---------|
| **plane** | `relayfile`, `relaycast`, `cloud`, `relayauth`, `*` | `relayfile` |
| **resource** | `fs`, `ops`, `admin`, `*` | `fs` |
| **action** | `read`, `write`, `create`, `delete`, `manage`, `*` | `read` |
| **path** | VFS path with wildcard support | `/github/repos/acme/*` |

`manage` implies `read` + `write` + `create` + `delete`.

Path matching: `/github/repos/acme/*` matches any file under that prefix.

## Packages

| Package | npm | Description |
|---------|-----|-------------|
| `@relayauth/core` | [![npm](https://img.shields.io/npm/v/@relayauth/core)](https://www.npmjs.com/package/@relayauth/core) | Scope parsing, matching, token verification |
| `@relayauth/sdk` | [![npm](https://img.shields.io/npm/v/@relayauth/sdk)](https://www.npmjs.com/package/@relayauth/sdk) | TypeScript SDK client |
| `@relayauth/server` | — | Express-compatible auth server |
| `@relayauth/types` | [![npm](https://img.shields.io/npm/v/@relayauth/types)](https://www.npmjs.com/package/@relayauth/types) | Shared TypeScript types |
| `@relayauth/ai` | — | AI-aware permission helpers |
| `relayauth` (CLI) | — | Token generation and management |
| Python SDK | — | `packages/sdk/python/` |
| Go middleware | — | `packages/go-middleware/` |

## How It Fits with Relayfile

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│   Agent      │────▶│  relayfile   │────▶│  relayauth   │
│              │     │  (VFS)       │     │  (verify +   │
│  read/write  │     │              │     │   enforce)   │
│  files       │     │  checks token│     │              │
└──────────────┘     │  on every    │     │  scopes map  │
                     │  request     │     │  to VFS paths│
                     └──────────────┘     └──────────────┘
```

1. Agent sends request with JWT token to relayfile
2. Relayfile passes the token to relayauth for verification
3. Relayauth checks the token's scopes against the requested path
4. If allowed, relayfile serves the file. If not, 403.

## ACL Files

Place `.relayfile.acl` files in any directory to set permissions that inherit downward:

```json
{
  "semantics": {
    "permissions": [
      "scope:relayfile:fs:read:*",
      "deny:agent:untrusted-bot"
    ]
  }
}
```

Rules:
- `scope:<scope>` — allow if token has matching scope
- `agent:<name>` — allow if JWT `agent_name` matches
- `deny:scope:<scope>` / `deny:agent:<name>` — explicit deny (overrides allow)
- Child rules append to parent rules (inheritance)

## Configuration

Relayauth supports config files for managing agents, roles, and ACLs declaratively:

```yaml
# relay.config.yaml
agents:
  review-bot:
    roles: [reviewer]
  support-bot:
    roles: [support]

roles:
  reviewer:
    scopes:
      - relayfile:fs:read:/github/*
      - relayfile:fs:write:/github/*/reviews/*
  support:
    scopes:
      - relayfile:fs:read:/slack/channels/support/*
      - relayfile:fs:write:/slack/channels/support/messages/*

acl:
  - path: /github
    rules:
      - scope:relayfile:fs:read:*
  - path: /slack/channels/support
    rules:
      - role:support
```

## Cloud

**[Relayfile Cloud](https://relayfile.dev/pricing)** manages token issuance, agent permissions, and scope enforcement. No self-hosting required.

## Development

```bash
npm install
npx turbo build
npx turbo test
```

## License

MIT
