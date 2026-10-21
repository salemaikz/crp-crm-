// Правило часов лицензии: часы позади (D-212, D-306). Пока часы отстают от максимума виденного больше чем на
// 10 минут, время лицензии идёт по монотонному времени процесса и по ходу самих часов; часы позади дольше 48 ч
// подряд — «только чтение» с причиной clock. Состояние между проверками — как в license_state; «перезапуск» —
// опора процесса теряется. Ключи — одноразовые на прогон.
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

/** Сервер: строка license_state между проверками и опора процесса в памяти. */
function server(start: number) {
  let row: Pick<ClockInput, 'lastSeenAt' | 'lastStepAt' | 'realAt' | 'behind'> = { lastSeenAt: start, lastStepAt: start, realAt: null, behind: null };
  let anchor: ClockAnchor | null = { mono: 0, realAt: start };
  return {
    check(clock: number, mono: number, opts: { restart?: boolean } = {}): ClockResult {
      if (opts.restart) anchor = null;
      const r = advanceClock({ clock, mono, anchor, ...row });
      row = { lastSeenAt: r.lastSeenAt, lastStepAt: r.lastStepAt, realAt: r.realAt, behind: r.behind };
      anchor = r.anchor;
      return r;
    },
  };
}

test('часы на год назад за сутки до срока, без правки БД: 8 суток проверок раз в сутки с перезапусками — read_only', () => {
  const v = verdictFor({ expiresAt: T0 + DAY_MS, graceDays: 0 });
  const s = server(T0);
  const access: string[] = [];
  for (let k = 1; k <= 8; k++) {
    // Реальное время T0 + k сут; часы показывают на год меньше; процесс только что перезапущен
    const c = s.check(T0 + k * DAY_MS - YEAR, 5_000, { restart: true });
    access.push(evaluateLicense({ verdict: v, now: c.now, previous: null, invalidSince: null, anchor: null, builtAt: null, clockLocked: c.locked }).access);
  }
  assert.equal(access.at(-1), 'read_only', access.join(','));
  // Время лицензии шло по ходу часов: срок наступил на вторые сутки, а не через год
  assert.equal(access[1], 'read_only', access.join(','));
});

test('часы позади дольше 48 ч подряд: «только чтение» с причиной clock, даже при долгой лицензии; починили часы — снова по часам', () => {
  const v = verdictFor({ expiresAt: T0 + YEAR, graceDays: 30 });
  const s = server(T0);
  const ev = (c: ClockResult) => evaluateLicense({ verdict: v, now: c.now, previous: null, invalidSince: null, anchor: null, builtAt: null, clockLocked: c.locked });
  const seen: ClockResult[] = [];
  for (let k = 1; k <= 4; k++) seen.push(s.check(T0 + k * DAY_MS - 30 * DAY_MS, 1_000, { restart: true }));
  // 1-я проверка после перезапуска — интервала не видно, время идёт на шаг CLOCK_RESTART_STEP_MS; дальше — по ходу часов
  assert.deepEqual(seen.map((c) => c.now - T0), [MIN, DAY_MS + MIN, 2 * DAY_MS + MIN, 3 * DAY_MS + MIN]);
  assert.deepEqual(seen.map((c) => c.locked), [false, false, true, true]);
  assert.equal(seen[2]!.behindForMs, CLOCK_BEHIND_LOCK_MS + MIN, '48 ч и шаг перезапуска — уже блокировка');
  const locked = ev(seen[2]!);
  assert.deepEqual([locked.status, locked.access, locked.reason], ['read_only', 'read_only', 'clock']);
  assert.equal(locked.license?.lid, 'lic-clock');
  // Часы починили (chrony): эпизод кончился, блокировки нет
  const fixed = s.check(T0 + 4 * DAY_MS + H, 2_000);
  assert.deepEqual([fixed.jump, fixed.locked, fixed.behind, ev(fixed).access], ['none', false, null, 'valid']);
});

