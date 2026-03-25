# relayauth

## Local development

Copy the local secrets template, apply the local D1 migration, then start the worker:

```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev:server
```

The worker listens on `http://127.0.0.1:8787` and persists local Cloudflare state under `.wrangler/state`.

Generate a local admin token with:

```bash
npm run token:dev
```

Run the full local smoke path, including migration apply, worker boot, health/discovery checks, a role write/read, and an identity create/read:

```bash
npm run smoke:local
```
