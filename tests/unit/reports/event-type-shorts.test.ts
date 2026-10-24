// Короткие подписи видов мероприятий для «Явка — список» (дефект 9): short из настроек, иначе полная подпись.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eventTypeShorts, type EventTypeDoc } from '../../../src/server/domain/reports/eventLabels';
import { eventTypeShortOf } from '../../../src/app/(mgr)/reports/eventTypeLabel';

const types: EventTypeDoc[] = [
  { key: 'a', behavior: 'group', label: { ru: 'Групповая встреча' }, short: { ru: 'ГВ' } },
  { key: 'b', behavior: 'individual', label: { ru: 'Индивидуальная консультация' } },
];

test('eventTypeShorts: short из настроек, нет short — полная подпись, нет подписи — ключ', () => {
  assert.deepEqual(eventTypeShorts(types), { a: 'ГВ', b: 'Индивидуальная консультация' });
  assert.deepEqual(eventTypeShorts([{ key: 'c', behavior: 'group', label: {} }]), { c: 'c' });
});

test('eventTypeShortOf: короткая подпись, запасной вариант — полная, затем ключ', () => {
  const labels = { eventTypes: { a: 'Групповая встреча', b: 'Консультация' }, eventTypeShorts: { a: 'ГВ' } };
  assert.deepEqual(eventTypeShortOf(labels, 'a'), { short: 'ГВ', full: 'Групповая встреча' });
  assert.deepEqual(eventTypeShortOf(labels, 'b'), { short: 'Консультация', full: 'Консультация' });
  assert.deepEqual(eventTypeShortOf(labels, 'zz'), { short: 'zz', full: 'zz' });
});
