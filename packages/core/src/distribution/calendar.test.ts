import { test } from 'node:test';
import assert from 'node:assert/strict';
import { at, TEST_CALENDAR as C } from './testCalendar';

test('адаптер календаря: сутки и минуты по местному поясу, не по поясу процесса', () => {
  const t = at('2026-10-20 23:30');
  assert.equal(C.localDay(t), '2026-10-20');
  assert.equal(C.localMinutes(t), 23 * 60 + 30);
  assert.equal(C.localMinutes(at('2026-10-21 00:05')), 5);
});

test('адаптер календаря: выходные и перенос пропускаются', () => {
  assert.equal(C.isWorkday('2026-10-26'), false);
  assert.equal(C.nextWorkday('2026-10-23'), '2026-10-27');
});
