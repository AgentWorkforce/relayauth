# Landing Page Plan — relayauth.dev

Tech: Astro + Tailwind CSS in `packages/landing/`. Single-page, static build.

## 1. Hero

- Headline: **"Auth for the agent era"**
- Subline: "One identity. Scoped tokens. Every action traced back to a human."
- Install: `npm install @relayauth/sdk`
- CTA buttons: "Get Started" → docs, "View on GitHub" → repo

## 2. Problem

- Agents hold long-lived secrets with broad access
- No audit trail when agent A spawns agent B spawns agent C
- Revoking access means rotating shared keys across every service
- Tagline: "Your agents have keys to everything. Do you know what they're doing?"

## 3. Features (4-panel grid)

1. **Scoped tokens** — `{plane}:{resource}:{action}:{path?}`. Least-privilege by default.
2. **Sponsor chain** — Every agent traces back to a human. `human → agent → sub-agent`.
3. **Instant revocation** — One call, global, <1s. Agent loses access everywhere.
4. **Behavioral budgets** — Rate limits, spending caps, auto-suspend at threshold.

## 4. Architecture Diagram

Horizontal flow diagram (SVG or Astro component):

```
Human sponsor → Agent identity → Scoped JWT → Edge verification → Scope + policy check → Plane action → Audit log
```

Show relayauth at center connecting to relaycast, relayfile, cloud planes.

## 5. Quick Start (3 steps)

```ts
// 1. Create an agent with scoped access
const agent = await auth.createAgent('billing-bot', {
  sponsor: 'jane@acme.com',
  scopes: ['stripe:orders:read', 'slack:channel:write:#billing'],
  budget: { maxActionsPerHour: 100 },
  ttl: '1h',
});

// 2. Protect any route
app.use('/api/orders', auth.protect({ scope: 'stripe:orders:read' }));

// 3. Revoke instantly
await auth.revoke('agent_8x2k');
```

Caption: "Works with any framework. Any language. Any cloud."

## 6. SDK Support (3 columns)

| Language   | Package                              | Features                          |
|------------|--------------------------------------|-----------------------------------|
| TypeScript | `@relayauth/sdk`                     | Verifier, Hono/Express middleware |
| Go         | `github.com/anthropics/relayauth-go` | Verifier, net/http middleware     |
| Python     | `relayauth`                          | Async client, FastAPI integration |

## 7. Self-host or Hosted

Two-column comparison:

- **Self-host**: `wrangler deploy` — runs on your Cloudflare account, you own the keys
- **Hosted**: `relayauth.dev` — managed service, zero infra, same API

Both use the same SDK. Switch with one env var.

## 8. Footer

- Links: GitHub, npm, Docs, API Reference, OpenAPI spec
- "Part of the Relay ecosystem" with logos: relaycast, relayfile
- Integration logos: LangChain, CrewAI, AutoGen, FastAPI, Express, Hono
- License: Apache-2.0
