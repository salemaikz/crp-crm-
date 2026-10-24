// «← К доске» (К3): откуда пришли и на какую вкладку вернуться; открытого редиректа нет.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backTarget } from '../../../src/app/(op)/clients/_ui/backTarget';

test('из доски оператора и доски пространства — на свою доску с вкладкой', () => {
  assert.deepEqual(backTarget('board', 'callback', true), { href: '/board?tab=callback', kind: 'board' });
  assert.deepEqual(backTarget('deals', 'agreed_2', true), { href: '/deals/calling?tab=agreed_2', kind: 'board' });
});

test('вкладка вне [a-z0-9_]{1,32} отбрасывается, возврат остаётся на доску без неё', () => {
  for (const bad of ['', 'A', 'a-b', 'a b', 'a/b', '../x', 'https://evil.example', 'x'.repeat(33), 'я']) {
    assert.deepEqual(backTarget('board', bad, true), { href: '/board', kind: 'board' }, bad);
  }
  assert.deepEqual(backTarget('board', undefined, true), { href: '/board', kind: 'board' });
  assert.deepEqual(backTarget('board', ['a', 'b'], true), { href: '/board', kind: 'board' });
  assert.deepEqual(backTarget('board', 'x'.repeat(32), true).href, `/board?tab=${'x'.repeat(32)}`);
});

test('другой from, мусор, массив и выключенная доска — прежняя «К списку клиентов»', () => {
  const list = { href: '/clients', kind: 'list' };
  for (const from of [undefined, '', 'list', 'Board', '//evil.example', 'https://evil.example', '/board', 'javascript:1', ['board']]) {
    assert.deepEqual(backTarget(from, 'callback', true), list, String(from));
  }
  assert.deepEqual(backTarget('board', 'callback', false), list);
  assert.deepEqual(backTarget('deals', 'callback', false), list);
});
