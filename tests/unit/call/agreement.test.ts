// «Договорились — записать» в шторке (D-202): тело итога, «Запишу позже», разбор ответа сервера.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bookingAgreement, laterAgreement, parseAgreementResponse } from '../../../src/ui/call/agreement';
import { withUnsent } from '../../../src/ui/call/tally';
import { fromLocal } from '../../../src/ui/call/zoned';

const TZ = 'Asia/Almaty';
const CAL = { workdays: [1, 2, 3, 4, 5], holidays: [] };

test('запись из мастера: групповая — id мероприятия, индивидуальная — вид, день, время, направление', () => {
  const group = bookingAgreement('ct-1', { kind: 'group', eventTypeKey: 'br', event: { id: 'ev-1' } as never });
  assert.deepEqual(group, { contactId: 'ct-1', agreedDueAt: null, booking: { kind: 'group', eventId: 'ev-1' } });
  const solo = bookingAgreement(null, { kind: 'individual', eventTypeKey: 'bk', directionKey: 'tax', date: '2026-10-26', time: '09:45' });
  assert.deepEqual(solo, {
    contactId: null,
    agreedDueAt: null,
    booking: { kind: 'individual', eventTypeKey: 'bk', date: '2026-10-26', time: '09:45', directionKey: 'tax', resourceId: null },
  });
});

test('«Запишу позже»: следующий рабочий день 10:00 по времени установки, записи нет', () => {
  // пятница вечером → понедельник
  const fri = fromLocal('2026-10-23', '18:30', TZ);
  const a = laterAgreement('ct-1', { timeZone: TZ, calendar: CAL }, fri);
  assert.equal(a.booking, null);
  assert.equal(a.contactId, 'ct-1');
  assert.equal(a.agreedDueAt, fromLocal('2026-10-26', '10:00', TZ));
  // вторник утром → среда
  const tue = fromLocal('2026-10-20', '08:00', TZ);
  assert.equal(laterAgreement(null, { timeZone: TZ, calendar: CAL }, tue).agreedDueAt, fromLocal('2026-10-21', '10:00', TZ));
  // праздник в среду → четверг
  const hol = { workdays: [1, 2, 3, 4, 5], holidays: [{ date: '2026-10-21', kind: 'holiday' as const }] };
  assert.equal(laterAgreement(null, { timeZone: TZ, calendar: hol }, tue).agreedDueAt, fromLocal('2026-10-22', '10:00', TZ));
});

test('ответ итога: запись созданная и перенесённая', () => {
  const booking = { id: 'bk-1', version: 0, bookingDate: '2026-10-29', startTime: '15:00' };
  assert.deepEqual(parseAgreementResponse(200, { status: 'applied', bookingId: 'bk-1', booking, bookingAction: 'created' }), {
    kind: 'result',
    result: { ok: true, booking, action: 'created' },
  });
  const moved = parseAgreementResponse(200, { status: 'duplicate', bookingId: 'bk-1', booking, bookingAction: 'moved' });
  assert.equal(moved.kind === 'result' && moved.result.ok && moved.result.action, 'moved');
});

test('ответ итога: карточку передали — итог без записи', () => {
  assert.deepEqual(parseAgreementResponse(200, { status: 'fact_only', bookingId: null, booking: null }), { kind: 'fact_only' });
});

test('ответ итога: мест не осталось — альтернативы из тела; другие ошибки записи — по коду', () => {
  const full = parseAgreementResponse(409, { detail: 'event_full', alternatives: [{ id: 'ev-2' }] });
  assert.deepEqual(full, { kind: 'result', result: { ok: false, code: 'event_full', alternatives: [{ id: 'ev-2' }] } });
  assert.deepEqual(parseAgreementResponse(409, { detail: 'event_cancelled' }), { kind: 'result', result: { ok: false, code: 'event_cancelled' } });
});

test('ответ итога: отказ обзвона — причина для оператора; сбой сервера и сеть — повтор тем же ключом', () => {
  assert.deepEqual(parseAgreementResponse(400, { error: 'bad_request', code: 'lpr_required', field: 'lpr' }), { kind: 'rejected', code: 'lpr_required' });
  assert.deepEqual(parseAgreementResponse(409, { error: 'conflict', code: 'invalid_transition' }), { kind: 'rejected', code: 'invalid_transition' });
  assert.deepEqual(parseAgreementResponse(404, { error: 'not_found' }), { kind: 'rejected', code: 'not_found' });
  assert.deepEqual(parseAgreementResponse(401, null), { kind: 'login' });
  for (const status of [423, 429, 500, 503]) assert.deepEqual(parseAgreementResponse(status, null), { kind: 'result', result: { ok: false, code: 'network' } });
});

test('сводка «Сегодня»: серверные числа плюс итоги, ещё лежащие в outbox', () => {
  assert.deepEqual(withUnsent({ outcomes: 4, connected: 2, booked: 1 }, ['no_answer', 'agreed', 'callback']), { outcomes: 7, connected: 4, booked: 1 });
  assert.deepEqual(withUnsent({ outcomes: 0, connected: 0, booked: 0 }, []), { outcomes: 0, connected: 0, booked: 0 });
});
