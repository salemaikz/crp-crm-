#!/usr/bin/env bash
# Демо-стенд CRM одной командой на синтетических данных (docs/ops/DEMO.md).
# Только для знакомства с продуктом на своём компьютере: НЕ для боевого сервера и НЕ с реальными данными.
#   scripts/demo/local.sh          — поднять (или показать, что уже работает) и напечатать адрес и учётки
#   scripts/demo/local.sh stop     — остановить приложение, воркер и контейнер (данные сохраняются)
#   scripts/demo/local.sh reset    — удалить контейнер, том и каталог .demo (следующий запуск — с нуля)
# Переменные: DEMO_PG_PORT (55432), DEMO_APP_PORT (3000), DEMO_DATABASE_URL (своя БД Postgres 16 — контейнер не нужен),
#             DEMO_REBUILD=1 (пересобрать приложение).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DEMO_DIR="$ROOT/.demo"
ENV_FILE="$DEMO_DIR/demo.env"
CONTAINER="crm-demo-pg"
VOLUME="crm-demo-pgdata"
PG_PORT="${DEMO_PG_PORT:-55432}"
APP_PORT="${DEMO_APP_PORT:-3000}"

say() { printf '%s\n' "$*"; }
die() { printf 'Ошибка: %s\n' "$*" >&2; exit 1; }

# Остановить процесс по pid-файлу вместе с дочерними
kill_pidfile() {
  local f="$1"
  [ -f "$f" ] || return 0
  local pid
  pid="$(cat "$f")"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    pkill -P "$pid" 2>/dev/null || true
    kill "$pid" 2>/dev/null || true
  fi
  rm -f "$f"
}

stop_all() {
  kill_pidfile "$DEMO_DIR/app.pid"
  kill_pidfile "$DEMO_DIR/worker.pid"
  if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
    docker stop "$CONTAINER" >/dev/null 2>&1 || true
  fi
}

case "${1:-up}" in
  stop)
    stop_all
    say "Демо остановлено. Данные сохранены; запуск — scripts/demo/local.sh"
    exit 0
    ;;
  reset)
    stop_all
    if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
      docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
      docker volume rm "$VOLUME" >/dev/null 2>&1 || true
    fi
    rm -rf "$DEMO_DIR"
    say "Демо удалено: контейнер, том и каталог .demo. Новый запуск создаст всё заново."
    exit 0
    ;;
  up) ;;
  *) die "неизвестная команда «$1» (есть: stop, reset)" ;;
esac

# --- 1. Требования ---
command -v node >/dev/null 2>&1 || die "не найден Node.js 22+ (https://nodejs.org)"
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 22 ] || die "нужен Node.js 22 или новее, сейчас $(node -v)"
if [ -z "${DEMO_DATABASE_URL:-}" ]; then
  command -v docker >/dev/null 2>&1 || die "не найден Docker (поставьте Docker Desktop) — или задайте DEMO_DATABASE_URL своей БД Postgres 16"
  docker info >/dev/null 2>&1 || die "Docker установлен, но не запущен: откройте Docker Desktop и повторите"
fi
if [ ! -d node_modules ]; then
  say "Ставлю зависимости (npm ci)…"
  npm ci
fi

mkdir -p "$DEMO_DIR"
chmod 700 "$DEMO_DIR"
# .demo/ содержит секреты демо: не даём закоммитить, даже если .gitignore подправили
if [ -d .git ] && ! git check-ignore -q "$DEMO_DIR/demo.env" 2>/dev/null; then
  die ".demo/ не закрыт в .gitignore — секреты демо могли бы попасть в репозиторий"
fi

rand() { node -e "process.stdout.write(require('crypto').randomBytes($1).toString('base64url'))"; }

# --- 2. Свободный порт Postgres и секреты ---
free_port() {
  node -e "
    const net=require('net');let p=+process.argv[1];
    const t=()=>{const s=net.createServer();s.once('error',()=>{p++;t()});s.listen(p,'127.0.0.1',()=>s.close(()=>console.log(p)))};t()" "$1"
}

if [ ! -f "$ENV_FILE" ]; then
  if [ -n "${DEMO_DATABASE_URL:-}" ]; then
    DB_URL="$DEMO_DATABASE_URL"
    PG_PORT=0
  else
    PG_PORT="$(free_port "$PG_PORT")"
    PG_PASS="$(rand 18)"
    DB_URL="postgres://crm:${PG_PASS}@127.0.0.1:${PG_PORT}/crm"
  fi
  umask 077
  cat > "$ENV_FILE" <<ENVEOF
