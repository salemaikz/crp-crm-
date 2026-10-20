#!/usr/bin/env bash
# CI: роли crm_app/crm_owner и deploy/postgres/grants.sql, применённый дважды (идемпотентность).
# Требует MIGRATE_DATABASE_URL (суперпользователь тестового Postgres).
set -euo pipefail

: "${MIGRATE_DATABASE_URL:?MIGRATE_DATABASE_URL не задан}"
psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_owner') THEN CREATE ROLE crm_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_app') THEN CREATE ROLE crm_app NOLOGIN; END IF;
END $$;
SQL

for run in 1 2; do
  echo "grants.sql, прогон $run"
  psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 -q \
    -c "SELECT set_config('crm.app_role','crm_app',false), set_config('crm.owner_role','crm_owner',false)" \
    -f deploy/postgres/grants.sql
done
