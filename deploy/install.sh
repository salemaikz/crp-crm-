#!/usr/bin/env bash
# Подготовка сервера (DEPLOY §4 п. 2). Запускает root ЦРП один раз:
#   sudo ./install.sh --package <каталог распакованного пакета> --domain crm.example.kz [--owner-user crmops]
# Ставит Docker, nginx, certbot, ufw, fail2ban, chrony, crmctl, cron-проверку здоровья, каталоги, сеть crm_ingest.
# НЕ ставит CRM и не создаёт БД: это делает `crmctl install` (под sudo от crmops).
# Повторный запуск безопасен. Секретов скрипт не печатает и не хранит.
set -euo pipefail

PACKAGE="" DOMAIN="" OWNER_USER="crmops" NGINX_ONLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --package) PACKAGE="${2:?--package: нужен каталог}"; shift 2 ;;
    --domain) DOMAIN="${2:?--domain: нужен хост}"; shift 2 ;;
    --owner-user) OWNER_USER="${2:?--owner-user: нужно имя}"; shift 2 ;;
    --nginx-only) NGINX_ONLY=1; shift ;;
    *) echo "Неизвестный аргумент: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "Запускайте от root." >&2; exit 1; }
[[ "$DOMAIN" =~ ^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$ ]] || { echo "--domain: имя хоста, например crm.example.kz" >&2; exit 2; }
[[ "$OWNER_USER" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "--owner-user: недопустимое имя" >&2; exit 2; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB=/usr/local/lib/crm

# --- nginx: шаблон из пакета; сертификата до certbot нет, поэтому до него только порт 80 (ACME) ---
render_nginx() {
  local tpl="$PACKAGE/nginx/crm.conf.template"
  [ -f "$tpl" ] || tpl="$HERE/nginx/crm.conf.template"
  [ -f "$tpl" ] || { echo "Нет nginx/crm.conf.template ни в пакете, ни рядом со скриптом." >&2; exit 1; }
  mkdir -p /etc/nginx/crm-static /var/www/certbot /var/log/crm
  local maint="$PACKAGE/nginx/maintenance.html"
  [ -f "$maint" ] || maint="$HERE/nginx/maintenance.html"
  install -m 0644 "$maint" /etc/nginx/crm-static/maintenance.html
  rm -f /etc/nginx/sites-enabled/default
  if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    ln -sfn "/etc/letsencrypt/live/$DOMAIN" /etc/nginx/tls
    CRM_DOMAIN="$DOMAIN" INGEST_PUBLIC=0 CRM_UPSTREAM=127.0.0.1:3100 \
      envsubst '${CRM_DOMAIN} ${INGEST_PUBLIC} ${CRM_UPSTREAM}' <"$tpl" >/etc/nginx/conf.d/crm.conf
  else
    cat >/etc/nginx/conf.d/crm.conf <<NGX
# Временная конфигурация до выпуска сертификата: certbot certonly --webroot -w /var/www/certbot -d $DOMAIN,
# затем повторить install.sh --nginx-only ...
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/certbot; }
    location / { return 503; }
}
NGX
    echo "Сертификата для $DOMAIN ещё нет: nginx отвечает только на ACME. После certbot повторите с --nginx-only."
  fi
  nginx -t
  systemctl reload nginx
}

if [ "$NGINX_ONLY" -eq 1 ]; then
  [ -n "$PACKAGE" ] || PACKAGE="$HERE"
  render_nginx
  exit 0
fi

[ -n "$PACKAGE" ] && [ -f "$PACKAGE/manifest.json" ] && [ -f "$PACKAGE/images.tar" ] || {
  echo "--package: нужен распакованный пакет (manifest.json, images.tar)." >&2; exit 2; }
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = "24.04" ] || echo "Предупреждение: проверено на Ubuntu 24.04 LTS, здесь ${PRETTY_NAME:-неизвестно}." >&2

echo "[1/6] Пакеты ОС"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq docker.io docker-compose-v2 nginx certbot ufw fail2ban chrony zstd gettext-base curl ca-certificates

echo "[2/6] Каталоги и сеть"
install -d -m 0755 /etc/crm "$LIB" /var/log/crm
install -d -m 0755 /var/lib/crm /var/lib/crm/license /var/lib/crm/packages
install -d -m 0700 /var/backups/crm
systemctl enable --now docker chrony nginx fail2ban
docker network inspect crm_ingest >/dev/null 2>&1 || docker network create crm_ingest

echo "[3/6] crmctl (node и dist/crmctl.mjs берутся из образа пакета)"
docker load -i "$PACKAGE/images.tar" >/dev/null
VERSION="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$PACKAGE/manifest.json" | head -1)"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$ ]] || { echo "Не прочитана версия из manifest.json" >&2; exit 1; }
CID="$(docker create "crm-app:$VERSION")"
trap 'docker rm -f "$CID" >/dev/null 2>&1 || true' EXIT
docker cp "$CID:/usr/local/bin/node" "$LIB/node.new"
docker cp "$CID:/app/dist/crmctl.mjs" "$LIB/crmctl.mjs.new"
chmod 0755 "$LIB/node.new"
mv -f "$LIB/node.new" "$LIB/node"
mv -f "$LIB/crmctl.mjs.new" "$LIB/crmctl.mjs"
cat >/usr/local/bin/crmctl <<'WRAP'
#!/bin/sh
exec /usr/local/lib/crm/node /usr/local/lib/crm/crmctl.mjs "$@"
WRAP
chmod 0755 /usr/local/bin/crmctl

echo "[4/6] Учётка владельца: sudo только на crmctl (D-027)"
if id "$OWNER_USER" >/dev/null 2>&1; then
  tmp="$(mktemp)"
  echo "$OWNER_USER ALL=(root) NOPASSWD: /usr/local/bin/crmctl" >"$tmp"
  visudo -cf "$tmp" >/dev/null
  install -m 0440 "$tmp" /etc/sudoers.d/crm-owner
  rm -f "$tmp"
else
  echo "Учётки $OWNER_USER нет: создайте её с ключом владельца и повторите скрипт (sudoers не записан)." >&2
fi

echo "[5/6] Межсетевой экран, cron, журналы"
ufw allow 22/tcp >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null
cat >/etc/cron.d/crm-health <<'CRON'
# Проверка здоровья каждые 5 минут (O3 добавит тревогу в Telegram); код выхода 1 — приложение не отвечает
*/5 * * * * root /usr/local/bin/crmctl health >>/var/log/crm/health.log 2>&1
CRON
cat >/etc/logrotate.d/crm <<'LR'
/var/log/crm/*.log {
    daily
    rotate 14
    compress
    missingok
    notifempty
}
LR

echo "[6/6] nginx"
render_nginx

echo
echo "Готово. Дальше от учётки $OWNER_USER:"
echo "  sudo crmctl install $PACKAGE --domain $DOMAIN --admin-phone <номер> --admin-name <имя>"
