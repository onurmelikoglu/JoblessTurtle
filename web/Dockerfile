# Web imajı: React arayüzü (/) + Caddy (/api ters vekil).
# Derleme bağlamı depo köküdür: docker compose build web

FROM node:22-bookworm-slim AS ui
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
RUN npm run build

FROM alpine:3.20 AS site
RUN apk add --no-cache brotli zstd
COPY --from=ui /src/dist /site
COPY web/assemble.sh /usr/local/bin/assemble.sh
RUN sh /usr/local/bin/assemble.sh /site

FROM caddy:2-alpine
COPY --from=site /site /srv
COPY web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
