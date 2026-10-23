// Горячесть и порядок очереди (pipeline-v2 §6). Веса — синтетические, как в разделе 6.5 проекта.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAT_MAX, compareForQueue, heatOf } from './heat.js';
import type { HeatCard, HeatWeights, QueueKey } from './heat.js';
import { dueBounds } from './due.js';
import { TEST_CALENDAR, at } from './spec/vectors.js';

const W: HeatWeights = {
  states: { callback: 100, retry: 0, new: 20 },
  reasons: { think: 200, no_time: 150, no_show_br: 400, attended_no_buy: 500 },
  flags: { attendedGroup: 200, attendedIndividual: 300, noShow: 100, purchased: 250, lprYes: 50 },
};

const base: HeatCard = {
  state: 'callback',
  callbackReason: '',
  lpr: '',
  attendedGroupAt: null,
  attendedIndividualAt: null,
  lastNoShowAt: null,
  purchasesTotal: 0,
  nextCallAt: null,
  nextCallPrecision: 'time',
};

const NOW = at('2026-10-28 12:00');
const B = dueBounds(NOW, 5, TEST_CALENDAR);

const key = (id: string, c: Partial<HeatCard>, nextCallAt: number | null): QueueKey & { card: HeatCard } => {
  const card = { ...base, ...c, nextCallAt };
  return { id, heat: heatOf(card, W), nextCallAt, nextCallPrecision: card.nextCallPrecision, card };
};

test('heatOf: сумма весов состояния, причины и признаков', () => {
  assert.equal(heatOf({ ...base, callbackReason: 'think' }, W), 300);
  assert.equal(heatOf({ ...base, state: 'retry' }, W), 0);
  assert.equal(heatOf({ ...base, state: 'new' }, W), 20);
  const noShow = { ...base, callbackReason: 'no_show_br', lastNoShowAt: at('2026-10-27 10:00') };
  assert.equal(heatOf(noShow, W), 600);
  const full = { ...base, callbackReason: 'attended_no_buy', lpr: 'yes' as const, purchasesTotal: 1, attendedGroupAt: 1 };
  assert.equal(heatOf(full, W), 100 + 500 + 250 + 200 + 50);
});

test('heatOf: неявка не греет, если после неё была явка', () => {
  const c = { ...base, lastNoShowAt: 1000, attendedIndividualAt: 2000 };
  assert.equal(heatOf(c, W), 100 + 300);
  assert.equal(heatOf({ ...c, lastNoShowAt: 3000 }, W), 100 + 300 + 100);
});

test('heatOf: закрытые, agreed и client — 0', () => {
  for (const state of ['agreed', 'client', 'not_interested', 'not_target', 'do_not_call', 'written_off'] as const) {
    assert.equal(heatOf({ ...base, state, callbackReason: 'think', purchasesTotal: 3, lpr: 'yes' }, W), 0, state);
  }
});

test('heatOf: сумма зажимается в 0..HEAT_MAX, мусорные веса дают 0', () => {
  const big: HeatWeights = {
    states: { callback: 10000 },
    reasons: { r: 10000 },
    flags: { attendedGroup: 10000, attendedIndividual: 10000, noShow: 10000, purchased: 10000, lprYes: 10000 },
  };
  // Максимум по схеме 10000 × 7 слагаемых даёт 70000: зажим — страховка на случай расширения схемы.
  const all = { ...base, callbackReason: 'r', lpr: 'yes' as const, purchasesTotal: 1, attendedGroupAt: 1, attendedIndividualAt: 1, lastNoShowAt: 5 };
  assert.equal(heatOf(all, big), 70_000);
  const huge: HeatWeights = { ...big, states: { callback: 90_000 } };
  assert.equal(heatOf(all, huge), HEAT_MAX);
  const junk: HeatWeights = { states: { callback: -5 }, reasons: { r: Number.NaN }, flags: { ...big.flags, attendedGroup: -1 } };
  assert.equal(heatOf({ ...base, callbackReason: 'r', attendedGroupAt: 1 }, junk), 0);
});

