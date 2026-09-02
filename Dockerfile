# Build in one stage, ship the compiled output plus production deps only.
FROM node:24-slim AS build
WORKDIR /app
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/gateway/package.json apps/gateway/
RUN pnpm install --frozen-lockfile

COPY . .
# --legacy: pnpm 10+ refuses a non-injected workspace deploy without it.
RUN pnpm build && pnpm --filter @crossbar/gateway deploy --prod --legacy /out


FROM node:24-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /out/node_modules ./node_modules
COPY --from=build /app/apps/gateway/dist ./dist
# Drizzle reads migration SQL from disk at startup.
COPY --from=build /app/apps/gateway/src/db/migrations ./dist/db/migrations

# Never run as root; PGlite needs a writable datadir when DATABASE_URL is unset.
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV CROSSBAR_PGLITE_DIR=/data/pglite

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
