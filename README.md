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

### Verify a token

```ts
import { TokenVerifier } from "@relayauth/core";

const verifier = new TokenVerifier({ signingKey: process.env.SIGNING_KEY! });
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
SIGNING_KEY=my-secret \
RELAYAUTH_SUB=review-agent \
RELAYAUTH_SCOPES_JSON='["relayfile:fs:read:/github/*", "relayfile:fs:write:/github/*/reviews/*"]' \
  ./scripts/generate-dev-token.sh
```

### Run the server

```bash
npm install
SIGNING_KEY=my-secret npm run start
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