test('вектор порядка: не пришёл на встречу сегодня > подумаю сегодня > недозвон сегодня > не пришёл завтра', () => {
  const todayAt = at('2026-10-28 15:00');
  const noShowToday = key('a', { callbackReason: 'no_show_br', lastNoShowAt: 1 }, todayAt);
  const thinkToday = key('b', { callbackReason: 'think' }, todayAt);
  const retryToday = key('c', { state: 'retry' }, todayAt);
  const noShowTomorrow = key('d', { callbackReason: 'no_show_br', lastNoShowAt: 1 }, at('2026-10-29 10:00'));
  assert.deepEqual([noShowToday.heat, thinkToday.heat, retryToday.heat], [600, 300, 0]);
  const sorted = [noShowTomorrow, retryToday, thinkToday, noShowToday].sort((x, y) => compareForQueue(x, y, B));
  assert.deepEqual(sorted.map((x) => x.id), ['a', 'b', 'c', 'd']);
});

test('просрочка — тоже огонёк; при равной горячести раньше тот, чей срок раньше, затем id', () => {
  const overdue = key('z', { state: 'retry' }, at('2026-10-27 10:00'));
  const today = key('y', { state: 'retry' }, at('2026-10-28 16:00'));
  const sameA = key('a', { state: 'retry' }, at('2026-10-28 16:00'));
  assert.deepEqual([today, overdue, sameA].sort((x, y) => compareForQueue(x, y, B)).map((x) => x.id), ['z', 'a', 'y']);
});

test('без срока — после тех, у кого срок есть, при равной горячести', () => {
  const dated = key('b', { state: 'new' }, at('2026-10-30 10:00'));
  const open = key('a', { state: 'new' }, null);
  assert.ok(compareForQueue(dated, open, B) < 0);
});

test('срок «день» сегодня не просрочен, вчерашний — просрочен', () => {
  const dayToday = { ...key('a', { nextCallPrecision: 'day', state: 'retry' }, at('2026-10-28 00:00')) };
  const dayYesterday = { ...key('b', { nextCallPrecision: 'day', state: 'retry' }, at('2026-10-27 00:00')) };
  const later = key('c', { state: 'retry' }, at('2026-10-29 09:00'));
  // оба «огонька» идут раньше будущего срока
  assert.deepEqual([later, dayToday, dayYesterday].sort((x, y) => compareForQueue(x, y, B)).map((x) => x.id), ['b', 'a', 'c']);
});

// ---------- Свойство: полный порядок ----------

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x1_0000_0000;
  };
}

test('свойство: compareForQueue — полный порядок (антисимметрия, транзитивность, равенство только у одного id)', () => {
  const r = rng(32);
  const items: QueueKey[] = [];
  const reasons = ['', 'think', 'no_time', 'no_show_br', 'attended_no_buy'];
  for (let i = 0; i < 60; i += 1) {
    const hasDate = r() > 0.15;
    const nextCallAt = hasDate ? NOW + Math.floor((r() - 0.5) * 6 * 86_400_000) : null;
    const card: HeatCard = {
      ...base,
      state: r() > 0.5 ? 'callback' : r() > 0.5 ? 'retry' : 'new',
      callbackReason: reasons[Math.floor(r() * reasons.length)] as string,
      lpr: r() > 0.5 ? 'yes' : '',
      purchasesTotal: r() > 0.7 ? 1 : 0,
      nextCallAt,
      nextCallPrecision: r() > 0.7 ? 'day' : 'time',
    };
    items.push({ id: `id-${String(i % 40).padStart(2, '0')}-${i}`, heat: heatOf(card, W), nextCallAt, nextCallPrecision: card.nextCallPrecision });
  }
  for (const a of items) {
    assert.equal(compareForQueue(a, a, B), 0);
    for (const b of items) {
      const ab = compareForQueue(a, b, B);
      const ba = compareForQueue(b, a, B);
      assert.equal(Math.sign(ab) + Math.sign(ba), 0, `${a.id} ${b.id}`);
      if (a !== b) assert.notEqual(ab, 0);
      for (const c of items) {
        if (ab <= 0 && compareForQueue(b, c, B) <= 0) assert.ok(compareForQueue(a, c, B) <= 0, `${a.id} ${b.id} ${c.id}`);
      }
    }
  }
  // Сортировка не зависит от начального порядка.
  const s1 = [...items].sort((x, y) => compareForQueue(x, y, B)).map((x) => x.id);
  const s2 = [...items].reverse().sort((x, y) => compareForQueue(x, y, B)).map((x) => x.id);
  assert.deepEqual(s1, s2);
});
