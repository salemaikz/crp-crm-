-- Права роли приложения на объекты схемы (ARCHITECTURE §4.1, D-068). Образец — crp-kz 2cd8a2b
-- deploy/postgres/grants.sql. Идемпотентно; выполняется от crm_owner после каждого прогона миграций
-- (migrate при crmctl install/update) и после восстановления из копии. Не миграция: права зависят
-- от имён ролей установки, а не от версии схемы.
--
-- Имена ролей приходят параметрами сессии crm.app_role и crm.owner_role (set_config), а не склейкой
-- строк. Схема — текущая (в тестах — временная схема теста). Пример запуска:
--   psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "SELECT set_config('crm.app_role','crm_app',false), set_config('crm.owner_role','crm_owner',false)" \
--     -f deploy/postgres/grants.sql
--
--   crm_app: SELECT/INSERT/UPDATE/DELETE на таблицы, кроме списков ниже;
--   только добавление (SELECT, INSERT): audit_log, client_events, booking_history, consents,
--     config_revisions — журналы и история не правятся и не чистятся приложением; чистку по сроку
--     (audit.retentionDays) и обезличивание делает crm_owner;
--   clients — без DELETE: клиент не удаляется, слияние ставит merged_into_id, обезличивание
--     чистит колонки (PROCESS 2.9);
--   schema_migrations — только SELECT (учёт миграций ведёт владелец схемы).
DO $$
DECLARE
  app   text := current_setting('crm.app_role');
  owner text := current_setting('crm.owner_role');
  s     text := current_schema();
  t     text;
BEGIN
  IF app !~ '^[a-z_][a-z0-9_]{0,62}$' OR owner !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'grants.sql: недопустимое имя роли';
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, app);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA %I TO %I', s, app);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, app);
  -- Таблицы из будущих миграций получают те же права сразу (страховка, если grants не запустили).
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I', owner, s, app);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', owner, s, app);

  -- Журналы и история — только добавление.
  FOREACH t IN ARRAY ARRAY['audit_log','client_events','booking_history','consents','config_revisions'] LOOP
    IF to_regclass(format('%I.%I', s, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.%I FROM %I', s, t, app);
    END IF;
  END LOOP;

  -- Клиент не удаляется никогда.
  IF to_regclass(format('%I.clients', s)) IS NOT NULL THEN
    EXECUTE format('REVOKE DELETE, TRUNCATE ON %I.clients FROM %I', s, app);
  END IF;

  -- Учёт миграций ведёт только владелец схемы.
  IF to_regclass(format('%I.schema_migrations', s)) IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.schema_migrations FROM %I', s, app);
  END IF;
END
$$;
