#!/usr/bin/env bash
# Выполняется НА ВТОРОМ СЕРВЕРЕ от владельца каталога: ссылка с боевого сервера только пишет
# (rrsync -wo -no-del -no-overwrite) и стереть ничего не может, поэтому чистим здесь (DEPLOY 6.1).
# Остаётся: последняя часовая копия и ночные/недельные не старше KEEP_DAYS (по умолчанию 35).
#   deploy/backup/offsite-prune.sh /srv/crm-backups/in
set -euo pipefail
DIR="${1:?каталог с копиями}"
KEEP_DAYS="${KEEP_DAYS:-35}"
shopt -s nullglob

hourly=("$DIR"/crm-hourly-*.dump.age)
if ((${#hourly[@]} > 1)); then
  mapfile -t sorted < <(printf '%s\n' "${hourly[@]}" | sort)
  for f in "${sorted[@]:0:${#sorted[@]}-1}"; do rm -f -- "$f" "$f.sha256"; done
fi
find "$DIR" -maxdepth 1 -type f \( -name 'crm-daily-*.dump.age' -o -name 'crm-weekly-*.dump.age' \) -mtime "+$KEEP_DAYS" -print0 |
  while IFS= read -r -d '' f; do rm -f -- "$f" "$f.sha256"; done
