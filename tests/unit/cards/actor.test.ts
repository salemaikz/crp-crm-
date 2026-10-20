// Исполнитель для ядра обзвона: охват карточек сотрудника → own / space / relation (docs/calls-design.md §3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toCoreActor } from '../../../src/server/domain/cards/actor';
import { testViewer } from '../../../src/server/access/testing';
import type { SystemActor } from '../../../src/server/access/types';
import { role } from '../access/helpers';

const viewerWith = (userId: string, scope: 'own' | 'team' | 'space' | 'all' | null) =>
  testViewer({ userId, role: role({ grants: scope ? [{ perm: 'card.outcome', scope }] : [] }) });

test('own → own', () => {
  assert.deepEqual(toCoreActor(viewerWith('u1', 'own')), { userId: 'u1', kind: 'user', scope: 'own' });
});

test('team, space, all → space', () => {
  for (const scope of ['team', 'space', 'all'] as const) assert.equal(toCoreActor(viewerWith('u2', scope)).scope, 'space', scope);
});

test('нет охвата (дежурный, консультант) → relation', () => {
  assert.equal(toCoreActor(viewerWith('u3', null)).scope, 'relation');
});

test('система → без userId, охват пространства', () => {
  const sys = { kind: 'system', job: 'x', now: 1 } as SystemActor;
  assert.deepEqual(toCoreActor(sys), { userId: null, kind: 'system', scope: 'space' });
});
