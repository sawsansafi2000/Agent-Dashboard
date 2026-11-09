FROM caddy:2-builder-alpine AS builder

ENV GOPROXY=https://proxy.golang.org|direct

RUN xcaddy build --with github.com/corazawaf/coraza-caddy/v2

FROM caddy:2-alpine

COPY --from=builder /usr/bin/caddy /usr/bin/caddy
