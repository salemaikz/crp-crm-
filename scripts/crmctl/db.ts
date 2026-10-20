// Операции с БД установки через контейнеры: migrate (под crm_owner), grants.sql, роли, чтение версии схемы.
// Хост не видит БД (сеть crm_internal), поэтому всё идёт через `docker compose run/exec`.
import { compose, describe, mustCompose, psql, sqlLit } from './compose';
import { CrmctlError, type Deps } from './types';

const APP_ROLE = 'crm_app';
const OWNER_ROLE = 'crm_owner';

/** Роли БД. crm_owner создаёт образ postgres; crm_app — postgres-init, а если его не было — создаём здесь. */
export async function ensureRoles(deps: Deps, version: string, appPassword: string): Promise<void> {
  const sql = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_ROLE}') THEN
    CREATE ROLE ${APP_ROLE} LOGIN PASSWORD ${sqlLit(appPassword)} NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END $$;
DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '${APP_ROLE}'); END $$;
GRANT USAGE ON SCHEMA public TO ${APP_ROLE};
`;
  const r = await psql(deps, version, sql);
  if (r.code !== 0) throw new CrmctlError(`Роли БД: ${describe(r)}`);
  const own = await psql(deps, version, `SELECT 1 FROM pg_roles WHERE rolname = '${OWNER_ROLE}';`);
  if (own.code !== 0 || own.stdout.trim() !== '1') throw new CrmctlError(`В БД нет роли ${OWNER_ROLE}`);
}

export type PendingState = 'none' | 'pending';

/** `migrate --status` образа: код 0 — всё накатано, 3 — есть ненакатанные, остальное — ошибка. */
export async function pendingMigrations(deps: Deps, version: string): Promise<PendingState> {
  const r = await compose(deps, version, ['run', '--rm', '--no-deps', 'migrate', 'node', 'dist/migrate.mjs', '--status']);
  if (r.code === 0) return 'none';
  if (r.code === 3) return 'pending';
  throw new CrmctlError(`Состояние миграций (код ${r.code}): ${describe(r)}`);
}

/** Накатка SQL-миграций образа версии `version` под crm_owner (под advisory lock, D-059). */
export async function runMigrate(deps: Deps, version: string): Promise<string> {
  const r = await mustCompose(deps, version, 'Миграции', ['run', '--rm', 'migrate']);
  return r.stdout.trim();
}

/** deploy/postgres/grants.sql берём из того же образа, что и миграции: права соответствуют схеме. */
export async function applyGrants(deps: Deps, version: string): Promise<void> {
  const cat = await deps.exec.run('docker', ['run', '--rm', '--entrypoint', 'cat', `crm-app:${version}`, '/app/deploy/postgres/grants.sql']);
  if (cat.code !== 0 || !cat.stdout.trim()) throw new CrmctlError(`grants.sql не прочитан из образа: ${describe(cat)}`);
  // Имена ролей — параметрами сессии, в одном сеансе с самим файлом (см. заголовок grants.sql)
  const script = `SELECT set_config('crm.app_role','${APP_ROLE}',false), set_config('crm.owner_role','${OWNER_ROLE}',false);\n${cat.stdout}\n`;
  const r = await psql(deps, version, script);
  if (r.code !== 0) throw new CrmctlError(`grants.sql: ${describe(r)}`);
}

/** Последняя накатанная миграция (имя файла) или '' в пустой БД. */
export async function currentSchema(deps: Deps, version: string): Promise<string> {
  const r = await psql(deps, version, `SELECT COALESCE(max(name), '') FROM schema_migrations;`);
  if (r.code !== 0) {
    // таблицы учёта ещё нет: БД пуста
    if (/schema_migrations/.test(r.stderr)) return '';
    throw new CrmctlError(`Версия схемы: ${describe(r)}`);
  }
  return r.stdout.trim();
}
