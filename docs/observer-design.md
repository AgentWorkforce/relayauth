# RelayAuth Observer - Specification

## Overview

The RelayAuth Observer is a real-time dashboard for visualizing authentication and authorization events as they happen. Similar to the RelayCast observer that streams agent messages and activity, this observer provides live visibility into:

1. Token verification requests
2. Scope checks (allowed/denied)
3. Permission trees and agent capabilities
4. ACL evaluation flow

## Problem

Current testing/demos require:
- Making API calls manually
- Reading audit logs after the fact
- No real-time visibility into what's happening

## Goals

1. **Real-time visibility** - See auth events as they happen
2. **Educational** - Visually demonstrate how scopes work
3. **Debugging** - Quickly see why an agent was denied access
4. **Demo-friendly** - Make relayauth's power obvious in < 2 minutes

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│                        RelayAuth Server                          │
│                                                                  │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────┐  │
│  │ Token       │  │ Scope       │  │ Audit                   │  │
│  │ Verification│  │ Checker     │  │ Logger                  │  │
│  └──────┬──────┘  └──────┬──────┘  └───────────┬─────────────┘  │
│         │                │                     │                │
│         └────────────────┼─────────────────────┘                │
│                          │                                       │
│                   ┌──────▼──────┐                               │
│                   │ Event       │                               │
│                   │ Emitter     │◄──── SSE / WebSocket         │
│                   └─────────────┘                               │
└──────────────────────────┬──────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────┐
│                    Observer Dashboard                             │
│                                                                  │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌───────────┐  │
│  │ Live Feed  │  │ Scope      │  │ Agent      │  │ Timeline  │  │
│  │            │  │ Visualizer │  │ Map        │  │           │  │
│  └────────────┘  └────────────┘  └────────────┘  └───────────┘  │
└──────────────────────────────────────────────────────────────────┘
```

### Tech Stack

- **Server**: Hono with Server-Sent Events (SSE)
- **Dashboard**: Next.js (follow relaycast pattern)
- **Styling**: Tailwind CSS

## Events to Emit

### 1. Token Events
```typescript
{
  type: "token.verified",
  timestamp: "2026-04-21T10:30:00Z",
  payload: {
    sub: "review-agent-123",
    org: "acme-corp",
    scopes: ["relayfile:fs:read:/github/*", "relayfile:fs:write:/github/*/reviews/*"],
    expiresIn: 3600
  }
}
```

### 2. Scope Check Events (THE KEY EVENT)
```typescript
{
  type: "scope.check",
  timestamp: "2026-04-21T10:30:05Z",
  payload: {
    agent: "review-agent-123",
    requestedScope: "relayfile:fs:read:/github/repos/acme/api/pull/42",
    grantedScopes: [
      "relayfile:fs:read:/github/*",
      "relayfile:fs:write:/github/*/reviews/*"
    ],
    result: "allowed", // or "denied"
    matchedScope: "relayfile:fs:read:/github/*",
    evaluation: {
      plane: "relayfile",
      resource: "fs", 
      action: "read",
      path: "/github/repos/acme/api/pull/42"
    }
  }
}
```

### 3. Denied Events (with explanation)
```typescript
{
  type: "scope.denied",
  timestamp: "2026-04-21T10:30:05Z",
  payload: {
    agent: "support-agent-456",
    requestedScope: "relayfile:fs:read:/slack/channels/general",
    reason: "No matching scope - agent only has GitHub scopes",
    grantedScopes: [
      "relayfile:fs:read:/github/*"
    ]
  }
}
```

## UI Components

### 1. Live Event Feed (Main Panel)

Shows incoming events in real-time, newest first:

```
┌─────────────────────────────────────────────────────────────┐
│ LIVE EVENTS                              [🔴] Connected   │
├─────────────────────────────────────────────────────────────┤
│ 10:30:05  🔴 DENIED  review-agent tried                   │
│           /slack/channels/general                          │
│           Reason: No matching scope                        │
│                                                             │
│ 10:30:02  🟢 ALLOWED review-agent read                   │
│           /github/repos/acme/api/pull/42                  │
│           Matched: relayfile:fs:read:/github/*            │
│                                                             │
│ 10:30:00  🔵 VERIFIED review-agent token                 │
│           Scopes: read:/github/*, write:/github/*/reviews │
└─────────────────────────────────────────────────────────────┘
```

### 2. Scope Visualizer

When clicking an event, show the full scope evaluation:

```
┌─────────────────────────────────────────────────────────────┐
│ SCOPE EVALUATION                                            │
├─────────────────────────────────────────────────────────────┤
│ Requested: relayfile:fs:read:/slack/channels/general        │
│                                                             │
│ Agent's Scopes:                                             │
│ ├─ relayfile:fs:read:/github/*          ✗ No match        │
│ └─ relayfile:fs:write:/github/*/reviews ✗ No match        │
│                                                             │
│ Result: DENIED                                             │
│ Reason: Path /slack/ doesn't match /github/               │
└─────────────────────────────────────────────────────────────┘
```

### 3. Agent Permission Map

List all known agents and their permissions:

```
┌─────────────────────────────────────────────────────────────┐
│ AGENTS                                    [+ Add Test Agent] │
├─────────────────────────────────────────────────────────────┤
│ 🔵 review-agent                                          │
│    org: acme-corp                                        │
│    scopes:                                                │
│    ├─ relayfile:fs:read:/github/*                        │
│    └─ relayfile:fs:write:/github/*/reviews/*            │
│                                                             │
│ 🔵 support-agent                                          │
│    org: acme-corp                                         │
│    scopes:                                                │
│    ├─ relayfile:fs:read:/slack/channels/support/*        │
│    └─ relayfile:fs:write:/slack/channels/support/*        │
│                                                             │
│ 🔵 admin-bot                                              │
│    org: acme-corp                                         │
│    scopes:                                                │
│    ├─ relayfile:fs:*                                      │
│    └─ relayauth:admin:*                                   │
└─────────────────────────────────────────────────────────────┘
```

### 4. Demo Mode Panel

Quick actions to trigger common scenarios:

```
┌─────────────────────────────────────────────────────────────┐
│ DEMO SCENARIOS                          [▶ Run All]       │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│ 1. GitHub-only agent tries Slack        [▶ Try]           │
│ 2. Full-access admin accesses file     [▶ Try]            │
│ 3. Expired token verification           [▶ Try]            │
│ 4. Budget exceeded                     [▶ Try]             │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

## Implementation Steps

### Phase 1: Event Emission (Server)

1. **Add EventEmitter to server**
   - Create an event bus that can broadcast to SSE connections
   - Located in server/src/lib/events.ts

2. **Hook into existing verification flow**
   - In TokenVerifier or middleware, emit events
   - Emit `token.verified` on successful verification
   - Emit `scope.check` when checking scopes

3. **Add SSE endpoint**
   - `GET /v1/observer/events` - streams events
   - Include query params for filtering (orgId, event types)

### Phase 2: Observer Dashboard (Frontend)

1. **Create Next.js app** at `packages/observer`
   - Follow pattern from relaycast/observer-dashboard

2. **SSE Client**
   - Connect to `/v1/observer/events`
   - Handle reconnection

3. **UI Components**
   - EventFeed component
   - ScopeVisualizer component  
   - AgentMap component
   - DemoPanel component

### Phase 3: Demo Scripts

1. **Create demo script** at `scripts/observer-demo.ts`
   - Spawns multiple test agents
   - Makes various requests
   - Can be run standalone

2. **Generate test tokens**
   - Pre-configured tokens with different scope sets

## API Design

### SSE Endpoint

```
GET /v1/observer/events?orgId=xxx&types=scope.check,scope.denied

Response: text/event-stream

data: {"type":"scope.check","payload":{...}}
data: {"type":"scope.denied","payload":{...}}
```

### Event Types

| Event | Description |
|-------|-------------|
| `token.issued` | New token created |
| `token.verified` | Token verified successfully |
| `token.invalid` | Token verification failed |
| `scope.check` | Scope check performed |
| `scope.denied` | Scope denied (alias for scope.check with denied result) |
| `identity.created` | New identity/agent created |
| `budget.alert` | Budget threshold reached |

## Demo Scenarios

### Scenario 1: The GitHub Agent

```bash
# Agent with only GitHub scopes tries to access Slack
TOKEN=$(generate-token "review-agent" "relayfile:fs:read:/github/*")
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/v1/files/read?path=/slack/channels/general

# Observer shows:
# 🔴 DENIED - review-agent tried read:/slack/...
#    No matching scope - only has /github/*
```

### Scenario 2: The Admin

```bash
# Admin with full access
TOKEN=$(generate-token "admin" "relayfile:fs:*")
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:8787/v1/files/read?path=/any/path

# Observer shows:
# 🟢 ALLOWED - admin read:/any/path
#    Matched: relayfile:fs:*
```

## Local Development

### Option 1: Run both server + observer

```bash
# Terminal 1: Start relayauth server
npm run dev:server

# Terminal 2: Start observer dashboard
cd packages/observer
npm run dev  # runs on port 3101
```

### Option 2: Single command

```bash
npm run dev:observer  # starts both
```

## Configuration

```yaml
# relay.config.yaml
observer:
  enabled: true
  port: 3101
  events:
    - token.verified
    - scope.check
    - scope.denied
    - identity.created
```

## Success Metrics

1. Can see event appear in < 100ms of it happening
2. Scope visualization clearly shows why match/no-match
3. Demo scenarios complete in < 30 seconds each
4. Non-technical user understands scope matching in < 2 min

## File Structure

```
packages/observer/
├── package.json
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx
│   │   └── globals.css
│   ├── components/
│   │   ├── EventFeed.tsx
│   │   ├── ScopeVisualizer.tsx
│   │   ├── AgentMap.tsx
│   │   └── DemoPanel.tsx
│   ├── lib/
│   │   ├── sse-client.ts
│   │   └── events.ts
│   └── types/
│       └── index.ts
├── public/
└── next.config.js
```

## Open Questions

1. **WebSocket vs SSE** - SSE is simpler but WebSocket allows bidirectional. For now SSE is sufficient.

2. **Persistent storage** - Should observer show historical events? Could pull from audit API for last N events, then stream new ones.

3. **Authentication** - Observer needs an API key? For local demo, probably not. For production, yes.

4. **Multiple orgs** - Should observer support switching between orgs? Yes, dropdown in UI.

## Related

- relaycast/observer-dashboard - Reference implementation
- packages/server/src/routes/audit-query.ts - Existing audit queries
- packages/core/src/scope-checker.ts - Scope matching logic
