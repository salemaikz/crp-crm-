// Лицензия на Postgres 16 (P10, ARCHITECTURE §5.3, §8.4, D-029, D-054, D-211): состояние считается из файла
// и license_state ядром с одноразовыми ключами; мутации в read_only/invalid/missing → 423, кроме D-054;
// выгрузка и чтение работают всегда; правило часов; подмена поля state в БД ничего не даёт.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { access as coreAccess, license as core } from '@crm/core';
import type { LicensePayload, Watermark } from '@crm/core/license';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { hashPassword } from '../../../src/server/platform/auth/password';
import { overrideAccessForTests, resetAccessForTests } from '../../../src/server/access/testing';
import { currentLicenseState } from '../../../src/server/access/license';
import { route } from '../../../src/server/access/wrappers';
import { POST as resetPasswordPost } from '../../../src/app/api/team/staff/[id]/password-reset/route';
import { invalidateLicenseCache, licenseJobHandler, readLicenseRow, readLicenseFile } from '../../../src/server/platform/license';
import { overrideLicenseEnvForTests, resetLicenseEnvForTests } from '../../../src/server/platform/license/testing';
import { seedIsolation, SEED_NOW, U } from '../../isolation/harness/seed';
import { actAs, enterSeedWorld } from '../../isolation/harness/actors';

const DAY = 86_400_000;
const H = 3_600_000;
const ORIGIN = 'http://localhost:3000';
const CLIENT: Watermark = { customer: 'demo-co', buildId: 'b-1' };
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = { 'prod-1': core.rawPublicKeyBase64(publicKey) };

let db: TestDb;
let dir: string;
let file: string;
let installId: string;
let clock = SEED_NOW;

function signed(p: Partial<LicensePayload> = {}, key = privateKey): string {
  const payload: LicensePayload = {
    v: 1,
    lid: 'lic-int-1',
    kid: 'prod-1',
    customer: 'demo-co',
    installId,
    issuedAt: SEED_NOW - DAY,
    notBefore: SEED_NOW - DAY,
    expiresAt: SEED_NOW + 30 * DAY,
    graceDays: 10,
    features: [],
    ...p,
  };
  const s = core.signingInput(payload);
  return core.assembleLicense(s, sign(null, Buffer.from(s, 'ascii'), key));
}

async function put(text: string | null): Promise<void> {
  if (text === null) await rm(file, { force: true });
  else await writeFile(file, `${text}\n`);
}

/** Состояние, как его увидит следующий запрос (кэш процесса сброшен). */
async function state(at = clock) {
  clock = at;
  invalidateLicenseCache();
  return currentLicenseState();
}

