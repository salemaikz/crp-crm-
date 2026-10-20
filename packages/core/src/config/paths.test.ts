import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigPathError, formatPath, getAt, parsePath, setAt, type PathSeg } from './paths.js';
import { diffJson, formatDiff } from './diff.js';

test('formatPath ↔ parsePath', () => {
  const cases: PathSeg[][] = [
    [],
    ['distribution', 'dailyCap'],
    ['calling', 'outcomes', { by: 'key', id: 'agreed' }, 'label', 'ru'],
    ['calendar', 'holidays', { by: 'date', id: '2026-03-08' }, 'note'],
    ['import', 'profiles', { by: 'key', id: 'p' }, 'columns', 'Телефон. [клиента]'],
  ];
  for (const c of cases) assert.deepEqual(parsePath(formatPath(c)), c, formatPath(c));
  assert.equal(formatPath(['calling', 'outcomes', { by: 'key', id: 'agreed' }, 'label']), 'calling.outcomes[key=agreed].label');
});

test('parsePath отклоняет мусор и __proto__', () => {
  for (const bad of ['.a', 'a[', 'a[x=1]', 'a..b?', '__proto__.x', 'a["__proto__"]']) assert.throws(() => parsePath(bad), ConfigPathError, bad);
});

test('getAt / setAt по ключу элемента', () => {
  const doc = { calling: { outcomes: [{ key: 'a', label: { ru: 'А' } }] } };
  assert.deepEqual(getAt(doc, parsePath('calling.outcomes[key=a].label.ru')), 'А');
  assert.equal(getAt(doc, parsePath('calling.outcomes[key=zz].label')), undefined);
  const r = setAt(doc, parsePath('calling.outcomes[key=a].label.kk'), 'А-kk');
  assert.deepEqual(r, { calling: { outcomes: [{ key: 'a', label: { ru: 'А', kk: 'А-kk' } }] } });
  assert.deepEqual(doc.calling.outcomes[0]!.label, { ru: 'А' }, 'исходный документ не изменился');
  const added = setAt(doc, parsePath('calling.outcomes[key=b].archived'), true);
  assert.deepEqual(getAt(added, parsePath('calling.outcomes[key=b]')), { key: 'b', archived: true });
  assert.throws(() => setAt({ a: 1 }, parsePath('a[key=x]'), 1), ConfigPathError);
});

test('diffJson: по ключу, перестановка — не изменение, массив без ключа — одно значение', () => {
  const a = { xs: [{ key: 'a', v: 1 }, { key: 'b', v: 2 }], days: [1, 2], n: 1 };
  const b = { xs: [{ key: 'b', v: 3 }, { key: 'a', v: 1 }, { key: 'c', v: 0 }], days: [1, 2, 3], m: true };
  const lines = formatDiff(diffJson(a, b));
  assert.deepEqual(lines.sort(), [
    '+ m: true',
    '+ xs[key=c]: {"key":"c","v":0}',
    '- n: 1',
    '~ days: [1,2] → [1,2,3]',
    '~ xs[key=b].v: 2 → 3',
  ]);
  assert.deepEqual(diffJson({ a: [{ key: 'x' }, { key: 'y' }] }, { a: [{ key: 'y' }, { key: 'x' }] }), []);
});
