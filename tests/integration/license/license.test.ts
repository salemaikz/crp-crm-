// Лицензия на Postgres 16 (P10, ARCHITECTURE §5.3, §8.4, D-029, D-054, D-211): состояние считается из файла
// и license_state ядром с одноразовыми ключами; мутации в read_only/invalid/missing → 423, кроме D-054;
// выгрузка и чтение работают всегда; правило часов; правка строки license_state в обход crmctl ничего не даёт
// (D-211, D-290): негодный файл — вердикт по подписанной копии license_raw; льгота invalid — только лицензии
// прежней сборки, до времени сборки (builtAt) + 7 сут и не дальше срока копии.
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
const CLIENT: Watermark = { customer: 'demo-co', buildId: 'b-1', builtAt: SEED_NOW - DAY };
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
  overrideLicenseEnvForTests({ watermark: { customer: null, buildId: null, builtAt: null } });
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
  // Подделка: поле state в БД при битой копии не делает лицензию рабочей и льготы не даёт — опоры нет (D-290)
  await db.sql`UPDATE license_state SET license_raw = ${'CRM1.e30.' + 'A'.repeat(86)}, state = 'valid'`;
  assert.equal(await state(), 'invalid');
  assert.equal((await row()).reason, 'malformed');
  await put(signed());
  assert.equal(await state(), 'valid');
  assert.equal((await row()).invalidSince, null);
});

