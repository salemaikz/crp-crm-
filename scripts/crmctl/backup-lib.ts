// Общее для копий и восстановления (DEPLOY §6): запуск pg_*-утилит, сессия psql со снимком,
// счётчики ключевых таблиц, чтение настроек. Утилиты запускаются либо напрямую по адресу БД
// (BACKUP_DATABASE_URL), либо через префикс (BACKUP_PG_EXEC="docker exec -i crm-db-1"), как на боевом сервере,
// где порта БД наружу нет. Пароль в аргументы не попадает: адрес разбирается в переменные PG*.
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';

export type Env = Record<string, string | undefined>;

/** Разбор файла окружения KEY=VALUE (без оболочки и подстановок); комментарии и пустые строки пропускаются. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    out[line.slice(0, eq).trim()] = line.slice(eq + 1).trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return out;
}

/** Окружение + BACKUP_ENV_FILE (значения из процесса важнее файла). */
export async function envWithFile(env: Env): Promise<Env> {
  const f = env.BACKUP_ENV_FILE?.trim();
  if (!f) return env;
  return { ...parseEnvFile(await readFile(f, 'utf8')), ...env };
}

/** Ключевые таблицы для сверки после восстановления (берём те, что есть в БД). */
export const KEY_TABLES = [
  'users',
  'spaces',
  'clients',
  'contacts',
  'client_phones',
  'cards',
  'calls',
  'events',
  'deals',
  'consents',
  'stop_list',
  'audit_log',
  'license_state',
  'schema_migrations',
] as const;

/** Временные БД проверки: удаляем только имена с этим префиксом. */
export const VERIFY_DB_PREFIX = 'crm_restorecheck';

const DB_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export function assertDbName(name: string): string {
  if (!DB_NAME_RE.test(name)) throw new Error(`Недопустимое имя БД: ${name}`);
  return name;
}

/** Убирает пароли из текста ошибок: postgres://user:pass@host → postgres://user:***@host. */
export function redact(text: string): string {
  return text.replace(/(\w+:\/\/[^:/\s@]+:)[^@\s]+@/g, '$1***@');
}

/** Разбор строки "docker exec -i crm-db-1" в argv (кавычек не поддерживаем: имена контейнеров без пробелов). */
export function splitCommand(s: string): string[] {
  return s.split(/\s+/).filter(Boolean);
}

export interface PgTarget {
  /** Префикс команды (docker exec ...), пусто — утилиты запускаются напрямую. */
  prefix: string[];
  /** Имя БД, к которой подключаемся по умолчанию. */
  database: string;
  /** Переменные окружения для прямого режима. */
  baseEnv: Record<string, string>;
  /** Пользователь для режима через префикс. */
  user?: string;
}

/** Цель из окружения: BACKUP_DATABASE_URL (прямой режим) или BACKUP_PG_EXEC + BACKUP_DB_USER + BACKUP_DB_NAME. */
export function pgTargetFromEnv(env: Env): PgTarget {
  const exec = env.BACKUP_PG_EXEC?.trim();
  if (exec) {
    const user = env.BACKUP_DB_USER?.trim() || 'crm_owner';
    const database = env.BACKUP_DB_NAME?.trim() || 'crm';
    return { prefix: splitCommand(exec), database: assertDbName(database), baseEnv: {}, user };
  }
  const url = env.BACKUP_DATABASE_URL?.trim();
  if (!url) throw new Error('Нужен BACKUP_DATABASE_URL или BACKUP_PG_EXEC (+BACKUP_DB_USER, BACKUP_DB_NAME).');
  return pgTargetFromUrl(url);
}

