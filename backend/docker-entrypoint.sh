#!/bin/sh
set -e
ROLE="${1:-api}"
case "$ROLE" in
  api)
    # Şema göçleri yalnızca API başlarken uygulanır; worker API sağlıklı olunca başlar.
    npx prisma migrate deploy
    if [ "${SEED_DEMO:-false}" = "true" ]; then node dist/prisma/seed.js || true; fi
    exec node dist/src/main.js
    ;;
  worker)
    exec node dist/src/worker.js
    ;;
  migrate)
    exec npx prisma migrate deploy
    ;;
  seed)
    exec node dist/prisma/seed.js
    ;;
  *)
    exec "$@"
    ;;
esac
