// Форма getActiveConfig для потребителей: доступ (Viewer), вход (политика, правила номеров), пояс и тема.
// Набор — настоящие слои base + kz + consulting-sales + накладка ЦРП, применённые через crmctl config apply.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runConfig, type ConfigCtx } from '../../../scripts/crmctl/config';
import { parseAccessConfig } from '../../../src/server/access/viewer';
import { readPhoneRules, readSecurityPolicy } from '../../../src/server/platform/auth/policy';
import { loginPhoneDigits } from '../../../src/server/platform/auth/login';
import { ConfigMissingError, getActiveConfig, getActiveConfigOrNull, resetConfigCache } from '../../../src/server/platform/config/active';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { resolveTimeZone } from '../../../src/i18n/config';
import { computeTheme } from '../../../src/ui/theme';

const CRP = path.join(import.meta.dirname, '..', '..', '..', 'presets', 'clients', 'crp');
let db: TestDb;
let assets: string;

before(async () => {
  db = await createTestDb();
  assets = await mkdtemp(path.join(os.tmpdir(), 'crm-shape-'));
});
after(async () => {
  await db.close();
  await rm(assets, { recursive: true, force: true });
});

test('нет настроек: ConfigMissingError (name для потребителей без импорта) и null у getActiveConfigOrNull', async () => {
  resetConfigCache();
  await assert.rejects(getActiveConfig({ now: 1 }), (e: unknown) => e instanceof Error && e.name === 'ConfigMissingError' && e instanceof ConfigMissingError);
  assert.equal(await getActiveConfigOrNull({ now: 2 }), null);
  assert.deepEqual(await readSecurityPolicy(), { sessionDays: 30, inviteTtlHours: 72, loginAttempts: { perPhone: 5, perIp: 20, windowMin: 15 } });
  assert.equal(resolveTimeZone(undefined), 'UTC');
});

test('набор ЦРП проходит схему; getActiveConfig отдаёт то, что ждут доступ, вход, пояс и тема', async () => {
  const out: string[] = [];
  const ctx: ConfigCtx = {
    io: { out: (l) => out.push(l), err: (l) => out.push(l) },
    openDb: async () => async () => {},
    env: { CRM_ASSETS_DIR: assets },
    productVersion: async () => '0.1.0',
  };
  const code = await runConfig(['apply', '--layers', `base,kz,consulting-sales,${CRP}`, '--yes'], ctx);
  assert.equal(code, 0, out.join('\n'));
  resetConfigCache();

  const cfg = await getActiveConfig({ now: 10 });
  assert.equal(typeof cfg.rev, 'number');
  assert.equal(cfg.global.org.timezone, 'Asia/Almaty');
  assert.equal(cfg.global.doc.org.timezone, 'Asia/Almaty', 'документ целиком по-прежнему в doc');

  // доступ: раздел ролей и пояс разбираются своей схемой доступа
  const access = parseAccessConfig(cfg);
  assert.equal(access.timeZone, 'Asia/Almaty');
  assert.equal(access.rev, cfg.rev);
  const live = access.roles.filter((r) => !r.archived).map((r) => r.key);
  assert.deepEqual(live, ['operator', 'rop', 'consultant', 'director', 'marketing_head', 'marketer']);
  assert.deepEqual(access.roles.filter((r) => r.archived).map((r) => r.key).sort(), ['lead', 'manager', 'observer']);
  assert.equal(access.roles.find((r) => r.key === 'director')?.readOnly, true);

  // вход: политика и правила номеров из настроек
  assert.deepEqual(cfg.global.security.loginAttempts, { perPhone: 5, perIp: 20, windowMin: 15 });
  const policy = await readSecurityPolicy();
  assert.equal(policy.sessionDays, cfg.global.security.sessionDays);
  const rules = await readPhoneRules();
  assert.deepEqual(rules.mobilePrefixes, cfg.global.phone.mobilePrefixes);
  assert.equal(loginPhoneDigits('8 (701) 555-01-23', rules), '77015550123');

  // пояс и тема
  assert.equal(resolveTimeZone(cfg.global.org.timezone), 'Asia/Almaty');
  assert.ok(!computeTheme(cfg.global.theme).warnings.includes('unknown-font-preset'));
});
