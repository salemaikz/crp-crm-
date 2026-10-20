// Копии и восстановление на Postgres 16 и настоящем age: дамп → проверка → шифрование → расшифровка
// обоими хранителями → восстановление. Источник — свежая БД с миграциями и синтетикой.
// Нужны TEST_DATABASE_URL (суперпользователь), pg_dump/pg_restore/psql и age/age-keygen в PATH.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { openDriver } from '../../../src/server/platform/db';
import { migrate } from '../../../src/server/platform/db/migrate';
import { testDatabaseUrl } from '../../../src/server/platform/db/testing';
import {
  type BackupConfig,
  loadBackupConfig,
  readStatus,
  runBackup,
} from '../../../scripts/crmctl/backup';
import {
  databaseExists,
  pgTargetFromUrl,
  psql,
  runOk,
  summarize,
} from '../../../scripts/crmctl/backup-lib';
import { restoreFromEncrypted, verifyDumpFile } from '../../../scripts/crmctl/restore';

// Нужные программы. В CI их ставит шаг workflow; без них (локально) тесты пропускаются, но если
// OPS_TOOLS_REQUIRED=1 (restore-drill.yml), отсутствие программ — ошибка, а не пропуск.
const tools = ['age', 'age-keygen', 'rsync', 'pg_dump', 'pg_restore', 'psql'];
const missing = tools.filter((b) => spawnSync(b, ['--version']).error);
if (missing.length > 0 && process.env.OPS_TOOLS_REQUIRED === '1') {
  throw new Error(`Нет программ для проверки копий: ${missing.join(', ')}`);
}
const have = missing.length === 0;
const itest = (name: string, fn: () => Promise<void>) =>
  have ? test(name, fn) : test(name, { skip: `нет программ: ${missing.join(', ')}` }, () => {});

const adminUrl = testDatabaseUrl();
const admin = pgTargetFromUrl(adminUrl);
const suffix = randomBytes(4).toString('hex');
const SRC = `crm_o3_src_${suffix}`;
const VDB = `crm_restorecheck_t${suffix}`;
const srcUrl = withDb(adminUrl, SRC);
let tmp = '';
const keys: { identity: string }[] = [];
let recipientsFile = '';