test('битый, подменённый или чужой файл при рабочей копии в БД: вердикт по копии, как без файла (D-290)', async () => {
  const t = SEED_NOW + H;
  await put(signed());
  assert.equal(await state(t), 'valid');
  const [pre, body] = signed().split('.') as [string, string];
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString()) as LicensePayload;
  forged.expiresAt += 365 * DAY;
  const bad: [string, string][] = [
    [`${pre}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${signed().split('.')[2]}`, 'bad_signature'],
    [signed({ installId: '99999999-0000-4000-8000-000000000000' }), 'wrong_install'],
    [signed({}, generateKeyPairSync('ed25519').privateKey), 'bad_signature'],
    [signed({ customer: 'other-co' }), 'wrong_customer'],
    [signed({ lid: 'lic-later', notBefore: t + 30 * DAY, issuedAt: t, expiresAt: t + 400 * DAY }), 'not_yet_valid'],
    ['x', 'malformed'],
  ];
  for (const [i, [text, reason]] of bad.entries()) {
    await put(text);
    assert.equal(await state(t + (i + 1) * H), 'valid', reason);
    const r = await row();
    assert.deepEqual([r.state, r.reason, r.licenseRaw], ['valid', '', signed()], reason);
    assert.equal((await writeRoute(req(), ctx)).status, 200);
  }
  // Без рабочей копии тот же файл — сразу invalid: прошлая проверка valid льготы не даёт
  await db.sql`UPDATE license_state SET license_raw = ''`;
  await put(bad[0]![0]);
  assert.equal(await state(t + 10 * H), 'invalid');
  assert.equal((await row()).reason, 'bad_signature');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  const changes = await audit('license.state_change');
  assert.ok(changes.some((m) => m.from === 'valid' && m.to === 'invalid' && m.access === 'invalid'));
  assert.ok(!changes.some((m) => m.to === 'invalid' && m.access === 'grace'));
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

// ── Подделка строки license_state (D-290) ──────────────────────────────────────────────────────────────────

type Forge = { licenseRaw?: string; state?: string; invalidSince?: number | null; lastSeenAt?: number };
/** Правка строки в обход crmctl, как её сделал бы root через psql. */
async function forge(f: Forge): Promise<void> {
  const r = await row();
  const lastSeen = f.lastSeenAt ?? r.lastSeenAt;
  await db.sql`UPDATE license_state
                  SET license_raw = ${f.licenseRaw ?? r.licenseRaw}, state = ${f.state ?? r.state},
                      invalid_since = ${f.invalidSince === undefined ? r.invalidSince : f.invalidSince},
                      last_seen_at = ${lastSeen}, checked_at = ${lastSeen}`;
}

async function fresh(raw: string, at: number): Promise<void> {
  clock = at;
  await db.sql`UPDATE license_state SET license_raw = ${raw}, state = 'missing', invalid_since = NULL, reason = '',
                      last_seen_at = ${at}, checked_at = ${at}`;
}

test('сборка клиента без лицензии: license_raw = x и invalid_since в будущем — invalid, а не grace', async () => {
  const t = (await row()).lastSeenAt + H;
  await put(null);
  await fresh('', t);
  assert.equal(await state(t), 'missing');
  await forge({ licenseRaw: 'x', invalidSince: 9_000_000_000_000_000 });
  assert.equal(await state(t + 60_000), 'invalid');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  // invalid_since — только для показа: подделанное «будущее» не сохраняется
  assert.equal((await row()).invalidSince, t + 60_000);
  // То же с подделанным state = valid и «свежим» invalid_since
  await forge({ licenseRaw: 'x', state: 'valid', invalidSince: t });
  assert.equal(await state(t + 2 * 60_000), 'invalid');
  await forge({ licenseRaw: 'x', state: 'expiring', invalidSince: null });
  assert.equal(await state(t + 3 * 60_000), 'invalid');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
});

test('просроченная лицензия: правка state, invalid_since, last_seen_at по одной и вместе — read_only/invalid', async () => {
  const t = (await row()).lastSeenAt + H;
  const exp = t - 20 * DAY;
  const old = signed({ lid: 'lic-old', issuedAt: exp - 60 * DAY, notBefore: exp - 60 * DAY, expiresAt: exp, graceDays: 10 });
  await put(null);
  await fresh(old, t);
  assert.equal(await state(t), 'read_only');
  // state
  await forge({ state: 'valid' });
  assert.equal(await state(t + 60_000), 'read_only');
  // invalid_since
  await forge({ invalidSince: t });
  assert.equal(await state(t + 2 * 60_000), 'read_only');
  // last_seen_at назад, до срока: «сейчас» — по часам, а не по подделанному максимуму
  await forge({ lastSeenAt: exp - 30 * DAY });
  assert.equal(await state(t + 3 * 60_000), 'read_only');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  // Битый файл + все колонки сразу: вердикт по копии, а она просрочена — «только чтение»
  await put('x');
  await forge({ state: 'valid', invalidSince: t, lastSeenAt: t });
  assert.equal(await state(t + 4 * 60_000), 'read_only');
  await forge({ state: 'invalid', invalidSince: t - DAY, lastSeenAt: t - DAY });
  assert.equal(await state(t + 5 * 60_000), 'read_only');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  // Копия в БД не затёрта битым файлом
  assert.equal((await row()).licenseRaw, old);
});

test('рабочая копия + битый файл: valid по копии при любой правке строки; срок — копии, а не строки', async () => {
  const t = (await row()).lastSeenAt + H;
  await put('x');
  await fresh(signed({ lid: 'lic-anchor', expiresAt: t + 365 * DAY }), t);
  for (const f of [{ state: 'invalid', invalidSince: t + 30 * DAY }, { state: 'invalid', invalidSince: t - 8 * DAY }, { state: 'read_only' }]) {
    await forge(f);
    assert.equal(await state(clock + 60_000), 'valid', JSON.stringify(f));
  }
  // Короткая копия: её expiresAt + graceDays — и всё; правка state = valid на каждой проверке не продлевает
  const end = t + 3 * DAY;
  await fresh(signed({ lid: 'lic-short', expiresAt: t + 2 * DAY, graceDays: 1 }), t);
  for (let at = t; at < end; at += 12 * H) {
    await forge({ state: 'valid', invalidSince: null });
    assert.equal(await state(at), at < t + 2 * DAY ? 'valid' : 'grace', new Date(at).toISOString());
  }
  await forge({ state: 'valid', invalidSince: null });
  assert.equal(await state(end), 'read_only');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  assert.equal((await row()).reason, 'expired');
});

// ── Лицензия прежней сборки (wrong_build): льгота от времени сборки, D-290 ────────────────────────────────

const B0: Watermark = { customer: 'demo-co', buildId: 'b-0', builtAt: null };

/** Рабочая лицензия под сборку b-0 стоит и записана копией; затем «обновили» сборку до b-1 от builtAt. */
async function upgraded(t: number, builtAt: number | null, p: Partial<LicensePayload> = {}): Promise<string> {
  await fresh('', t);
  const prevBuild = signed({ lid: 'lic-b0', buildId: 'b-0', expiresAt: t + 365 * DAY, ...p });
  overrideLicenseEnvForTests({ watermark: B0 });
  await put(prevBuild);
  assert.equal(await state(t), 'valid');
  assert.equal((await row()).licenseRaw, prevBuild);
  overrideLicenseEnvForTests({ watermark: { ...CLIENT, builtAt } });
  return prevBuild;
}

test('законная льгота: лицензия прежней сборки — grace до builtAt + 7 сут, затем invalid → 423', async () => {
  const t = (await row()).lastSeenAt + H;
  await upgraded(t, t - DAY);
  assert.equal(await state(t + H), 'grace');
  assert.deepEqual([(await row()).reason, (await row()).state], ['wrong_build', 'invalid']);
  assert.equal((await writeRoute(req(), ctx)).status, 200);
  // Шагами по 24 ч, как работающий сервер; конец — builtAt + 7 сут, а не 7 сут от первой проверки
  for (let at = t + DAY; at < t + 6 * DAY; at += DAY) assert.equal(await state(at), 'grace');
  assert.equal(await state(t + 6 * DAY - 1), 'grace');
  assert.equal(await state(t + 6 * DAY), 'invalid');
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  // Лицензия под новую сборку снимает «только чтение»
  await put(signed({ lid: 'lic-b1', buildId: 'b-1', expiresAt: t + 365 * DAY }));
  assert.equal(await state(t + 6 * DAY + H), 'valid');
  assert.equal((await writeRoute(req(), ctx)).status, 200);
  overrideLicenseEnvForTests({ watermark: CLIENT });
});

test('льгота wrong_build: без builtAt, без копии в БД или после срока копии — сразу invalid', async () => {
  const t = (await row()).lastSeenAt + H;
  // Сборка без времени (образ до D-290)
  await upgraded(t, null);
  assert.equal(await state(t + H), 'invalid');
  // Копии нет (подменили на мусор): опоры нет
  await upgraded(t + DAY, t + DAY);
  await forge({ licenseRaw: 'x' });
  assert.equal(await state(t + DAY + H), 'invalid');
  // Копия кончается раньше builtAt + 7 сут: льгота — до её expiresAt + graceDays
  const t2 = t + 2 * DAY;
  await upgraded(t2, t2, { expiresAt: t2 + 2 * DAY, graceDays: 1 });
  assert.equal(await state(t2 + 2 * DAY + 23 * H), 'grace');
  assert.equal(await state(t2 + 3 * DAY), 'invalid');
  overrideLicenseEnvForTests({ watermark: CLIENT });
});

test('подделка строки раз в 6 суток (state = valid, invalid_since = NULL) не продлевает льготу wrong_build', async () => {
  const t = (await row()).lastSeenAt + H;
  const builtAt = t;
  await upgraded(t, builtAt);
  const seen: Record<number, string> = {};
  for (let d = 0; d <= 100; d++) {
    if (d % 6 === 0) await forge({ state: 'valid', invalidSince: null });
    seen[d] = await state(builtAt + d * DAY + H);
  }
  for (let d = 0; d < 7; d++) assert.equal(seen[d], 'grace', `сутки ${d}`);
  for (const d of [7, 8, 30, 100]) assert.equal(seen[d], 'invalid', `сутки ${d}`);
  assert.equal((await writeRoute(req(), ctx)).status, 423);
  // То же вместе с last_seen_at назад и invalid_since «сейчас»: конец по-прежнему builtAt + 7 сут
  await forge({ state: 'valid', invalidSince: builtAt + 100 * DAY, lastSeenAt: builtAt });
  assert.equal(await state(builtAt + 100 * DAY + 2 * H), 'invalid');
  // Подмена файла мусором вдобавок: вердикт по копии — та же лицензия прежней сборки, льготы нет
  await put('x');
  assert.equal(await state(builtAt + 100 * DAY + 3 * H), 'invalid');
  assert.equal((await row()).reason, 'wrong_build');
  overrideLicenseEnvForTests({ watermark: CLIENT });
});

test('правило часов в льготе wrong_build: назад — не продлевает; вперёд и починка — снова по часам', async () => {
  const t = (await row()).lastSeenAt + H;
  await upgraded(t, t);
  for (let at = t + DAY; at <= t + 5 * DAY; at += DAY) assert.equal(await state(at), 'grace');
  // Часы назад на 30 суток: «сейчас» = максимум виденного, льгота идёт своим ходом
  assert.equal(await state(t - 30 * DAY), 'grace');
  assert.equal((await row()).lastSeenAt, t + 5 * DAY);
  await state(t + 6 * DAY);
  await state(t + 7 * DAY);
  assert.equal(await state(t - 30 * DAY), 'invalid');
  // Скачок вперёд на год посреди льготы: invalid по часам; починили часы — снова grace до builtAt + 7 сут
  const t2 = t + 8 * DAY;
  await upgraded(t2, t2);
  assert.equal(await state(t2 + H), 'grace');
  assert.equal(await state(t2 + 365 * DAY), 'invalid');
  assert.equal((await row()).lastSeenAt, t2 + H + 48 * H);
  assert.equal(await state(t2 + 2 * H), 'grace');
  overrideLicenseEnvForTests({ watermark: CLIENT });
});

test('лицензия «на будущее» не затирает рабочую копию: работа по копии до начала новой', async () => {
  const t = (await row()).lastSeenAt + H;
  const prev = signed({ lid: 'lic-now', expiresAt: t + 365 * DAY });
  await fresh(prev, t);
  await put(prev);
  assert.equal(await state(t), 'valid');
  const next = signed({ lid: 'lic-next', notBefore: t + 30 * DAY, issuedAt: t, expiresAt: t + 400 * DAY });
  await put(next);
  assert.equal(await state(t + H), 'valid');
  assert.equal((await row()).licenseRaw, prev);
  // Новая начала действовать — она становится копией
  for (let at = t + DAY; at <= t + 30 * DAY; at += DAY) await state(at);
  assert.equal(await state(t + 30 * DAY + H), 'valid');
  assert.equal((await row()).licenseRaw, next);
});
