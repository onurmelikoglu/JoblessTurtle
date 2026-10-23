#!/usr/bin/env bash
# Jobless Turtle — tek komutla kurulum ve güncelleme.
#
#   ./install.sh            Kur ve başlat (.env yoksa gizli anahtarları üretip oluşturur)
#   ./install.sh update     Hazır imajların yenisini indirip uygulamayı günceller
#   ./install.sh status     Servislerin durumunu gösterir
#   ./install.sh stop       Uygulamayı durdurur (veriler silinmez)
#
# Depo klonlanmadan da çalışır:
#   curl -fsSL https://raw.githubusercontent.com/onurmelikoglu/JoblessTurtle/main/install.sh | bash
#
# Ortam değişkenleri (isteğe bağlı): JT_PORT (varsayılan 8080), JT_DIR (klonsuz kurulumda klasör), JT_BUILD=1 (imajları
# indirmek yerine bu bilgisayarda derle), JT_NO_OPEN=1 (tarayıcıyı açma).
set -euo pipefail

REPO="onurmelikoglu/JoblessTurtle"
IMAGE_PREFIX="ghcr.io/onurmelikoglu/jobless-turtle"
DEFAULT_PORT=8080

say() { printf '\033[1;32m▸\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

ask() {
  local question="$1" default="$2" answer=""
  if [ -z "${JT_YES:-}" ] && (exec < /dev/tty) 2> /dev/null; then
    printf '%s [%s]: ' "$question" "$default" > /dev/tty 2> /dev/null || true
    read -r answer < /dev/tty || answer=""
  fi
  printf '%s' "${answer:-$default}"
}

random_base64() { head -c "$1" /dev/urandom | base64 | tr -d '\n'; }
random_hex() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }

# .env içinde KEY=değer satırını yazar (yoksa ekler). Değerler base64 olabileceği için sed yerine awk kullanılır.
set_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  awk -v k="$key" -v v="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" k "=" { print k "=" v; done = 1; next }
    { print }
    END { if (!done) print k "=" v }
  ' .env > "$tmp"
  cat "$tmp" > .env
  rm -f "$tmp"
}

get_env() { grep -E "^$1=" .env 2>/dev/null | tail -n1 | cut -d= -f2- || true; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

open_browser() {
  [ -n "${JT_NO_OPEN:-}" ] && return 0
  if command -v open > /dev/null 2>&1; then open "$1" > /dev/null 2>&1 || true
  elif command -v xdg-open > /dev/null 2>&1; then xdg-open "$1" > /dev/null 2>&1 || true
  fi
}

check_docker() {
  command -v docker > /dev/null 2>&1 || die "Docker bulunamadı. Önce Docker Desktop'u kur: https://docs.docker.com/get-docker/ (Linux'ta: https://docs.docker.com/engine/install/)"
  docker info > /dev/null 2>&1 || die "Docker çalışmıyor. Docker Desktop'u aç (ya da Linux'ta: sudo systemctl start docker) ve tekrar dene."
  docker compose version > /dev/null 2>&1 || die "Docker Compose v2 gerekli ('docker compose' komutu). Docker Desktop'u güncelle ya da compose eklentisini kur."
}

# Depo klonlanmadan (curl | bash) çalıştırıldıysa kaynak dosyaları indirip o klasörde devam eder.
ensure_project_dir() {
  local here
  here="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2> /dev/null && pwd || pwd)"
  if [ -f "$here/docker-compose.yml" ] && [ -f "$here/.env.example" ]; then
    cd "$here"
    return
  fi
  local target="${JT_DIR:-$PWD/jobless-turtle}"
  if [ ! -f "$target/docker-compose.yml" ]; then
    say "Dosyalar indiriliyor → $target"
    mkdir -p "$target"
    if command -v git > /dev/null 2>&1; then
      git clone --depth 1 "https://github.com/$REPO.git" "$target" > /dev/null 2>&1 || die "Depo indirilemedi: https://github.com/$REPO"
    else
      curl -fsSL "https://github.com/$REPO/archive/refs/heads/main.tar.gz" | tar -xz -C "$target" --strip-components 1 || die "Depo indirilemedi: https://github.com/$REPO"
    fi
  fi
  cd "$target"
}

create_env() {
  if [ -f .env ]; then
    say ".env zaten var; gizli anahtarlara dokunulmuyor."
    [ -n "$(get_env BACKEND_IMAGE)" ] || set_env BACKEND_IMAGE "$IMAGE_PREFIX-backend:latest"
    [ -n "$(get_env WEB_IMAGE)" ] || set_env WEB_IMAGE "$IMAGE_PREFIX-web:latest"
    return
  fi

  local port="${JT_PORT:-}"
  if [ -z "$port" ]; then
    port="$DEFAULT_PORT"
    while port_in_use "$port"; do port=$((port + 1)); done
    port="$(ask "Uygulama hangi portta açılsın?" "$port")"
  fi
  case "$port" in '' | *[!0-9]*) die "Geçersiz port: $port" ;; esac
  port_in_use "$port" && die "$port portu kullanımda. Başka bir port seç (JT_PORT=8090 ./install.sh)."

  say ".env oluşturuluyor (gizli anahtarlar bu bilgisayarda rastgele üretilir)"
  cp .env.example .env
  chmod 600 .env
  set_env WEB_PORT "$port"
  set_env APP_PUBLIC_URL "http://localhost:$port"
  set_env POSTGRES_PASSWORD "$(random_hex 24)"
  set_env JWT_SECRET "$(random_base64 48)"
  set_env APP_ENCRYPTION_KEY "$(random_base64 32)"
  set_env WEBHOOK_SECRET "$(random_hex 24)"
  set_env INSTALL_AI_CLI true
  set_env BACKEND_IMAGE "$IMAGE_PREFIX-backend:latest"
  set_env WEB_IMAGE "$IMAGE_PREFIX-web:latest"
}

