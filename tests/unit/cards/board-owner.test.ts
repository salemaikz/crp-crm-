// Имя ответственного на плитке: видят все охваты, кроме «своих» (team получает имя явно).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showsOwner } from '@/server/domain/cards/board';

test('имя ответственного: own — нет; team, space, all — да', () => {
  assert.equal(showsOwner('own'), false);
  for (const s of ['team', 'space', 'all'] as const) assert.equal(showsOwner(s), true, s);
});
