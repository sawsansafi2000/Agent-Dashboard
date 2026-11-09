#!/bin/sh
set -eu

mkdir -p /app/data
chown -R node:node /app/data

if [ -z "${INTERNAL_AGENT_API_TOKEN:-}" ]; then
    INTERNAL_AGENT_API_TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
    export INTERNAL_AGENT_API_TOKEN
fi

exec dumb-init -- su-exec node "$@"