fetch_images() {
  if [ -n "${JT_BUILD:-}" ]; then
    say "İmajlar bu bilgisayarda derleniyor (10-20 dakika sürebilir, ~10 GB boş alan gerekir)"
    docker compose build api web
    return
  fi
  say "Hazır imajlar indiriliyor"
  if ! docker compose pull postgres redis api worker web; then
    warn "Hazır imajlar indirilemedi; bu bilgisayarda derlenecek (10-20 dakika, ~10 GB boş alan)."
    docker compose build api web
  fi
}

wait_until_ready() {
  local url="$1" i
  say "Uygulama başlatılıyor (ilk açılışta veritabanı hazırlanır, 1-2 dakika sürebilir)"
  for i in $(seq 1 90); do
    if curl -fsS "$url/api/health" > /dev/null 2>&1; then return 0; fi
    sleep 2
  done
  warn "Uygulama 3 dakikada yanıt vermedi. Kayıtlar için: docker compose logs api"
  return 1
}

install() {
  check_docker
  ensure_project_dir
  create_env
  fetch_images
  docker compose up -d
  local url="http://localhost:$(get_env WEB_PORT)"
  if wait_until_ready "$url"; then
    open_browser "$url"
    cat << EOF

  Jobless Turtle hazır: $url

  • İlk kayıt olan kullanıcı sunucu yöneticisidir.
  • Kayıttan sonra Profilim › Kurulum bölümünden Claude/ChatGPT hesabını bağlayabilir ve tarayıcı eklentisini
    kurabilirsin; terminal gerekmez.
  • Güncellemek için: ./install.sh update   Durdurmak için: ./install.sh stop
  • .env dosyasındaki APP_ENCRYPTION_KEY kaybolursa bağlı hesaplar yeniden bağlanmalıdır; dosyanın yedeğini sakla.

EOF
  fi
}

update() {
  check_docker
  ensure_project_dir
  [ -f .env ] || die ".env bulunamadı; önce ./install.sh ile kur."
  if [ -d .git ] && command -v git > /dev/null 2>&1; then
    say "Kurulum dosyaları güncelleniyor"
    git pull --ff-only || warn "git pull yapılamadı (yerel değişiklik olabilir); mevcut dosyalarla devam ediliyor."
  fi
  create_env
  fetch_images
  docker compose up -d --no-deps api worker web
  docker image prune -f > /dev/null 2>&1 || true
  wait_until_ready "http://localhost:$(get_env WEB_PORT)" && say "Güncellendi."
}

case "${1:-install}" in
  install) install ;;
  update) update ;;
  status) ensure_project_dir; docker compose ps ;;
  stop) ensure_project_dir; docker compose stop ;;
  *) die "Bilinmeyen komut: $1 (install | update | status | stop)" ;;
esac
