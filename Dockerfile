FROM node:24-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci
COPY agent-dashboard/package*.json ./agent-dashboard/
RUN npm ci --prefix agent-dashboard
COPY agent-dashboard/src ./agent-dashboard/src
COPY tsconfig.json ./tsconfig.json
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY portal ./portal
COPY test ./test
RUN npm run build
RUN npm test

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_PATH=/app/data/dashboard.sqlite \
    RUN_AGENT_WORKER=true \
    AGENT_EXECUTION_MODE=local \
    AGENT_LOCAL_AUTOSTART=true \
    AGENT_AUTOSTART=false \
    AGENT_API_BUDGET_CENTS=0
RUN apk add --no-cache dumb-init su-exec libstdc++
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src ./src
COPY --from=build /app/dist ./dist
COPY --from=build /app/public ./public
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/portal ./portal
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data /app/backups && chown -R node:node /app/data /app/backups
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/server.cjs"]