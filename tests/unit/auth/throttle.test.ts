import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUSY_RETRY_MS,
  checkLogin as reserve,
  inflightSizes,
  phoneDelayMs,
  recordLoginFailure,
  recordLoginSuccess,
  resetLoginThrottle,
  throttleSizes,
  THROTTLE_MAX_KEYS,
} from '../../../src/server/platform/auth/throttle';
import { DEFAULT_SECURITY_POLICY } from '../../../src/server/platform/auth/types';

const P = DEFAULT_SECURITY_POLICY.loginAttempts; // 5 / 20 / 15 мин
const WIN = P.windowMin * 60_000;
const T0 = 1_760_000_000_000;
const who = (phone = '77095550123', ip = '203.0.113.1') => ({ phoneDigits: phone, ip });

/** Проверка без удержания слота: как последовательные запросы, каждый из которых завершился. */
function checkLogin(...a: Parameters<typeof reserve>): ReturnType<typeof reserve> {
  const v = reserve(...a);
  if (v.ok) v.release();
  return v;
}

beforeEach(() => resetLoginThrottle());

test('последовательность задержек: 0×4, 1, 2, 4, 8, 16, 30, 30 с', () => {
  const got: number[] = [];
  let now = T0;
  for (let i = 0; i < 10; i++) {
    const d = recordLoginFailure(who(), P, now);
    got.push(d / 1000);
    now += d + 1; // ждём, пока задержка пройдёт
  }
  assert.deepEqual(got, [0, 0, 0, 0, 1, 2, 4, 8, 16, 30]);
  assert.equal(phoneDelayMs(50, 5), 30_000);
  assert.equal(phoneDelayMs(4, 5), 0);
});

test('до nextAt вход отклонён и неудача не засчитывается', () => {
  for (let i = 0; i < 5; i++) recordLoginFailure(who(), P, T0);
  const v = checkLogin(who(), P, T0 + 400);
  assert.deepEqual(v, { ok: false, reason: 'phone_delay', retryAfterMs: 600 });
  // отказ ничего не менял: после ожидания следующая неудача — шестая, а не седьмая
  assert.equal(checkLogin(who(), P, T0 + 1000).ok, true);
  assert.equal(recordLoginFailure(who(), P, T0 + 1000), 2000);
});

test('неудачи выходят из окна — счёт начинается заново', () => {
  for (let i = 0; i < 6; i++) recordLoginFailure(who('77095550123', 'a'), P, T0 + i);
  assert.equal(checkLogin(who('77095550123', 'a'), P, T0 + WIN + 60_000).ok, true);
  assert.equal(recordLoginFailure(who('77095550123', 'a'), P, T0 + WIN + 60_000), 0);
});

test('успех сбрасывает номер, но не IP', () => {
  const ip = '198.51.100.7';
  for (let i = 0; i < 5; i++) recordLoginFailure(who('77095550123', ip), P, T0);
  recordLoginSuccess('77095550123');
  assert.equal(checkLogin(who('77095550123', ip), P, T0 + 1).ok, true);
  // 15 неудач с этого IP по другим номерам: к 20 доходит только с учётом прежних пяти
  for (let i = 0; i < 15; i++) recordLoginFailure(who(`7709555${1000 + i}`, ip), P, T0 + 2);
  const v = checkLogin(who('77099999999', ip), P, T0 + 3);
  assert.equal(v.ok, false);
  assert.equal(!v.ok && v.reason, 'ip_blocked');
});

test('30 успешных входов с одного IP не блокируют его (считаются только неудачи)', () => {
  for (let i = 0; i < 30; i++) {
    assert.equal(checkLogin(who(`7709555${2000 + i}`, 'office'), P, T0 + i).ok, true);
    recordLoginSuccess(`7709555${2000 + i}`);
  }
  assert.equal(checkLogin(who('77095552999', 'office'), P, T0 + 40).ok, true);
});

test('блок IP после perIp неудач снимается, когда старейшая выходит из окна', () => {
  for (let i = 0; i < 20; i++) recordLoginFailure(who(`7709555${3000 + i}`, 'x'), P, T0 + i * 1000);
  const v = checkLogin(who('77095553999', 'x'), P, T0 + 30_000);
  assert.deepEqual(v, { ok: false, reason: 'ip_blocked', retryAfterMs: T0 + WIN - (T0 + 30_000) });
  assert.equal(checkLogin(who('77095553999', 'x'), P, T0 + WIN + 1).ok, true);
});

test('неизвестный IP — общее ведро с пределом ×5', () => {
  for (let i = 0; i < 99; i++) recordLoginFailure(who(`7709${String(4000000 + i)}`, 'unknown'), P, T0);
  assert.equal(checkLogin(who('77099990000', 'unknown'), P, T0).ok, true);
  recordLoginFailure(who('77098880000', 'unknown'), P, T0);
  assert.equal(checkLogin(who('77099990000', 'unknown'), P, T0).ok, false);
});

test('вытеснение ключей не трогает номер под перебором', () => {
  for (let i = 0; i < 8; i++) recordLoginFailure(who('77090000001', 'brute'), P, T0);
  for (let i = 0; i <= THROTTLE_MAX_KEYS; i++) recordLoginFailure({ phoneDigits: `9${i}`, ip: `ip${i}` }, P, T0 + 1);
  assert.ok(throttleSizes().phones <= THROTTLE_MAX_KEYS);
  assert.equal(checkLogin(who('77090000001', 'fresh'), P, T0 + 2).ok, false); // задержка по номеру жива
});

test('идущие попытки по номеру: не больше perPhone − неудачи одновременно, после perPhone — одна', () => {
  const held = [];
  for (let i = 0; i < 60; i++) held.push(reserve(who('77095557777', `198.51.100.${i}`), P, T0));
  const ok = held.filter((v) => v.ok);
  assert.equal(ok.length, P.perPhone);
  const denied = held.find((v) => !v.ok);
  assert.deepEqual(denied, { ok: false, reason: 'phone_delay', retryAfterMs: BUSY_RETRY_MS });
  // все разрешённые завершились неудачей → задержка, новая попытка отклонена
  for (const [i, v] of held.entries()) {
    if (!v.ok) continue;
    recordLoginFailure(who('77095557777', `198.51.100.${i}`), P, T0);
    v.release();
  }
  assert.deepEqual(inflightSizes(), { phones: 0, ips: 0 });
  assert.equal(reserve(who('77095557777', '198.51.100.200'), P, T0 + 10).ok, false);
  // после задержки — ровно одна попытка за раз
  const a = reserve(who('77095557777', '198.51.100.201'), P, T0 + 1000);
  const b = reserve(who('77095557777', '198.51.100.202'), P, T0 + 1000);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  if (a.ok) a.release();
});

test('идущие попытки по IP считаются вместе с неудачами; release повторно ничего не ломает', () => {
  const held = [];
  for (let i = 0; i < 25; i++) held.push(reserve(who(`7709666${1000 + i}`, 'busy-ip'), P, T0));
  assert.equal(held.filter((v) => v.ok).length, P.perIp);
  const denied = held.find((v) => !v.ok);
  assert.equal(denied && !denied.ok && denied.reason, 'ip_blocked');
  for (const v of held) if (v.ok) {
    v.release();
    v.release();
  }
  assert.deepEqual(inflightSizes(), { phones: 0, ips: 0 });
  assert.equal(reserve(who('77096669999', 'busy-ip'), P, T0).ok, true);
});
