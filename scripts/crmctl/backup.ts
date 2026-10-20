// crmctl backup — копия БД по DEPLOY §6: pg_dump -Fc → (проверка восстановления) → age на ключи двух
// хранителей → .sha256 → ротация → отправка на второй сервер (только при подтверждённом ЦОД в РК, D-044)
// → файл статуса для healthcheck. Закрытых ключей здесь нет: только публичные получатели.
//
//   tsx scripts/crmctl/backup.ts run --kind hourly|daily|weekly [--verify] [--no-verify]
//   tsx scripts/crmctl/backup.ts status
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type DbSummary,
  type Env,
  PsqlSession,
  type PgTarget,
  VERIFY_DB_PREFIX,
  countSql,
  envWithFile,
  parseSummary,
  pgDumpTo,
  pgTargetFromEnv,
  redact,
  runOk,
  sha256File,
  summarySql,
  timed,
} from './backup-lib';
import { type VerifyReport, verifyDumpFile } from './restore';

export const KINDS = ['hourly', 'daily', 'weekly'] as const;
export type BackupKind = (typeof KINDS)[number];

/** Сколько копий каждого вида хранить локально (DEPLOY §6.1: 7 дневных + 4 недельные; часовые — рабочий день пилота). */
export const DEFAULT_KEEP: Record<BackupKind, number> = { hourly: 12, daily: 7, weekly: 4 };

export interface OffsiteConfig {
  /** Куда слать: user@host:каталог. */
  target?: string;
  /** Подтверждено письменно, что ЦОД второго сервера в РК (D-044). Без этого наружу ничего не уходит. */
  confirmedKz: boolean;
  sshKey?: string;
  kinds: BackupKind[];
}

export interface BackupConfig {
  target: PgTarget;
  /** Отдельный том с копиями. */
  dir: string;
  /** Файл получателей age: по строке на ключ, не меньше двух. */
  recipientsFile: string;
  statusFile: string;
  keep: Record<BackupKind, number>;
  offsite: OffsiteConfig;
  ageBin: string;
}

function flag(v: string | undefined): boolean {
  return v === '1' || v?.toLowerCase() === 'true';
}

function keepFrom(env: Env, kind: BackupKind): number {
  const raw = env[`BACKUP_KEEP_${kind.toUpperCase()}`]?.trim();
  if (!raw) return DEFAULT_KEEP[kind];
  const n = Number(raw);
  if (!/^\d+$/.test(raw) || n < 1) throw new Error(`BACKUP_KEEP_${kind.toUpperCase()}: нужно целое от 1`);
  return n;
}

export function loadBackupConfig(env: Env = process.env): BackupConfig {
  const dir = env.BACKUP_DIR?.trim();
  if (!dir) throw new Error('BACKUP_DIR не задан: копии пишутся на отдельный том.');
  const recipientsFile = env.BACKUP_RECIPIENTS_FILE?.trim();
  if (!recipientsFile) throw new Error('BACKUP_RECIPIENTS_FILE не задан: нужен файл публичных ключей двух хранителей.');
  const kinds = (env.BACKUP_OFFSITE_KINDS?.trim() || KINDS.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const k of kinds) if (!(KINDS as readonly string[]).includes(k)) throw new Error(`BACKUP_OFFSITE_KINDS: неизвестный вид ${k}`);
  return {
    target: pgTargetFromEnv(env),
    dir,
    recipientsFile,
    statusFile: env.BACKUP_STATUS_FILE?.trim() || path.join(dir, 'status.json'),
    keep: { hourly: keepFrom(env, 'hourly'), daily: keepFrom(env, 'daily'), weekly: keepFrom(env, 'weekly') },
    offsite: {
      target: env.BACKUP_OFFSITE_TARGET?.trim() || undefined,
      confirmedKz: flag(env.BACKUP_OFFSITE_DC_CONFIRMED_KZ),
      sshKey: env.BACKUP_OFFSITE_SSH_KEY?.trim() || undefined,
      kinds: kinds as BackupKind[],
    },
    ageBin: env.BACKUP_AGE_BIN?.trim() || 'age',
  };
}

