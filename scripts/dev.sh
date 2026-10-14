#!/usr/bin/env bash
# Docker olmadan yerel çalıştırma: PostgreSQL 16 ve Redis 7 bilgisayarda kurulu olmalı.
# Kullanım: ./scripts/dev.sh           (API + worker + web, http://localhost:8080)
#           SEED_DEMO=true ./scripts/dev.sh
# Claude Code CLI köprüsü bu modda doğrudan çalışır (worker bilgisayarınızda, kendi `claude` girişinizle).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -f .env ]; then set -a; . ./.env; set +a; fi
export DATABASE_URL="${DATABASE_URL:-postgresql://${POSTGRES_USER:-jobtrack}:${POSTGRES_PASSWORD:-jobtrack}@localhost:5432/${POSTGRES_DB:-jobtrack}}"
export REDIS_URL="${REDIS_URL:-redis://localhost:6379}"
export PORT="${WEB_PORT:-8080}"
export APP_PUBLIC_URL="${APP_PUBLIC_URL:-http://localhost:$PORT}"
export STORAGE_DIR="${STORAGE_DIR:-$ROOT/backend/storage}"
export WEB_DIR="$ROOT/web/dist"

command -v node >/dev/null || { echo "Node.js 20+ gerekli"; exit 1; }
pg_isready -d "$DATABASE_URL" >/dev/null 2>&1 || { echo "PostgreSQL'e ulaşılamıyor: $DATABASE_URL"; exit 1; }
redis-cli -u "$REDIS_URL" ping >/dev/null 2>&1 || { echo "Redis'e ulaşılamıyor: $REDIS_URL"; exit 1; }

cd backend
[ -d node_modules ] || npm ci
npm run build
npx prisma migrate deploy
if [ "${SEED_DEMO:-false}" = "true" ]; then node dist/prisma/seed.js; fi

if [ ! -f "$WEB_DIR/index.html" ]; then
  (cd "$ROOT/web" && { [ -d node_modules ] || npm ci; } && npm run build)
fi

trap 'kill 0' INT TERM EXIT
node dist/src/main.js &
sleep 3
node dist/src/worker.js &
echo "Hazır: $APP_PUBLIC_URL  (API dokümantasyonu: $APP_PUBLIC_URL/api/docs)"
wait
