#!/bin/sh
set -eu

mkdir -p /app/data
chown -R node:node /app/data

exec dumb-init -- su-exec node "$@"