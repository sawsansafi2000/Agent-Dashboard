FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY agent-dashboard/package*.json ./agent-dashboard/
RUN npm --prefix agent-dashboard ci
COPY tsconfig.json guardrails.env ./
COPY src ./src
COPY test ./test
COPY agent-dashboard ./agent-dashboard
RUN npm run typecheck && npm test && npm --prefix agent-dashboard run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=3000
RUN apk add --no-cache dumb-init su-exec
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/guardrails.env ./guardrails.env
COPY --from=build /app/src ./src
COPY --from=build /app/agent-dashboard/node_modules ./agent-dashboard/node_modules
COPY --from=build /app/agent-dashboard/package.json ./agent-dashboard/package.json
COPY --from=build /app/agent-dashboard/dist ./agent-dashboard/dist
COPY --from=build /app/agent-dashboard/src/views ./agent-dashboard/src/views
COPY --from=build /app/agent-dashboard/src/public ./agent-dashboard/src/public
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /app/data && chown -R node:node /app/data
EXPOSE 3000
VOLUME ["/app/data"]
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "agent-dashboard/dist/server.js"]