test('часы держат в одной точке (date -s перед каждой проверкой) без перезапуска: время идёт по монотонному времени', () => {
  const s = server(T0);
  const held = T0 - YEAR;
  const alerts: number[] = [];
  let last: ClockResult | null = null;
  for (let h = 1; h <= 72; h++) {
    last = s.check(held, h * H);
    assert.equal(last.now, T0 + h * H, `час ${h}`);
    assert.equal(last.jump, 'backward');
    if (last.alert) alerts.push(h);
    assert.equal(last.locked, h * H > CLOCK_BEHIND_LOCK_MS, `час ${h}`);
  }
  // Тревога — в начале эпизода и раз в сутки, пока он длится
  assert.deepEqual(alerts, [1, 24, 48, 72]);
  assert.equal(last!.lastSeenAt, T0 + 72 * H);
});

test('несколько процессов: монотонное время каждого не складывается с чужим', () => {
  let row: Pick<ClockInput, 'lastSeenAt' | 'lastStepAt' | 'realAt' | 'behind'> = { lastSeenAt: T0, lastStepAt: T0, realAt: null, behind: null };
  const anchors: (ClockAnchor | null)[] = [{ mono: 0, realAt: T0 }, { mono: 0, realAt: T0 }];
  const held = T0 - YEAR;
  for (let m = 1; m <= 120; m++) {
    // web и воркер по очереди, раз в минуту каждый
    const p = m % 2;
    const r = advanceClock({ clock: held, mono: m * MIN, anchor: anchors[p]!, ...row });
    row = { lastSeenAt: r.lastSeenAt, lastStepAt: r.lastStepAt, realAt: r.realAt, behind: r.behind };
    anchors[p] = r.anchor;
  }
  assert.equal(row.lastSeenAt, T0 + 120 * MIN);
});

test('часы ушли вперёд, их починили: время стоит, пока часы не догонят, блокировки нет — и с перезапусками', () => {
  for (const restart of [false, true]) {
    const s = server(T0);
    // Ошибка часов на год вперёд длится час: два шага по 48 ч
    s.check(T0 + YEAR, MIN, { restart });
    const s2 = s.check(T0 + YEAR + H, H + MIN, { restart });
    assert.equal(s2.lastSeenAt, T0 + 96 * H);
    let c: ClockResult | null = null;
    for (let h = 2; h <= 100; h++) {
      c = s.check(T0 + h * H, h * H, { restart });
      assert.equal(c.locked, false, `час ${h}`);
      assert.equal(c.now, Math.max(T0 + 96 * H, T0 + h * H), `час ${h}`);
    }
    assert.equal(c!.behind, null, 'часы догнали — эпизода нет');
  }
});

test('часы вперёд, потом назад: льготы по времени нет — сначала лицензия «постарела» на шаги, потом стоит столько же', () => {
  const s = server(T0);
  s.check(T0 + 10 * YEAR, MIN);
  s.check(T0 + 10 * YEAR + H, H + MIN);
  // Теперь на год назад; реальное время идёт, проверки раз в час без перезапуска
  let c: ClockResult | null = null;
  for (let h = 2; h <= 160; h++) {
    c = s.check(T0 - YEAR + h * H, h * H);
    // «Сейчас» лицензии не отстаёт от настоящего времени
    assert.ok(c.now >= T0 + h * H - 2 * H, `час ${h}: ${(c.now - T0) / H}`);
  }
  assert.equal(c!.locked, true);
});

test('дрейф до 10 минут назад — как раньше: время ждёт часы, тревоги и эпизода нет', () => {
  const s = server(T0);
  const c = s.check(T0 - 5 * MIN, 4 * MIN);
  assert.deepEqual([c.now, c.jump, c.behind, c.alert, c.locked], [T0, 'none', null, false, false]);
  // Часы догнали — дальше по ним
  assert.equal(s.check(T0 + MIN, 6 * MIN).now, T0 + MIN);
});

