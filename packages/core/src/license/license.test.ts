// Лицензия: подпись и проверка, подделка, чужая установка, водяной знак, истечение → льгота → «только чтение»,
// правило часов. Ключи — одноразовые на прогон: закрытых ключей в репозитории нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  DAY_MS,
  TEST_KEYS,
  advanceClock,
  assembleLicense,
  decodeLicense,
  embeddedKeys,
  buildWatermark,
  evaluateLicense,
  hasFeature,
  rawPublicKeyBase64,
  missingAllowed,
  signingInput,
  verifyLicense,
  verifyStoredCopy,
  CLOCK_MAX_STEP_MS,
  INVALID_GRACE_DAYS,
  type EvaluateInput,
  type LicensePayload,
  type Watermark,
} from './index';
import { parseBuiltAt } from './keys';

const H = 3_600_000;
const T0 = Date.UTC(2026, 9, 24, 6, 0, 0);
const INSTALL = '11111111-2222-3333-4444-555555555555';
const NO_MARK: Watermark = { customer: null, buildId: null, builtAt: null };

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: rawPublicKeyBase64(publicKey), privateKey };
}
const K = keypair();
const OTHER = keypair();
const KEYS = { 'prod-1': K.pub };

function payload(p: Partial<LicensePayload> = {}): LicensePayload {
  return {
    v: 1,
    lid: 'lic-0001',
    kid: 'prod-1',
    customer: 'demo-co',
    installId: INSTALL,
    issuedAt: T0,
    notBefore: T0 - DAY_MS,
    expiresAt: T0 + 30 * DAY_MS,
    graceDays: 10,
    features: ['telephony.zadarma'],
    ...p,
  };
}

function signWith(p: LicensePayload, key = K.privateKey): string {
  const signed = signingInput(p);
  return assembleLicense(signed, sign(null, Buffer.from(signed, 'ascii'), key));
}

/** Оценка с опорой по умолчанию — рабочая подписанная копия payload() и сборка от T0. */
const ev = (i: Omit<EvaluateInput, 'builtAt' | 'anchor'> & Partial<Pick<EvaluateInput, 'builtAt' | 'anchor'>>) =>
  evaluateLicense({ builtAt: T0, anchor: payload(), ...i });

const expect = (watermark: Watermark = NO_MARK, keys: Record<string, string> = KEYS) => ({ installId: INSTALL, keys, watermark });

