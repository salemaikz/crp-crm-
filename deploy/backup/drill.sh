#!/usr/bin/env bash
# Учебное восстановление на синтетике (DEPLOY §6.3, первая строка таблицы): вся цепочка
# миграции → синтетика → копия с проверкой → расшифровка ключами обоих хранителей → восстановление.
# Ничего боевого: БД создаётся заново, ключи age — одноразовые во временной папке и удаляются.
#
#   ADMIN_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres deploy/backup/drill.sh [каталог отчёта]
# Выход: 0 — сошлось и уложились в 30 минут; иначе не 0. Отчёты: <каталог>/restore-keeper{1,2}.json, summary.md
set -euo pipefail

cd "$(dirname "$0")/../.."
: "${ADMIN_DATABASE_URL:?нужен ADMIN_DATABASE_URL (суперпользователь, БД postgres)}"
REPORT_DIR="${1:-drill-report}"
mkdir -p "$REPORT_DIR"
REPORT_DIR="$(cd "$REPORT_DIR" && pwd)"

SUFFIX="$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
SRC="crm_drill_src_${SUFFIX}"
WORK="$(mktemp -d)"
url_with_db() { node -e 'const u=new URL(process.argv[1]);u.pathname="/"+process.argv[2];console.log(u.toString())' "$ADMIN_DATABASE_URL" "$1"; }
SRC_URL="$(url_with_db "$SRC")"

cleanup() {
  psql -X -q "$ADMIN_DATABASE_URL" -c "DROP DATABASE IF EXISTS ${SRC} WITH (FORCE)" >/dev/null 2>&1 || true
  psql -X -q "$ADMIN_DATABASE_URL" -c "DROP DATABASE IF EXISTS crm_restorecheck_drill WITH (FORCE)" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

psql -X -q -v ON_ERROR_STOP=1 "$ADMIN_DATABASE_URL" -c "CREATE DATABASE ${SRC}"
MIGRATE_DATABASE_URL="$SRC_URL" npm run --silent db:migrate
psql -X -q -v ON_ERROR_STOP=1 -f deploy/backup/seed-synthetic.sql "$SRC_URL"

# Два «хранителя»: закрытые ключи только в $WORK
age-keygen -o "$WORK/keeper1.key" 2>/dev/null
age-keygen -o "$WORK/keeper2.key" 2>/dev/null
{
  echo "# владелец (учебный)";  age-keygen -y "$WORK/keeper1.key"
  echo "# директор (учебный)";  age-keygen -y "$WORK/keeper2.key"
} > "$WORK/recipients.txt"

export BACKUP_DATABASE_URL="$SRC_URL"
export BACKUP_DIR="$WORK/volume"
export BACKUP_RECIPIENTS_FILE="$WORK/recipients.txt"
export BACKUP_VERIFY_DB="crm_restorecheck_drill"
# Для проверки восстановления нужна суперпользовательская цель на том же сервере
npx tsx scripts/crmctl/backup.ts run --kind weekly --verify

FILE="$(ls "$BACKUP_DIR"/crm-weekly-*.dump.age)"
for n in 1 2; do
  npx tsx scripts/crmctl/restore.ts verify --file "$FILE" --identity "$WORK/keeper${n}.key" \
    --report "$REPORT_DIR/restore-keeper${n}.json"
done

node -e '
const fs = require("fs");
const dir = process.argv[1];
const rows = [1, 2].map((n) => {
  const r = JSON.parse(fs.readFileSync(`${dir}/restore-keeper${n}.json`, "utf8"));
  return `| хранитель ${n} | ${r.ok ? "сошлось" : "РАСХОЖДЕНИЯ"} | ${r.tables} | ${r.lastMigration} | ${(r.timings.totalMs / 1000).toFixed(1)} с |`;
});
const md = ["## Учебное восстановление (синтетика)", "", "| Ключ | Сверка | Таблиц | Последняя миграция | Время восстановления |", "|---|---|---|---|---|", ...rows, "", "Цель: не дольше 30 минут (DEPLOY 6.3)."].join("\n");
fs.writeFileSync(`${dir}/summary.md`, md + "\n");
console.log(md);
' "$REPORT_DIR"
