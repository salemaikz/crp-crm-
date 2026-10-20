#!/usr/bin/env bash
# CI: в сборке нет карт кода (.map) — ARCHITECTURE §8, защита кода.
set -euo pipefail

[ -d .next ] || { echo "::error::Каталог .next не найден: сначала npm run build" >&2; exit 1; }
maps=$(find .next -name '*.map' -not -path '.next/cache/*' | head -20)
if [ -n "$maps" ]; then
  echo "::error::В .next найдены .map-файлы:" >&2
  echo "$maps" >&2
  exit 1
fi
echo "Карт кода (.map) в .next нет."
