// Чистые части копий: получатели, имена, ротация, решение об отправке (D-044). БД не нужна.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS,
  backupName,
  loadBackupConfig,
  offsiteDecision,
  parseBackupName,
  parseRecipients,
  planRotation,
} from '../../../scripts/crmctl/backup';
import { assertDbName, diffSummary, parseEnvFile, redact } from '../../../scripts/crmctl/backup-lib';

const K1 = `age1${'q'.repeat(58)}`;
const K2 = `age1${'p'.repeat(58)}`;

test('получатели: меньше двух ключей и закрытый ключ отвергаются', () => {
  assert.deepEqual(parseRecipients(`# владелец\n${K1}\n\n# директор\n${K2}\n`), [K1, K2]);
  assert.throws(() => parseRecipients(`${K1}\n${K1}\n`), /двух хранителей/);
  assert.throws(() => parseRecipients(`${K1}\n`), /двух хранителей/);
  assert.throws(() => parseRecipients(`${K1}\nAGE-SECRET-KEY-1ABCDEF\n`), /закрытый ключ/);
  assert.throws(() => parseRecipients(`${K1}\nnot a key\n`), /не похожа/);
});

test('имя копии разбирается обратно и сортируется по времени', () => {
  const n = backupName('daily', new Date('2026-10-22T02:00:05.123Z'));
  assert.equal(n, 'crm-daily-20261022T020005Z.dump.age');
  assert.deepEqual(parseBackupName(n), { kind: 'daily', stamp: '20261022T020005Z' });
  assert.equal(parseBackupName('crm-daily-20261022T020005Z.dump.age.sha256'), null);
  assert.equal(parseBackupName('status.json'), null);
});

test('ротация: остаются самые новые каждого вида, чужие файлы не трогаем', () => {
  const names: string[] = ['status.json', 'notes.txt'];
  for (let d = 1; d <= 10; d++) names.push(backupName('daily', new Date(Date.UTC(2026, 9, d, 2))));
  for (let w = 1; w <= 6; w++) names.push(backupName('weekly', new Date(Date.UTC(2026, 8, w, 2))));
  for (let h = 9; h <= 19; h++) names.push(backupName('hourly', new Date(Date.UTC(2026, 9, 5, h - 5))));
  const del = planRotation(names, { hourly: 12, daily: 7, weekly: 4 });
  assert.equal(del.filter((n) => n.includes('daily')).length, 3);
  assert.ok(del.includes(backupName('daily', new Date(Date.UTC(2026, 9, 1, 2)))));
  assert.ok(!del.includes(backupName('daily', new Date(Date.UTC(2026, 9, 10, 2)))));
  assert.equal(del.filter((n) => n.includes('weekly')).length, 2);
  assert.equal(del.filter((n) => n.includes('hourly')).length, 0);
  assert.ok(!del.includes('status.json') && !del.includes('notes.txt'));
});

test('D-044: без подтверждения ЦОД в РК наружу ничего не уходит', () => {
  const base = { target: 'u@h:/in', confirmedKz: false, kinds: [...KINDS] };
  assert.equal(offsiteDecision(base, 'daily'), 'disabled_unconfirmed');
  assert.equal(offsiteDecision({ ...base, confirmedKz: true }, 'daily'), 'send');
  assert.equal(offsiteDecision({ ...base, confirmedKz: true, kinds: ['daily'] }, 'hourly'), 'skipped_kind');
  assert.equal(offsiteDecision({ ...base, target: undefined, confirmedKz: true }, 'daily'), 'disabled_not_configured');
});

test('настройки: флаг подтверждения по умолчанию выключен, без тома и ключей — ошибка', () => {
  const env = {
    BACKUP_DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/crm',
    BACKUP_DIR: '/var/backups/crm',
    BACKUP_RECIPIENTS_FILE: '/etc/crm/backup-recipients.txt',
    BACKUP_OFFSITE_TARGET: 'crmbackup@second:/in',
  };
  const cfg = loadBackupConfig(env);
  assert.equal(cfg.offsite.confirmedKz, false);
  assert.deepEqual(cfg.keep, { hourly: 12, daily: 7, weekly: 4 });
  assert.throws(() => loadBackupConfig({ ...env, BACKUP_DIR: '' }), /BACKUP_DIR/);
  assert.throws(() => loadBackupConfig({ ...env, BACKUP_RECIPIENTS_FILE: '' }), /BACKUP_RECIPIENTS_FILE/);
  assert.throws(() => loadBackupConfig({ ...env, BACKUP_KEEP_DAILY: '0' }), /BACKUP_KEEP_DAILY/);
  assert.equal(loadBackupConfig({ ...env, BACKUP_OFFSITE_DC_CONFIRMED_KZ: '1' }).offsite.confirmedKz, true);
});

test('защита: имена БД, пароли в тексте ошибок, сравнение сводок', () => {
  assert.throws(() => assertDbName('crm; DROP DATABASE x'), /Недопустимое/);
  assert.equal(redact('failed: postgres://crm:s3cret@db:5432/crm'), 'failed: postgres://crm:***@db:5432/crm');
  const a = { tables: 3, lastMigration: 'm1', counts: { users: 2, clients: 5 } };
  assert.deepEqual(diffSummary(a, { ...a }), []);
  assert.equal(diffSummary(a, { ...a, counts: { users: 2, clients: 4 } }).length, 1);
  assert.equal(diffSummary(a, { ...a, lastMigration: 'm0', tables: 4 }).length, 2);
});

test('файл окружения: комментарии, кавычки, значения с пробелами', () => {
  const e = parseEnvFile('# c\nBACKUP_PG_EXEC=docker exec -i crm-db-1\n\nBACKUP_DIR="/v/b"\nBROKEN\n');
  assert.deepEqual(e, { BACKUP_PG_EXEC: 'docker exec -i crm-db-1', BACKUP_DIR: '/v/b' });
});