// ---------- получатели ----------

const RECIPIENT_RE = /^(age1[a-z0-9]{50,}|ssh-(ed25519|rsa) [A-Za-z0-9+/=]+( .*)?)$/;

/** Получатели из файла; меньше двух разных ключей — ошибка (копию должны суметь прочитать оба хранителя). */
export function parseRecipients(text: string): string[] {
  const keys: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.includes('AGE-SECRET-KEY')) throw new Error('В файле получателей закрытый ключ: уберите его, здесь только публичные.');
    if (!RECIPIENT_RE.test(line)) throw new Error('В файле получателей строка не похожа на публичный ключ age или ssh.');
    keys.push(line);
  }
  const uniq = new Set(keys);
  if (uniq.size < 2) throw new Error('Нужны публичные ключи двух хранителей (владелец и директор): найдено меньше двух.');
  return [...uniq];
}

// ---------- имена и ротация ----------

const NAME_RE = /^crm-(hourly|daily|weekly)-(\d{8}T\d{6}Z)\.dump\.age$/;

export function stamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

export function backupName(kind: BackupKind, d: Date): string {
  return `crm-${kind}-${stamp(d)}.dump.age`;
}

export function parseBackupName(name: string): { kind: BackupKind; stamp: string } | null {
  const m = NAME_RE.exec(name);
  return m ? { kind: m[1] as BackupKind, stamp: m[2]! } : null;
}

/** Побочные файлы копии (удаляются вместе с ней). */
export function sidecars(name: string): string[] {
  return [`${name}.sha256`, `${name}.counts.json`];
}

/** Какие копии удалить: на каждый вид остаются `keep[kind]` самых новых. Чужие файлы не трогаем. */
export function planRotation(names: string[], keep: Record<BackupKind, number>): string[] {
  const parsed = names.map((n) => ({ n, p: parseBackupName(n) })).filter((x) => x.p !== null);
  const del: string[] = [];
  for (const kind of KINDS) {
    const own = parsed.filter((x) => x.p!.kind === kind).sort((a, b) => b.p!.stamp.localeCompare(a.p!.stamp));
    del.push(...own.slice(keep[kind]).map((x) => x.n));
  }
  return del;
}

async function rotate(cfg: BackupConfig): Promise<string[]> {
  const gone = planRotation(await readdir(cfg.dir), cfg.keep);
  for (const n of gone) for (const f of [n, ...sidecars(n)]) await rm(path.join(cfg.dir, f), { force: true });
  return gone;
}

// ---------- статус ----------

export interface BackupStatus {
  /** Последний запуск удался (дамп, шифрование, контрольная сумма). */
  ok: boolean;
  /** Время последнего успешного запуска, epoch-мс. */
  at: number | null;
  /** Время последней попытки. */
  attemptAt: number;
  kind: BackupKind | null;
  file: string | null;
  sizeBytes: number | null;
  /** Итог последней проверки восстановления: время, результат, миллисекунды. */
  verified: { at: number; ok: boolean; ms: number } | null;
  offsite: { state: 'sent' | 'disabled_unconfirmed' | 'disabled_not_configured' | 'skipped_kind' | 'failed'; lastSentAt: number | null };
  error: string | null;
}

export async function readStatus(file: string): Promise<BackupStatus | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as BackupStatus;
  } catch {
    return null;
  }
}

async function writeStatus(file: string, s: BackupStatus): Promise<void> {
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o640 });
  await rename(tmp, file);
}

// ---------- шифрование и сумма ----------

async function encrypt(cfg: BackupConfig, plain: string, out: string): Promise<void> {
  await runOk([cfg.ageBin, '-R', cfg.recipientsFile, '-o', out, plain]);
  await chmod(out, 0o640);
}

