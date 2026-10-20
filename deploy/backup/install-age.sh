#!/usr/bin/env bash
# Ставит age, если его нет: сначала пакет ОС, иначе официальный релиз FiloSottile/age.
# Для релиза обязательна контрольная сумма архива (AGE_SHA256, из страницы релиза): без неё не ставим.
#   AGE_VERSION=v1.2.1 AGE_SHA256=<sha256 linux-amd64 архива> deploy/backup/install-age.sh [каталог, по умолчанию /usr/local/bin]
set -euo pipefail
if command -v age >/dev/null && command -v age-keygen >/dev/null; then age --version; exit 0; fi

if command -v apt-get >/dev/null && [ "$(id -u)" = 0 ] && apt-get install -y age >/dev/null 2>&1; then age --version; exit 0; fi

: "${AGE_VERSION:?нет пакета age в ОС: укажите AGE_VERSION (например v1.2.1)}"
: "${AGE_SHA256:?нужна контрольная сумма архива релиза (AGE_SHA256)}"
DEST="${1:-/usr/local/bin}"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
ARCHIVE="age-${AGE_VERSION}-linux-amd64.tar.gz"
curl -fsSL -o "$TMP/$ARCHIVE" "https://github.com/FiloSottile/age/releases/download/${AGE_VERSION}/${ARCHIVE}"
echo "${AGE_SHA256}  $TMP/$ARCHIVE" | sha256sum -c -
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
install -m 0755 "$TMP/age/age" "$TMP/age/age-keygen" "$DEST/"
"$DEST/age" --version
