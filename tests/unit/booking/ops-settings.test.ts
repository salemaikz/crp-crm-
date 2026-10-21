// Срез настроек дежурства и гостя без записи (B4): пресеты, источник walk_in, лимит проверок номера, срок шага.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '../../../packages/core/src';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { parseWalkInSettings, resolveStepDue } from '../../../src/server/domain/booking/opsSettings';
import { assembleChain } from '../config/helpers';

const CAL = time.createWorkCalendar({
  timezone: 'Asia/Almaty',
  workdays: [1, 2, 3, 4, 5],
  workHours: { start: '09:00', end: '18:00' },
  callWindow: { start: '09:00', end: '18:00' },
  holidays: [],
});

function settingsOf(chain: Parameters<typeof assembleChain>[0]) {
  const a = assembleChain(chain);
  return parseWalkInSettings({ spaceId: 'sp-test', global: a.global, space: a.spaces.sales });
}

test('пресеты base+kz+consulting-sales: источник walk_in, дежурный по умолчанию, лимит проверок и автонеявка', () => {
  const s = settingsOf(['base', 'kz', 'consulting-sales']);
  assert.equal(s.walkInSourceKey, 'walk_in');
  assert.equal(s.dutyDefaultRole, 'manager');
  assert.equal(s.phoneProbesPerDay, 20);
  assert.equal(s.autoNoShowWorkdays, 2);
  assert.equal(s.phoneRules.country, 'KZ');
  assert.ok(s.legalForms.length > 0);
  assert.equal(s.grey.mode, 'suggest');
});

test('только base: источника walk_in нет — ключ null (гость → walk_in_source_missing)', () => {
  assert.equal(settingsOf(['base']).walkInSourceKey, null);
});

test('сломанный документ — invalid_settings', () => {
  assert.throws(() => parseWalkInSettings({ spaceId: 'x', global: {}, space: {} }), (e: unknown) => e instanceof BookingDomainError && e.code === 'invalid_settings');
});

test('resolveStepDue: сдвиг +Nh/+Nm и следующий рабочий день в HH:MM, неверный формат — ошибка', () => {
  const thu = Date.parse('2026-10-29T11:00:00+05:00');
  assert.equal(resolveStepDue('+2h', thu, CAL), thu + 2 * 3_600_000);
  assert.equal(resolveStepDue('+30m', thu, CAL), thu + 30 * 60_000);
  assert.equal(resolveStepDue('nextWorkday@10:00', thu, CAL), Date.parse('2026-10-30T10:00:00+05:00'));
  // пятница → понедельник
  assert.equal(resolveStepDue('nextWorkday@10:00', Date.parse('2026-10-30T11:00:00+05:00'), CAL), Date.parse('2026-11-02T10:00:00+05:00'));
  assert.throws(() => resolveStepDue('завтра', thu, CAL), (e: unknown) => e instanceof BookingDomainError);
});
