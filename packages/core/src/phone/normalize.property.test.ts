// Свойство: нормализация номеров идемпотентна — normalize(normalize(x)) = normalize(x).
// Детерминированный генератор с seed, без новых зависимостей.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PHONE_RULES, normalizePhone, parsePhone, splitPhones } from './index.js';

const CASES = 5000;

/** mulberry32: маленький детерминированный генератор. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(xs: readonly T[]): T => xs[int(0, xs.length - 1)]!;
  return { next, int, pick, chance: (p: number) => next() < p };
}
type Rng = ReturnType<typeof rng>;

const digits = (r: Rng, n: number) => Array.from({ length: n }, () => r.int(0, 9)).join('');

/** Строка похожа на то, что пишут в ячейке: код страны, разделители, добавочный, мусор. */
function genPhone(r: Rng): string {
  const len = r.pick([0, 3, 7, 9, 10, 10, 10, 11, 11, 11, 12, 13]);
  const prefix = r.pick(['', '', '+7', '8', '7', '+7 ', '8-', '+8', '(7)']);
  const body = r.chance(0.2) ? r.pick(['700', '701', '747', '771', '777', '7172', '727', '705']) + digits(r, Math.max(0, len - 3)) : digits(r, len);
  let s = prefix + body;
  if (r.chance(0.5)) {
    // Разделители в случайных местах.
    s = [...s].map((c) => (r.chance(0.2) ? c + r.pick([' ', '-', '(', ')', '.', ' ']) : c)).join('');
  }
  if (r.chance(0.15)) s += r.pick([' доб. 123', ' доб 45', ' ext. 7', ' вн. 99', '#12']);
  if (r.chance(0.05)) s = r.pick(['нет', '-', 'N/A', '   ', 'тел']) + (r.chance(0.5) ? s : '');
  return s;
}

const RULES = [
  DEFAULT_PHONE_RULES,
  { ...DEFAULT_PHONE_RULES, stubs: ['77090001234', '7709xxx0000'] },
  { ...DEFAULT_PHONE_RULES, stubs: [] },
];

test(`свойство: normalizePhone идемпотентен (${CASES} случаев)`, () => {
  const r = rng(401);
  for (let i = 0; i < CASES; i++) {
    const rules = r.pick(RULES);
    const x = genPhone(r);
    const once = normalizePhone(x, rules);
    const twice = normalizePhone(once, rules);
    assert.equal(twice, once, `случай ${i}: вход ${JSON.stringify(x)} → ${JSON.stringify(once)} → ${JSON.stringify(twice)}`);
    if (once !== null) {
      assert.match(once, /^7\d{10}$/, `случай ${i}: ${JSON.stringify(x)} → ${once}: не канон`);
      // Канон не теряет вид и тип номера.
      assert.equal(parsePhone(once, rules)?.kind, parsePhone(x, rules)?.kind, `случай ${i}: вид номера изменился для ${JSON.stringify(x)}`);
    }
  }
});

test(`свойство: канон из splitPhones при повторной нормализации не меняется (${CASES} случаев)`, () => {
  const r = rng(402);
  for (let i = 0; i < CASES; i++) {
    const rules = r.pick(RULES);
    const cell = Array.from({ length: r.int(1, 4) }, () => genPhone(r)).join(r.pick([';', ',', '\n', ' / ']));
    const once = splitPhones(cell, rules);
    const again = splitPhones(once.map((p) => p.digits ?? p.raw).join('; '), rules);
    const pick = (ps: typeof once) => ps.filter((p) => p.digits !== null).map((p) => [p.digits, p.working, p.kind, p.needsReview]);
    assert.deepEqual(pick(again), pick(once), `случай ${i}: ячейка ${JSON.stringify(cell)}`);
  }
});
