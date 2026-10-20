#!/usr/bin/env bash
# CI: миграции с нуля дважды и проверка контрольных сумм (D-059).
# Требует MIGRATE_DATABASE_URL (или DATABASE_URL) на пустую БД.
set -euo pipefail

first=$(npm run --silent db:migrate)
echo "$first"
second=$(npm run --silent db:migrate)
echo "$second"
if ! grep -q 'Новых миграций нет' <<<"$second"; then
  echo "::error::Второй прогон db:migrate применил миграции (не идемпотентно)" >&2
  exit 1
fi
# db:status: код 0 — всё накатано, 3 — есть ненакатанные, 4 — применённый файл изменён
npm run --silent db:status