function withDb(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

function cfg(over: Record<string, string> = {}, dirName = 'vol'): BackupConfig {
  return loadBackupConfig({
    BACKUP_DATABASE_URL: srcUrl,
    BACKUP_DIR: path.join(tmp, dirName),
    BACKUP_RECIPIENTS_FILE: recipientsFile,
    BACKUP_VERIFY_DB: VDB,
    ...over,
  });
}

before(async () => {
  if (!have) return;
  tmp = await mkdtemp(path.join(tmpdir(), 'crm-backup-test-'));
  // Два хранителя: ключи только во временной папке теста
  const pubs: string[] = [];
  for (const n of ['keeper1', 'keeper2']) {
    const id = path.join(tmp, `${n}.key`);
    await runOk(['age-keygen', '-o', id]);
    const pub = (await readFile(id, 'utf8')).match(/public key: (age1\S+)/)?.[1];
    assert.ok(pub);
    pubs.push(pub);
    keys.push({ identity: id });
  }
  recipientsFile = path.join(tmp, 'recipients.txt');
  await writeFile(recipientsFile, `# владелец\n${pubs[0]}\n# директор\n${pubs[1]}\n`);
  // Источник: миграции + синтетика
  await psql(admin, 'postgres', `CREATE DATABASE ${SRC}`);
  const db = await openDriver(srcUrl);
  try {
    await migrate(db);
  } finally {
    await db.close();
  }
  await runOk(['psql', '-X', '-q', '-v', 'ON_ERROR_STOP=1', '-f', 'deploy/backup/seed-synthetic.sql', srcUrl]);
});

after(async () => {
  if (!have) return;
  await psql(admin, 'postgres', `DROP DATABASE IF EXISTS ${SRC} WITH (FORCE)`);
  await psql(admin, 'postgres', `DROP DATABASE IF EXISTS ${VDB} WITH (FORCE)`);
  await rm(tmp, { recursive: true, force: true });
});

itest('недельная копия: проверка, шифрование, статус, ни одного открытого файла', async () => {
  const c = cfg();
  const out = await runBackup(c, { kind: 'weekly', now: new Date('2026-10-25T02:00:00Z') });
  assert.equal(out.status.ok, true);
  assert.equal(out.verify?.ok, true);
  assert.equal(out.verify?.compared, true);
  assert.equal(out.verify?.counts.clients, 200);
  assert.ok(out.verify!.timings.restoreMs > 0 && out.verify!.timings.totalMs > 0);
  assert.equal(out.status.verified?.ok, true);
  assert.equal(out.status.offsite.state, 'disabled_not_configured');
  const files = (await readdir(c.dir)).sort();
  assert.deepEqual(files, [
    'crm-weekly-20261025T020000Z.dump.age',
    'crm-weekly-20261025T020000Z.dump.age.counts.json',
    'crm-weekly-20261025T020000Z.dump.age.sha256',
    'status.json',
  ]);
  const head = (await readFile(path.join(c.dir, files[0]!))).subarray(0, 21).toString();
  assert.equal(head, 'age-encryption.org/v1');
  assert.equal(await databaseExists(admin, VDB), false, 'временная БД удалена');
  assert.equal((await readStatus(c.statusFile))?.file, files[0]);
});

itest('оба хранителя расшифровывают и восстанавливают; время попадает в отчёт', async () => {
  const c = cfg();
  const file = path.join(c.dir, 'crm-weekly-20261025T020000Z.dump.age');
  for (const [i, k] of keys.entries()) {
    const reportPath = path.join(tmp, `report-${i}.json`);
    const r = await restoreFromEncrypted(admin, { file, identity: k.identity, kind: 'verify', db: VDB, reportPath });
    assert.equal(r.ok, true, r.mismatches.join('; '));
    assert.equal(r.compared, true);
    assert.equal(r.counts.users, 5);
    assert.equal(r.counts.audit_log, 200);
    assert.equal(r.withinTarget, true);
    const saved = JSON.parse(await readFile(reportPath, 'utf8')) as { timings: { totalMs: number } };
    assert.ok(saved.timings.totalMs > 0);
  }
  assert.equal(await databaseExists(admin, VDB), false);
});

itest('apply: восстановление в новую БД; в существующую — отказ', async () => {
  const c = cfg();
  const file = path.join(c.dir, 'crm-weekly-20261025T020000Z.dump.age');
  const target = `crm_o3_new_${suffix}`;
  try {
    const r = await restoreFromEncrypted(admin, { file, identity: keys[0]!.identity, kind: 'apply', db: target, noAcl: true });
    assert.equal(r.ok, true);
    assert.equal((await summarize(admin, target)).counts.clients, 200);
    await assert.rejects(
      restoreFromEncrypted(admin, { file, identity: keys[0]!.identity, kind: 'apply', db: target, noAcl: true }),
      /уже есть/,
    );
    assert.equal((await summarize(admin, target)).counts.clients, 200, 'существующая БД не тронута');
  } finally {
    await psql(admin, 'postgres', `DROP DATABASE IF EXISTS ${target} WITH (FORCE)`);
  }
});

itest('чужой ключ не расшифровывает, повреждённый файл ловится суммой', async () => {
  const c = cfg();
  const file = path.join(c.dir, 'crm-weekly-20261025T020000Z.dump.age');
  const stranger = path.join(tmp, 'stranger.key');
  await runOk(['age-keygen', '-o', stranger]);
  await assert.rejects(restoreFromEncrypted(admin, { file, identity: stranger, kind: 'verify', db: VDB }), /age/);
  const copy = path.join(tmp, 'broken.dump.age');
  await writeFile(copy, await readFile(file));
  await writeFile(`${copy}.sha256`, await readFile(`${file}.sha256`));
  await appendFile(copy, 'x');
  await assert.rejects(restoreFromEncrypted(admin, { file: copy, identity: keys[0]!.identity, kind: 'verify', db: VDB }), /Контрольная сумма/);
});

itest('сверка ловит расхождение счётчиков', async () => {
  const dump = path.join(tmp, 'plain.fc');
  const { pgDumpTo } = await import('../../../scripts/crmctl/backup-lib');
  await pgDumpTo(pgTargetFromUrl(srcUrl), dump);
  const real = await summarize(pgTargetFromUrl(srcUrl), SRC);
  const r = await verifyDumpFile(admin, dump, { expected: { ...real, counts: { ...real.counts, clients: 201 } }, tempDb: VDB });
  assert.equal(r.ok, false);
  assert.match(r.mismatches.join(';'), /clients/);
  assert.equal(await databaseExists(admin, VDB), false);
});

itest('ротация на диске: остаются только свежие, сумма и счётчики уходят вместе', async () => {
  const c = cfg({ BACKUP_KEEP_DAILY: '2' }, 'vol-rot');
  for (const day of [20, 21, 22]) {
    await runBackup(c, { kind: 'daily', verify: false, now: new Date(Date.UTC(2026, 9, day, 2)) });
  }
  const names = (await readdir(c.dir)).filter((n) => n.endsWith('.dump.age'));
  assert.deepEqual(names.sort(), ['crm-daily-20261021T020000Z.dump.age', 'crm-daily-20261022T020000Z.dump.age']);
  assert.ok(!existsSync(path.join(c.dir, 'crm-daily-20261020T020000Z.dump.age.sha256')));
  assert.ok(!existsSync(path.join(c.dir, 'crm-daily-20261020T020000Z.dump.age.counts.json')));
});

itest('D-044: без подтверждения ЦОД второй сервер не получает ничего, с подтверждением получает', async () => {
  const inbox = path.join(tmp, 'inbox');
  await mkdir(inbox);
  const a = await runBackup(cfg({ BACKUP_OFFSITE_TARGET: inbox }, 'vol-off1'), { kind: 'hourly', verify: false });
  assert.equal(a.status.offsite.state, 'disabled_unconfirmed');
  assert.deepEqual(await readdir(inbox), []);
  const b = await runBackup(cfg({ BACKUP_OFFSITE_TARGET: inbox, BACKUP_OFFSITE_DC_CONFIRMED_KZ: '1' }, 'vol-off2'), {
    kind: 'hourly',
    verify: false,
  });
  assert.equal(b.status.offsite.state, 'sent');
  assert.equal((await readdir(inbox)).length, 2);
  assert.ok(b.status.offsite.lastSentAt);
});

itest('сбой отправки не отменяет локальную копию и виден в статусе', async () => {
  const c = cfg(
    { BACKUP_OFFSITE_TARGET: path.join(tmp, 'нет', 'такого', 'каталога'), BACKUP_OFFSITE_DC_CONFIRMED_KZ: '1' },
    'vol-off3',
  );
  const out = await runBackup(c, { kind: 'daily', verify: false });
  assert.equal(out.status.ok, true);
  assert.equal(out.status.offsite.state, 'failed');
  assert.ok(existsSync(out.file));
});

itest('один ключ в файле получателей: копия не делается, статус ok=false, открытых файлов нет', async () => {
  const one = path.join(tmp, 'one.txt');
  const first = (await readFile(recipientsFile, 'utf8')).split('\n').find((l) => l.startsWith('age1'))!;
  await writeFile(one, `${first}\n`);
  const c = cfg({ BACKUP_RECIPIENTS_FILE: one }, 'vol-bad');
  await assert.rejects(runBackup(c, { kind: 'daily', verify: false }), /двух хранителей/);
  const st = await readStatus(c.statusFile);
  assert.equal(st?.ok, false);
  assert.deepEqual((await readdir(c.dir)).filter((n) => n !== 'status.json'), []);
});

itest('ошибка дампа: статус ok=false, пароль в статус не попадает', async () => {
  const bad = new URL(srcUrl);
  bad.password = 'topsecret-pw';
  bad.pathname = '/crm_no_such_db';
  const c = cfg({ BACKUP_DATABASE_URL: bad.toString() }, 'vol-err');
  await assert.rejects(runBackup(c, { kind: 'daily', verify: false }));
  const raw = await readFile(c.statusFile, 'utf8');
  assert.ok(!raw.includes('topsecret-pw'));
  assert.equal(JSON.parse(raw).ok, false);
});