// ---------- отправка на второй сервер ----------

type OffsiteResult = BackupStatus['offsite']['state'];

/** Решение «слать ли»: чистая функция, чтобы D-044 проверялся тестом. */
export function offsiteDecision(o: OffsiteConfig, kind: BackupKind): 'send' | Exclude<OffsiteResult, 'sent' | 'failed'> {
  if (!o.target) return 'disabled_not_configured';
  if (!o.confirmedKz) return 'disabled_unconfirmed';
  if (!o.kinds.includes(kind)) return 'skipped_kind';
  return 'send';
}

async function sendOffsite(cfg: BackupConfig, files: string[]): Promise<void> {
  const o = cfg.offsite;
  const ssh = ['ssh', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', ...(o.sshKey ? ['-i', o.sshKey] : [])].join(' ');
  // Сначала сумма, потом копия: на втором сервере копия без суммы не считается готовой
  await runOk(['rsync', '-t', '-e', ssh, ...files, `${o.target!.replace(/\/?$/, '/')}`], { timeoutMs: 30 * 60_000 });
}

// ---------- запуск ----------

export interface RunOptions {
  kind: BackupKind;
  /** true/false — принудительно; undefined — по виду (weekly проверяем). */
  verify?: boolean;
  now?: Date;
  /** Для тестов: подмена имени временной БД проверки. */
  verifyDb?: string;
}

export interface RunOutcome {
  status: BackupStatus;
  file: string;
  verify: VerifyReport | null;
  rotated: string[];
}

/** Один запуск копии. При ошибке пишет статус ok=false и бросает исключение. */
export async function runBackup(cfg: BackupConfig, opts: RunOptions, env: Env = process.env): Promise<RunOutcome> {
  const now = opts.now ?? new Date();
  const prev = await readStatus(cfg.statusFile);
  const base: BackupStatus = {
    ok: false,
    at: prev?.at ?? null,
    attemptAt: now.getTime(),
    kind: prev?.kind ?? null,
    file: prev?.file ?? null,
    sizeBytes: prev?.sizeBytes ?? null,
    verified: prev?.verified ?? null,
    offsite: prev?.offsite ?? { state: 'disabled_not_configured', lastSentAt: null },
    error: null,
  };
  await mkdir(cfg.dir, { recursive: true, mode: 0o750 });
  const work = path.join(cfg.dir, `.tmp-${randomBytes(4).toString('hex')}`);
  await mkdir(work, { mode: 0o700 });
  try {
    parseRecipients(await readFile(cfg.recipientsFile, 'utf8'));
    const name = backupName(opts.kind, now);
    const plain = path.join(work, 'dump.fc');

    // 1. Дамп и счётчики в одном снимке: потом восстановленная копия сверяется с ними точно
    const dump = await timed(() => dumpWithSummary(cfg.target, plain));
    const expected = dump.value;

    // 2. Проверка восстановления до шифрования (ключ хранителя не нужен)
    const doVerify = opts.verify ?? opts.kind === 'weekly';
    let verify: VerifyReport | null = null;
    if (doVerify) {
      verify = await verifyDumpFile(cfg.target, plain, {
        expected,
        tempDb: opts.verifyDb ?? env.BACKUP_VERIFY_DB?.trim() ?? VERIFY_DB_PREFIX,
        file: name,
      });
      base.verified = { at: Date.now(), ok: verify.ok, ms: verify.timings.totalMs };
      if (!verify.ok) throw new Error(`Проверка восстановления не прошла: ${verify.mismatches.join('; ')}`);
    }

    // 3. Шифрование, сумма, суммы строк
    const final = path.join(cfg.dir, name);
    const part = `${final}.part`;
    await encrypt(cfg, plain, part);
    await rename(part, final);
    await writeFile(`${final}.sha256`, `${await sha256File(final)}  ${name}\n`, { mode: 0o640 });
    await writeFile(`${final}.counts.json`, `${JSON.stringify(expected, null, 2)}\n`, { mode: 0o640 });
    const size = (await stat(final)).size;

    // 4. Ротация после успешной копии
    const rotated = await rotate(cfg);

    // 5. Второй сервер. Сбой отправки не отменяет локальную копию, но виден в статусе
    const decision = offsiteDecision(cfg.offsite, opts.kind);
    let offsite = base.offsite;
    if (decision === 'send') {
      try {
        await sendOffsite(cfg, [`${final}.sha256`, final]);
        offsite = { state: 'sent', lastSentAt: Date.now() };
      } catch (e) {
        offsite = { state: 'failed', lastSentAt: base.offsite.lastSentAt };
        console.error(`offsite: ${redact(String(e instanceof Error ? e.message : e))}`);
      }
    } else {
      offsite = { state: decision, lastSentAt: base.offsite.lastSentAt };
    }

    const status: BackupStatus = {
      ...base,
      ok: true,
      at: Date.now(),
      kind: opts.kind,
      file: name,
      sizeBytes: size,
      offsite,
    };
    await writeStatus(cfg.statusFile, status);
    return { status, file: final, verify, rotated };
  } catch (e) {
    const msg = redact(String(e instanceof Error ? e.message : e)).slice(0, 500);
    await writeStatus(cfg.statusFile, { ...base, ok: false, error: msg }).catch(() => {});
    throw e;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Открывает транзакцию со снимком, снимает дамп этим снимком и считает строки в нём же. */
async function dumpWithSummary(t: PgTarget, file: string): Promise<DbSummary> {
  const session = PsqlSession.open(t, t.database);
  try {
    await session.query('BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;');
    const snap = (await session.query('SELECT pg_export_snapshot();'))[0];
    if (!snap || !/^[0-9A-F-]+$/i.test(snap)) throw new Error('Не удалось получить снимок БД');
    await pgDumpTo(t, file, snap);
    const head = parseSummary(await session.query(summarySql()));
    const counts = head.keyTables.length ? parseSummary(await session.query(countSql(head.keyTables))).counts : {};
    return { tables: head.tables, lastMigration: head.lastMigration, counts };
  } finally {
    await session.close();
  }
}

// ---------- CLI ----------

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/** Точка входа для crmctl: возвращает код выхода (0 — ок, 1 — ошибка, 2 — неверные аргументы). */
export async function backupMain(argv: string[], rawEnv: Env = process.env): Promise<number> {
  const cmd = argv[0];
  try {
    const env = await envWithFile(rawEnv);
    if (cmd === 'status') {
      const cfg = loadBackupConfig(env);
      const s = await readStatus(cfg.statusFile);
      console.log(s ? JSON.stringify(s, null, 2) : 'Статуса нет: копий ещё не было.');
      return s?.ok ? 0 : 1;
    }
    if (cmd === 'run') {
      const kind = arg(argv, '--kind');
      if (!kind || !(KINDS as readonly string[]).includes(kind)) {
        console.error('Нужно --kind hourly|daily|weekly');
        return 2;
      }
      const verify = argv.includes('--verify') ? true : argv.includes('--no-verify') ? false : undefined;
      const cfg = loadBackupConfig(env);
      const out = await runBackup(cfg, { kind: kind as BackupKind, verify }, env);
      const v = out.verify;
      console.log(
        `backup ok: ${out.status.file} ${out.status.sizeBytes} B, offsite=${out.status.offsite.state}` +
          (v ? `, verify=${v.ok ? 'ok' : 'FAIL'} ${v.timings.totalMs} ms` : ''),
      );
      return 0;
    }
    console.error('Использование: backup run --kind hourly|daily|weekly [--verify|--no-verify] | backup status');
    return 2;
  } catch (e) {
    console.error(`backup: ${redact(String(e instanceof Error ? e.message : e))}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  backupMain(process.argv.slice(2)).then((c) => process.exit(c));
}