export function pgTargetFromUrl(url: string): PgTarget {
  const u = new URL(url);
  const baseEnv: Record<string, string> = {};
  if (u.hostname) baseEnv.PGHOST = u.hostname;
  if (u.port) baseEnv.PGPORT = u.port;
  if (u.username) baseEnv.PGUSER = decodeURIComponent(u.username);
  if (u.password) baseEnv.PGPASSWORD = decodeURIComponent(u.password);
  const database = decodeURIComponent(u.pathname.replace(/^\//, ''));
  return { prefix: [], database: assertDbName(database), baseEnv };
}

/** Аргументы утилиты и окружение для подключения к БД `db` на той же установке. */
function conn(t: PgTarget, db: string): { args: string[]; env: Record<string, string> } {
  assertDbName(db);
  if (t.prefix.length > 0) return { args: ['-U', t.user ?? 'crm_owner', '-d', db], env: {} };
  return { args: [], env: { ...t.baseEnv, PGDATABASE: db } };
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOpts {
  env?: Record<string, string>;
  /** Файл, из которого читаем stdin. */
  stdinFile?: string;
  /** Файл, в который пишем stdout (вместо накопления в памяти). */
  stdoutFile?: string;
  input?: string;
  timeoutMs?: number;
}

/** Запуск команды без оболочки. Код выхода не 0 не бросает: решает вызывающий. */
export async function run(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error('Пустая команда');
  const child = spawn(cmd, args, {
    env: { ...process.env, ...opts.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs) : undefined;
  let stderr = '';
  let stdout = '';
  child.stderr!.on('data', (d: Buffer) => (stderr += d.toString()));
  const closed = new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  const jobs: Promise<unknown>[] = [];
  if (opts.stdoutFile) jobs.push(pipeline(child.stdout!, createWriteStream(opts.stdoutFile, { mode: 0o600 })));
  else child.stdout!.on('data', (d: Buffer) => (stdout += d.toString()));
  child.stdin!.on('error', () => {}); // процесс мог завершиться раньше конца ввода
  if (opts.stdinFile) jobs.push(pipeline(createReadStream(opts.stdinFile), child.stdin!).catch(() => {}));
  else child.stdin!.end(opts.input ?? '');
  try {
    const code = await closed;
    await Promise.all(jobs).catch(() => {});
    return { code, stdout, stderr: redact(stderr) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runOk(argv: string[], opts: RunOpts = {}): Promise<RunResult> {
  const r = await run(argv, opts);
  if (r.code !== 0) throw new Error(`${argv[0]} завершился с кодом ${r.code}: ${r.stderr.trim().slice(0, 500)}`);
  return r;
}

/** psql одним запросом, результат без выравнивания (-At). */
export async function psql(t: PgTarget, db: string, sql: string): Promise<string> {
  const c = conn(t, db);
  const r = await runOk([...t.prefix, 'psql', '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...c.args], {
    env: c.env,
    input: sql,
  });
  return r.stdout.trim();
}

/** pg_dump -Fc в файл. snapshot — идентификатор снимка из открытой транзакции. */
export async function pgDumpTo(t: PgTarget, file: string, snapshot?: string): Promise<void> {
  const c = conn(t, t.database);
  const extra = snapshot ? [`--snapshot=${snapshot}`] : [];
  await runOk([...t.prefix, 'pg_dump', '-Fc', ...extra, ...c.args], { env: c.env, stdoutFile: file });
}

/** pg_restore из файла в существующую БД `db`. */
export async function pgRestoreFrom(
  t: PgTarget,
  db: string,
  file: string,
  opts: { noAcl?: boolean } = {},
): Promise<void> {
  const c = conn(t, db);
  const flags = ['--no-owner', '--exit-on-error', ...(opts.noAcl ? ['--no-acl'] : [])];
  // pg_restore не берёт имя БД из PGDATABASE: -d обязателен и в прямом режиме
  const dbArgs = t.prefix.length > 0 ? c.args : ['-d', db];
  await runOk([...t.prefix, 'pg_restore', ...flags, ...dbArgs], { env: c.env, stdinFile: file });
}

export async function createDatabase(t: PgTarget, name: string): Promise<void> {
  assertDbName(name);
  await psql(t, 'postgres', `CREATE DATABASE ${name}`);
}

/** Удаляет только временные БД проверки (защита от DROP боевой БД по ошибке в имени). */
export async function dropVerifyDatabase(t: PgTarget, name: string): Promise<void> {
  assertDbName(name);
  if (!name.startsWith(VERIFY_DB_PREFIX)) throw new Error(`Удалять можно только ${VERIFY_DB_PREFIX}*, получено: ${name}`);
  await psql(t, 'postgres', `DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}

export async function databaseExists(t: PgTarget, name: string): Promise<boolean> {
  assertDbName(name);
  return (await psql(t, 'postgres', `SELECT 1 FROM pg_database WHERE datname = '${name}'`)) === '1';
}

export interface DbSummary {
  /** Число таблиц схемы public. */
  tables: number;
  /** Последняя применённая миграция (по имени), null если учёта нет. */
  lastMigration: string | null;
  /** Строки ключевых таблиц, которые есть в БД. */
  counts: Record<string, number>;
}

/** Сводка по БД одним запросом: SQL тот же для живой БД (внутри снимка) и для восстановленной. */
export function summarySql(): string {
  const list = KEY_TABLES.map((n) => `'${n}'`).join(',');
  return `
SELECT 'tables=' || count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
SELECT 'last=' || coalesce((SELECT max(name) FROM schema_migrations), '') WHERE to_regclass('schema_migrations') IS NOT NULL;
SELECT 'key=' || table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name IN (${list}) ORDER BY table_name;
`;
}

/** Счётчики по списку таблиц: каждая отдельным запросом, имена только из белого списка. */
export function countSql(tables: string[]): string {
  return tables
    .map((n) => {
      if (!(KEY_TABLES as readonly string[]).includes(n)) throw new Error(`Таблица вне списка: ${n}`);
      return `SELECT 'count:${n}=' || count(*) FROM ${n};`;
    })
    .join('\n');
}

export function parseSummary(lines: string[]): DbSummary & { keyTables: string[] } {
  let tables = 0;
  let lastMigration: string | null = null;
  const keyTables: string[] = [];
  const counts: Record<string, number> = {};
  for (const l of lines) {
    if (l.startsWith('tables=')) tables = Number(l.slice(7));
    else if (l.startsWith('last=')) lastMigration = l.slice(5) || null;
    else if (l.startsWith('key=')) keyTables.push(l.slice(4));
    else if (l.startsWith('count:')) {
      const [k, v] = l.slice(6).split('=');
      if (k) counts[k] = Number(v);
    }
  }
  return { tables, lastMigration, counts, keyTables };
}

/** Сводка по БД `db` (обычное соединение). */
export async function summarize(t: PgTarget, db: string): Promise<DbSummary> {
  const head = parseSummary((await psql(t, db, summarySql())).split('\n').filter(Boolean));
  const body = head.keyTables.length ? await psql(t, db, countSql(head.keyTables)) : '';
  const counts = parseSummary(body.split('\n').filter(Boolean)).counts;
  return { tables: head.tables, lastMigration: head.lastMigration, counts };
}

/**
 * Долгая сессия psql: нужна, чтобы держать транзакцию со снимком открытой, пока pg_dump
 * снимает копию, и в той же транзакции посчитать строки. Тогда счётчики можно сверять с
 * восстановленной копией точно, даже если БД живая.
 */
export class PsqlSession {
  private buf = '';
  private waiter: (() => void) | null = null;
  private seq = 0;
  private constructor(private readonly child: ChildProcess) {
    child.stdout!.on('data', (d: Buffer) => {
      this.buf += d.toString();
      this.waiter?.();
    });
  }

  static open(t: PgTarget, db: string): PsqlSession {
    const c = conn(t, db);
    const child = spawn(
      t.prefix[0] ?? 'psql',
      [...t.prefix.slice(1), ...(t.prefix.length ? ['psql'] : []), '-X', '-q', '-At', '-v', 'ON_ERROR_STOP=1', ...c.args],
      { env: { ...process.env, ...c.env }, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    child.stderr!.on('data', () => {});
    child.stdin!.on('error', () => {});
    return new PsqlSession(child);
  }

  /** Выполняет SQL и возвращает непустые строки вывода. */
  async query(sql: string, timeoutMs = 120_000): Promise<string[]> {
    const mark = `__END_${++this.seq}__`;
    this.child.stdin!.write(`${sql}\n\\echo ${mark}\n`);
    const deadline = Date.now() + timeoutMs;
    while (!this.buf.includes(`${mark}\n`)) {
      if (this.child.exitCode !== null) throw new Error('psql завершился раньше времени');
      if (Date.now() > deadline) throw new Error('psql: таймаут сессии');
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
        setTimeout(resolve, 200);
      });
    }
    const idx = this.buf.indexOf(`${mark}\n`);
    const out = this.buf.slice(0, idx);
    this.buf = this.buf.slice(idx + mark.length + 1);
    return out.split('\n').filter(Boolean);
  }

  async close(): Promise<void> {
    this.child.stdin!.end('ROLLBACK;\n');
    await new Promise<void>((resolve) => {
      if (this.child.exitCode !== null) return resolve();
      this.child.on('close', () => resolve());
      setTimeout(() => {
        this.child.kill('SIGKILL');
        resolve();
      }, 5000);
    });
  }
}

/** Таймер этапа: возвращает миллисекунды. */
export async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: Math.round(performance.now() - t0) };
}

/** Сравнение сводок: пустой список — совпало. */
export function diffSummary(expected: DbSummary, actual: DbSummary): string[] {
  const out: string[] = [];
  if (expected.tables !== actual.tables) out.push(`tables: ожидали ${expected.tables}, получили ${actual.tables}`);
  if (expected.lastMigration !== actual.lastMigration) {
    out.push(`lastMigration: ожидали ${expected.lastMigration}, получили ${actual.lastMigration}`);
  }
  const names = new Set([...Object.keys(expected.counts), ...Object.keys(actual.counts)]);
  for (const n of [...names].sort()) {
    if (expected.counts[n] !== actual.counts[n]) out.push(`${n}: ожидали ${expected.counts[n]}, получили ${actual.counts[n]}`);
  }
  return out;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
  return h.digest('hex');
}
