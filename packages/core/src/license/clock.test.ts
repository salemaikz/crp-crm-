// Правило часов лицензии: часы позади (D-212, D-306, D-314). Пока часы отстают от максимума виденного больше чем
// на 10 минут, время лицензии стоит, а длительность эпизода идёт по ходу часов и монотонному времени процесса;
// эпизод дольше 48 ч — «только чтение» с причиной clock; эпизод кончается сам, когда часы снова не позади.
// Состояние между проверками — как в license_state; «перезапуск» — опора процесса теряется. Ключи — одноразовые.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  DAY_MS,
  advanceClock,
  assembleLicense,
  evaluateLicense,
  rawPublicKeyBase64,
  signingInput,
  verifyLicense,
  CLOCK_BEHIND_LOCK_MS,
  CLOCK_BACKWARD_TOLERANCE_MS,
  type ClockAnchor,
  type ClockInput,
  type ClockResult,
  type LicensePayload,
} from './index';

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 2, 6, 0, 0);
const YEAR = 365 * DAY_MS;
const INSTALL = '11111111-2222-3333-4444-555555555555';
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const KEYS = { 'prod-1': rawPublicKeyBase64(publicKey) };

function verdictFor(p: Partial<LicensePayload>) {
  const payload: LicensePayload = {
    v: 1,
    lid: 'lic-clock',
    kid: 'prod-1',
    customer: 'demo-co',
    installId: INSTALL,
    issuedAt: T0 - DAY_MS,
    notBefore: T0 - DAY_MS,
    expiresAt: T0 + 30 * DAY_MS,
    graceDays: 0,
    features: [],
    ...p,
  };
  const s = signingInput(payload);
  const text = assembleLicense(s, sign(null, Buffer.from(s, 'ascii'), privateKey));
  return verifyLicense(text, { installId: INSTALL, keys: KEYS, watermark: { customer: 'demo-co', buildId: null, builtAt: null } });
}

type Row = Pick<ClockInput, 'lastSeenAt' | 'lastStepAt' | 'behind'>;

/** Сервер: строка license_state между проверками и опоры процессов в памяти (по умолчанию один процесс). */
function server(start: number) {
  let row: Row = { lastSeenAt: start, lastStepAt: start, behind: null };
  const anchors = new Map<string, ClockAnchor | null>();
  return {
    check(clock: number, mono: number, opts: { restart?: boolean; proc?: string } = {}): ClockResult {
      const proc = opts.proc ?? 'app';
      if (opts.restart) anchors.set(proc, null);
      const r = advanceClock({ clock, mono, anchor: anchors.get(proc) ?? null, ...row });
      row = { lastSeenAt: r.lastSeenAt, lastStepAt: r.lastStepAt, behind: r.behind };
      anchors.set(proc, r.anchor);
      return r;
    },
    get row() {
      return row;
    },
  };
}

test('целые мс: дробное performance.now() и дробные часы, несколько пересчётов в одном процессе — все поля целые', () => {
  const s = server(T0);
  const results = [
    s.check(T0 + 0.4, 1_000.37),
    s.check(T0 + MIN + 0.9, 61_000.91),
    s.check(T0 + MIN - H + 0.5, 121_001.5),
    s.check(T0 + 2 * MIN - H + 0.25, 181_002.75),
    s.check(T0 + 3 * MIN - H, 241_003.125),
  ];
  for (const r of results) {
    const nums = [r.now, r.lastSeenAt, r.lastStepAt, r.behindForMs, r.anchor.mono, r.anchor.forMs, r.behind?.since ?? 0, r.behind?.lastClock ?? 0, r.behind?.forMs ?? 0];
    assert.ok(nums.every(Number.isInteger), JSON.stringify(r));
  }
  assert.equal(results.at(-1)!.jump, 'backward');
  assert.ok(results.at(-1)!.behindForMs >= 2 * MIN && results.at(-1)!.behindForMs < 2 * MIN + 10);
  assert.throws(() => advanceClock({ clock: Number.NaN, mono: 0, anchor: null, lastSeenAt: T0, lastStepAt: T0, behind: null }), RangeError);
});

