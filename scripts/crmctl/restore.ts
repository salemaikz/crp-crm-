// crmctl restore — проверка и восстановление копии (DEPLOY §6.2–6.3).
//
//   verify: расшифровать копию ключом хранителя, восстановить во временную БД crm_restorecheck*, сверить
//           число таблиц, последнюю миграцию и счётчики ключевых таблиц, удалить БД, записать отчёт с временем.
//   apply:  то же, но в НОВУЮ БД с заданным именем (существующую не трогаем); для «сервер погиб».
//
//   tsx scripts/crmctl/restore.ts verify --file F.dump.age --identity KEY [--report out.json]
//   tsx scripts/crmctl/restore.ts apply  --file F.dump.age --identity KEY --db NAME [--no-acl]
// Закрытый ключ хранителя передаётся только путём к файлу и нигде не сохраняется.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  type DbSummary,
  type Env,
  type PgTarget,
  VERIFY_DB_PREFIX,
  assertDbName,
  createDatabase,
  databaseExists,
  diffSummary,
  envWithFile,
  dropVerifyDatabase,
  pgRestoreFrom,
  pgTargetFromEnv,
  psql,
  redact,
  runOk,
  sha256File,
  summarize,
  timed,
} from './backup-lib';

/** Цель учебного восстановления (DEPLOY §6.3): не дольше 30 минут. */
export const TARGET_MS = 30 * 60_000;

export interface VerifyReport {
  kind: 'verify' | 'apply';
  file: string;
  ok: boolean;
  startedAt: number;
  database: string;
  tables: number;
  lastMigration: string | null;
  counts: Record<string, number>;
  /** Что не совпало с ожидаемым (пусто — всё сошлось или сверки не было). */
  mismatches: string[];
  /** Было ли с чем сверять (counts.json рядом с копией или снимок при backup). */
  compared: boolean;
  timings: { checksumMs: number; decryptMs: number; restoreMs: number; countMs: number; totalMs: number };
  withinTarget: boolean;
}

export interface VerifyOpts {
  expected?: DbSummary;
  tempDb?: string;
  file?: string;
  keepDb?: boolean;
  kind?: 'verify' | 'apply';
  noAcl?: boolean;
  timings?: Partial<VerifyReport['timings']>;
}

/**
 * Восстанавливает несжатый дамп в БД и собирает отчёт. kind=verify: временная БД создаётся заново и удаляется;
 * kind=apply: БД новая, остаётся.
 */
export async function verifyDumpFile(t: PgTarget, dump: string, opts: VerifyOpts = {}): Promise<VerifyReport> {
  const kind = opts.kind ?? 'verify';
  const db = assertDbName(opts.tempDb ?? VERIFY_DB_PREFIX);
  const startedAt = Date.now();
  const t0 = performance.now();
  if (kind === 'verify') {
    await dropVerifyDatabase(t, db); // остатки прошлого прогона
  } else if (await databaseExists(t, db)) {
    throw new Error(`БД ${db} уже есть: восстанавливаем только в новую.`);
  }
  await createDatabase(t, db);
  let created = true;
  try {
    // Временная БД без ACL: ролей приложения в ней может не быть; apply оставляет права, если не --no-acl
    const restore = await timed(() => pgRestoreFrom(t, db, dump, { noAcl: kind === 'verify' || opts.noAcl }));
    const sum = await timed(() => summarize(t, db));
    const mismatches = opts.expected ? diffSummary(opts.expected, sum.value) : [];
    const totalMs = Math.round(performance.now() - t0) + (opts.timings?.checksumMs ?? 0) + (opts.timings?.decryptMs ?? 0);
    const report: VerifyReport = {
      kind,
      file: opts.file ?? path.basename(dump),
      ok: mismatches.length === 0,
      startedAt,
      database: db,
      ...sum.value,
      mismatches,
      compared: Boolean(opts.expected),
      timings: { checksumMs: 0, decryptMs: 0, ...opts.timings, restoreMs: restore.ms, countMs: sum.ms, totalMs },
      withinTarget: totalMs <= TARGET_MS,
    };
    if (kind === 'apply' && report.ok) created = false; // успешная новая БД остаётся
    return report;
  } finally {
    if (created && kind === 'verify' && !opts.keepDb) await dropVerifyDatabase(t, db);
    else if (created && kind === 'apply') await dropNewDatabase(t, db);
  }
}

/** Недовосстановленную новую БД apply убираем сами: полусделанная БД хуже отсутствующей. */
async function dropNewDatabase(t: PgTarget, db: string): Promise<void> {
  await psql(t, 'postgres', `DROP DATABASE IF EXISTS ${assertDbName(db)} WITH (FORCE)`);
}

