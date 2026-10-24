// Раскладка колонок, сортировка и запросы доски (pipeline-v2 §9.2, §9.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { columnEventLabel, roleOfStates } from '@/ui/board/columns';
import { availableFilters, boardQuery, columnQuery, sortCards } from '@/ui/board/order';
import { applyPlacements } from '@/ui/board/placement';
import { card } from './fixtures';

test('роль колонки по состояниям: совпадает с правилом ядра', () => {
  assert.equal(roleOfStates(['new']), 'new');
  assert.equal(roleOfStates(['retry', 'callback']), 'callback');
  assert.equal(roleOfStates(['agreed']), 'agreed');
  assert.equal(roleOfStates(['client']), 'client');
  assert.equal(roleOfStates(['not_interested', 'written_off']), 'trash');
  assert.equal(roleOfStates(['x']), 'other');
});

test('сортировка «По горячести» не трогает порядок сервера; «По сроку» ставит ближайшие вперёд, без срока в конец', () => {
  const a = card({ id: 'a', nextCallAt: 300 });
  const b = card({ id: 'b', nextCallAt: null });
  const c = card({ id: 'c', nextCallAt: 100 });
  assert.deepEqual(sortCards([a, b, c], 'heat', 'callback').map((x) => x.id), ['a', 'b', 'c']);
  assert.deepEqual(sortCards([a, b, c], 'due', 'callback').map((x) => x.id), ['c', 'a', 'b']);
});

test('«Новые сверху»: ни разу не набранные впереди, порядок внутри групп сохраняется', () => {
  const old1 = card({ id: 'o1', state: 'callback', callbackTouches: 1 });
  const fresh1 = card({ id: 'f1' });
  const old2 = card({ id: 'o2', state: 'retry', attempts: 2 });
  const fresh2 = card({ id: 'f2' });
  assert.deepEqual(sortCards([old1, fresh1, old2, fresh2], 'new', 'callback').map((x) => x.id), ['f1', 'f2', 'o1', 'o2']);
});

test('сортировка применяется только к «Новые» и «Перезвон»: остальные колонки в порядке сервера', () => {
  const xs = [card({ id: 'a', nextCallAt: 9 }), card({ id: 'b', nextCallAt: 1 })];
  for (const role of ['agreed', 'client', 'trash'] as const) assert.deepEqual(sortCards(xs, 'due', role).map((x) => x.id), ['a', 'b']);
});

test('фильтр «Покупал» доступен только при праве на покупки', () => {
  assert.ok(availableFilters(true).includes('purchased'));
  assert.ok(!availableFilters(false).includes('purchased'));
});

test('запрос доски: поиск и фильтры в том виде, который понимает сервер; пустое не отправляется', () => {
  assert.equal(boardQuery('', []), '');
  assert.equal(boardQuery('  Синтетика ', ['today', 'noShow']), 'q=%D0%A1%D0%B8%D0%BD%D1%82%D0%B5%D1%82%D0%B8%D0%BA%D0%B0&filter=today%2CnoShow');
  const col = new URLSearchParams(columnQuery('callback', 'abc', ['today']));
  assert.equal(col.get('column'), 'callback');
  assert.equal(col.get('cursor'), 'abc');
  assert.equal(col.get('filter'), 'today');
  assert.equal(col.get('q'), null);
});

test('перенос «в уме»: плитка уходит из прежней колонки и встаёт первой в целевой с новыми полями', () => {
  const a = card({ id: 'a' });
  const b = card({ id: 'b' });
  const x = card({ id: 'x', state: 'callback', column: 'callback' });
  const out = applyPlacements({ new: [a, b], callback: [x], trash: [] }, [{ cardId: 'a', column: 'callback', patch: { state: 'callback', callbackReason: 'think' }, opId: 'op1' }]);
  assert.deepEqual(out.new?.map((c) => c.id), ['b']);
  assert.deepEqual(out.callback?.map((c) => c.id), ['a', 'x']);
  assert.equal(out.callback?.[0]?.callbackReason, 'think');
  assert.equal(out.callback?.[0]?.column, 'callback');
});

test('перенос «в уме»: без размещений колонки возвращаются как есть; незагруженная плитка не появляется из воздуха', () => {
  const cols = { new: [card({ id: 'a' })], callback: [] };
  assert.equal(applyPlacements(cols, []), cols);
  const out = applyPlacements(cols, [{ cardId: 'ghost', column: 'callback', patch: {}, opId: 'o' }]);
  assert.deepEqual(out.callback, []);
});

test('пустая «Договорились»: подпись берётся по виду записи своей колонки, две колонки agreed различаются', () => {
  const labels = { br: 'БР', bk: 'БК' };
  assert.equal(columnEventLabel(['br'], labels), 'БР');
  assert.equal(columnEventLabel(['bk'], labels), 'БК');
  assert.equal(columnEventLabel([], labels), '');
  assert.equal(columnEventLabel(undefined, labels), '');
  assert.equal(columnEventLabel(['zz'], labels), '');
});
