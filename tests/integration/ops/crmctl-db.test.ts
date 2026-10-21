// crmctl install/update на настоящем Postgres 16 (TEST_DATABASE_URL): docker и compose подменены, а
// migrate (scripts/db-migrate.ts) и psql с grants.sql выполняются по-настоящему в отдельной БД теста.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import postgres from 'postgres';
import { run } from '../../../scripts/crmctl';
import { readState } from '../../../scripts/crmctl/state';
import { makeFake, writePackage as writeBasePackage, type Fake } from '../../unit/ops/crmctl-fakes';
import type { RunOptions, RunResult } from '../../../scripts/crmctl/types';

const ADMIN_URL = process.env.TEST_DATABASE_URL?.trim() ?? '';
const REPO = process.cwd();
const created: string[] = [];
let dbUrl = '';
let admin: ReturnType<typeof postgres>;

/** Версия схемы пакета = последняя миграция репозитория по имени: новые миграции тест не ломают. */
async function latestMigration(): Promise<string> {
  const all = (await readdir(path.join(REPO, 'migrations'))).filter((n) => n.endsWith('.sql')).sort();
  assert.ok(all.length > 0, 'в migrations/ нет миграций');
  return all[all.length - 1] as string;
}

/** Пакет с актуальной схемой: manifest.schemaVersion не отстаёт от migrations/. */
async function writePackage(dir: string, version: string): Promise<string> {
  return writeBasePackage(dir, version, { schemaVersion: await latestMigration() });
}

function sh(cmd: string, args: string[], opts: RunOptions & { env?: Record<string, string> }): Promise<RunResult> {
  return new Promise((resolve) => {
    const c = spawn(cmd, args, { cwd: REPO, env: { ...process.env, ...opts.env } });
    let stdout = '';
    let stderr = '';
    c.stdout.on('data', (d: Buffer) => (stdout += d));
    c.stderr.on('data', (d: Buffer) => (stderr += d));
    c.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    c.stdin.on('error', () => {});
    c.stdin.end(opts.input ?? '');
  });
}

/** compose run migrate -> настоящий db-migrate; compose exec db psql -> настоящий psql в БД теста. */
async function realDb(cmd: string, args: string[], opts: RunOptions): Promise<RunResult | undefined> {
  if (cmd !== 'docker') return undefined;
  // `docker run … license verify` (водяной знак образа, D-213) отвечает базовый фейк: образ клиента crp
  if (args[0] === 'run' && args.includes('--entrypoint') && !args.includes('license') && !args.includes('keys')) {
    return { code: 0, stdout: await readFile(path.join(REPO, 'deploy/postgres/grants.sql'), 'utf8'), stderr: '' };
  }
  if (args[0] !== 'compose') return undefined;
  const i = args.indexOf('--env-file');
  const sub = args.slice(i + 2);
  if (sub[0] === 'run') {
    const m = sub.indexOf('migrate');
    const rest = sub.slice(m + 1); // [] или node dist/migrate.mjs --status
    const status = rest.includes('--status') ? ['--status'] : [];
    return sh('node', ['--import', 'tsx', 'scripts/db-migrate.ts', ...status], { env: { MIGRATE_DATABASE_URL: dbUrl } });
  }
  if (sub[0] === 'exec') {
    const p = sub.indexOf('psql');
    const rest: string[] = [];
    for (let k = p + 1; k < sub.length; k++) {
      if (sub[k] === '-U' || sub[k] === '-d') k++; // подключение задаёт тест
      else rest.push(sub[k] as string);
    }
    return sh('psql', [dbUrl, ...rest], { input: opts.input });
  }
  return undefined;
}

before(async () => {
  assert.ok(ADMIN_URL, 'TEST_DATABASE_URL не задан');
  admin = postgres(ADMIN_URL, { max: 1, onnotice: () => {} });
  // Роли кластера создаёт образ postgres и postgres-init; в тестовом кластере — на случай их отсутствия
  await admin.unsafe(`DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'crm_owner') THEN CREATE ROLE crm_owner NOLOGIN; END IF;
  END $$`);
});

after(async () => {
  for (const n of created) await admin.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await admin.end();
});

