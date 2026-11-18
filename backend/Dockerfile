# Jobless Turtle — backend imajı (API ve worker aynı imajdan farklı komutla çalışır)
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY prisma ./prisma
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates tini && rm -rf /var/lib/apt/lists/*
# İyileştirilmiş CV'yi orijinal tasarımla PDF'e çevirmek için Chromium; CV fotoğrafını çıkarmak için poppler
RUN apt-get update && apt-get install -y --no-install-recommends chromium poppler-utils fonts-dejavu-core && rm -rf /var/lib/apt/lists/* && chromium --version && pdfimages -v
ENV CHROMIUM_PATH=/usr/bin/chromium
# İsteğe bağlı: worker içinde Claude Code / Codex / Cursor CLI köprüsü (kişisel abonelikle giriş gerekir; docs/SETUP.md)
ARG INSTALL_AI_CLI=false
RUN if [ "$INSTALL_AI_CLI" = "true" ]; then \
      npm i -g @anthropic-ai/claude-code @openai/codex && \
      if ! claude --version >/dev/null 2>&1; then \
        case "$(uname -m)" in aarch64) plat=linux-arm64 ;; *) plat=linux-x64 ;; esac && \
        root="$(npm root -g)/@anthropic-ai/claude-code" && \
        ver="$(node -p "require('$root/package.json').version")" && \
        npm i -g "@anthropic-ai/claude-code-$plat@$ver" && \
        node "$root/install.cjs"; \
      fi && \
      claude --version && codex --version && \
      apt-get update && apt-get install -y --no-install-recommends curl && \
      HOME=/opt/cursor bash -c 'curl -fsS https://cursor.com/install | bash' && \
      ln -sf "$(readlink -f /opt/cursor/.local/bin/cursor-agent)" /usr/local/bin/cursor-agent && \
      chmod -R a+rX /opt/cursor && \
      apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/* && \
      cursor-agent --version; \
    fi
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY package.json ./
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data/storage && chown -R node:node /data /app
USER node
ENV STORAGE_DIR=/data/storage PORT=3000
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--", "docker-entrypoint.sh"]
CMD ["api"]
