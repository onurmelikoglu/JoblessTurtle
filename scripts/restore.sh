#!/usr/bin/env bash
# Geri yükleme (VPS taşıma veya geri yükleme testi). Önce worker'ı durdurun; iki sunucu aynı başvuruyu göndermemeli.
# Kullanım: ./scripts/restore.sh backups/db-XXXX.dump backups/documents-XXXX.tar.gz
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_DUMP="$1"; DOCS="$2"
cd "$ROOT"
if [ -f .env ]; then set -a; . ./.env; set +a; fi
read -r -p "Mevcut veritabanı ve belgeler bu yedekle DEĞİŞTİRİLECEK. Devam? (evet/hayır) " ans
[ "$ans" = "evet" ] || { echo "İptal edildi"; exit 1; }
docker compose stop worker api
docker compose exec -T postgres pg_restore -U "${POSTGRES_USER:-jobtrack}" -d "${POSTGRES_DB:-jobtrack}" --clean --if-exists < "$DB_DUMP"
docker compose run --rm --no-deps -v "$(cd "$(dirname "$DOCS")" && pwd):/backup" --entrypoint sh api -c "rm -rf /data/storage/* && tar xzf /backup/$(basename "$DOCS") -C /data"
docker compose up -d api worker
echo "Geri yükleme tamamlandı. Belirsiz (submission_unknown) gönderimleri Başvuru panosunda uzlaştırın."