test('подпись и проверка: формат CRM1, поля сохраняются, перевод строки в файле не мешает', () => {
  const raw = signWith(payload());
  assert.match(raw, /^CRM1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const v = verifyLicense(`${raw}\n`, expect());
  assert.equal(v.ok, true);
  assert.deepEqual(v.ok && v.license, payload());
});

test('подделка: изменённое поле, чужой ключ, чужая подпись, мусор', () => {
  const raw = signWith(payload());
  const [pre, body, sig] = raw.split('.') as [string, string, string];
  const forged = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as LicensePayload;
  forged.expiresAt += 365 * DAY_MS;
  const forgedRaw = `${pre}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${sig}`;
  assert.deepEqual(verifyLicense(forgedRaw, expect()), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyLicense(signWith(payload(), OTHER.privateKey), expect()), { ok: false, reason: 'bad_signature' });
  assert.deepEqual(verifyLicense(signWith(payload({ kid: 'nobody' })), expect()), { ok: false, reason: 'unknown_kid' });
  // kid из прототипа объекта не находит ключ
  assert.deepEqual(verifyLicense(signWith(payload({ kid: 'constructor' })), expect()), { ok: false, reason: 'unknown_kid' });
  const badSig = `${pre}.${body}.${Buffer.alloc(64, 1).toString('base64url')}`;
  assert.deepEqual(verifyLicense(badSig, expect()), { ok: false, reason: 'bad_signature' });
  for (const junk of ['', 'CRM1', 'CRM1.a.b', `CRM1.${body}`, `XXX.${body}.${sig}`, `${raw}.x`, 'x'.repeat(9000)]) {
    assert.equal(verifyLicense(junk, expect()).ok, false, junk.slice(0, 20));
  }
  assert.deepEqual(decodeLicense(`CRM2.${body}.${sig}`), { ok: false, reason: 'unsupported_version' });
  const v2 = Buffer.from(JSON.stringify({ ...payload(), v: 2 })).toString('base64url');
  assert.deepEqual(decodeLicense(`CRM1.${v2}.${sig}`), { ok: false, reason: 'unsupported_version' });
});

test('чужой installId, чужой клиент, привязка к сборке', () => {
  assert.deepEqual(verifyLicense(signWith(payload({ installId: '99999999-0000-0000-0000-000000000000' })), expect()), {
    ok: false,
    reason: 'wrong_install',
  });
  const mark: Watermark = { customer: 'demo-co', buildId: 'b-42', builtAt: T0 };
  assert.equal(verifyLicense(signWith(payload()), expect(mark)).ok, true);
  assert.deepEqual(verifyLicense(signWith(payload({ customer: 'other-co' })), expect(mark)), { ok: false, reason: 'wrong_customer' });
  assert.equal(verifyLicense(signWith(payload({ buildId: 'b-42' })), expect(mark)).ok, true);
  assert.deepEqual(verifyLicense(signWith(payload({ buildId: 'b-41' })), expect(mark)), { ok: false, reason: 'wrong_build' });
  // Общая сборка без водяного знака: клиент не сверяется, но лицензия на конкретную сборку не подходит
  assert.equal(verifyLicense(signWith(payload({ customer: 'other-co' })), expect()).ok, true);
  assert.deepEqual(verifyLicense(signWith(payload({ buildId: 'b-42' })), expect()), { ok: false, reason: 'wrong_build' });
});

test('тестовые ключи в сборке клиента не принимаются; без define — тестовый ключ и общая сборка', () => {
  const testKeys = { 'test-x': K.pub };
  const raw = signWith(payload({ kid: 'test-x' }));
  assert.equal(verifyLicense(raw, expect(NO_MARK, testKeys)).ok, true);
  assert.deepEqual(verifyLicense(raw, expect({ customer: 'demo-co', buildId: null, builtAt: null }, testKeys)), { ok: false, reason: 'test_key_in_client_build' });
  assert.deepEqual(embeddedKeys(), TEST_KEYS);
  assert.deepEqual(buildWatermark(), NO_MARK);
});

test('общая сборка: без лицензии работает (missing → valid); сборка клиента — missing блокирует', () => {
  assert.equal(missingAllowed(NO_MARK), true);
  assert.equal(missingAllowed({ customer: 'demo-co', buildId: 'b-1', builtAt: T0 }), false);
  const dev = ev({ verdict: null, now: T0, previous: null, invalidSince: null, allowMissing: true });
  assert.deepEqual([dev.status, dev.access], ['missing', 'valid']);
  // Загруженная, но плохая лицензия в общей сборке не прощается
  const bad = ev({ verdict: { ok: false, reason: 'bad_signature' }, now: T0, previous: 'missing', invalidSince: null, allowMissing: true });
  assert.equal(bad.access, 'invalid');
});

test('проверка срока не в подписи: подпись верна, но notBefore в будущем — invalid', () => {
  const v = verifyLicense(signWith(payload({ notBefore: T0 + DAY_MS })), expect());
  assert.equal(v.ok, true);
  const e = ev({ verdict: v, now: T0, previous: null, invalidSince: null });
  assert.equal(e.status, 'invalid');
  assert.equal(e.reason, 'not_yet_valid');
  assert.equal(e.access, 'invalid');
});

test('истечение → expiring → льгота (grace) → read_only; признаки модулей', () => {
  const v = verifyLicense(signWith(payload()), expect());
  const at = (now: number) => ev({ verdict: v, now, previous: 'valid', invalidSince: null });
  const exp = T0 + 30 * DAY_MS;
  assert.deepEqual([at(T0).status, at(T0).access], ['valid', 'valid']);
  assert.deepEqual([at(exp - 14 * DAY_MS).status, at(exp - 14 * DAY_MS).access], ['expiring', 'valid']);
  assert.deepEqual([at(exp - 1).status, at(exp - 1).access], ['expiring', 'valid']);
  const g = at(exp);
  assert.deepEqual([g.status, g.access, g.reason, g.graceUntil], ['expired', 'grace', 'expired', exp + 10 * DAY_MS]);
  assert.deepEqual([at(exp + 10 * DAY_MS - 1).access], ['grace']);
  const ro = at(exp + 10 * DAY_MS);
  assert.deepEqual([ro.status, ro.access], ['read_only', 'read_only']);
  assert.equal(hasFeature(at(T0), 'telephony.zadarma'), true);
  assert.equal(hasFeature(g, 'telephony.zadarma'), true);
  assert.equal(hasFeature(ro, 'telephony.zadarma'), false);
  assert.equal(hasFeature(at(T0), 'messenger.wazzup'), false);
  // graceDays = 0: сразу после срока — «только чтение»
  const v0 = verifyLicense(signWith(payload({ graceDays: 0 })), expect());
  assert.equal(ev({ verdict: v0, now: exp, previous: 'expiring', invalidSince: null }).access, 'read_only');
});

test('отсутствие лицензии → missing; invalid не по сборке льготы не даёт, что бы ни было в прошлой проверке', () => {
  assert.deepEqual(ev({ verdict: null, now: T0, previous: 'valid', invalidSince: null }).access, 'missing');
  for (const reason of ['bad_signature', 'malformed', 'unknown_kid', 'wrong_install', 'wrong_customer', 'test_key_in_client_build'] as const) {
    for (const previous of [null, 'missing', 'valid', 'expiring', 'expired', 'invalid'] as const) {
      const e = ev({ verdict: { ok: false, reason }, now: T0, previous, invalidSince: null });
      assert.deepEqual([e.status, e.access, e.graceUntil], ['invalid', 'invalid', null], `${reason} ${previous}`);
    }
  }
  // invalid_since — только для показа: прежнее начало сохраняется, если прошлая проверка тоже invalid
  const bad = { ok: false as const, reason: 'bad_signature' as const };
  assert.equal(ev({ verdict: bad, now: T0, previous: 'invalid', invalidSince: T0 - DAY_MS }).invalidSince, T0 - DAY_MS);
  assert.equal(ev({ verdict: bad, now: T0, previous: 'valid', invalidSince: T0 - DAY_MS }).invalidSince, T0);
  assert.equal(ev({ verdict: bad, now: T0, previous: 'invalid', invalidSince: T0 + DAY_MS }).invalidSince, T0);
});

test('правило часов: назад — не продлевает; вперёд — шаг 48 ч не чаще раза в час; обычный ход', () => {
  // Обычный ход
  assert.deepEqual(advanceClock({ clock: T0 + H, lastSeenAt: T0, lastStepAt: T0 }), {
    now: T0 + H,
    lastSeenAt: T0 + H,
    lastStepAt: T0 + H,
    jump: 'none',
    stepped: false,
  });
  // Первая проверка
  assert.equal(advanceClock({ clock: T0, lastSeenAt: null, lastStepAt: null }).lastSeenAt, T0);
  // Назад на 40 дней: «сейчас» остаётся максимумом виденного
  const back = advanceClock({ clock: T0 - 40 * DAY_MS, lastSeenAt: T0, lastStepAt: T0 });
  assert.deepEqual([back.now, back.lastSeenAt, back.jump], [T0, T0, 'backward']);
  // Дрейф на минуту — не тревога
  assert.equal(advanceClock({ clock: T0 - 60_000, lastSeenAt: T0, lastStepAt: T0 }).jump, 'none');
  // Вперёд на 72 ч (сервер стоял): считаем по часам, максимум сдвигается на 48 ч; через минуту — догоняет
  const fwd = advanceClock({ clock: T0 + 72 * H, lastSeenAt: T0, lastStepAt: T0 });
  assert.deepEqual([fwd.now, fwd.lastSeenAt, fwd.jump, fwd.stepped], [T0 + 72 * H, T0 + CLOCK_MAX_STEP_MS, 'forward', true]);
  const next = advanceClock({ clock: T0 + 72 * H + 60_000, lastSeenAt: fwd.lastSeenAt, lastStepAt: fwd.lastStepAt });
  assert.deepEqual([next.lastSeenAt, next.jump], [T0 + 72 * H + 60_000, 'none']);
  // Часы ушли на год вперёд: шаг 48 ч, затем в течение часа шагов нет, через час — ещё 48 ч
  const year = T0 + 365 * DAY_MS;
  const s1 = advanceClock({ clock: year, lastSeenAt: T0, lastStepAt: T0 });
  const s2 = advanceClock({ clock: year + 59 * 60_000, lastSeenAt: s1.lastSeenAt, lastStepAt: s1.lastStepAt });
  assert.deepEqual([s2.lastSeenAt, s2.stepped, s2.jump], [T0 + 48 * H, false, 'forward']);
  const s3 = advanceClock({ clock: year + H, lastSeenAt: s2.lastSeenAt, lastStepAt: s2.lastStepAt });
  assert.deepEqual([s3.lastSeenAt, s3.stepped], [T0 + 96 * H, true]);
  // После починки часов лицензия снова считается по ним: «сейчас» = максимум виденного (≈ +4 сут), а не год вперёд
  const fixed = advanceClock({ clock: T0 + H, lastSeenAt: s3.lastSeenAt, lastStepAt: s3.lastStepAt });
  assert.equal(fixed.now, T0 + 96 * H);
});

test('перевод часов назад не возвращает лицензию из «только чтения»', () => {
  const v = verifyLicense(signWith(payload()), expect());
  const roAt = T0 + 40 * DAY_MS + H;
  const c = advanceClock({ clock: T0, lastSeenAt: roAt, lastStepAt: roAt });
  assert.equal(ev({ verdict: v, now: c.now, previous: 'read_only', invalidSince: null }).access, 'read_only');
});

const WRONG_BUILD = { ok: false as const, reason: 'wrong_build' as const };

test('льгота wrong_build: до builtAt + 7 сут, строка license_state её не даёт и не продлевает (D-290)', () => {
  const B = T0 - 2 * DAY_MS;
  const end = B + INVALID_GRACE_DAYS * DAY_MS;
  // previous и invalid_since на льготу не влияют: любые значения — один и тот же конец
  for (const previous of [null, 'missing', 'valid', 'expiring', 'expired', 'invalid'] as const) {
    for (const invalidSince of [null, T0, T0 + 1_000 * DAY_MS, T0 - 30 * DAY_MS]) {
      const e = ev({ verdict: WRONG_BUILD, now: T0, previous, invalidSince, builtAt: B });
      assert.deepEqual([e.status, e.access, e.graceUntil], ['invalid', 'grace', end], `${previous} ${invalidSince}`);
    }
  }
  assert.equal(ev({ verdict: WRONG_BUILD, now: end - 1, previous: 'valid', invalidSince: null, builtAt: B }).access, 'grace');
  // Сброс «state = valid, invalid_since = NULL» после конца не возвращает льготу
  for (const d of [8, 30, 100]) {
    const e = ev({ verdict: WRONG_BUILD, now: B + d * DAY_MS, previous: 'valid', invalidSince: null, builtAt: B });
    assert.deepEqual([e.access, e.graceUntil], ['invalid', null], `сутки ${d}`);
  }
  // Сборка без времени (dev, образ до D-290) — без льготы
  assert.equal(ev({ verdict: WRONG_BUILD, now: T0, previous: 'valid', invalidSince: null, builtAt: null }).access, 'invalid');
});

test('льгота wrong_build: нужна рабочая подписанная копия; не дальше её expiresAt + graceDays (D-290)', () => {
  assert.equal(ev({ verdict: WRONG_BUILD, now: T0, previous: 'valid', invalidSince: null, anchor: null }).access, 'invalid');
  // Копия кончилась (expiresAt + graceDays позади) или ещё не началась — льготы нет
  const old = payload({ expiresAt: T0 - 11 * DAY_MS, notBefore: T0 - 40 * DAY_MS, issuedAt: T0 - 40 * DAY_MS });
  assert.equal(ev({ verdict: WRONG_BUILD, now: T0, previous: 'valid', invalidSince: null, anchor: old }).access, 'invalid');
  assert.equal(ev({ verdict: WRONG_BUILD, now: T0, previous: 'valid', invalidSince: null, anchor: payload({ notBefore: T0 + DAY_MS }) }).access, 'invalid');
  // Конец — раньший из builtAt + 7 сут и срока копии: expiresAt через 2 дня, graceDays 1 → T0 + 3 сут
  const short = payload({ expiresAt: T0 + 2 * DAY_MS, graceDays: 1 });
  const g = ev({ verdict: WRONG_BUILD, now: T0, previous: 'valid', invalidSince: null, anchor: short, builtAt: T0 });
  assert.deepEqual([g.access, g.graceUntil], ['grace', T0 + 3 * DAY_MS]);
  assert.equal(ev({ verdict: WRONG_BUILD, now: T0 + 3 * DAY_MS, previous: 'valid', invalidSince: null, anchor: short }).access, 'invalid');
  // Сборка, долго лежавшая до установки: льготы меньше или нет
  assert.equal(ev({ verdict: WRONG_BUILD, now: T0, previous: 'valid', invalidSince: null, builtAt: T0 - 6 * DAY_MS }).graceUntil, T0 + DAY_MS);
  assert.equal(ev({ verdict: WRONG_BUILD, now: T0, previous: 'valid', invalidSince: null, builtAt: T0 - 7 * DAY_MS }).access, 'invalid');
});

test('время сборки в водяном знаке: только 13 цифр epoch-мс', () => {
  assert.equal(parseBuiltAt('1792000000000'), 1_792_000_000_000);
  for (const v of [null, '', 'unset', '0', '179200000000', '1792000000000.5', '-1792000000000', '01792000000000', ' 1792000000000']) {
    assert.equal(parseBuiltAt(v), null, String(v));
  }
});

test('verifyStoredCopy: подпись, installId и клиент — да, buildId — нет; мусор и пусто → null', () => {
  const mark: Watermark = { customer: 'demo-co', buildId: 'b-42', builtAt: T0 };
  assert.equal(verifyStoredCopy('', expect(mark)), null);
  assert.equal(verifyStoredCopy('x', expect(mark)), null);
  assert.equal(verifyStoredCopy(signWith(payload(), OTHER.privateKey), expect(mark)), null);
  assert.equal(verifyStoredCopy(signWith(payload({ installId: '99999999-0000-0000-0000-000000000000' })), expect(mark)), null);
  assert.equal(verifyStoredCopy(signWith(payload({ customer: 'other-co' })), expect(mark)), null);
  // Лицензия прежней сборки — опора льготы после обновления
  assert.equal(verifyStoredCopy(signWith(payload({ buildId: 'b-41' })), expect(mark))?.lid, 'lic-0001');
  assert.deepEqual(verifyLicense(signWith(payload({ buildId: 'b-41' })), expect(mark)), { ok: false, reason: 'wrong_build' });
});
