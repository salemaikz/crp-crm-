#!/bin/sh
# Первый запуск тома: роль приложения crm_app без DDL (ARCHITECTURE §4.1).
# crm_owner создаёт образ postgres (POSTGRES_USER). Права crm_app выдаёт grants.sql после migrate.
set -eu
: "${CRM_APP_PASSWORD:?CRM_APP_PASSWORD не задан в db.env}"
psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" \
  -v app_pw="$CRM_APP_PASSWORD" <<'SQL'
CREATE ROLE crm_app LOGIN PASSWORD :'app_pw' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT CONNECT ON DATABASE crm TO crm_app;
GRANT USAGE ON SCHEMA public TO crm_app;
SQL