/** Проверка суммы и расшифровка копии во временную папку. */
export async function decryptBackup(
  file: string,
  identity: string,
  outDir: string,
  ageBin = 'age',
): Promise<{ plain: string; checksumMs: number; decryptMs: number }> {
  const sumFile = `${file}.sha256`;
  const checksum = await timed(async () => {
    const want = (await readFile(sumFile, 'utf8')).trim().split(/\s+/)[0];
    const got = await sha256File(file);
    if (want !== got) throw new Error('Контрольная сумма копии не совпала: файл повреждён или подменён.');
  });
  const plain = path.join(outDir, 'dump.fc');
  const dec = await timed(() => runOk([ageBin, '-d', '-i', identity, '-o', plain, file]));
  return { plain, checksumMs: checksum.ms, decryptMs: dec.ms };
}

async function readExpected(file: string): Promise<DbSummary | undefined> {
  try {
    return JSON.parse(await readFile(`${file}.counts.json`, 'utf8')) as DbSummary;
  } catch {
    return undefined;
  }
}

export async function restoreFromEncrypted(
  t: PgTarget,
  o: { file: string; identity: string; kind: 'verify' | 'apply'; db?: string; noAcl?: boolean; ageBin?: string; reportPath?: string },
): Promise<VerifyReport> {
  const work = await mkdtemp(path.join(tmpdir(), 'crm-restore-'));
  try {
    const dec = await decryptBackup(o.file, o.identity, work, o.ageBin);
    const report = await verifyDumpFile(t, dec.plain, {
      expected: await readExpected(o.file),
      tempDb: o.db,
      file: path.basename(o.file),
      kind: o.kind,
      noAcl: o.noAcl,
      timings: { checksumMs: dec.checksumMs, decryptMs: dec.decryptMs },
    });
    if (o.reportPath) {
      await mkdir(path.dirname(path.resolve(o.reportPath)), { recursive: true });
      await writeFile(o.reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o640 });
    }
    return report;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

export function formatReport(r: VerifyReport): string {
  const s = (ms: number) => `${(ms / 1000).toFixed(1)} с`;
  return [
    `${r.kind}: ${r.ok ? 'OK' : 'РАСХОЖДЕНИЯ'} ${r.file}`,
    `БД ${r.database}: таблиц ${r.tables}, последняя миграция ${r.lastMigration ?? '-'}`,
    `строки: ${Object.entries(r.counts).map(([k, v]) => `${k}=${v}`).join(', ')}`,
    `время: сумма ${s(r.timings.checksumMs)}, расшифровка ${s(r.timings.decryptMs)}, восстановление ${s(r.timings.restoreMs)}, ` +
      `подсчёт ${s(r.timings.countMs)}, всего ${s(r.timings.totalMs)} (цель ${TARGET_MS / 60000} мин: ${r.withinTarget ? 'уложились' : 'НЕ уложились'})`,
    ...(r.compared ? [] : ['сверки со счётчиками копии не было (нет .counts.json)']),
    ...r.mismatches.map((m) => `расхождение: ${m}`),
  ].join('\n');
}

/** Точка входа для crmctl. 0 — ок, 1 — ошибка или расхождения, 2 — неверные аргументы. */
export async function restoreMain(argv: string[], rawEnv: Env = process.env): Promise<number> {
  const cmd = argv[0];
  const file = arg(argv, '--file');
  const identity = arg(argv, '--identity');
  if ((cmd !== 'verify' && cmd !== 'apply') || !file || !identity) {
    console.error('Использование: restore verify|apply --file F.dump.age --identity KEY [--db NAME] [--report out.json] [--no-acl]');
    return 2;
  }
  const db = arg(argv, '--db');
  if (cmd === 'apply' && !db) {
    console.error('apply: нужно --db NAME (новая БД)');
    return 2;
  }
  try {
    const env = await envWithFile(rawEnv);
    const report = await restoreFromEncrypted(pgTargetFromEnv(env), {
      file,
      identity,
      kind: cmd,
      db: cmd === 'apply' ? db : (env.BACKUP_VERIFY_DB?.trim() ?? db),
      noAcl: argv.includes('--no-acl'),
      ageBin: env.BACKUP_AGE_BIN?.trim() || undefined,
      reportPath: arg(argv, '--report'),
    });
    console.log(formatReport(report));
    return report.ok && report.withinTarget ? 0 : 1;
  } catch (e) {
    console.error(`restore: ${redact(String(e instanceof Error ? e.message : e))}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  restoreMain(process.argv.slice(2)).then((c) => process.exit(c));
}
