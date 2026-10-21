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
  // 1-я проверка после перезапуска — время стоит (интервала не видно), дальше идёт по ходу часов
  assert.deepEqual(seen.map((c) => c.now - T0), [0, DAY_MS, 2 * DAY_MS, 3 * DAY_MS]);
  assert.deepEqual(seen.map((c) => c.locked), [false, false, false, true]);
  assert.equal(seen[2]!.behindForMs, CLOCK_BEHIND_LOCK_MS, 'ровно 48 ч — ещё не блокировка');
  const locked = ev(seen[3]!);
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
