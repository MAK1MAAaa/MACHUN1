FROM node:24-bookworm-slim AS dependencies
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
FROM dependencies AS build
COPY . .
RUN pnpm build

FROM dependencies AS production-dependencies
RUN pnpm prune --prod && rm -rf node_modules/.tmp node_modules/.vite

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/opt/playwright \
    MACHUN_LISTEN_HOST=0.0.0.0 \
    MACHUN_PORT=1650 \
    MACHUN_DATA_DIR=/data \
    MACHUN_BINDING_MODE=companion
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=production-dependencies /app/package.json ./
COPY --from=production-dependencies /app/node_modules ./node_modules
RUN node node_modules/playwright/cli.js install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /opt/playwright \
    && mkdir /data && chown node:node /data && chmod 700 /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/src ./src
COPY --from=build /app/db ./db
COPY --from=build /app/LICENSE ./LICENSE
COPY docker/entrypoint.sh /usr/local/bin/machun-entrypoint
RUN chmod 755 /usr/local/bin/machun-entrypoint
USER node
VOLUME ["/data"]
EXPOSE 1650
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:'+(process.env.MACHUN_PORT||1650)+'/healthz').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/machun-entrypoint"]
CMD ["node", "node_modules/tsx/dist/cli.mjs", "server/index.ts"]
