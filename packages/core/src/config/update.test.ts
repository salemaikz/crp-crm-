import { test } from 'node:test';
import assert from 'node:assert/strict';
import { presetUpdate } from './update.js';
import { formatPath } from './paths.js';

const paths = (xs: { path: Parameters<typeof formatPath>[0] }[]) => xs.map((x) => formatPath(x.path)).sort();

test('нетронутое клиентом значение обновляется, правка клиента остаётся', () => {
  const prevPreset = { distribution: { dailyCap: 40, mode: 'manual' } };
  const current = { distribution: { dailyCap: 35, mode: 'manual' } }; // РОП поменял лимит
  const nextPreset = { distribution: { dailyCap: 50, mode: 'top_up' } };
  const r = presetUpdate({ current, prevPreset, nextPreset });
  assert.deepEqual(r.doc, { distribution: { dailyCap: 35, mode: 'top_up' } });
  assert.deepEqual(paths(r.applied), ['distribution.mode']);
  assert.deepEqual(paths(r.kept), ['distribution.dailyCap']);
  assert.deepEqual(r.kept[0], { path: ['distribution', 'dailyCap'], before: 35, preset: 50 });
});

test('force перезаписывает правки клиента и отчитывается о них', () => {
  const r = presetUpdate({ current: { cap: 35 }, prevPreset: { cap: 40 }, nextPreset: { cap: 50 }, force: true });
  assert.deepEqual(r.doc, { cap: 50 });
  assert.deepEqual(paths(r.forced), ['cap']);
  assert.equal(r.kept.length, 0);
});

test('новый ключ пресета добавляется; ключ, убранный из пресета, остаётся у клиента', () => {
  const r = presetUpdate({ current: { a: 1, old: 'x' }, prevPreset: { a: 1, old: 'x' }, nextPreset: { a: 1, fresh: true } });
  assert.deepEqual(r.doc, { a: 1, old: 'x', fresh: true });
  assert.deepEqual(paths(r.applied), ['fresh']);
});

test('элементы с ключом: по элементу и по полю; новый элемент — в конец; элемент клиента не трогается', () => {
  const prevPreset = { outcomes: [{ key: 'a', label: { ru: 'А' }, order: 1 }] };
  const current = {
    outcomes: [
      { key: 'a', label: { ru: 'А клиента' }, order: 1 },
      { key: 'mine', label: { ru: 'Свой' }, order: 9 },
    ],
  };
  const nextPreset = {
    outcomes: [
      { key: 'a', label: { ru: 'А2' }, order: 2 },
      { key: 'b', label: { ru: 'Б' }, order: 3 },
    ],
  };
  const r = presetUpdate({ current, prevPreset, nextPreset });
  assert.deepEqual(r.doc, {
    outcomes: [
      { key: 'a', label: { ru: 'А клиента' }, order: 2 },
      { key: 'mine', label: { ru: 'Свой' }, order: 9 },
      { key: 'b', label: { ru: 'Б' }, order: 3 },
    ],
  });
  assert.deepEqual(paths(r.applied), ['outcomes[key=a].order', 'outcomes[key=b]']);
  assert.deepEqual(paths(r.kept), ['outcomes[key=a].label.ru']);
});

test('массив без ключа — одно значение: правка клиента целиком остаётся', () => {
  const r = presetUpdate({ current: { workdays: [1, 2, 3, 4, 5, 6] }, prevPreset: { workdays: [1, 2, 3, 4, 5] }, nextPreset: { workdays: [1, 2, 3, 4] } });
  assert.deepEqual(r.doc, { workdays: [1, 2, 3, 4, 5, 6] });
  assert.deepEqual(paths(r.kept), ['workdays']);
});

test('без прошлого пресета любое отличие — правка клиента; совпадения не отчитываются', () => {
  const r = presetUpdate({ current: { a: 1, b: 2 }, prevPreset: undefined, nextPreset: { a: 1, b: 3, c: 4 } });
  assert.deepEqual(r.doc, { a: 1, b: 2, c: 4 });
  assert.deepEqual(paths(r.kept), ['b']);
  assert.deepEqual(paths(r.applied), ['c']);
});

test('клиент убрал необязательное значение: если пресет его не менял — остаётся убранным', () => {
  const prevPreset = { label: { ru: 'А', kk: 'A' } };
  const current = { label: { ru: 'А' } };
  assert.deepEqual(presetUpdate({ current, prevPreset, nextPreset: prevPreset }).doc, current);
  const r = presetUpdate({ current, prevPreset, nextPreset: { label: { ru: 'А', kk: 'B' } } });
  assert.deepEqual(r.doc, current);
  assert.deepEqual(paths(r.kept), ['label.kk']);
});

test('первая установка: текущей ревизии нет — документ равен пресету', () => {
  const next = { a: { b: [{ key: 'x' }] } };
  const r = presetUpdate({ current: undefined, prevPreset: undefined, nextPreset: next });
  assert.deepEqual(r.doc, next);
});

test('повторный apply того же пресета — без изменений', () => {
  const p = { a: 1, xs: [{ key: 'k', v: 1 }] };
  const r = presetUpdate({ current: structuredClone(p), prevPreset: p, nextPreset: p });
  assert.deepEqual(r.doc, p);
  assert.equal(r.applied.length + r.kept.length + r.forced.length, 0);
});