# Локальные секреты демо-стенда: случайные, только для этого компьютера. Не коммитить.
DATABASE_URL=${DB_URL}
DEMO_PG_PORT=${PG_PORT}
DEMO_PG_PASSWORD=${PG_PASS:-}
APP_ORIGIN=http://localhost:${APP_PORT}
DEMO_APP_PORT=${APP_PORT}
CRM_STAND=1
CRM_PHONE_HMAC_KEY=$(rand 32)
CRM_IIN_HMAC_KEY=$(rand 32)
CRM_PROXY_SECRET=$(rand 32)
CRM_SEED_PASSWORD=Demo-$(rand 9)-7
FEATURE_REPORTS=1
FEATURE_SALES_SETTINGS=1
FEATURE_BK_WIZARD=1
FEATURE_PURCHASES=1
FEATURE_KANBAN=1
FEATURE_MERGE=1
FEATURE_BULK_TRANSFER=1
FEATURE_WAZZUP=0
ENVEOF
fi

set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
APP_PORT="$DEMO_APP_PORT"
# Часы и пояс: приложение считает в поясе установки (Asia/Almaty) само, но TZ процесса не мешает
unset NODE_OPTIONS

# --- 3. Postgres 16 ---
if [ -z "${DEMO_DATABASE_URL:-}" ]; then
  if ! docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER"; then
    say "Создаю контейнер $CONTAINER (Postgres 16, порт $DEMO_PG_PORT)…"
    docker run -d --name "$CONTAINER" \
      -e POSTGRES_USER=crm -e POSTGRES_PASSWORD="$DEMO_PG_PASSWORD" -e POSTGRES_DB=crm \
      -v "$VOLUME":/var/lib/postgresql/data \
      -p "127.0.0.1:${DEMO_PG_PORT}:5432" postgres:16 >/dev/null
  else
    docker start "$CONTAINER" >/dev/null
  fi
  say "Жду базу…"
  for _ in $(seq 1 60); do
    docker exec "$CONTAINER" pg_isready -U crm -d crm >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec "$CONTAINER" pg_isready -U crm -d crm >/dev/null 2>&1 || die "Postgres не поднялся (docker logs $CONTAINER)"
fi

# --- 4. Миграции и синтетический сид ---
say "Миграции…"
npm run --silent db:migrate
say "Синтетические данные (повторный запуск ничего не дублирует)…"
npx tsx scripts/crmctl/seed.ts --i-know-this-is-a-stand >"$DEMO_DIR/seed.log" 2>&1 || { cat "$DEMO_DIR/seed.log" >&2; die "сид не прошёл"; }

# --- 5. Сборка и запуск ---
if [ ! -f .next/BUILD_ID ] || [ "${DEMO_REBUILD:-0}" = "1" ]; then
  say "Собираю приложение (несколько минут при первом запуске)…"
  npm run build >"$DEMO_DIR/build.log" 2>&1 || { tail -30 "$DEMO_DIR/build.log" >&2; die "сборка не прошла (.demo/build.log)"; }
fi

running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# next start — это production: по http работает только для localhost (cookie без префикса __Host-, он нужен лишь для https)
if ! running "$DEMO_DIR/app.pid"; then
  say "Запускаю приложение на порту $APP_PORT…"
  nohup node_modules/.bin/next start -p "$APP_PORT" >"$DEMO_DIR/app.log" 2>&1 &
  echo $! >"$DEMO_DIR/app.pid"
fi
# Воркер: раздача лидов, создание мероприятий, уведомления
if ! running "$DEMO_DIR/worker.pid"; then
  nohup node_modules/.bin/tsx scripts/worker/index.ts >"$DEMO_DIR/worker.log" 2>&1 &
  echo $! >"$DEMO_DIR/worker.pid"
fi

for _ in $(seq 1 60); do
  curl -fsS "http://localhost:${APP_PORT}/api/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://localhost:${APP_PORT}/api/health" >/dev/null 2>&1 || die "приложение не отвечает (.demo/app.log)"

# --- 6. Итог ---
say ""
say "Демо готово: http://localhost:${APP_PORT}"
say "Вход по номеру телефона, пароль у всех один: ${CRM_SEED_PASSWORD}"
say ""
node_modules/.bin/tsx -e "
import { staffSpecs } from './scripts/seed/staff';
const R: Record<string,string> = { rop:'РОП', operator:'оператор', consultant:'консультант', director:'директор', marketing_head:'глава маркетинга' };
for (const s of staffSpecs(5)) {
  const role = s.admin ? 'администратор' : s.key === 'duty' ? 'дежурный (роль РОП)' : (R[s.role ?? ''] ?? s.role);
  const p = s.phone; console.log('  ' + role.padEnd(22) + '+' + p[0] + ' ' + p.slice(1,4) + ' ' + p.slice(4,7) + ' ' + p.slice(7,9) + ' ' + p.slice(9) + '  ' + s.name);
}"
say ""
say "Остановить: scripts/demo/local.sh stop · начать заново: scripts/demo/local.sh reset"