test('часы на год назад за сутки до срока, без правки БД, перезапуск перед каждой проверкой: время стоит, 48 ч эпизода — read_only', () => {
  const v = verdictFor({ expiresAt: T0 + DAY_MS, graceDays: 0 });
  const s = server(T0);
  const ev = (c: ClockResult) => evaluateLicense({ verdict: v, now: c.now, previous: null, invalidSince: null, anchor: null, builtAt: null, clockLocked: c.locked });
  const seen: ClockResult[] = [];
  for (let k = 1; k <= 4; k++) seen.push(s.check(T0 + k * DAY_MS - YEAR, 5_000, { restart: true }));
  // Длительность эпизода — по ходу часов (перезапуск его не теряет): 0, 24, 48, 72 ч; время лицензии — T0
  assert.deepEqual(seen.map((c) => c.behindForMs), [0, DAY_MS, 2 * DAY_MS, 3 * DAY_MS]);
  assert.deepEqual(seen.map((c) => c.now), [T0, T0, T0, T0]);
  assert.deepEqual(seen.map((c) => ev(c).access), ['valid', 'valid', 'valid', 'read_only']);
  assert.equal(ev(seen[3]!).reason, 'clock');
  // Часы вернули: срок считается по ним и уже вышел — перевод назад ничего не дал сверх 48 ч эпизода
  const back = s.check(T0 + 4 * DAY_MS + H, 6_000, { restart: true });
  assert.deepEqual([back.jump, back.locked, ev(back).access, ev(back).reason], ['none', false, 'read_only', 'expired']);
});

test('часы позади дольше 48 ч: «только чтение» с причиной clock при долгой лицензии; тревога раз в сутки; починили — блокировки нет', () => {
  const v = verdictFor({ expiresAt: T0 + YEAR, graceDays: 30 });
  const s = server(T0);
  const ev = (c: ClockResult) => evaluateLicense({ verdict: v, now: c.now, previous: null, invalidSince: null, anchor: null, builtAt: null, clockLocked: c.locked });
  const held = T0 - 30 * DAY_MS;
  const alerts: number[] = [];
  let last: ClockResult | null = null;
  for (let h = 1; h <= 73; h++) {
    last = s.check(held + h * H, h * H);
    if (last.alert) alerts.push(h);
    assert.equal(last.locked, last.behindForMs > CLOCK_BEHIND_LOCK_MS, `час ${h}`);
  }
  assert.deepEqual(alerts, [1, 25, 49, 73], 'начало эпизода и раз в сутки');
  assert.equal(last!.behindForMs, 72 * H);
  const locked = ev(last!);
  assert.deepEqual([locked.status, locked.access, locked.reason, locked.license?.lid], ['read_only', 'read_only', 'clock', 'lic-clock']);
  // Часы починили (chrony): эпизод кончился сам, ничего из него не осталось
  const fixed = s.check(T0 + 3 * DAY_MS + 2 * H, 74 * H);
  assert.deepEqual([fixed.jump, fixed.locked, fixed.behind, fixed.behindForMs, ev(fixed).access], ['none', false, null, 0, 'valid']);
});

test('часы держат в одной точке позади, без перезапуска: длительность эпизода — по монотонному времени процесса', () => {
  const s = server(T0);
  const held = T0 - YEAR;
  let last: ClockResult | null = null;
  for (let h = 1; h <= 50; h++) {
    last = s.check(held, h * H);
    assert.equal(last.now, T0, `час ${h}: время лицензии стоит`);
    assert.equal(last.behindForMs, (h - 1) * H, `час ${h}`);
  }
  assert.equal(last!.locked, true);
});

test('несколько процессов: монотонное время каждого не складывается с чужим', () => {
  const s = server(T0);
  const held = T0 - YEAR;
  for (let m = 1; m <= 121; m++) s.check(held, m * MIN, { proc: m % 2 === 0 ? 'app' : 'worker' });
  // Эпизод начался на 1-й минуте; два процесса по очереди раз в минуту — 120 минут, а не 240
  assert.equal(s.row.behind!.forMs, 120 * MIN);
});

test('часы спешили на 15 мин / 5 ч / 47 ч, затем NTP: блокировки нет, время стоит на величину ошибки, потом снова по часам', () => {
  for (const ahead of [15 * MIN, 5 * H, 47 * H]) {
    for (const restarts of [false, true]) {
      const s = server(T0);
      // Час со спешащими часами, пересчёт раз в минуту
      for (let m = 1; m <= 60; m++) s.check(T0 + m * MIN + ahead, m * MIN, { restart: restarts && m % 7 === 0 });
      const peak = s.row.lastSeenAt!;
      assert.equal(peak, T0 + H + ahead);
      // NTP: верные часы, пересчёт раз в 10 минут, с перезапусками каждые полчаса или без; 10 суток
      for (let m = 70; m <= 70 + 10 * 24 * 60; m += 10) {
        const c = s.check(T0 + m * MIN, m * MIN, { restart: restarts && m % 30 === 0 });
        assert.equal(c.locked, false, `ahead=${ahead} restarts=${restarts} m=${m}`);
        assert.equal(c.now, Math.max(peak, T0 + m * MIN), `ahead=${ahead} m=${m}`);
      }
      assert.equal(s.row.behind, null);
    }
  }
});

