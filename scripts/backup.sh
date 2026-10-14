#!/usr/bin/env bash
# Günlük yedek: PostgreSQL dökümü + belge deposu. Önerilen RPO 24 saat (cron ile günde bir çalıştırın).
# Kullanım: ./scripts/backup.sh [hedef-klasör]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="${1:-$ROOT/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p "$DEST"
cd "$ROOT"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
docker compose exec -T postgres pg_dump -U "${POSTGRES_USER:-jobtrack}" -d "${POSTGRES_DB:-jobtrack}" -Fc > "$DEST/db-$STAMP.dump"
docker compose run --rm --no-deps -v "$DEST:/backup" --entrypoint sh api -c "tar czf /backup/documents-$STAMP.tar.gz -C /data storage"
# Saklama: 14 günden eski yedekler silinir.
find "$DEST" -name 'db-*.dump' -mtime +14 -delete
find "$DEST" -name 'documents-*.tar.gz' -mtime +14 -delete
echo "Yedek alındı: $DEST (db-$STAMP.dump, documents-$STAMP.tar.gz)"
