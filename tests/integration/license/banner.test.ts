// Полоса лицензии на настоящем пересчёте (P10b, D-327): подписанная лицензия → снимок → loadLicenseBanner.
// Состояния: валидна, заканчивается, льгота, просрочена, нет лицензии; администратор и обычный сотрудник.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { license as core } from '@crm/core';
import type { LicensePayload } from '@crm/core/license';
import type { Viewer } from '../../../src/server/access';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { invalidateLicenseCache, readLicenseFile } from '../../../src/server/platform/license';
import { overrideLicenseEnvForTests, resetLicenseEnvForTests } from '../../../src/server/platform/license/testing';
import { loadLicenseBanner } from '../../../src/ui/shells/loadBanner';

const DAY = 86_400_000;
const H = 3_600_000;
const NOW = Date.UTC(2026, 9, 28, 10, 0);
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = { 'prod-1': core.rawPublicKeyBase64(publicKey) };
const INSTALL = '0f0e0d0c-0000-4000-8000-00000000b001';

let db: TestDb;
let dir: string;
let file: string;
let clock = NOW;

function signed(p: Partial<LicensePayload> = {}): string {
  const payload: LicensePayload = {
    v: 1,
    lid: 'lic-banner-1',
    kid: 'prod-1',
    customer: 'demo-co',
    installId: INSTALL,
    issuedAt: NOW - 100 * DAY,
    notBefore: NOW - 100 * DAY,
    expiresAt: NOW + 90 * DAY,
    graceDays: 10,
    features: [],
    ...p,
  };
  const s = core.signingInput(payload);
  return core.assembleLicense(s, sign(null, Buffer.from(s, 'ascii'), privateKey));
}

async function bannerFor(text: string | null, at: number, isAdmin: boolean) {
  await rm(file, { force: true });
  if (text !== null) await writeFile(file, `${text}\n`);
  clock = at;
  invalidateLicenseCache();
  const viewer = { isAdmin, readOnly: false, timeZone: 'Asia/Almaty' } as unknown as Viewer;
  return loadLicenseBanner(viewer);
}

before(async () => {
  db = await createTestDb();
  dir = await mkdtemp(path.join(tmpdir(), 'crm-banner-'));
  file = path.join(dir, 'license.crm');
  await db.sql`INSERT INTO license_state (id, license_raw, install_id, state, last_seen_at, checked_at)
               VALUES (1, '', ${INSTALL}, 'missing', ${NOW - DAY}, ${NOW - DAY})`;
  overrideLicenseEnvForTests({
    keys: KEYS,
    watermark: { customer: 'demo-co', buildId: 'b-1', builtAt: NOW - DAY },
    readFile: () => readLicenseFile(file),
    clock: () => clock,
    mono: () => 0,
  });
});
after(async () => {
  resetLicenseEnvForTests();
  invalidateLicenseCache();
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('валидная лицензия: полосы нет', async () => {
  assert.equal(await bannerFor(signed(), NOW, true), null);
});

test('до конца 10 дней: администратор видит предупреждение, сотрудник нет', async () => {
  const text = signed({ expiresAt: NOW + 10 * DAY });
  assert.deepEqual(await bannerFor(text, NOW, true), { tone: 'warn', key: 'expiring', params: { days: 10, date: '07.11.2026' } });
  assert.equal(await bannerFor(text, NOW, false), null);
});

test('срок истёк, идёт льгота: danger с датой конца льготы только администратору', async () => {
  const text = signed({ expiresAt: NOW - DAY, graceDays: 10 });
  const b = await bannerFor(text, NOW, true);
  assert.equal(b?.key, 'grace');
  assert.equal(b?.params.date, '06.11.2026');
  assert.equal(await bannerFor(text, NOW, false), null);
});

test('срок и льгота прошли: администратору подробно, сотруднику коротко', async () => {
  const text = signed({ expiresAt: NOW - 20 * DAY, graceDays: 10 });
  assert.equal((await bannerFor(text, NOW, true))?.key, 'readOnly');
  assert.deepEqual(await bannerFor(text, NOW, false), { tone: 'info', key: 'readOnlyShort', params: {} });
});

test('лицензия прежней сборки (wrong_build) в льготе: предупреждение о версии с датой конца льготы', async () => {
  const build0 = { customer: 'demo-co', buildId: 'b-0', builtAt: null };
  const build1 = { customer: 'demo-co', buildId: 'b-1', builtAt: NOW - DAY };
  const text = signed({ buildId: 'b-0' });
  overrideLicenseEnvForTests({ watermark: build0 });
  assert.equal(await bannerFor(text, NOW, true), null);
  // сборку обновили, лицензию под новую ещё не выдали: льгота builtAt + 7 суток
  overrideLicenseEnvForTests({ watermark: build1 });
  assert.deepEqual(await bannerFor(text, NOW + H, true), { tone: 'danger', key: 'wrongBuild', params: { date: '03.11.2026' } });
  assert.equal(await bannerFor(text, NOW + H, false), null);
});