const row = async () => (await readLicenseRow(db.sql))!;
const audit = async (action: string) =>
  (await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = ${action} ORDER BY created_at`).map((r) => r.meta);

const req = (method = 'POST') => new Request(`${ORIGIN}/api/x`, { method, headers: { Origin: ORIGIN } });
const ctx = { params: Promise.resolve({}) };
const ok = async () => Response.json({ ok: true });
const writeRoute = route({ perm: 'client.edit' }, ok);
const readRoute = route({ perm: 'card.read' }, ok);
const exportRoute = route({ perm: 'data.export_all' }, ok);
async function resetPassword(): Promise<number> {
  actAs(U.admin);
  try {
    return (await resetPasswordPost(req(), { params: Promise.resolve({ id: U.opB }) })).status;
  } finally {
    actAs(U.rop);
  }
}

before(async () => {
  db = await createTestDb();
  await seedIsolation(db.sql);
  // у синтетики пароля нет: «активен» = есть пароль (сброс пароля D-054 нужен действующему сотруднику)
  const hash = await hashPassword('Надёжный-пароль-77');
  await db.sql`UPDATE users SET password_hash = ${hash} WHERE status = 'active'`;
  dir = await mkdtemp(path.join(tmpdir(), 'crm-license-'));
  file = path.join(dir, 'license.crm');
  // installId создаёт crmctl install; здесь — строка, как после установки
  installId = '0f0e0d0c-0000-4000-8000-00000000a001';
  await db.sql`INSERT INTO license_state (id, license_raw, install_id, state, last_seen_at, checked_at)
               VALUES (1, '', ${installId}, 'missing', ${SEED_NOW - DAY}, ${SEED_NOW - DAY})`;
});
after(async () => {
  resetAccessForTests();
  resetLicenseEnvForTests();
  invalidateLicenseCache();
  await rm(dir, { recursive: true, force: true });
  await db.close();
});
beforeEach(() => {
  enterSeedWorld();
  // Viewer берёт лицензию из настоящего пересчёта, а не из подмены прогона
  overrideAccessForTests({ license: currentLicenseState, now: () => clock });
  overrideLicenseEnvForTests({ keys: KEYS, watermark: CLIENT, readFile: () => readLicenseFile(file), clock: () => clock });
  actAs(U.rop);
});

test('нет файла и копии: missing — мутации 423, мутации безопасности D-054, чтение и полная выгрузка работают', async () => {
  await put(null);
  assert.equal(await state(SEED_NOW), 'missing');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  assert.equal((await readRoute(req('GET'), ctx)).status, 200);
  // Поиск/выгрузка POST-ом — не мутация (D-074): лицензия её не блокирует (D-055)
  assert.equal((await exportRoute(req(), ctx)).status, 200);
  for (const key of coreAccess.SECURITY_MUTATIONS) {
    const r = route({ perm: 'authenticated', securityMutation: key }, ok);
    assert.equal((await r(req(), ctx)).status, 200, key);
  }
  // Настоящий маршрут из списка D-054: сброс пароля администратором
  assert.equal(await resetPassword(), 200);
  assert.equal((await row()).state, 'missing');
});

test('общая сборка без водяного знака: без лицензии работает (dev, тесты, e2e)', async () => {
  overrideLicenseEnvForTests({ watermark: { customer: null, buildId: null } });
  await put(null);
  assert.equal(await state(), 'valid');
  assert.equal((await writeRoute(req(), ctx)).status, 200);
});

test('подпись и установка: valid; запись копии в БД и аудит загрузки; правка поля state в БД ничего не даёт', async () => {
  await put(signed());
  assert.equal(await state(SEED_NOW), 'valid');
  assert.equal((await writeRoute(req(), ctx)).status, 200);
  const r = await row();
  assert.equal(r.state, 'valid');
  assert.match(r.licenseRaw, /^CRM1\./);
  assert.equal((await audit('license.install')).at(-1)?.source, 'file');
  // Файл пропал — работает копия из БД (восстановление на новой ВМ)
  await put(null);
  assert.equal(await state(), 'valid');
  // Подделка: поле state в БД при битой копии не делает лицензию рабочей
  await db.sql`UPDATE license_state SET license_raw = ${'CRM1.e30.' + 'A'.repeat(86)}, state = 'valid'`;
  assert.equal(await state(), 'grace'); // invalid после рабочей — льгота 7 дней
  await put(signed());
  assert.equal(await state(), 'valid');
  assert.equal((await row()).invalidSince, null);
});

test('подделка и чужой installId после рабочей лицензии: льгота 7 дней, затем invalid → 423; льгота не продлевается', async () => {
  const t = SEED_NOW + H;
  await put(signed());
  assert.equal(await state(t), 'valid');
  const [pre, body] = signed().split('.') as [string, string];
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString()) as LicensePayload;
  forged.expiresAt += 365 * DAY;
  await put(`${pre}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signed().split('.')[2]}`);
  assert.equal(await state(t + H), 'grace');
  assert.equal((await row()).reason, 'bad_signature');
  assert.equal((await row()).invalidSince, t + H);
  assert.equal((await writeRoute(req(), ctx)).status, 200);
  await put(signed({ installId: '99999999-0000-4000-8000-000000000000' }));
  assert.equal(await state(t + 2 * H), 'grace');
  assert.equal((await row()).reason, 'wrong_install');
  // Через 7 дней от начала — invalid, хотя проверки шли всё время
  for (let d = 1; d <= 6; d++) assert.equal(await state(t + H + d * DAY), 'grace');
  assert.equal(await state(t + H + 7 * DAY), 'invalid');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  // Чужой ключ подписи — тоже invalid
  await put(signed({}, generateKeyPairSync('ed25519').privateKey));
  assert.equal(await state(), 'invalid');
  assert.equal((await row()).reason, 'bad_signature');
  const changes = await audit('license.state_change');
  assert.ok(changes.some((m) => m.from === 'valid' && m.to === 'invalid' && m.access === 'grace'));
});

test('первая установка с чужой лицензией — сразу invalid, без льготы', async () => {
  await db.sql`UPDATE license_state SET license_raw = '', state = 'missing', invalid_since = NULL, reason = ''`;
  await put(signed({ customer: 'other-co' }));
  assert.equal(await state(), 'invalid');
  assert.equal((await row()).reason, 'wrong_customer');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
});

test('истечение: valid → expiring → grace → read_only; перевод часов назад не возвращает работу', async () => {
  await db.sql`UPDATE license_state SET license_raw = '', state = 'missing', invalid_since = NULL, reason = '',
                      last_seen_at = ${SEED_NOW}, checked_at = ${SEED_NOW}`;
  const exp = SEED_NOW + 30 * DAY;
  await put(signed({ expiresAt: exp, graceDays: 10 }));
  // Часы идут шагами меньше 48 ч, как при работающем сервере
  let t = SEED_NOW;
  const walk = async (to: number) => {
    let s = await state(t);
    while (t < to) {
      t = Math.min(to, t + 24 * H);
      s = await state(t);
    }
    return s;
  };
  assert.equal(await walk(exp - 15 * DAY), 'valid');
  assert.equal(await walk(exp - 13 * DAY), 'valid');
  assert.equal((await row()).state, 'expiring');
  assert.equal(await walk(exp + DAY), 'grace');
  assert.equal((await row()).state, 'expired');
  assert.equal((await writeRoute(req(), ctx)).status, 200);
  assert.equal(await walk(exp + 10 * DAY), 'read_only');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  assert.equal((await exportRoute(req(), ctx)).status, 200);
  assert.equal(await resetPassword(), 200);
  // Перевод часов на 60 дней назад: «сейчас» = максимум виденного, «только чтение» остаётся
  const seen = (await row()).lastSeenAt;
  assert.equal(await state(SEED_NOW - 20 * DAY), 'read_only');
  assert.equal((await row()).lastSeenAt, seen);
  // Новая лицензия снимает «только чтение»
  await put(signed({ lid: 'lic-int-2', expiresAt: seen + 365 * DAY }));
  assert.equal(await state(SEED_NOW - 20 * DAY), 'valid');
  assert.equal((await writeRoute(req(), ctx)).status, 200);
});

test('скачок часов вперёд больше 48 ч: максимум виденного — шаг 48 ч не чаще раза в час, тревога в аудите', async () => {
  const before = (await row()).lastSeenAt;
  const far = before + 400 * DAY;
  clock = far;
  invalidateLicenseCache();
  await currentLicenseState();
  assert.equal((await row()).lastSeenAt, before + 48 * H);
  await state(far + 30 * 60_000);
  assert.equal((await row()).lastSeenAt, before + 48 * H);
  await state(far + H);
  assert.equal((await row()).lastSeenAt, before + 96 * H);
  const jumps = await audit('license.clock_jump');
  assert.equal(jumps.length, 2);
  assert.equal(jumps[0]?.direction, 'forward');
  // Часы починили: лицензия снова считается по ним
  assert.equal(await state(before + H), 'valid');
});

test('кэш процесса: смена файла видна после истечения минуты кэша; задача воркера пересчитывает сразу', async () => {
  await put(signed({ lid: 'lic-int-3', expiresAt: (await row()).lastSeenAt + 365 * DAY }));
  assert.equal(await state(), 'valid');
  await put(null);
  await db.sql`UPDATE license_state SET license_raw = ''`;
  assert.equal(await currentLicenseState(), 'valid'); // ещё из кэша
  const res = await licenseJobHandler();
  assert.equal(res.status, 'ok');
  assert.match(res.note ?? '', /^missing\/missing/);
  assert.equal(await currentLicenseState(), 'missing');
});
