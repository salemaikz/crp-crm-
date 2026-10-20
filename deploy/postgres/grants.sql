-- Права роли приложения на объекты схемы (ARCHITECTURE §4.1, D-068). Образец — crp-kz 2cd8a2b
-- deploy/postgres/grants.sql. Идемпотентно; выполняется от crm_owner после каждого прогона миграций
-- (migrate при crmctl install/update) и после восстановления из копии. Не миграция: права зависят
-- от имён ролей установки, а не от версии схемы, поэтому файл можно править (D-059 его не касается);
-- сужение прав снимает и то, что выдала прежняя версия файла.
--
-- Имена ролей приходят параметрами сессии crm.app_role и crm.owner_role (set_config), а не склейкой
-- строк. Схема — текущая (в тестах — временная схема теста). Пример запуска:
--   psql "$MIGRATE_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -c "SELECT set_config('crm.app_role','crm_app',false), set_config('crm.owner_role','crm_owner',false)" \
--     -f deploy/postgres/grants.sql
--
-- crm_app:
--   SELECT, INSERT, UPDATE — на все таблицы схемы, кроме списков ниже; DDL — никогда (только USAGE схемы);
--   DELETE — ТОЛЬКО у служебных таблиц из списка deletable (сессии, приглашения, очереди, purge,
--     сменяемые окна графика консультанта и дежурства, стоп-лист для снятия «Не звонить» PROCESS 3.5
--     № 15, номера клиента для слияния). Звонки, сделки, карточки, записи, задачи, клиенты, сотрудники,
--     пространства не удаляются даже ошибкой в репозитории. Новой таблице DELETE по умолчанию не
--     выдаётся: нужен — architect добавляет её в список;
--   только добавление (SELECT, INSERT): audit_log, client_events, booking_history, consents,
--     config_revisions — журналы и история не правятся и не чистятся приложением; чистку по сроку
--     (audit.retentionDays) и обезличивание делает crm_owner;
--   schema_migrations — только SELECT (учёт миграций ведёт владелец схемы);
--   TRUNCATE — ни на что.
-- Проверка — tests/integration/schema/schema-v1.test.ts.
DO $$
DECLARE
  app   text := current_setting('crm.app_role');
  owner text := current_setting('crm.owner_role');
  s     text := current_schema();
  t     text;
  deletable text[] := ARRAY[
    'sessions', 'invites', 'push_subscriptions', 'push_outbox', 'device_status',
    'import_rows', 'ingest_batches', 'change_snapshots',
    'client_phones', 'stop_list',
    'resource_schedule', 'resource_exceptions', 'event_duty',
    'integration_secrets'
  ];
  append_only text[] := ARRAY['audit_log', 'client_events', 'booking_history', 'consents', 'config_revisions'];
BEGIN
  IF app !~ '^[a-z_][a-z0-9_]{0,62}$' OR owner !~ '^[a-z_][a-z0-9_]{0,62}$' THEN
    RAISE EXCEPTION 'grants.sql: недопустимое имя роли';
  END IF;

  EXECUTE format('GRANT USAGE ON SCHEMA %I TO %I', s, app);
  EXECUTE format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I', s, app);
  -- DELETE и TRUNCATE снимаются со всех таблиц, в том числе выданные прежней версией файла
  EXECUTE format('REVOKE DELETE, TRUNCATE ON ALL TABLES IN SCHEMA %I FROM %I', s, app);
  EXECUTE format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', s, app);
  -- Таблицы из будущих миграций сразу читаются и пишутся (страховка, если grants не запустили),
  -- но без DELETE: удаление выдаётся только явным списком
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT SELECT, INSERT, UPDATE ON TABLES TO %I', owner, s, app);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I REVOKE DELETE, TRUNCATE ON TABLES FROM %I', owner, s, app);
  EXECUTE format('ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA %I GRANT USAGE, SELECT ON SEQUENCES TO %I', owner, s, app);

  -- Служебные строки: удаляет приложение (выход, purge, замена окон графика, снятие «Не звонить»)
  FOREACH t IN ARRAY deletable LOOP
    IF to_regclass(format('%I.%I', s, t)) IS NOT NULL THEN
      EXECUTE format('GRANT DELETE ON %I.%I TO %I', s, t, app);
    END IF;
  END LOOP;

  -- Журналы и история — только добавление.
  FOREACH t IN ARRAY append_only LOOP
    IF to_regclass(format('%I.%I', s, t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I.%I FROM %I', s, t, app);
    END IF;
  END LOOP;

  -- Учёт миграций ведёт только владелец схемы.
  IF to_regclass(format('%I.schema_migrations', s)) IS NOT NULL THEN
    EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON %I.schema_migrations FROM %I', s, app);
  END IF;
END
$$;
