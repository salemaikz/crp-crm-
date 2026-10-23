// Доска РОП и директора (линия M1): фильтры сотрудника и причины в запросе, перенос РОП в «Перезвон» онлайн.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boardQuery, columnQuery } from '@/ui/board/order';
import { moveTargets } from '@/ui/board/moves';
import { COLUMNS, card } from './fixtures';

test('фильтры сотрудника и причины попадают в запрос доски и «Ещё»', () => {
  assert.equal(boardQuery('', [], { owner: 'u1', callbackReason: 'think' }), 'owner=u1&callbackReason=think');
  assert.equal(boardQuery('', ['noShow'], { owner: '', callbackReason: '' }), 'filter=noShow');
  const q = new URLSearchParams(columnQuery('callback', 'cur', ['noShow'], { owner: 'u1', callbackReason: '' }));
  assert.equal(q.get('owner'), 'u1');
  assert.equal(q.get('filter'), 'noShow');
  assert.equal(q.get('callbackReason'), null);
});

test('РОП на общей доске: «Перезвон» доступен только онлайн; без признака доски — погашен как раньше', () => {
  const c = card({ column: 'new' });
  const on = moveTargets(c, COLUMNS, true, 'wide', { managerMove: true, online: true }).find((t) => t.column === 'callback');
  assert.equal(on?.available, true);
  assert.equal(on?.action, 'callback');
  const off = moveTargets(c, COLUMNS, true, 'wide', { managerMove: true, online: false }).find((t) => t.column === 'callback');
  assert.equal(off?.available, false);
  assert.equal(off?.blocked, 'offline');
  const old = moveTargets(c, COLUMNS, true, 'wide').find((t) => t.column === 'callback');
  assert.equal(old?.blocked, 'manual');
});

test('директор (без права переноса): целей нет даже на доске РОП', () => {
  const ts = moveTargets(card({ column: 'new' }), COLUMNS, false, 'wide', { managerMove: true, online: true });
  assert.ok(ts.every((t) => !t.available));
});
