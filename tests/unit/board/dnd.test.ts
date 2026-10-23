// Геометрия перетаскивания мышью (pipeline-v2 §9.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DRAG_THRESHOLD, edgeScroll, hitColumn, movedEnough } from '@/ui/board/dnd';

const RECTS = [
  { key: 'a', left: 0, top: 0, right: 100, bottom: 400 },
  { key: 'b', left: 110, top: 0, right: 210, bottom: 400 },
];

test('клик не становится перетаскиванием, пока указатель не сдвинулся на порог', () => {
  assert.equal(movedEnough({ x: 0, y: 0 }, { x: 2, y: 2 }), false);
  assert.equal(movedEnough({ x: 0, y: 0 }, { x: DRAG_THRESHOLD, y: 0 }), true);
});

test('колонка под указателем; между колонками и за доской — ничего', () => {
  assert.equal(hitColumn({ x: 50, y: 10 }, RECTS), 'a');
  assert.equal(hitColumn({ x: 150, y: 399 }, RECTS), 'b');
  assert.equal(hitColumn({ x: 105, y: 10 }, RECTS), null);
  assert.equal(hitColumn({ x: 50, y: 500 }, RECTS), null);
});

test('автопрокрутка у краёв: к левому краю — влево, к правому — вправо, в середине — нет', () => {
  const box = { left: 0, right: 1000 };
  assert.ok(edgeScroll(5, box) < 0);
  assert.ok(edgeScroll(995, box) > 0);
  assert.equal(edgeScroll(500, box), 0);
  assert.ok(Math.abs(edgeScroll(0, box)) >= Math.abs(edgeScroll(60, box)));
});
