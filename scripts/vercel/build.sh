#!/usr/bin/env bash
# Сборка на Vercel (npm run vercel-build, D-318, docs/ops/VERCEL.md).
# Режим стенда (VERCEL=1, CRM_STAND=1, VERCEL_ENV=production, общая сборка): ядро → проверка базы (пустая или
# синтетика) → миграции → синтетический сид → next build с признаком стенда в бандле. Иначе (в т. ч. preview) —
# обычная сборка, как npm run build, без миграций, сида и признака.
# Только тестовый стенд на синтетике: реальные данные клиентов на Vercel не кладутся (D-008).
# Секреты и адрес базы не печатаются: шаги получают их через stand-env.ts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TSX="$ROOT/node_modules/.bin/tsx"
say() { printf '[vercel-build] %s\n' "$*"; }
die() { printf '[vercel-build] Ошибка: %s\n' "$*" >&2; exit 1; }

say "Ядро…"
node packages/core/build.mjs

# Код 1 и текст причины печатает сам stand-env.ts (например, CRM_STAND=1 в сборке клиента); иное — сбой tsx
if ! MODE="$("$TSX" scripts/vercel/stand-env.ts mode)"; then
  die "не удалось определить режим сборки: scripts/vercel/stand-env.ts завершился с ошибкой (причина выше)"
fi
# Признак стенда в бандле ставит только этот скрипт; заданный в переменных проекта не действует
export CRM_VERCEL_STAND_BUILD=0

if [ "$MODE" = "preview" ]; then
  say "Preview-сборка (VERCEL_ENV=${VERCEL_ENV:-}): режим стенда не включается, миграций и сида нет — обычная сборка."
elif [ "$MODE" = "stand" ]; then
  say "Режим стенда на Vercel: только синтетика (+7 709 …), не для данных клиентов."
  if [ -z "${DATABASE_URL:-}${POSTGRES_URL:-}" ]; then
    die "нет базы: подключите Neon Postgres к проекту (Storage → Neon, регион Frankfurt) и пересоберите (docs/ops/VERCEL.md)"
  fi
  if [ -z "${CRM_SEED_PASSWORD:-}" ]; then
    die "не задан CRM_SEED_PASSWORD — общий пароль учёток стенда (от 8 символов, не из частых, не номер телефона). Задайте в Environment Variables и пересоберите"
  fi
  RUN=("$TSX" scripts/vercel/stand-env.ts run --)
  say "Проверка базы: пустая или только синтетика…"
  "${RUN[@]}" "$TSX" scripts/demo/precheck.ts || die "база не похожа на стенд — миграции и сид не запускались"
  say "Миграции…"
  "${RUN[@]}" "$TSX" scripts/db-migrate.ts || die "миграции не прошли"
  say "Синтетические данные (повторная сборка ничего не дублирует)…"
  "${RUN[@]}" "$TSX" scripts/crmctl/seed.ts --i-know-this-is-a-stand || die "сид не прошёл"
  # Ядро — в бандле функций (запасной вариант D-028): функции Vercel получают только трассированные файлы, и ссылку
  # node_modules/@crm/core → packages/core трассировка может не положить (в образе её страхует Dockerfile)
  export CRM_CORE_BUNDLE=1
  export CRM_VERCEL_STAND_BUILD=1
else
  say "Обычная сборка: без миграций и сида."
fi

say "next build…"
exec "$ROOT/node_modules/.bin/next" build --webpack
