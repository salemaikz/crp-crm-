// Тихие часы push (PROCESS 11, D-328): вне рабочего времени push ждёт ближайшего рабочего момента календаря установки.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ActiveConfig } from '../../../packages/core/src/config';
import { quietShift } from '../../../src/server/jobs/push';

const cfg = (quiet: 'outside_work_hours' | 'none') =>
  ({
    global: {
      doc: {
        org: { timezone: 'Asia/Almaty' },
        calendar: { workdays: [1, 2, 3, 4, 5], workHours: { start: '09:00', end: '18:00' }, callWindow: { start: '09:00', end: '18:00' }, holidays: [] },
      },
    },
    spaces: { sales: { spaceId: 'sp-1', rev: 1, hash: '', doc: { notifications: { quietHours: quiet } } } },
  }) as unknown as ActiveConfig;

// Пятница 30.10.2026 19:00 по Алматы (UTC+5) → понедельник 02.11 09:00
const FRI_19 = Date.UTC(2026, 9, 30, 14, 0);
const MON_09 = Date.UTC(2026, 10, 2, 4, 0);
const WED_11 = Date.UTC(2026, 9, 28, 6, 0);

test('outside_work_hours: вечер пятницы → утро понедельника, рабочее время — без сдвига', () => {
  const shift = quietShift(cfg('outside_work_hours'));
  assert.equal(shift(FRI_19), MON_09);
  assert.equal(shift(WED_11), WED_11);
});

test('none и установка без настроек — без сдвига', () => {
  assert.equal(quietShift(cfg('none'))(FRI_19), FRI_19);
  assert.equal(quietShift(null)(FRI_19), FRI_19);
});