test('часы держат в пределах допуска (на 9 минут позади, без перезапуска): время идёт, отставание не больше допуска', () => {
  const s = server(T0);
  let c: ClockResult | null = null;
  for (let m = 1; m <= 180; m++) {
    c = s.check(T0 - 9 * MIN, m * MIN);
    assert.ok(c.now >= T0 + m * MIN - 10 * MIN, `минута ${m}: ${(c.now - T0) / MIN}`);
  }
  assert.equal(c!.now, T0 + 180 * MIN);
  assert.equal(c!.jump, 'backward', 'часы стоят — эпизод «часы позади»');
});

test('без lastSeenAt (первая проверка) — по часам', () => {
  const c = advanceClock({ clock: T0, lastSeenAt: null, lastStepAt: null, realAt: null, behind: null, mono: 0, anchor: null });
  assert.deepEqual([c.now, c.lastSeenAt, c.realAt, c.behind, c.anchor], [T0, T0, T0, null, { mono: 0, realAt: T0 }]);
});

// ── Перезапуск перед каждым пересчётом (круг 1 волны B, D-306): опоры процесса нет, ход часов нулевой ──────────

test('часы в одной точке и перезапуск перед каждым пересчётом: каждый пересчёт двигает время на шаг, 48 ч — read_only', () => {
  const v = verdictFor({ expiresAt: T0 + DAY_MS, graceDays: 0 });
  const s = server(T0);
  const held = T0 - YEAR;
  let c: ClockResult | null = null;
  let k = 0;
  while (k < 3_000) {
    k++;
    c = s.check(held, 5_000, { restart: true });
    assert.ok(c.now >= T0 + k * MIN, `пересчёт ${k}: ${(c.now - T0) / MIN} мин`);
    assert.equal(c.jump, 'backward');
    if (k === 24 * 60 + 1) {
      // Срок наступил: время лицензии не стоит
      const e = evaluateLicense({ verdict: v, now: c.now, previous: null, invalidSince: null, anchor: null, builtAt: null, clockLocked: c.locked });
      assert.equal(e.access, 'read_only', `пересчёт ${k}`);
    }
    if (c.locked) break;
  }
  assert.equal(c!.locked, true, `48 ч по времени лицензии — «только чтение», пересчётов ${k}`);
  assert.equal(k, 48 * 60 + 1);
});

test('часы в пределах допуска позади и перезапуск перед каждым пересчётом: время идёт, затем эпизод и read_only', () => {
  const s = server(T0);
  const held = T0 - 5 * MIN;
  let c: ClockResult | null = null;
  let prev = T0;
  let k = 0;
  while (k < 3_100) {
    k++;
    c = s.check(held, 5_000, { restart: true });
    assert.ok(c.now >= prev, `пересчёт ${k}: время назад`);
    prev = c.now;
    if (k > 30) assert.ok(c.now >= T0 + (k - 30) * MIN, `пересчёт ${k}: ${(c.now - T0) / MIN} мин`);
    if (c.locked) break;
  }
  assert.equal(c!.locked, true, `пересчётов ${k}`);
  assert.ok(k <= 48 * 60 + 30, `пересчётов ${k}`);
});

test('законные перезапуски при верных часах: ни тревоги, ни эпизода; гонка процессов на старте — тоже', () => {
  const s = server(T0);
  // Два процесса стартуют вместе: второй прочитал часы на 200 мс раньше, чем первый записал своё показание
  const a = s.check(T0 + 1_000, 5, { restart: true });
  const b = s.check(T0 + 800, 7, { restart: true });
  assert.deepEqual([a.jump, b.jump, b.now, b.alert, b.behind], ['none', 'none', T0 + 1_000, false, null]);
  // Дальше — перезапуск раз в минуту при идущих часах (падающий контейнер): время по часам, без тревог
  for (let m = 1; m <= 120; m++) {
    const c = s.check(T0 + 1_000 + m * MIN, 5, { restart: true });
    assert.deepEqual([c.now, c.jump, c.alert, c.locked], [T0 + 1_000 + m * MIN, 'none', false, false], `минута ${m}`);
  }
});