/** Каждый тест — своя пустая БД: установка проверяется с нуля. */
async function fresh(): Promise<Fake> {
  const name = `crm_ops_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  created.push(name);
  const u = new URL(ADMIN_URL);
  u.pathname = `/${name}`;
  dbUrl = u.toString();
  const f = await makeFake(realDb);
  f.server.running = '';
  return f;
}

test('install: миграции, grants, роли, installId, первый администратор и секреты один раз; повторный install отказывает', async () => {
  const f = await fresh();
  const pkg = await writePackage(f.dirs.lib, '1.0.0');
  // install сам кладёт v1.0.0 «как запущенную» через compose up — фейк это моделирует
  const code = await run(
    ['install', pkg, '--domain', 'crm.example.kz', '--admin-phone', '+7 709 123-45-67', '--admin-name', "Админ О'Нил", '--wait-seconds', '1'],
    f.deps,
  );
  assert.equal(code, 0, `${f.err.join('\n')}\n${f.out.join('\n')}`);

  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    const mig = await sql`SELECT name, sha256 FROM schema_migrations ORDER BY name`;
    assert.ok(mig.length >= 1);
    assert.match(String(mig[0]?.sha256), /^[0-9a-f]{64}$/);

    // grants.sql применён: приложение читает и пишет, но не правит журнал и не удаляет звонки
    const [g] = await sql`SELECT
      has_table_privilege('crm_app', 'users', 'SELECT') AS users_sel,
      has_table_privilege('crm_app', 'users', 'INSERT') AS users_ins,
      has_table_privilege('crm_app', 'audit_log', 'UPDATE') AS audit_upd,
      has_table_privilege('crm_app', 'audit_log', 'DELETE') AS audit_del,
      has_table_privilege('crm_app', 'sessions', 'DELETE') AS sess_del,
      has_table_privilege('crm_app', 'schema_migrations', 'INSERT') AS mig_ins`;
    assert.deepEqual({ ...g }, {
      users_sel: true, users_ins: true, audit_upd: false, audit_del: false, sess_del: true, mig_ins: false,
    });

    const [lic] = await sql`SELECT install_id, state FROM license_state WHERE id = 1`;
    assert.equal(lic?.state, 'missing');
    const printed = f.out.join('\n');
    assert.ok(printed.includes(`installId: ${lic?.install_id}`));
    const st = await readState(f.deps.paths);
    assert.equal(st?.installId, lic?.install_id);

    const [u] = await sql`SELECT phone_digits, name, is_admin, password_hash FROM users`;
    assert.deepEqual({ ...u }, { phone_digits: '77091234567', name: "Админ О'Нил", is_admin: true, password_hash: null });

    // Ссылка одноразового входа: в БД только sha256 токена, срок 72 ч
    const link = /https:\/\/crm\.example\.kz\/invite#(\S+)/.exec(printed);
    assert.ok(link, 'ссылка приглашения напечатана');
    const hash = createHash('sha256').update(link![1] as string).digest('hex');
    const [inv] = await sql`SELECT kind, phone_digits, space_id, role_key, created_by, expires_at, created_at FROM invites WHERE token_hash = ${hash}`;
    assert.equal(inv?.kind, 'reset');
    assert.equal(inv?.created_by, null);
    assert.equal(Number(inv?.expires_at) - Number(inv?.created_at), 72 * 3600_000);
    assert.equal((await sql`SELECT count(*)::int AS n FROM invites WHERE token_hash = ${link![1] as string}`)[0]?.n, 0, 'сам токен не хранится');

    const [a] = await sql`SELECT action FROM audit_log WHERE action = 'install.first_admin_invite'`;
    assert.ok(a);
  } finally {
    await sql.end();
  }

  // секреты: показаны один раз и записаны в app.env с правами 0600
  assert.match(printed_secrets(f), /CRM_SECRETS_KEY_k1=/);
  const appEnv = await readFile(path.join(f.dirs.etc, 'app.env'), 'utf8');
  assert.match(appEnv, /^APP_ORIGIN=https:\/\/crm\.example\.kz$/m);
  assert.match(appEnv, /^CRM_SECRETS_KEY_k1=\S{44}$/m);
  const { stat } = await import('node:fs/promises');
  assert.equal((await stat(path.join(f.dirs.etc, 'app.env'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(f.dirs.etc, 'db.env'))).mode & 0o777, 0o600);
  // пароль БД не попадает в вывод и в argv
  const dbPw = /POSTGRES_PASSWORD=(\S+)/.exec(await readFile(path.join(f.dirs.etc, 'db.env'), 'utf8'))![1] as string;
  assert.ok(!f.out.join('\n').includes(dbPw) && !f.err.join('\n').includes(dbPw));
  assert.ok(!f.calls.some((c) => c.args.join(' ').includes(dbPw)), 'пароль не в argv');

  // повторный install не проходит (state.json есть)
  assert.equal(await run(['install', pkg, '--domain', 'crm.example.kz', '--admin-phone', '77091234567', '--admin-name', 'x'], f.deps), 1);
  assert.match(f.err.join('\n'), /Установка уже выполнена/);
});

function printed_secrets(f: Fake): string {
  return f.out.join('\n');
}

test('install, оборванный после секретов, повторяется без смены паролей и без второго installId', async () => {
  const f = await fresh();
  const pkg = await writePackage(f.dirs.lib, '1.0.0');
  f.server.unhealthy.add('1.0.0'); // app не отвечает -> install остановится после записи в БД
  const args = ['install', pkg, '--domain', 'crm.example.kz', '--admin-phone', '77095550000', '--admin-name', 'Админ', '--wait-seconds', '1'];
  assert.equal(await run(args, f.deps), 1);
  assert.match(f.err.join('\n'), /app не ответил/);
  assert.equal(await readState(f.deps.paths), null, 'state пишется только после успешного health');
  const env1 = await readFile(path.join(f.dirs.etc, 'app.env'), 'utf8');
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  const id1 = (await sql`SELECT install_id FROM license_state WHERE id = 1`)[0]?.install_id;

  f.server.unhealthy.clear();
  f.out.length = 0;
  assert.equal(await run(args, f.deps), 0, f.err.join('\n'));
  assert.equal(await readFile(path.join(f.dirs.etc, 'app.env'), 'utf8'), env1, 'ключи не перегенерированы');
  assert.equal((await sql`SELECT install_id FROM license_state WHERE id = 1`)[0]?.install_id, id1);
  assert.ok(!/CRM_SECRETS_KEY_k1=/.test(f.out.join('\n')), 'секреты второй раз не печатаются');
  assert.equal((await sql`SELECT count(*)::int AS n FROM users WHERE phone_digits = '77095550000'`)[0]?.n, 1);
  await sql.end();
});

test('update на настоящей БД: ненакатанная миграция -> копия -> migrate -> grants -> переключение', async () => {
  const f = await fresh();
  const p1 = await writePackage(f.dirs.lib, '1.0.0');
  assert.equal(
    await run(['install', p1, '--domain', 'crm.example.kz', '--admin-phone', '77095551111', '--admin-name', 'Админ', '--wait-seconds', '1'], f.deps),
    0,
    f.err.join('\n'),
  );
  const sql = postgres(dbUrl, { max: 1, onnotice: () => {} });
  try {
    // Без новых миграций: копия не нужна
    const p2 = await writePackage(f.dirs.lib, '1.0.1');
    assert.equal(await run(['update', p2, '--wait-seconds', '1', '--recheck-seconds', '1'], f.deps), 0, f.err.join('\n'));
    assert.equal(f.calls.filter((c) => c.cmd === '/fake/backup.sh').length, 0);

    // Откатим учёт последней миграции: она станет «ненакатанной», migrate обязан накатить её снова (идемпотентно)
    const [last] = await sql`SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1`;
    await sql`DELETE FROM schema_migrations WHERE name = ${last!.name as string}`;
    await sql`REVOKE SELECT ON users FROM crm_app`; // и проверим, что grants вернёт права
    const p3 = await writePackage(f.dirs.lib, '1.0.2');
    assert.equal(await run(['update', p3, '--wait-seconds', '1', '--recheck-seconds', '1'], f.deps), 0, f.err.join('\n'));
    assert.equal(f.calls.filter((c) => c.cmd === '/fake/backup.sh').length, 1, 'копия перед миграциями');
    assert.equal((await sql`SELECT count(*)::int AS n FROM schema_migrations WHERE name = ${last!.name as string}`)[0]?.n, 1);
    assert.equal((await sql`SELECT has_table_privilege('crm_app', 'users', 'SELECT') AS ok`)[0]?.ok, true);
    assert.equal((await readState(f.deps.paths))?.current.version, '1.0.2');
  } finally {
    await sql.end();
  }
});
