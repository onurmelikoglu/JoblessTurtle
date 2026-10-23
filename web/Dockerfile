# Web imajı: React arayüzü (/) + Caddy (/api ters vekil).
# Derleme bağlamı depo köküdür: docker compose build web

FROM node:22-bookworm-slim AS ui
WORKDIR /src
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ .
COPY browser-extension/manifest.json /browser-extension/manifest.json
RUN npm run build

FROM alpine:3.20 AS site
RUN apk add --no-cache brotli zstd zip
COPY --from=ui /src/dist /site
COPY browser-extension /extension
# Profilim › Tarayıcı eklentisi › Eklentiyi indir: Chrome'a "Paketlenmemiş öğe yükle" ile kurulan klasörün zip'i.
RUN mkdir -p /site/downloads && cd /extension && zip -qr -X /site/downloads/jobless-turtle-extension.zip . -x '*.md' '*.pem' '*.crx' '.*' '*/.*'
COPY web/assemble.sh /usr/local/bin/assemble.sh
RUN sh /usr/local/bin/assemble.sh /site

FROM caddy:2-alpine
COPY --from=site /site /srv
COPY web/Caddyfile /etc/caddy/Caddyfile
EXPOSE 80