// ── Часы спешили, их починили (круг 1 раунда 4 волны B): ложной блокировки нет ────────────────────────────────

type Restarts = 'none' | 'boot' | 'each';

/** Часы спешат на ahead в течение часа (пересчёт раз в минуту), затем NTP; дальше 5 суток пересчётов с верными часами.
 *  boot — процесс стартовал уже со спешащими часами (первый пересчёт без опоры), each — перезапуск перед каждым. */
function aheadThenFixed(ahead: number, restarts: Restarts, downtime = 0) {
  const s = server(T0);
  let real = T0 + downtime;
  let mono = 0;
  let k = 0;
  const out: { real: number; c: ClockResult }[] = [];
  const step = (clock: number) => {
    k++;
    mono += MIN;
    const restart = restarts === 'each' || (restarts === 'boot' && k === 1);
    out.push({ real, c: s.check(clock, mono, { restart }) });
    real += MIN;
  };
  for (let m = 0; m < 60; m++) step(real + ahead);
  const fixedAt = out.length;
  for (let m = 0; m < 5 * 24 * 60; m++) step(real);
  return { out, fixedAt };
}

test('часы спешили на 15 мин / 5 ч / 47 ч, затем NTP: блокировки нет, время стоит на величину ошибки, потом снова по часам', () => {
  for (const ahead of [15 * MIN, 5 * H, 47 * H]) {
    for (const restarts of ['none', 'boot', 'each'] as const) {
      const tag = `${ahead / MIN} мин, перезапуски: ${restarts}`;
      const { out, fixedAt } = aheadThenFixed(ahead, restarts);
      let prev = 0;
      for (const [i, { real, c }] of out.entries()) {
        assert.equal(c.locked, false, `${tag}, пересчёт ${i}`);
        assert.ok(c.now >= prev, `${tag}, пересчёт ${i}: время назад`);
        // Время лицензии не убегает дальше ошибки часов и после починки стоит, а не идёт от ложной точки
        assert.ok(c.now <= real + ahead + MIN, `${tag}, пересчёт ${i}: +${(c.now - real) / MIN} мин`);
        prev = c.now;
      }
      const last = out.at(-1)!;
      assert.deepEqual([last.c.now, last.c.jump, last.c.behind, last.c.locked], [last.real, 'none', null, false], tag);
      // Часы догнали время лицензии примерно через величину ошибки
      const caught = out.findIndex((o, i) => i >= fixedAt && o.c.now === o.real);
      assert.ok(caught - fixedAt <= ahead / MIN + 2, `${tag}: догнали через ${caught - fixedAt} мин`);
    }
  }
});

test('часы спешили на 100 ч час (скачок больше 48 ч), затем NTP: блокировки нет и с перезапусками, потом снова по часам', () => {
  for (const restarts of ['none', 'boot', 'each'] as const) {
    const { out } = aheadThenFixed(100 * H, restarts);
    assert.ok(out.every((o) => !o.c.locked), restarts);
    const last = out.at(-1)!;
    assert.deepEqual([last.c.now, last.c.jump, last.c.behind], [last.real, 'none', null], restarts);
  }
});

test('RTC в местном времени: после простоя контейнеры стартовали до chrony (+5 ч), затем NTP — блокировки нет', () => {
  for (const downtime of [0, 10 * H, 47 * H]) {
    const { out } = aheadThenFixed(5 * H, 'boot', downtime);
    assert.ok(out.every((o) => !o.c.locked), `простой ${downtime / H} ч`);
    const last = out.at(-1)!;
    assert.deepEqual([last.c.now, last.c.behind], [last.real, null], `простой ${downtime / H} ч`);
  }
});

// ── Часы спешили больше чем на 48 ч и был перезапуск (круг 2 раунда 4 волны B): ложной блокировки нет ────────

/** Часы спешат на ahead fastHours часов (пересчёт раз в минуту), перезапуски — на минутах restartAt; затем NTP и
 *  10 суток пересчётов с верными часами. Проверяет и инвариант: realAt не впереди настоящего времени больше чем на
 *  шаги перезапусков (по минуте на старт). */
