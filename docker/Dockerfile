# syntax=docker/dockerfile:1
#
# RelayAuth Node server (packages/server) for self-hosting.
#
#   docker build -f docker/Dockerfile -t relayauth:local .
#   docker run -p 127.0.0.1:8787:8787 -v relayauth-data:/data \
#     -e INTERNAL_SECRET_FILE=/run/secrets/internal-secret \
#     -e RELAYAUTH_SIGNING_KEY_PEM_FILE=/run/secrets/signing-key.pem relayauth:local
#
# See docs/self-hosting.md for every environment variable.

ARG NODE_VERSION=22

FROM node:${NODE_VERSION}-bookworm-slim AS build
# better-sqlite3 falls back to a source build when no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
# Host umask may be 077; make sources world-readable for the non-root runtime.
RUN chmod -R go+rX /src
ENV npm_config_fund=false npm_config_audit=false
RUN npm ci --include-workspace-root \
      -w @relayauth/types -w @relayauth/sdk -w @relayauth/migrate -w @relayauth/server \
  && npx turbo build --filter=@relayauth/server...
# Production dependency tree only (workspace packages stay symlinked).
RUN rm -rf node_modules \
  && npm ci --omit=dev --include-workspace-root \
      -w @relayauth/types -w @relayauth/sdk -w @relayauth/migrate -w @relayauth/server

FROM node:${NODE_VERSION}-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    RELAYAUTH_DB_PATH=/data/relayauth.db
WORKDIR /app
COPY --from=build --chown=root:root /src/package.json ./package.json
COPY --from=build --chown=root:root /src/node_modules ./node_modules
COPY --from=build --chown=root:root /src/packages/types/package.json ./packages/types/package.json
COPY --from=build --chown=root:root /src/packages/types/dist ./packages/types/dist
COPY --from=build --chown=root:root /src/packages/sdk/typescript/package.json ./packages/sdk/typescript/package.json
COPY --from=build --chown=root:root /src/packages/sdk/typescript/dist ./packages/sdk/typescript/dist
COPY --from=build --chown=root:root /src/packages/migrate/package.json ./packages/migrate/package.json
COPY --from=build --chown=root:root /src/packages/migrate/dist ./packages/migrate/dist
COPY --from=build --chown=root:root /src/packages/server/package.json ./packages/server/package.json
COPY --from=build --chown=root:root /src/packages/server/dist ./packages/server/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "packages/server/dist/server.js"]
