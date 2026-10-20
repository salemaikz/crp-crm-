/**
 * Планирование прогона автоназначения «серых» заявок: кандидаты пула, предложения, граница прогонов.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { greyBookings, nextBoundary, pendingGreys, planGreyProposals, poolCandidates } from './autoAssign';
import { MONDAY_11_13, booking, consultant, snapshot } from './fixtures';

const sched = { schedule: MONDAY_11_13, exceptions: [] as [] };

test('«серые» снимка — только записи без консультанта', () => {
  const snap = snapshot([consultant('a')], [booking('g', null, '11:00'), booking('x', 'a', '12:00')]);
  assert.deepEqual(greyBookings(snap).map((b) => b.id), ['g']);
});

test('кандидаты — только консультанты пула, направление первым', () => {
  const grey = booking('g', null, '11:00', { directionKey: 'marketing' });
  const snap = snapshot(
    [
      consultant('owner', { autoAssign: false, directions: ['marketing'] }),
      consultant('a', { autoAssign: true }),
      consultant('b', { autoAssign: true, directions: ['marketing'] }),
    ],
    [grey],
  );
  assert.deepEqual(poolCandidates(snap, grey).map((c) => c.consultantId), ['b', 'a'], 'owner вне пула — не кандидат');
});

test('предложения идут по очереди: двум записям на одно время не достаётся один консультант', () => {
  const g1 = booking('g1', null, '11:00', { createdAt: 1 });
  const g2 = booking('g2', null, '11:00', { createdAt: 2 });
  const snap = snapshot([consultant('a'), consultant('b')], [g1, g2]);
  const plan = planGreyProposals(snap);
  assert.deepEqual(plan.proposals.map((p) => [p.booking.id, p.consultantId]), [['g1', 'a'], ['g2', 'b']]);
  assert.deepEqual(plan.unassignable, []);
});

test('некому принять — заявка уходит в неразмещаемые, остальные размещаются', () => {
  const g1 = booking('g1', null, '11:00');
  const g2 = booking('g2', null, '11:00');
  const snap = snapshot([consultant('a')], [g1, g2]);
  const plan = planGreyProposals(snap);
  assert.deepEqual(plan.proposals.map((p) => p.booking.id), ['g1']);
  assert.deepEqual(plan.unassignable.map((b) => b.id), ['g2']);
});

test('консультанта с графиком предлагают только на старт его слота', () => {
  const ok = booking('ok', null, '11:45');
  const bad = booking('bad', null, '11:20');
  const snap = snapshot([consultant('a', { usesSchedule: true })], [ok, bad], { a: sched });
  const plan = planGreyProposals(snap);
  assert.deepEqual(plan.proposals.map((p) => p.booking.id), ['ok']);
  assert.deepEqual(plan.unassignable.map((b) => b.id), ['bad']);
});

test('граница прогонов: первый берёт все, следующий — только записанные позже', () => {
  const old = booking('old', null, '11:00', { createdAt: 100 });
  const fresh = booking('fresh', null, '11:45', { createdAt: 200 });
  assert.deepEqual(pendingGreys([old], null).map((b) => b.id), ['old']);
  const boundary = nextBoundary(null, [old]);
  assert.equal(boundary, 100);
  assert.deepEqual(pendingGreys([old, fresh], boundary).map((b) => b.id), ['fresh']);
  assert.equal(nextBoundary(boundary, [old, fresh]), 200);
  assert.equal(nextBoundary(300, [old]), 300, 'граница не откатывается назад');
});

test('перенос обработанной «серой» вторым предложением не приходит', () => {
  const moved = booking('moved', null, '12:30', { createdAt: 250 });
  const fresh = booking('fresh', null, '11:45', { createdAt: 260 });
  assert.deepEqual(pendingGreys([moved, fresh], 100, new Set(['moved'])).map((b) => b.id), ['fresh']);
});
