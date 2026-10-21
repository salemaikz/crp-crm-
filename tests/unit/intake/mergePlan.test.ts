// B9b: чистая часть слияния (docs/tasks-team-design.md §7.3): конфликты записей, заполнение только пустых полей,
// номера, план карточек и отпечаток. Синтетика: номера +7 709 …, «ТОО Пример».
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fillEmpty,
  hasBookingConflict,
  mergeConflicts,
  mergeFingerprint,
  planCards,
  planPhones,
  type MergeBookingRow,
  type MergeClientRow,
} from '../../../src/server/domain/intake/mergePlan';

const NOW = Date.UTC(2026, 9, 28, 6, 0);
const DAY = 86_400_000;

const client = (id: string, over: Partial<MergeClientRow> = {}): MergeClientRow => ({
  id,
  kind: 'company',
  name: 'ТОО Пример',
  legalForm: '',
  orgId: '',
  iinHmac: null,
  region: '',
  address: '',
  email: '',
  website: '',
  custom: {},
  mergedIntoId: null,
  updatedAt: NOW,
  ...over,
});

const booking = (id: string, clientId: string, over: Partial<MergeBookingRow> = {}): MergeBookingRow => ({
  id,
  clientId,
  kind: 'group',
  eventId: 'ev-1',
  eventTypeKey: 'seminar',
  status: 'registered',
  startsAt: NOW + DAY,
  ...over,
});

test('заполняются только пустые поля; ключи custom выжившего не перезаписываются', () => {
  const s = client('cl-s', { region: 'north', email: 'office@example.test', custom: { niche: 'trade' } });
  const l = client('cl-l', { region: 'south', address: 'ул. Синтетическая, 1', orgId: '000000000001', iinHmac: 'a'.repeat(64), custom: { niche: 'service', size: 'small' } });
  const { next, filled } = fillEmpty(s, l);
  assert.equal(next.region, 'north');
  assert.equal(next.email, 'office@example.test');
  assert.equal(next.address, 'ул. Синтетическая, 1');
  assert.equal(next.orgId, '000000000001');
  assert.equal(next.iinHmac, 'a'.repeat(64));
  assert.deepEqual(next.custom, { niche: 'trade', size: 'small' });
  assert.deepEqual(filled, ['orgId', 'iinHmac', 'address', 'custom']);
});

test('ничего не заполняется, если у проигравшего пусто или у выжившего уже есть', () => {
  const s = client('cl-s', { orgId: '000000000002', iinHmac: 'b'.repeat(64) });
  const l = client('cl-l', { orgId: '000000000003', iinHmac: 'c'.repeat(64) });
  const { next, filled } = fillEmpty(s, l);
  assert.deepEqual(filled, []);
  assert.equal(next.orgId, '000000000002');
  assert.equal(next.iinHmac, 'b'.repeat(64));
  assert.equal(next.custom, s.custom);
});

test('номера: совпавшие цифры удаляются, остальные переезжают', () => {
  const plan = planPhones(['77090000001', '77090000002'], [
    { id: 'ph-1', digits: '77090000002' },
    { id: 'ph-2', digits: '77090000003' },
  ]);
  assert.deepEqual(plan, { move: ['ph-2'], drop: ['ph-1'] });
});

test('конфликт: живые групповые записи обоих на одно мероприятие', () => {
  assert.equal(hasBookingConflict('s', 'l', [booking('b1', 's'), booking('b2', 'l')], NOW), true);
  // прошедшая, но с отметкой явки — тоже держит место (уникальный индекс)
  assert.equal(hasBookingConflict('s', 'l', [booking('b1', 's', { status: 'attended', startsAt: NOW - DAY }), booking('b2', 'l', { status: 'no_show', startsAt: NOW - DAY })], NOW), true);
  // отменённая не мешает
  assert.equal(hasBookingConflict('s', 'l', [booking('b1', 's', { status: 'cancelled' }), booking('b2', 'l')], NOW), false);
});

test('конфликт: будущие активные одного вида на разные мероприятия; разные виды или прошедшая — нет', () => {
  const s = booking('b1', 's', { eventId: 'ev-1' });
  assert.equal(hasBookingConflict('s', 'l', [s, booking('b2', 'l', { eventId: 'ev-2' })], NOW), true);
  assert.equal(hasBookingConflict('s', 'l', [s, booking('b2', 'l', { eventId: 'ev-2', eventTypeKey: 'consult', kind: 'individual' })], NOW), false);
  assert.equal(
    hasBookingConflict('s', 'l', [booking('b1', 's', { eventId: 'ev-1', status: 'registered', startsAt: NOW - DAY, kind: 'individual' }), booking('b2', 'l', { eventId: 'ev-2' })], NOW),
    false,
  );
  // записи одной стороны между собой не конфликтуют
  assert.equal(hasBookingConflict('s', 'l', [s, booking('b2', 's', { eventId: 'ev-2' })], NOW), false);
});

test('конфликты в порядке показа', () => {
  assert.deepEqual(mergeConflicts({ hiddenCards: true, bookingConflict: true }), ['booking_conflict', 'other_space']);
  assert.deepEqual(mergeConflicts({ hiddenCards: false, bookingConflict: false }), []);
});

test('карточки: у обоих — слияние, только у проигравшего — перенос, только у выжившего — ничего', () => {
  const plan = planCards('s', 'l', [
    { id: 'c1', spaceId: 'sp-1', clientId: 's', version: 0 },
    { id: 'c2', spaceId: 'sp-1', clientId: 'l', version: 3 },
    { id: 'c3', spaceId: 'sp-2', clientId: 'l', version: 0 },
    { id: 'c4', spaceId: 'sp-3', clientId: 's', version: 0 },
  ]);
  assert.deepEqual(plan, { merge: [{ spaceId: 'sp-1', survivorCardId: 'c1', loserCardId: 'c2' }], move: [{ spaceId: 'sp-2', cardId: 'c3' }] });
});

test('отпечаток не зависит от порядка и меняется от версии карточки, выбора и состава строк', () => {
  const base = {
    pairId: 'p1',
    survivorId: 's',
    ownerFrom: 'auto' as const,
    clients: [{ id: 's', updatedAt: 1 }, { id: 'l', updatedAt: 2 }],
    cards: [{ id: 'c1', version: 0 }, { id: 'c2', version: 1 }],
    rows: { calls: ['x', 'y'], notes: [] as string[] },
  };
  const fp = mergeFingerprint(base);
  assert.match(fp, /^[0-9a-f]{64}$/);
  assert.equal(mergeFingerprint({ ...base, clients: [...base.clients].reverse(), cards: [...base.cards].reverse(), rows: { notes: [], calls: ['y', 'x'] } }), fp);
  assert.notEqual(mergeFingerprint({ ...base, cards: [{ id: 'c1', version: 1 }, { id: 'c2', version: 1 }] }), fp);
  assert.notEqual(mergeFingerprint({ ...base, ownerFrom: 'other' }), fp);
  assert.notEqual(mergeFingerprint({ ...base, survivorId: 'l' }), fp);
  assert.notEqual(mergeFingerprint({ ...base, rows: { calls: ['x', 'y', 'z'], notes: [] } }), fp);
});
