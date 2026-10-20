import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigMergeError, mergeJson, mergeLayers } from './merge.js';
import type { Json } from './json.js';

test('объекты сливаются глубоко, отсутствующий ключ — «не менять»', () => {
  const base = { a: { b: 1, c: 2 }, d: 'x' };
  const over = { a: { c: 3 } };
  assert.deepEqual(mergeJson(base, over), { a: { b: 1, c: 3 }, d: 'x' });
});

test('null — значение, а не удаление', () => {
  assert.deepEqual(mergeJson({ alerts: { h: 26 } }, { alerts: { h: null } }), { alerts: { h: null } });
});

test('массивы с key сливаются по key: частичное перекрытие, новые в конец, порядок базы', () => {
  const base = [
    { key: 'a', label: { ru: 'А' }, order: 1 },
    { key: 'b', label: { ru: 'Б' }, order: 2 },
  ];
  const over: Json[] = [
    { key: 'c', label: { ru: 'В' } },
    { key: 'a', label: { kk: 'А-kk' } },
  ];
  assert.deepEqual(mergeJson(base, over), [
    { key: 'a', label: { ru: 'А', kk: 'А-kk' }, order: 1 },
    { key: 'b', label: { ru: 'Б' }, order: 2 },
    { key: 'c', label: { ru: 'В' } },
  ]);
});

test('праздники сливаются по date: корпоративный день клиента переживает обновление странового слоя', () => {
  const kzOld = { calendar: { holidays: [{ date: '2026-03-08', kind: 'holiday', note: 'old' }] } };
  const client = { calendar: { holidays: [{ date: '2026-12-31', kind: 'holiday', note: 'corp' }] } };
  const kzNew = { calendar: { holidays: [{ date: '2026-03-08', kind: 'holiday', note: 'new' }, { date: '2026-03-09', kind: 'holiday', note: 'перенос' }] } };
  const a = mergeLayers([kzOld, client]) as { calendar: { holidays: Json[] } };
  const b = mergeLayers([kzNew, client]) as { calendar: { holidays: { date: string; note: string }[] } };
  assert.equal(a.calendar.holidays.length, 2);
  assert.deepEqual(
    b.calendar.holidays.map((h) => [h.date, h.note]),
    [
      ['2026-03-08', 'new'],
      ['2026-03-09', 'перенос'],
      ['2026-12-31', 'corp'],
    ],
  );
});

test('массивы без ключа заменяются целиком', () => {
  assert.deepEqual(mergeJson({ workdays: [1, 2, 3, 4, 5] }, { workdays: [1, 2, 3, 4, 5, 6] }), { workdays: [1, 2, 3, 4, 5, 6] });
  assert.deepEqual(mergeJson({ grants: [{ perm: 'a', scope: 'own' }] }, { grants: [{ perm: 'b', scope: 'space' }] }), {
    grants: [{ perm: 'b', scope: 'space' }],
  });
  assert.deepEqual(mergeJson({ workdays: [1, 2] }, { workdays: [] }), { workdays: [] });
});

test('пустой массив с ключом ничего не удаляет', () => {
  assert.deepEqual(mergeJson({ xs: [{ key: 'a' }] }, { xs: [] }), { xs: [{ key: 'a' }] });
});

test('удаление — только archived: true', () => {
  const r = mergeJson({ xs: [{ key: 'a', label: 'А' }] }, { xs: [{ key: 'a', archived: true }] });
  assert.deepEqual(r, { xs: [{ key: 'a', label: 'А', archived: true }] });
});

test('вложенные массивы с ключом внутри элемента сливаются по ключу', () => {
  const base = { pipelines: [{ key: 'p', stages: [{ key: 's1', staleDays: 14 }, { key: 's2', staleDays: 7 }] }] };
  const over = { pipelines: [{ key: 'p', stages: [{ key: 's2', staleDays: 3 }] }] };
  assert.deepEqual(mergeJson(base, over), { pipelines: [{ key: 'p', stages: [{ key: 's1', staleDays: 14 }, { key: 's2', staleDays: 3 }] }] });
});

test('смена типа: побеждает слой выше', () => {
  assert.deepEqual(mergeJson({ a: { b: 1 } }, { a: 5 }), { a: 5 });
  assert.deepEqual(mergeJson({ a: 5 }, { a: [1] }), { a: [1] });
});

test('ошибки: повтор ключа, смесь элементов с ключом и без, __proto__', () => {
  assert.throws(() => mergeJson([{ key: 'a' }], [{ key: 'b' }, { key: 'b' }]), ConfigMergeError);
  assert.throws(() => mergeJson([], [{ key: 'a' }, { x: 1 }]), ConfigMergeError);
  // повтор внутри значения, которого не было в базе, тоже ловится
  assert.throws(() => mergeJson({ a: 1 }, { b: [{ key: 'x' }, { key: 'x' }] }), ConfigMergeError);
  const evil = JSON.parse('{"__proto__": {"polluted": true}}') as Json;
  assert.throws(() => mergeJson({}, evil), ConfigMergeError);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('входы не мутируются', () => {
  const base = { xs: [{ key: 'a', v: 1 }], o: { p: 1 } };
  const over = { xs: [{ key: 'a', v: 2 }], o: { q: 2 } };
  const snapB = structuredClone(base);
  const snapO = structuredClone(over);
  const r = mergeJson(base, over) as typeof base;
  r.xs[0]!.v = 99;
  assert.deepEqual(base, snapB);
  assert.deepEqual(over, snapO);
});

test('mergeLayers: слои по порядку, верхний побеждает', () => {
  assert.deepEqual(mergeLayers([{ cap: 40, mode: 'manual' }, undefined, { mode: 'auto_even' }, { cap: 30 }]), { cap: 30, mode: 'auto_even' });
});
