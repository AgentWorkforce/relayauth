# relayauth Architecture

## Overview

relayauth is the identity and authorization plane for the Agent Relay ecosystem.
One identity, one token, scoped access across all planes.

## Core Concepts

### Identity
An agent identity (`agent_xxxx`) represents a single agent across all planes.
Identities belong to an organization and operate within workspaces.

### Token
JWTs signed by relayauth, validated at the edge by any plane.
Contains: identity, org, workspace, scopes, expiry.

### Scopes
Fine-grained capabilities: `{plane}:{resource}:{action}:{path?}`
- `relaycast:channel:read:*`
- `relayfile:fs:write:/src/api/*`
- `cloud:workflow:run`

### RBAC Roles
Named bundles of scopes: `backend-developer`, `reviewer`, `admin`.
Assigned per-workspace.

### Policies
Rules evaluated at authorization time:
- Allow/deny based on identity, role, resource, time, IP
- Hierarchical: org → workspace → agent

### Audit Log
Every token use, scope check, and admin action is logged.
Queryable, exportable, retention-configurable.

## Infrastructure

- Cloudflare Workers: API + edge validation
- KV: revocation list (global, <1s propagation)
- Durable Objects: per-identity state, session tracking
- D1: audit logs, policies, org/workspace metadata
- JWKS: public keys at /.well-known/jwks.json

## Components

### Public repo (relayauth)
1. Token format spec
2. SDK: @relayauth/sdk (TS), relayauth (Go middleware)
3. CLI: relayauth
4. Verification library
5. RBAC policy format
6. OpenAPI spec
7. Docs + landing page

### Private repo (relayauth-cloud)
1. CF Workers server
2. Identity DO
3. Token issuance + signing
4. Revocation engine
5. RBAC engine
6. Audit pipeline
7. Key management
8. Admin console

## Workflow Domains

### Domain 1: Foundation (workflows 001-010)
Project scaffolding, spec, types, test infrastructure

### Domain 2: Token System (workflows 011-020)
JWT issuance, validation, refresh, revocation, JWKS

### Domain 3: Identity Lifecycle (workflows 021-030)
Create, read, update, suspend, retire, delete agents

### Domain 4: Scopes & RBAC (workflows 031-040)
Scope format, validation, roles, policies, inheritance

### Domain 5: API Routes (workflows 041-050)
All HTTP endpoints, middleware, error handling

### Domain 6: Audit & Observability (workflows 051-058)
Logging pipeline, query API, export, retention

### Domain 7: SDK & Verification (workflows 059-068)
TS SDK, Go middleware, Python SDK, verification library

### Domain 8: CLI (workflows 069-075)
Agent management, token operations, audit queries

### Domain 9: Integration (workflows 076-082)
relaycast integration, relayfile integration, cloud integration

### Domain 10: Hosted Server (workflows 083-090)
CF Workers, DOs, KV, D1, deployment

### Domain 11: Testing & CI (workflows 091-096)
E2E tests, contract tests, CI/CD, npm publish

### Domain 12: Docs & Landing (workflows 097-100)
Docs, guides, landing page, README
