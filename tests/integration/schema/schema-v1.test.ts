// Схема v1 и права роли приложения на Postgres 16 (TEST_DATABASE_URL под суперпользователем).
// Как на бою: файл схемы применяет владелец схемы без прав суперпользователя (migrate дважды),
// затем владелец дважды применяет deploy/postgres/grants.sql; права проверяются под ролью
// приложения. Роли и схема создаются со случайным суффиксом и удаляются в конце.
// Нормативно: ARCHITECTURE §4.1, D-059, D-067, D-068; карта прав — docs/schema-v1.md.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DbHandle } from '../../../src/server/platform/db/core';
import { migrate, migrationStatus } from '../../../src/server/platform/db/migrate';
import { createPostgresDb } from '../../../src/server/platform/db/postgres';
import { testDatabaseUrl } from '../../../src/server/platform/db/testing';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const SCHEMA_FILE = '2026-10-21-platform-schema-v1.sql';
const GRANTS = readFileSync(path.join(ROOT, 'deploy', 'postgres', 'grants.sql'), 'utf8');

// Ожидаемые права — спецификация, а не копия grants.sql: новая таблица в списке — осознанная правка теста.
/** Служебные таблицы: у crm_app есть DELETE. */
const DELETABLE = [
  'sessions', 'invites', 'push_subscriptions', 'push_outbox', 'device_status',
  'import_rows', 'ingest_batches', 'change_snapshots',
  'client_phones', 'stop_list',
  'resource_schedule', 'resource_exceptions', 'event_duty',
  'integration_secrets',
];
/** Только добавление (D-068). */
const APPEND_ONLY = ['audit_log', 'client_events', 'booking_history', 'consents', 'config_revisions'];
/** История, которая не удаляется даже ошибкой репозитория (ревью схемы, п. 3). */
const NEVER_DELETED = ['clients', 'calls', 'deals', 'cards', 'users', 'spaces', 'bookings', 'tasks', 'notes', 'memberships'];

const suffix = randomBytes(5).toString('hex');
const OWNER = `crm_t_own_${suffix}`;
const APP = `crm_t_app_${suffix}`;
const SCHEMA = `test_schema_${suffix}`;
const PASSWORD = randomBytes(16).toString('hex');

let admin: DbHandle;
let owner: DbHandle;
let app: DbHandle;

function urlFor(role: string): string {
  const u = new URL(testDatabaseUrl());
  u.username = role;
  u.password = PASSWORD;
  return u.toString();
}

async function applyGrants(db: DbHandle): Promise<void> {
  await db.withTx(async (c) => {
    await c.sql`SELECT set_config('crm.app_role', ${APP}, true), set_config('crm.owner_role', ${OWNER}, true)`;
    await c.exec(GRANTS);
  });
}

/** Оператор под crm_app отклоняется по правам (42501), а не по данным. */
async function denied(sqlText: string): Promise<void> {
  await assert.rejects(app.exec(sqlText), (e: unknown) => (e as { code?: string }).code === '42501', `должно быть запрещено: ${sqlText}`);
}

async function tables(): Promise<string[]> {
  const rows = await admin.sql<{ tablename: string }>`SELECT tablename FROM pg_tables WHERE schemaname = ${SCHEMA} ORDER BY tablename`;
  return rows.map((r) => r.tablename);
}

async function privileges(table: string): Promise<string[]> {
  const out: string[] = [];
  for (const p of ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) {
    const [r] = await admin.sql<{ ok: boolean }>`SELECT has_table_privilege(${APP}, ${`${SCHEMA}.${table}`}, ${p}) AS ok`;
    if (r?.ok) out.push(p);
  }
  return out;
}

function expectedPrivileges(table: string): string[] {
  if (table === 'schema_migrations') return ['SELECT'];
  if (APPEND_ONLY.includes(table)) return ['SELECT', 'INSERT'];
  if (DELETABLE.includes(table)) return ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
  return ['SELECT', 'INSERT', 'UPDATE'];
}

before(async () => {
  admin = await createPostgresDb(testDatabaseUrl());
  const [me] = await admin.sql<{ ok: boolean }>`SELECT rolsuper OR rolcreaterole AS ok FROM pg_roles WHERE rolname = current_user`;
  assert.equal(me?.ok, true, 'TEST_DATABASE_URL: нужна роль с правом создавать роли (суперпользователь тестового Postgres)');
  // Имена и пароль — из [a-z0-9_] и hex: склейка безопасна
  await admin.exec(`CREATE ROLE ${OWNER} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${PASSWORD}'`);
  await admin.exec(`CREATE ROLE ${APP} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD '${PASSWORD}'`);
  // pg_trgm на бою ставит владелец БД (доверенное расширение); здесь владелец — схемы, а не БД,
  // поэтому расширение ставит администратор, и IF NOT EXISTS в файле схемы его пропускает
  await admin.exec('CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public');
  await admin.exec(`CREATE SCHEMA ${SCHEMA} AUTHORIZATION ${OWNER}`);
  owner = await createPostgresDb(urlFor(OWNER), { schema: SCHEMA });
  app = await createPostgresDb(urlFor(APP), { schema: SCHEMA });
});

