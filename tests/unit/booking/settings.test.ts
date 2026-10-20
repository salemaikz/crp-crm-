// Разбор настроек записи: пресеты base и consulting-sales, накладка клиента, календарь, ошибки схемы.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBookingSettings } from '../../../src/server/domain/booking/settings';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { assembleChain } from '../config/helpers';

const SPACE = 'sp-test';

function settingsOf(chain: Parameters<typeof assembleChain>[0], withRoles = false) {
  const a = assembleChain(chain, withRoles);
  return parseBookingSettings({ spaceId: SPACE, global: a.global, space: a.spaces.sales });
}

test('base: видов мероприятий нет, сделку запись не создаёт (воронка manual)', () => {
  const s = settingsOf(['base']);
  assert.equal(s.spaceId, SPACE);
  assert.deepEqual(s.groupTypes, []);
  assert.equal(s.deals, null);
  assert.equal(s.horizonDays, 28);
  assert.equal(s.groupOptions, 3);
  assert.equal(s.operatorErrorWindowMin, 10);
});

test('consulting-sales: воронка с createDealOn agreed даёт этапы записи и явки', () => {
  const s = settingsOf(['base', 'consulting-sales']);
  assert.deepEqual(s.deals, { pipelineKey: 'sales', onAgreedStageKey: 'booked', onAttendedStageKey: 'attended' });
});

test('накладка клиента: групповой вид и стартовая серия берутся из настроек', () => {
  const s = settingsOf(['base', 'kz', 'consulting-sales', 'crp'], true);
  assert.equal(s.groupTypes.length, 1, 'индивидуальный вид в групповые не входит');
  assert.deepEqual(s.groupTypes[0], { key: 'br', capacity: 30, durationMin: 180 });
  assert.equal(s.seedSeries.length, 1);
  assert.deepEqual(s.seedSeries[0], { key: 'br_thursday', eventTypeKey: 'br', weekday: 4, startTime: '15:00', durationMin: 180, location: '', format: 'offline', capacity: 30 });
  assert.equal(s.timeZone, 'Asia/Almaty');
});

test('календарь настроек: праздник — нерабочий день, суббота — нерабочий', () => {
  const s = settingsOf(['base', 'kz']);
  assert.equal(s.calendar.isWorkday('2026-10-28'), true, 'среда');
  assert.equal(s.calendar.isWorkday('2026-10-31'), false, 'суббота');
  assert.equal(s.calendar.isWorkday('2026-10-25'), false, 'День Республики, воскресенье');
});

test('сломанный документ → invalid_settings, а не неопределённое поведение', () => {
  const a = assembleChain(['base']);
  const bad = { ...(a.spaces.sales as Record<string, unknown>), booking: { eventTypes: 'нет' } };
  assert.throws(
    () => parseBookingSettings({ spaceId: SPACE, global: a.global, space: bad }),
    (e: unknown) => e instanceof BookingDomainError && e.code === 'invalid_settings',
  );
  assert.throws(
    () => parseBookingSettings({ spaceId: SPACE, global: {}, space: a.spaces.sales }),
    (e: unknown) => e instanceof BookingDomainError && e.code === 'invalid_settings',
  );
});
