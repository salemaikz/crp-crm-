// Логотип клиента (D-333) на Postgres 16: те же байты в ответе, новый ETag после замены файла, 200 при любом
// состоянии лицензии (D-054), loadBrand отдаёт адрес. Синтетика прогона изоляции, файл — во временном каталоге.
import { register } from 'node:module';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { license as core } from '@crm/core';
import type { LicensePayload } from '@crm/core/license';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { resetConfigCache, getActiveConfig } from '../../../src/server/platform/config/active';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { invalidateLicenseCache, currentLicenseSnapshot, readLicenseFile } from '../../../src/server/platform/license';
import { overrideLicenseEnvForTests, resetLicenseEnvForTests } from '../../../src/server/platform/license/testing';
import { resetLogoCacheForTests } from '../../../src/server/platform/brand/logo';
import { writeConfig } from '../../../src/server/platform/config/write';
import { readLogo } from '../../../src/server/platform/brand';
import { seedIsolation } from '../../isolation/harness/seed';
import { applySeedConfig } from '../../isolation/harness/config';
import { GET } from '../../../src/app/api/brand/logo/route';

// loadBrand зовёт getTranslations: нужна серверная сборка next-intl и файл запроса — те же хуки, что у прогона изоляции
register('../../isolation/runner/hooks.mjs', import.meta.url);
type LoadBrand = typeof import('../../../src/ui/shells/loadBrand').loadBrand;
let loadBrand: LoadBrand;

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 28, 10, 0);
const INSTALL = '0f0e0d0c-0000-4000-8000-00000000b002';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const svg = (w: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="4"><rect width="${w}" height="4"/></svg>`;
const ctx = { params: Promise.resolve({}) };
const req = (headers: Record<string, string> = {}) => new Request('http://localhost:3000/api/brand/logo', { headers });

let db: TestDb;
let dir: string;
let licFile: string;
let logoKey: string;
let savedAssets: string | undefined;

function signed(p: Partial<LicensePayload>): string {
  const payload: LicensePayload = {
    v: 1, lid: 'lic-logo-1', kid: 'prod-1', customer: 'demo-co', installId: INSTALL,
    issuedAt: NOW - 100 * DAY, notBefore: NOW - 100 * DAY, expiresAt: NOW + 90 * DAY, graceDays: 10, features: [], ...p,
  };
  const s = core.signingInput(payload);
  return core.assembleLicense(s, sign(null, Buffer.from(s, 'ascii'), privateKey));
}

async function replaceLogo(text: string): Promise<void> {
  await writeFile(path.join(dir, '.next.tmp'), text);
  await rename(path.join(dir, '.next.tmp'), path.join(dir, logoKey)); // как installAssets: через rename
}

before(async () => {
  loadBrand = (await import('../../../src/ui/shells/loadBrand')).loadBrand;
  db = await createTestDb();
  await seedIsolation(db.sql);
  resetConfigCache();
  await applySeedConfig();
  // Безусловно: явная ревизия настроек с логотипом (docs/logo-design.md §5 п. 7), а не то, что дал пресет сида
  // (на базовом пресете brandMark = 'name', и ветка с логотипом иначе не проверялась бы).
  const base = await getActiveConfig();
  const global = { ...(base.global.doc as unknown as Record<string, unknown>) };
  global.theme = { ...(global.theme as Record<string, unknown>), brandMark: 'logo', logo: 'int-logo.svg' };
  await writeConfig({ docs: { global: global as never }, source: 'cli', authorId: null, note: 'логотип: проверка D-333' });
  resetConfigCache();
  const theme = (await getActiveConfig()).global.theme;
  assert.equal(theme.brandMark, 'logo');
  logoKey = theme.logo;
  assert.equal(logoKey, 'int-logo.svg');
  dir = await mkdtemp(path.join(tmpdir(), 'crm-brand-int-'));
  licFile = path.join(dir, 'license.crm');
  savedAssets = process.env.CRM_ASSETS_DIR;
  process.env.CRM_ASSETS_DIR = dir;
  resetLogoCacheForTests();
  await db.sql`INSERT INTO license_state (id, license_raw, install_id, state, last_seen_at, checked_at)
               VALUES (1, '', ${INSTALL}, 'missing', ${NOW - DAY}, ${NOW - DAY}) ON CONFLICT (id) DO NOTHING`;
  let clock = NOW;
  overrideLicenseEnvForTests({
    keys: { 'prod-1': core.rawPublicKeyBase64(publicKey) },
    watermark: { customer: 'demo-co', buildId: 'b-1', builtAt: NOW - DAY },
    readFile: () => readLicenseFile(licFile),
    clock: () => clock++ && NOW,
    mono: () => 0,
  });
});
after(async () => {
  if (savedAssets === undefined) delete process.env.CRM_ASSETS_DIR;
  else process.env.CRM_ASSETS_DIR = savedAssets;
  resetLicenseEnvForTests();
  invalidateLicenseCache();
  resetLogoCacheForTests();
  resetAccessForTests();
  await rm(dir, { recursive: true, force: true });
  await db.close();
});

test('маршрут отдаёт те же байты; после замены файла меняется ETag', async () => {
  await replaceLogo(svg(10));
  const a = await GET(req(), ctx);
  assert.equal(a.status, 200);
  assert.equal(await a.text(), svg(10));
  const etagA = a.headers.get('ETag');
  assert.ok(etagA);
  await replaceLogo(svg(12));
  const b = await GET(req(), ctx);
  assert.equal(await b.text(), svg(12));
  assert.notEqual(b.headers.get('ETag'), etagA);
  assert.equal((await GET(req({ 'If-None-Match': b.headers.get('ETag') as string }), ctx)).status, 304);
});

test('лицензия read_only и expired логотип не блокирует (D-054)', async () => {
  await replaceLogo(svg(10));
  for (const [name, text] of [['read_only', null], ['expired', signed({ expiresAt: NOW - 30 * DAY, graceDays: 1 })]] as const) {
    await rm(licFile, { force: true });
    if (text !== null) await writeFile(licFile, `${text}\n`);
    invalidateLicenseCache();
    const snap = await currentLicenseSnapshot();
    assert.notEqual(snap.status, 'valid', name);
    assert.ok(snap.access === 'read_only' || snap.access === 'missing' || snap.access === 'invalid', `${name}: access=${snap.access}`);
    const r = await GET(req(), ctx);
    assert.equal(r.status, 200, name);
    assert.equal(r.headers.get('Set-Cookie'), null);
  }
});

test('loadBrand по активным настройкам: адрес с хешем при brandMark=logo', async () => {
  await replaceLogo(svg(10));
  const view = await loadBrand();
  const file = await readLogo(logoKey);
  assert.ok(file);
  assert.equal(view.logoSrc, `/api/brand/logo?v=${file.hash}`);
  await replaceLogo(svg(14));
  assert.notEqual((await loadBrand()).logoSrc, view.logoSrc, 'после замены файла адрес другой');
  await rm(path.join(dir, logoKey), { force: true });
  assert.equal((await loadBrand()).logoSrc, null, 'без файла — название текстом');
});
