// Следующий шаг итогового отчёта (C8 §3.4) и фильтр «История правок».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FEED_FILTERS, EVENT_KINDS, isFeedFilter, kindsOfGroups } from '../../../src/server/domain/timeline/kinds';
import { pickNextStep } from '../../../src/server/domain/timeline/summary';

const none = { state: null, nextCallAt: null, nextBookingAt: null, task: null };

test('перезвон и повтор берут время из next_call_at и важнее записи и задачи', () => {
  const rest = { nextBookingAt: 50, task: { source: 'manual', dueAt: 70 } };
  assert.deepEqual(pickNextStep({ ...none, ...rest, state: 'callback', nextCallAt: 10 }), { kind: 'callback', at: 10 });
  assert.deepEqual(pickNextStep({ ...none, ...rest, state: 'retry', nextCallAt: 20 }), { kind: 'retry', at: 20 });
});

test('перезвон без времени не считается шагом; дальше — запись, затем задача', () => {
  assert.deepEqual(pickNextStep({ ...none, state: 'callback', nextBookingAt: 50 }), { kind: 'booking', at: 50 });
  assert.deepEqual(pickNextStep({ ...none, state: 'client', nextBookingAt: 50, task: { source: 'manual', dueAt: 70 } }), { kind: 'booking', at: 50 });
  assert.deepEqual(pickNextStep({ ...none, state: 'client', task: { source: 'next_step', dueAt: 70 } }), { kind: 'task', at: 70, taskSource: 'next_step' });
  assert.deepEqual(pickNextStep({ ...none, task: { source: 'review', dueAt: null } }), { kind: 'task', at: null, taskSource: 'review' });
});

test('нет ничего — «нет»; закрытое состояние время перезвона не использует', () => {
  assert.deepEqual(pickNextStep(none), { kind: 'none', at: null });
  assert.deepEqual(pickNextStep({ ...none, state: 'not_target', nextCallAt: 99 }), { kind: 'none', at: null });
});

test('«История правок»: только виды реестра — правки полей, номеров и контактов', () => {
  assert.ok(isFeedFilter('edits'));
  assert.ok(!isFeedFilter('calls'));
  for (const k of FEED_FILTERS.edits) assert.ok(Object.hasOwn(EVENT_KINDS, k), k);
  assert.ok(!(FEED_FILTERS.edits as readonly string[]).some((k) => k === 'call' || k === 'note.created'));
  // группы по-прежнему работают без фильтра
  assert.ok(kindsOfGroups(['notes']).includes('note.created'));
});