test('круг 3: часы спешили на 60 ч / 100 ч / 30 суток не меньше 4 ч, 8–20 перезапусков в эпизоде — блокировка снимается сама, когда часы догнали', () => {
  for (const ahead of [60 * H, 100 * H, 30 * DAY_MS]) {
    for (const every of [6, 4, 2]) {
      const s = server(T0);
      // 4 ч спешащих часов, пересчёт воркера раз в час: шаги по 48 ч, затем по часам
      for (let h = 1; h <= 4; h++) s.check(T0 + h * H + ahead, h * H);
      const peak = s.row.lastSeenAt!;
      // NTP: верные часы, пересчёт раз в час, перезапуск стека каждые `every` часов; пока часы не догнали — и 10 суток после
      const until = Math.ceil((peak - T0) / H) + 10 * 24;
      let lockedAfterCatchUp = false;
      let lockedBeforeLimit = false;
      for (let h = 5; h <= until; h++) {
        const clock = T0 + h * H;
        const c = s.check(clock, h * H, { restart: h % every === 0 });
        if (c.locked && clock >= peak - CLOCK_BACKWARD_TOLERANCE_MS) lockedAfterCatchUp = true;
        if (c.locked && clock - (T0 + 5 * H) <= CLOCK_BEHIND_LOCK_MS) lockedBeforeLimit = true;
      }
      assert.equal(lockedAfterCatchUp, false, `ahead=${ahead / H} ч, перезапуск раз в ${every} ч`);
      assert.equal(lockedBeforeLimit, false, `перезапуски не приближают блокировку: ahead=${ahead / H} ч`);
      assert.equal(s.row.behind, null);
    }
  }
});

test('круг 3: часы позади на 1 ч, воркер 20 минут перезапускается каждые 30 с (и каждые 5 с), затем 10 суток верных часов — без read_only', () => {
  for (const stepSec of [30, 5]) {
    const s = server(T0);
    for (let sec = stepSec; sec <= 20 * 60; sec += stepSec) {
      // Каждый старт — пересчёт без опоры; часы позади на час и идут верно
      const c = s.check(T0 - H + sec * 1000, 2_000, { restart: true, proc: 'worker' });
      assert.equal(c.locked, false);
    }
    // Длительность эпизода — ровно прошедшее по часам: шагов за перезапуск нет
    assert.equal(s.row.behind!.forMs, 20 * MIN - stepSec * 1000);
    for (let h = 1; h <= 240; h++) assert.equal(s.check(T0 + H + h * H, h * H).locked, false, `час ${h}`);
    assert.equal(s.row.behind, null);
  }
});

test('шаг за старт не копится: 500 перезапусков подряд при часах позади — эпизод не длиннее прошедшего по часам', () => {
  const s = server(T0);
  for (let k = 1; k <= 500; k++) s.check(T0 - 2 * H + k * 1000, 1_000, { restart: true });
  assert.equal(s.row.behind!.forMs, 499 * 1000);
  assert.equal(s.row.lastSeenAt, T0);
  // Часы вернули — эпизода нет, время лицензии по часам
  const c = s.check(T0 + MIN, 2_000, { restart: true });
  assert.deepEqual([c.behind, c.now, c.lastSeenAt], [null, T0 + MIN, T0 + MIN]);
});

test('дрейф до 10 минут назад: время ждёт часы, тревоги и эпизода нет', () => {
  const s = server(T0);
  const c = s.check(T0 - 9 * MIN, MIN);
  assert.deepEqual([c.now, c.lastSeenAt, c.jump, c.alert, c.behind], [T0, T0, 'none', false, null]);
  const d = s.check(T0 + MIN, 11 * MIN);
  assert.deepEqual([d.now, d.lastSeenAt], [T0 + MIN, T0 + MIN]);
});

test('без lastSeenAt (первая проверка) — по часам', () => {
  const r = advanceClock({ clock: T0, lastSeenAt: null, lastStepAt: null, behind: null, mono: 0, anchor: null });
  assert.deepEqual([r.now, r.lastSeenAt, r.lastStepAt, r.behind, r.locked], [T0, T0, T0, null, false]);
});

test('законные перезапуски при верных часах: ни тревоги, ни эпизода; гонка процессов на старте — тоже', () => {
  const s = server(T0);
  for (let k = 1; k <= 100; k++) {
    const c = s.check(T0 + k * MIN, 1_000, { restart: true, proc: k % 2 ? 'app' : 'worker' });
    assert.deepEqual([c.jump, c.alert, c.behind, c.now], ['none', false, null, T0 + k * MIN]);
  }
  // Воркер записал чуть более позднее показание, приложение пересчитывает с часами на секунду раньше — дрейф
  const w = s.check(T0 + 101 * MIN, 2_000, { proc: 'worker' });
  const a = s.check(T0 + 101 * MIN - 1_000, 2_000, { proc: 'app' });
  assert.deepEqual([w.jump, a.jump, a.behind, a.now], ['none', 'none', null, T0 + 101 * MIN]);
});
