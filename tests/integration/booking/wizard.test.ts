// Мастер записи одним чтением (B3a, docs/booking-wizard-design.md §6.2): режим по состоянию карточки, вкладки,
// предложения по видам, охват («чужая карточка = несуществующая»).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, NotFoundError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { createBooking } from '../../../src/server/domain/booking/bookings';
import { getBookingWizard } from '../../../src/server/domain/booking/wizard';
import type { BookingDeps, BookingSettings } from '../../../src/server/domain/booking/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { CRP_CATALOG, SEED_NOW, closeWorld, fakeCardPort, makeDeps, openBookingWorld, seedBookings, seedEvent, setCardState, testSettings, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let opA: Viewer;
let rop: Viewer;
let consultant: Viewer;
const clock = { now: SEED_NOW };

before(async () => {
  db = await openBookingWorld();
  const settings: BookingSettings = testSettings({
    catalog: {
      ...CRP_CATALOG,
      eventTypes: [
        { key: 'br', behavior: 'group', label: { ru: 'Бизнес-разбор', kk: 'Іскерлік талдау' }, short: { ru: 'Р1', kk: 'Р1-kk' }, durationMin: 180, directions: [] },
        { key: 'bk', behavior: 'individual', label: { ru: 'Консультация' }, short: { ru: 'К1' }, durationMin: 45, directions: ['marketing', 'other'] },
      ],
    },
  });
  deps = makeDeps(clock, fakeCardPort(), settings);
  opA = await viewerOf(U.opA);
  rop = await viewerOf(U.rop);
  consultant = await viewerOf(U.consultant);
  for (const [id, date] of [['w1', '2026-10-29'], ['w2', '2026-11-05'], ['w3', '2026-11-12'], ['w4', '2026-11-19']] as const) await seedEvent(db.sql, { id, date, time: '15:00', capacity: id === 'w1' ? 1 : 30 });
  await seedBookings(db.sql, 'w1', [{ client: 'cl-b-70', card: 'cd-b-70' }]);
});
after(() => closeWorld(db));

test('mode: agreed → direct; callback → outcome_required (предложения всё равно есть для шторки)', async () => {
  const direct = await getBookingWizard(deps, opA, { cardId: 'cd-a-1', locale: 'ru' });
  assert.equal(direct.mode, 'direct');
  assert.equal(direct.clientId, 'cl-a-1');
  assert.ok(direct.clientName.length > 0);
  await setCardState(db.sql, 'cd-a-2', 'callback');
  const later = await getBookingWizard(deps, opA, { cardId: 'cd-a-2', locale: 'ru' });
  assert.equal(later.mode, 'outcome_required');
  assert.ok(later.groupOffers[0]!.options.length > 0);
  await setCardState(db.sql, 'cd-a-2', 'agreed');
  await setCardState(db.sql, 'cd-a-3', 'client');
  assert.equal((await getBookingWizard(deps, opA, { cardId: 'cd-a-3', locale: 'ru' })).mode, 'direct');
});

test('вкладки в порядке настроек; подписи по языку: ru и kz → kk с запасом ru', async () => {
  const ru = await getBookingWizard(deps, opA, { cardId: 'cd-a-1', locale: 'ru' });
  assert.deepEqual(ru.types.map((t) => [t.key, t.label, t.short]), [['br', 'Бизнес-разбор', 'Р1'], ['bk', 'Консультация', 'К1']]);
  const kz = await getBookingWizard(deps, opA, { cardId: 'cd-a-1', locale: 'kz' });
  assert.deepEqual(kz.types.map((t) => [t.label, t.short]), [['Іскерлік талдау', 'Р1-kk'], ['Консультация', 'К1']]);
  assert.equal(ru.timeZone, 'Asia/Almaty');
  assert.equal(ru.today, '2026-10-28');
});

test('БР: ближайшие с местами (полное пропущено), не больше groupOptions; current при записи', async () => {
  const v = await getBookingWizard(deps, opA, { cardId: 'cd-a-4', locale: 'ru' });
  const offer = v.groupOffers.find((o) => o.eventTypeKey === 'br')!;
  assert.deepEqual(offer.options.map((o) => o.id), ['w2', 'w3', 'w4'], 'w1 заполнено, показано groupOptions = 3');
  assert.equal(offer.current, null);
  await createBooking(deps, opA, { kind: 'group', requestId: uuid(), clientId: 'cl-a-4', eventId: 'w2', contactId: null });
  const after = await getBookingWizard(deps, opA, { cardId: 'cd-a-4', locale: 'ru' });
  assert.equal(after.groupOffers[0]!.current?.eventId, 'w2');
});

test('БК: дни полосы, направления вида в порядке настроек, current после заявки', async () => {
  const v = await getBookingWizard(deps, opA, { cardId: 'cd-a-5', locale: 'ru' });
  const offer = v.consultOffers[0]!;
  assert.equal(offer.eventTypeKey, 'bk');
  assert.deepEqual(offer.directions.map((d) => d.key), ['marketing', 'other'], 'только разрешённые виду');
  assert.equal(offer.days.length, 7);
  assert.equal(offer.days[0]!.date, '2026-10-28');
  assert.equal(offer.days[0]!.times[0], '11:15', 'сегодня — только будущие слоты (сейчас 11:00)');
  assert.equal(offer.current, null);
  await createBooking(deps, opA, { kind: 'individual', requestId: uuid(), clientId: 'cl-a-5', eventTypeKey: 'bk', date: '2026-10-29', time: '09:00', directionKey: 'other', resourceId: null, contactId: null });
  const again = await getBookingWizard(deps, opA, { cardId: 'cd-a-5', locale: 'ru' });
  assert.equal(again.consultOffers[0]!.current?.startTime, '09:00');
});

test('направление не из списка вида отклоняется записью', async () => {
  await assert.rejects(
    createBooking(deps, opA, { kind: 'individual', requestId: uuid(), clientId: 'cl-a-6', eventTypeKey: 'bk', date: '2026-10-29', time: '09:00', directionKey: 'training', resourceId: null, contactId: null }),
    (e: unknown) => e instanceof BadRequestError,
  );
});

test('охват: чужая карточка и несуществующая — одинаковый NotFoundError; консультант и без права — тоже 404', async () => {
  await assert.rejects(getBookingWizard(deps, opA, { cardId: 'cd-b-1', locale: 'ru' }), NotFoundError);
  await assert.rejects(getBookingWizard(deps, opA, { cardId: 'нет-такой', locale: 'ru' }), NotFoundError);
  await assert.rejects(getBookingWizard(deps, consultant, { cardId: 'cd-a-1', locale: 'ru' }), NotFoundError);
  const ropView = await getBookingWizard(deps, rop, { cardId: 'cd-a-1', locale: 'ru' });
  assert.equal(ropView.cardId, 'cd-a-1', 'РОП видит карточки оператора');
});