after(async () => {
  await app?.close();
  await owner?.close();
  if (!admin) return;
  await admin.exec(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
  for (const r of [APP, OWNER]) {
    const [exists] = await admin.sql<{ ok: boolean }>`SELECT EXISTS (SELECT FROM pg_roles WHERE rolname = ${r}) AS ok`;
    if (exists?.ok) {
      await admin.exec(`DROP OWNED BY ${r}`);
      await admin.exec(`DROP ROLE ${r}`);
    }
  }
  await admin.close();
});

test('схема v1 на пустой схеме: migrate дважды под владельцем без суперпользователя', async () => {
  const first = await migrate(owner, MIGRATIONS);
  assert.ok(first.includes(SCHEMA_FILE), `первый прогон должен применить ${SCHEMA_FILE}: ${first.join(', ')}`);
  assert.deepEqual(await migrate(owner, MIGRATIONS), []);
  const st = await migrationStatus(owner, MIGRATIONS);
  assert.deepEqual([st.pending, st.changed], [[], []]);
  assert.ok((await tables()).includes('clients'));
});

test('файл схемы идемпотентен сам по себе: повторное выполнение ничего не меняет', async () => {
  const before = await tables();
  const sql = readFileSync(path.join(MIGRATIONS, SCHEMA_FILE), 'utf8');
  await owner.withTx(async (c) => c.exec(sql));
  assert.deepEqual(await tables(), before);
});

test('grants.sql применяется дважды', async () => {
  await applyGrants(owner);
  await applyGrants(owner);
});

test('права crm_app по каждой таблице: DELETE только у служебных, журналы только дополняются', async () => {
  const all = await tables();
  for (const t of [...DELETABLE, ...APPEND_ONLY, ...NEVER_DELETED, 'schema_migrations']) {
    assert.ok(all.includes(t), `таблицы ${t} нет в схеме: поправьте список в тесте`);
  }
  for (const t of all) assert.deepEqual(await privileges(t), expectedPrivileges(t), `права crm_app на ${t}`);
});

test('под crm_app запрещены правка журналов, удаление истории, TRUNCATE и DDL', async () => {
  for (const t of APPEND_ONLY) {
    await denied(`UPDATE ${t} SET id = id WHERE false`);
    await denied(`DELETE FROM ${t} WHERE false`);
  }
  for (const t of NEVER_DELETED) await denied(`DELETE FROM ${t} WHERE false`);
  await denied('TRUNCATE sessions');
  await denied("INSERT INTO schema_migrations (name, applied_at, sha256) VALUES ('x.sql', 0, 'x')");
  await denied('CREATE TABLE app_ddl_probe (id TEXT)');
  await denied('CREATE TABLE public.app_ddl_probe (id TEXT)');
  await denied('ALTER TABLE clients ADD COLUMN probe TEXT');
  await denied('DROP TABLE calls');
  await denied('CREATE INDEX app_idx_probe ON calls (note)');
});

test('под crm_app работает нужное: системный автор NULL (D-067), одна открытая автозадача на ключ', async () => {
  const now = 1_761_000_000_000;
  await app.exec(`
    INSERT INTO users (id, phone_digits, name, created_at) VALUES ('u-1', '77010000001', 'Оператор', ${now});
    INSERT INTO spaces (id, key, is_default, created_at) VALUES ('sp-1', 'sales', TRUE, ${now});
    INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at)
      VALUES ('cl-1', 'company', 'ТОО Тест', 'тоо тест', 'import', ${now}, ${now});
    INSERT INTO cards (id, space_id, client_id, owner_user_id, created_at, updated_at)
      VALUES ('cd-1', 'sp-1', 'cl-1', 'u-1', ${now}, ${now});
    UPDATE clients SET address = 'адрес' WHERE id = 'cl-1';
  `);
  // Импорт «Подтвержден» от имени системы (векторы K1d r30a–r30c): звонок и сделка без автора
  await app.exec(`
    INSERT INTO calls (id, space_id, card_id, client_id, user_id, owner_user_id_at_call, via, outcome_code,
                       outcome_kind, applied, occurred_at, received_at, import_key, config_rev)
      VALUES ('op-imp-1', 'sp-1', 'cd-1', 'cl-1', NULL, 'u-1', 'import', 'agreed', 'agreed', 'applied',
              ${now}, ${now}, 'imp:row-1', 1);
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id,
                       stage_changed_at, request_id, created_by, created_at, updated_at)
      VALUES ('dl-1', 'sp-1', 'main', 'agreed', 'open', 'cl-1', 'cd-1', 'u-1', ${now}, 'op-imp-1', NULL, ${now}, ${now});
    INSERT INTO bookings (id, space_id, kind, event_type_key, client_id, card_id, booking_date, start_time,
                          starts_at, duration_min, via, booked_by_user_id, created_at, updated_at)
      VALUES ('bk-1', 'sp-1', 'individual', 'consult', 'cl-1', 'cd-1', '2026-10-28', '10:00', ${now}, 60, 'import',
              NULL, ${now}, ${now});
    INSERT INTO invites (id, token_hash, phone_digits, expires_at, created_by, created_at)
      VALUES ('inv-1', '${'a'.repeat(64)}', '77010000002', ${now + 1}, NULL, ${now});
    INSERT INTO audit_log (id, action, entity, entity_id, meta, created_at)
      VALUES ('au-1', 'export.report', 'report', 'calls', '{"filterFields":["owner","state"],"rows":3}', ${now});
    INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at)
      VALUES ('${'b'.repeat(64)}', 'u-1', ${now}, ${now + 1}, ${now});
    DELETE FROM sessions WHERE user_id = 'u-1';
  `);
  // Звонок из интерфейса или с устройства без автора — ошибка
  await assert.rejects(
    app.exec(`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, outcome_code, outcome_kind, applied,
                                 occurred_at, received_at, config_rev)
              VALUES ('op-ui-1', 'sp-1', 'cd-1', 'cl-1', NULL, 'ui', 'no_answer', 'no_answer', 'applied', ${now}, ${now}, 1)`),
    (e: unknown) => (e as { code?: string; constraint_name?: string }).constraint_name === 'calls_user_id_check',
  );

  // Автозадача: повтор при открытой — не создаётся; после закрытия тот же ключ — новая задача
  const create = (id: string) =>
    app.sql<{ id: string }>`
      INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, source_key, created_at)
      VALUES (${id}, 'sp-1', 'cl-1', 'message', 'inbound_message', 'Ответить', 'u-1', 'reply:chat-1', ${now})
      ON CONFLICT (source_key) WHERE source_key IS NOT NULL AND status = 'open' DO NOTHING
      RETURNING id`;
  assert.deepEqual((await create('t-1')).map((r) => r.id), ['t-1']);
  assert.deepEqual(await create('t-2'), []);
  await app.sql`UPDATE tasks SET status = 'done', done_at = ${now} WHERE source_key = 'reply:chat-1' AND status = 'open'`;
  assert.deepEqual((await create('t-3')).map((r) => r.id), ['t-3']);
  const open = await app.sql<{ id: string }>`SELECT id FROM tasks WHERE source_key = 'reply:chat-1' AND status = 'open'`;
  assert.deepEqual(open.map((r) => r.id), ['t-3']);
});

test('таблица из будущей миграции: crm_app читает и пишет, но DELETE не получает по умолчанию', async () => {
  await owner.exec('CREATE TABLE future_probe (id TEXT PRIMARY KEY)');
  try {
    assert.deepEqual(await privileges('future_probe'), ['SELECT', 'INSERT', 'UPDATE']);
  } finally {
    await owner.exec('DROP TABLE future_probe');
  }
});

test('grants.sql снимает DELETE, выданный прежней версией файла', async () => {
  await owner.exec(`GRANT DELETE ON ALL TABLES IN SCHEMA ${SCHEMA} TO ${APP}`);
  await owner.exec(`ALTER DEFAULT PRIVILEGES IN SCHEMA ${SCHEMA} GRANT DELETE ON TABLES TO ${APP}`);
  await applyGrants(owner);
  for (const t of await tables()) assert.deepEqual(await privileges(t), expectedPrivileges(t), `права crm_app на ${t}`);
  await owner.exec('CREATE TABLE future_probe2 (id TEXT PRIMARY KEY)');
  try {
    assert.deepEqual(await privileges('future_probe2'), ['SELECT', 'INSERT', 'UPDATE']);
  } finally {
    await owner.exec('DROP TABLE future_probe2');
  }
});
