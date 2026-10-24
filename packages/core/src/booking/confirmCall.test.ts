import { test } from 'node:test';
import assert from 'node:assert/strict';

import { compareConfirm, confirmMark, confirmWindow } from './confirmCall';

const cfg = (weekdays: number[]) => ({ eventTypes: ['br'], weekdays });

test('вне дней обзвона окно неактивно', () => {
  // 2026-10-23 — пятница (5)
  assert.deepEqual(confirmWindow(cfg([4]), '2026-10-23', 5), { active: false, horizonEndDay: null });
});

test('[4] в четверг: горизонт до среды следующей недели (не включая четверг)', () => {
  // 2026-10-22 — четверг
  assert.deepEqual(confirmWindow(cfg([4]), '2026-10-22', 4), { active: true, horizonEndDay: '2026-10-29' });
});

test('[1,4] в понедельник: до среды; в четверг: до воскресенья включая понедельник', () => {
  assert.deepEqual(confirmWindow(cfg([1, 4]), '2026-10-19', 1), { active: true, horizonEndDay: '2026-10-22' });
  assert.deepEqual(confirmWindow(cfg([1, 4]), '2026-10-22', 4), { active: true, horizonEndDay: '2026-10-26' });
});

test('все дни недели: горизонт — завтра (только сегодняшний день)', () => {
  assert.deepEqual(confirmWindow(cfg([1, 2, 3, 4, 5, 6, 7]), '2026-10-22', 4), { active: true, horizonEndDay: '2026-10-23' });
});

test('пометка: registered 0 → todo, ≥1 → tried, confirmed при любых недозвонах, прочее — null', () => {
  assert.equal(confirmMark('registered', 0), 'todo');
  assert.equal(confirmMark('registered', 1), 'tried');
  assert.equal(confirmMark('registered', 5), 'tried');
  assert.equal(confirmMark('confirmed', 0), 'confirmed');
  assert.equal(confirmMark('confirmed', 3), 'confirmed');
  assert.equal(confirmMark('attended', 0), null);
  assert.equal(confirmMark('cancelled', 0), null);
});

test('порядок: todo < tried (раньше) < tried (позже) < прочие', () => {
  const items = [
    { id: 'rest', mark: 'confirmed' as const, lastTryAt: null },
    { id: 'late', mark: 'tried' as const, lastTryAt: 200 },
    { id: 'none', mark: null, lastTryAt: null },
    { id: 'todo', mark: 'todo' as const, lastTryAt: null },
    { id: 'early', mark: 'tried' as const, lastTryAt: 100 },
  ];
  const sorted = [...items].sort(compareConfirm).map((x) => x.id);
  assert.deepEqual(sorted.slice(0, 3), ['todo', 'early', 'late']);
  assert.equal(compareConfirm(items[0]!, items[2]!), 0);
});