function aheadLongThenFixed(ahead: number, fastHours: number, restartAt: readonly number[]) {
  const s = server(T0);
  let real = T0;
  let mono: number;
  let starts = 0;
  const out: { real: number; c: ClockResult }[] = [];
  const step = (clock: number, restart: boolean) => {
    mono = real - T0;
    if (restart) starts++;
    const c = s.check(clock, mono, { restart });
    assert.ok(c.realAt <= real + starts * MIN, `realAt впереди настоящего времени на ${((c.realAt - real) / H).toFixed(2)} ч`);
    out.push({ real, c });
    real += MIN;
  };
  for (let m = 0; m < fastHours * 60; m++) step(real + ahead, restartAt.includes(m));
  // После починки — пока часы не догонят время лицензии (не меньше 10 суток)
  const after = Math.max(10 * DAY_MS, ahead + 2 * DAY_MS);
  for (let m = 0; m < after / MIN; m++) step(real, false);
  return out;
}

test('часы спешили на 60 ч / 100 ч / 30 суток не меньше 4 ч, перезапуск после догона, затем NTP: без read_only, пока часы не догонят', () => {
  const cases: [number, number, number[]][] = [
    [60 * H, 4, [180]],
    [60 * H, 4, [0, 120, 239]],
    [100 * H, 6, [300]],
    [30 * DAY_MS, 24 * 16, [24 * 16 * 60 - 10]],
  ];
  for (const [ahead, fastHours, restartAt] of cases) {
    const tag = `+${ahead / H} ч, перезапуски ${restartAt.join(',')}`;
    const out = aheadLongThenFixed(ahead, fastHours, restartAt);
    for (const [i, { c }] of out.entries()) assert.equal(c.locked, false, `${tag}, пересчёт ${i}`);
    const last = out.at(-1)!;
    // Часы догнали время лицензии: снова по часам, эпизода нет
    assert.deepEqual([last.c.now, last.c.jump, last.c.behind], [last.real, 'none', null], tag);
  }
});

test('простой копится запасом не больше самого простоя: часы на год назад — read_only не позже простоя + 48 ч', () => {
  const s = server(T0);
  let real = T0;
  let mono = 0;
  // Простой — время, которое не видно монотонному времени процессов: между пересчётами до и после старта
  let unseen = 0;
  let prev = { real: T0, mono: 0 };
  const check = (clock: number, restart: boolean) => {
    unseen += real - prev.real - (restart ? 0 : mono - prev.mono);
    prev = { real, mono };
    const c = s.check(clock, mono, { restart });
    assert.ok(c.realAt <= real, 'realAt не впереди настоящего времени');
    return c;
  };
  // 30 суток: 10 ч работы (пересчёт раз в час), 14 ч простоя, старт без опоры, часы верные
  for (let d = 0; d < 30; d++) {
    for (let h = 0; h < 10; h++) {
      mono += H;
      check(real, h === 0);
      real += H;
    }
    real += 14 * H;
  }
  // Часы на год назад без правки БД, пересчёт раз в минуту без перезапуска
  let c: ClockResult | null = null;
  let m = 0;
  while (m < 600 * 60) {
    m++;
    mono += MIN;
    c = check(real - YEAR, false);
    real += MIN;
    if (c.locked) break;
  }
  assert.equal(c!.locked, true);
  // Запас — не больше простоя: столько же даёт перевод часов назад перед каждым стартом (D-312)
  assert.ok(unseen > 400 * H, `простой ${unseen / H} ч`);
  assert.ok(m * MIN <= unseen + CLOCK_BEHIND_LOCK_MS + MIN, `блокировка через ${(m / 60).toFixed(1)} ч, простой ${unseen / H} ч`);
  // Время лицензии к блокировке отстаёт от настоящего не больше чем на простой
  assert.ok(c!.now >= real - MIN - unseen, `отставание ${((real - c!.now - unseen) / H).toFixed(2)} ч сверх простоя`);
});
