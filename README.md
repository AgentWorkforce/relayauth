# relayauth

Minimal local run notes:

## Landing page
```bash
cd packages/landing
npm install
npm run dev
```

## Full local worker
```bash
cp .dev.vars.example .dev.vars
npm install
npm run db:migrate:local
npm run dev:server
```
