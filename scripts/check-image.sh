#!/usr/bin/env bash
# Проверка поставляемого содержимого (ARCHITECTURE §8.2, п. 4): в образе нет карт кода, src/, *.ts,
# packages/core/src, tests/, .git. Нарушение — выход 1 (шаг CI роняет сборку).
#
#   scripts/check-image.sh <образ>            проверка образа (нужен docker)
#   scripts/check-image.sh --dir <каталог>    проверка каталога (например, .next/standalone + dist)
#                                             без docker: тот же набор правил
set -euo pipefail

usage() { echo "usage: $0 <image> | --dir <path>" >&2; exit 2; }
[ $# -ge 1 ] || usage

cleanup() { [ -n "${tmp:-}" ] && rm -rf "$tmp"; [ -n "${cid:-}" ] && docker rm -f "$cid" >/dev/null 2>&1 || true; }
trap cleanup EXIT

if [ "$1" = "--dir" ]; then
  [ $# -eq 2 ] && [ -d "$2" ] || usage
  root="$2"
else
  [ $# -eq 1 ] || usage
  tmp="$(mktemp -d)"
  cid="$(docker create "$1")"
  # Содержимое файловой системы образа без /proc, /sys, /dev
  # Прерванная распаковка (docker export упал, поток оборван, tar не дочитал) — не чистый образ: часть файлов не
  # проверена. pipefail: ненулевой код docker export или tar роняет всю цепочку
  if ! docker export "$cid" | tar -x -C "$tmp" --exclude='./proc' --exclude='./sys' --exclude='./dev'; then
    echo "НАРУШЕНИЕ: файловая система образа не извлечена (docker export или tar прерван)" >&2; echo "check-image: FAIL" >&2; exit 1
  fi
  # Пустой экспорт не должен выглядеть как чистый образ
  if [ ! -d "$tmp/app" ]; then echo "НАРУШЕНИЕ: файловая система образа не извлечена (нет /app)" >&2; echo "check-image: FAIL" >&2; exit 1; fi
  root="$tmp"
fi

fail=0
report() { # <что ищем> <найдено>
  if [ -n "$2" ]; then
    echo "НАРУШЕНИЕ: $1" >&2
    echo "$2" | head -20 | sed 's/^/  /' >&2
    fail=1
  fi
}

# Файлы TypeScript: *.ts, *.tsx, но не объявления типов *.d.ts внутри node_modules (их публикуют сами пакеты)
report "*.ts / *.tsx вне node_modules" \
  "$(find "$root" -path '*/node_modules' -prune -o -type f \( -name '*.ts' -o -name '*.tsx' \) -print)"
# Исходники продукта: src/ рядом с приложением (корень или /app) и packages/core/src
report "каталог src/ приложения" \
  "$(find "$root" -path '*/node_modules' -prune -o -type d -name src \( -path "$root/src" -o -path "$root/app/src" -o -path '*/packages/core/src' \) -print)"
# Пакеты продукта @crm/* в node_modules: в образе это ссылка на packages/<пакет> (Dockerfile). Если трассировка
# standalone положила туда каталог, `ln -sfn` его не заменит — исходники пакета остались бы под node_modules
report "исходники пакетов @crm/* в node_modules" \
  "$(find "$root" -path '*/node_modules/@crm/*' \( -type d -name src -o -type f \( -name '*.ts' -o -name '*.tsx' \) ! -name '*.d.ts' \) -print)"
report "tests/, .git, .github" \
  "$(find "$root" -path '*/node_modules' -prune -o -type d \( -name tests -o -name .git -o -name .github \) -print)"
# Карты кода: везде, включая node_modules (клиенту отдаём только то, что нужно)
report "*.map" "$(find "$root" -type f -name '*.map' -print)"
# Секреты и окружение
report "файлы окружения и ключей" \
  "$(find "$root" -type f \( -name '.env' -o -name '.env.*' -o -name '*.pem' -o -name '*.key' -o -name '*.age' \) -print)"

if [ "$fail" -ne 0 ]; then echo "check-image: FAIL" >&2; exit 1; fi
echo "check-image: OK ($1)"
