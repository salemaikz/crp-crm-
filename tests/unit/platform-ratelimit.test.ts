import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RATE_LIMIT_MAX_KEYS, evictRateLimitKeys, rateLimit, rateLimitSize, resetRateLimit } from '../../src/server/platform/ratelimit';

test('лимит исчерпан — отказ с retryAfterMs, окно скользит', () => {
  const k = 'rl:a';
  assert.equal(rateLimit(k, 2, 1000, 0).ok, true);
  assert.equal(rateLimit(k, 2, 1000, 100).ok, true);
  const r = rateLimit(k, 2, 1000, 200);
  assert.deepEqual(r, { ok: false, retryAfterMs: 800 });
  assert.equal(rateLimit(k, 2, 1000, 1001).ok, true); // первая попытка вышла из окна
});

test('resetRateLimit сбрасывает счётчик', () => {
  const k = 'rl:b';
  rateLimit(k, 1, 1000, 0);
  assert.equal(rateLimit(k, 1, 1000, 1).ok, false);
  resetRateLimit(k);
  assert.equal(rateLimit(k, 1, 1000, 2).ok, true);
});

test('вытеснение: перебираемый ключ переживает одиночные', () => {
  evictRateLimitKeys(0, Number.MAX_SAFE_INTEGER); // очистить
  const t = 1_000_000;
  for (let i = 0; i < 5; i++) rateLimit('hot', 100, 60_000, t);
  for (let i = 0; i < 10; i++) rateLimit(`cold:${i}`, 100, 60_000, t);
  assert.equal(rateLimitSize(), 11);
  evictRateLimitKeys(1, t + 1);
  assert.equal(rateLimitSize(), 1);
  assert.equal(rateLimit('hot', 5, 60_000, t + 2).ok, false); // счётчик hot сохранён
  assert.ok(RATE_LIMIT_MAX_KEYS >= 1000);
});
