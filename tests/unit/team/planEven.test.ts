// B9a: «поровну» и семьи двойников (docs/tasks-team-design.md §6.4). Чистые функции, без БД.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupFamilies, planEven, type Family } from '../../../src/server/domain/team/plan';

const fam = (...ids: string[]): Family => ({ key: [...ids].sort()[0] as string, cardIds: [...ids].sort() });

test('семьи: транзитивные пары склеиваются, пара с клиентом вне набора — нет, одиночки отдельно', () => {
  const cards = ['a', 'b', 'c', 'd', 'e', 'f'].map((x) => ({ id: `cd-${x}`, clientId: `cl-${x}` }));
  const out = groupFamilies(cards, [
    { aClientId: 'cl-a', bClientId: 'cl-b' },
    { aClientId: 'cl-b', bClientId: 'cl-c' },
    { aClientId: 'cl-e', bClientId: 'cl-zzz' },
  ]);
  assert.deepEqual(out.map((f) => f.cardIds), [['cd-a', 'cd-b', 'cd-c'], ['cd-d'], ['cd-e'], ['cd-f']]);
  assert.deepEqual(out.map((f) => f.key), ['cd-a', 'cd-d', 'cd-e', 'cd-f']);
});

test('результат семей не зависит от порядка карточек и пар', () => {
  const cards = ['1', '2', '3', '4'].map((x) => ({ id: `cd-${x}`, clientId: `cl-${x}` }));
  const pairs = [{ aClientId: 'cl-3', bClientId: 'cl-4' }, { aClientId: 'cl-1', bClientId: 'cl-3' }];
  const a = groupFamilies(cards, pairs);
  const b = groupFamilies([...cards].reverse(), [...pairs].reverse());
  assert.deepEqual(a, b);
});

test('«поровну»: большие семьи первыми, наименьшая сумма, равенство — порядок списка; семья не делится', () => {
  const families = [fam('c5'), fam('c1', 'c2', 'c3'), fam('c4'), fam('c6', 'c7'), fam('c8')];
  const { toByCard, totals } = planEven(families, ['x', 'y', 'z']);
  // порядок: [c1c2c3]→x(3), [c6c7]→y(2), c4→z(1), c5→z(2), c8→y(2→3)? y=2,z=2,x=3 → наименьшая y (раньше z)
  assert.deepEqual([...totals], [['x', 3], ['y', 3], ['z', 2]]);
  assert.equal(toByCard.get('c1'), toByCard.get('c2'));
  assert.equal(toByCard.get('c2'), toByCard.get('c3'));
  assert.equal(toByCard.get('c6'), toByCard.get('c7'));
  assert.equal(toByCard.get('c1'), 'x');
  assert.equal(toByCard.get('c6'), 'y');
  assert.equal(toByCard.get('c4'), 'z');
  assert.equal(toByCard.get('c5'), 'z');
  assert.equal(toByCard.get('c8'), 'y');
  assert.equal(toByCard.size, 8);
});

test('«поровну»: 10 одиночных на троих — 4/3/3, первому в списке достаётся лишняя', () => {
  const families = Array.from({ length: 10 }, (_, i) => fam(`c${String(i).padStart(2, '0')}`));
  const { totals } = planEven(families, ['x', 'y', 'z']);
  assert.deepEqual([...totals.values()], [4, 3, 3]);
});

test('«поровну»: без получателей — ошибка вызова; пустой набор — нули', () => {
  assert.throws(() => planEven([fam('c1')], []));
  assert.deepEqual([...planEven([], ['x', 'y']).totals], [['x', 0], ['y', 0]]);
});
