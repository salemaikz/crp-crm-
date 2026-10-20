import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as core from './index';

test('корневой экспорт: пространства имён модулей и рабочая связка', () => {
  assert.deepEqual(Object.keys(core).sort(), ['booking', 'calling', 'dedup', 'distribution', 'fields', 'imports', 'names', 'phone', 'time']);
  assert.equal(typeof core.calling.applyOutcome, 'function');
  const cal = core.time.createWorkCalendar({
    timezone: 'Asia/Almaty',
    workdays: [1, 2, 3, 4, 5],
    workHours: { start: '09:00', end: '18:00' },
    callWindow: { start: '09:00', end: '18:00' },
    holidays: [],
  });
  const dc = core.distribution.toDistributionCalendar(cal);
  assert.equal(dc.nextWorkday('2026-10-23'), '2026-10-26');
  assert.equal(core.phone.normalizePhone('8 709 000 11 22', core.phone.DEFAULT_PHONE_RULES), '77090001122');
});
