// Прокрутка ряда колонок: края, шаг кнопок, затухание (D-358 п. 1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fadeMask, metricsOf, rowEdges, rowStep, rowTarget } from '@/ui/board/rowScroll';

const M = { scrollLeft: 0, clientWidth: 1000, scrollWidth: 1600 };

test('края ряда: в начале есть только правый, в конце только левый, без переполнения — никаких', () => {
  assert.deepEqual(rowEdges(M), { before: false, after: true });
  assert.deepEqual(rowEdges({ ...M, scrollLeft: 300 }), { before: true, after: true });
  assert.deepEqual(rowEdges({ ...M, scrollLeft: 600 }), { before: true, after: false });
  assert.deepEqual(rowEdges({ scrollLeft: 0, clientWidth: 1000, scrollWidth: 1000 }), { before: false, after: false });
});

test('кнопки «‹ ›» не выходят за края', () => {
  assert.equal(rowTarget(1, M, 400), 400);
  assert.equal(rowTarget(1, { ...M, scrollLeft: 500 }, 400), 600);
  assert.equal(rowTarget(-1, { ...M, scrollLeft: 100 }, 400), 0);
});

test('шаг — колонка с промежутком, но не меньше половины окна', () => {
  assert.equal(rowStep(272, 8, 1000), 500);
  assert.equal(rowStep(600, 8, 1000), 608);
});

test('затухание 24 px только у тех краёв, где есть ещё колонки', () => {
  assert.equal(fadeMask({ before: false, after: false }), undefined);
  assert.match(fadeMask({ before: false, after: true })!, /black 0, black calc\(100% - 24px\), transparent 100%/);
  assert.match(fadeMask({ before: true, after: false })!, /transparent 0, black 24px, black 100%/);
});

test('конец ряда считается по ширине с резервом под полосу: последние пиксели лежат в ней', () => {
  // clientWidth 1185 + резерв 15 = offsetWidth 1200; предел прокрутки 1672 − 1200 = 472
  const el = { scrollLeft: 472, offsetWidth: 1200, scrollWidth: 1672 };
  assert.deepEqual(rowEdges(metricsOf(el)), { before: true, after: false });
  assert.equal(rowTarget(1, metricsOf(el), 500), 472);
  assert.deepEqual(rowEdges(metricsOf({ ...el, scrollLeft: 0 })), { before: false, after: true });
});
