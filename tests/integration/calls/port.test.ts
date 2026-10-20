// Порт карточки для записи с настоящей машиной состояний (docs/calls-design.md §9): события записи
// записывают карточку, задачи и сделки (тесты B2 используют поддельный порт и проверяют только вход).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { cancelBooking, markAttendance } from '../../../src/server/domain/booking/bookings';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { seedEvent } from '../booking/helpers';
import { SEED_NOW, callsDeps, cardOf, closeCallsWorld, openCallsWorld, outcomeReq, setCard, uuid, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
let rop: Viewer;
const clock = { now: SEED_NOW };
/** Пятница 30.10.2026 17:00 по Алматы: мероприятие 15:00 уже прошло. */
const AFTER_EVENT = Date.UTC(2026, 9, 30, 12, 0);

/** Клиент оператора A записан через итог «Договорились» на мероприятие ev-port. */
async function agreedWithBooking(card: string): Promise<string> {
  await setCard(db.sql, card, { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const r = await submitOutcome(
    deps,
    opA,
    outcomeReq({ cardId: card, outcomeKey: 'agreed', agreement: { contactId: null, agreedDueAt: null, booking: { kind: 'group', eventId: 'ev-port' } } }),
  );
  assert.ok(r.bookingId);
  return r.bookingId;
}

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  rop = await viewerOf(U.rop);
  await seedEvent(db.sql, { id: 'ev-port', date: '2026-10-30', time: '15:00' });
});
after(() => closeCallsWorld(db));

test('«не пришёл»: карточка → перезвон по настройкам, задача no_show:<bookingId> владельцу, сделка помечена к перезаписи', async () => {
  const bookingId = await agreedWithBooking('cd-a-80');
  clock.now = AFTER_EVENT;
  try {
    await markAttendance(deps.booking(), rop, { bookingId, opId: uuid(), version: 0, to: 'no_show' });
  } finally {
    clock.now = SEED_NOW;
  }
  const card = await cardOf(db.sql, 'cd-a-80');
  assert.equal(card.state, 'callback');
  assert.equal(card.nextCallAt, Date.UTC(2026, 10, 2, 5, 0), 'следующий рабочий день 10:00: понедельник 02.11');
  const t = await db.sql<{ assigneeUserId: string; sourceKey: string; source: string }>`SELECT assignee_user_id, source_key, source FROM tasks WHERE client_id = 'cl-a-80' AND status = 'open'`;
  assert.deepEqual(t.map((x) => [x.source, x.sourceKey, x.assigneeUserId]), [['no_show', `no_show:${bookingId}`, U.opA]]);
  const b = await db.sql<{ needsRebook: boolean }>`SELECT needs_rebook FROM deals WHERE id = (SELECT deal_id FROM bookings WHERE id = ${bookingId})`;
  assert.equal(b[0]?.needsRebook, true);
  assert.equal(await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE entity_id = 'cd-a-80' AND kind = 'no_show'`.then((r) => r[0]!.n), 1);
});

test('«пришёл»: сделка сдвигается на этап явки, владельцу — задача «записать на следующий шаг»', async () => {
  const bookingId = await agreedWithBooking('cd-a-81');
  clock.now = AFTER_EVENT;
  try {
    await markAttendance(deps.booking(), rop, { bookingId, opId: uuid(), version: 0, to: 'attended' });
  } finally {
    clock.now = SEED_NOW;
  }
  const d = await db.sql<{ stageKey: string }>`SELECT stage_key FROM deals WHERE card_id = 'cd-a-81'`;
  assert.deepEqual(d.map((x) => x.stageKey), ['attended']);
  const t = await db.sql<{ source: string; sourceKey: string; assigneeUserId: string }>`SELECT source, source_key, assignee_user_id FROM tasks WHERE client_id = 'cl-a-81' AND status = 'open'`;
  assert.deepEqual(t.map((x) => [x.source, x.sourceKey, x.assigneeUserId]), [['next_step', `next_step:${bookingId}`, U.opA]]);
  assert.equal((await cardOf(db.sql, 'cd-a-81')).state, 'agreed');
});

test('отмена записи клиентом: карточка → перезвон сразу, задача «записать заново»', async () => {
  const bookingId = await agreedWithBooking('cd-a-82');
  await cancelBooking(deps.booking(), rop, { bookingId, opId: uuid(), version: 0, reason: 'client' });
  const card = await cardOf(db.sql, 'cd-a-82');
  assert.equal(card.state, 'callback');
  assert.equal(card.nextCallAt, SEED_NOW);
  const t = await db.sql<{ source: string; sourceKey: string }>`SELECT source, source_key FROM tasks WHERE client_id = 'cl-a-82' AND status = 'open'`;
  assert.deepEqual(t.map((x) => [x.source, x.sourceKey]), [['rebook', `rebook:${bookingId}`]]);
});

test('порт без изменения версии при отказе ядра: карточка не в «Договорились» — событие отклонено, запись действует', async () => {
  const bookingId = await agreedWithBooking('cd-a-83');
  await setCard(db.sql, 'cd-a-83', { state: 'callback' });
  const before = await cardOf(db.sql, 'cd-a-83');
  clock.now = AFTER_EVENT;
  try {
    const v = await markAttendance(deps.booking(), rop, { bookingId, opId: uuid(), version: 0, to: 'attended' });
    assert.equal(v.status, 'attended');
  } finally {
    clock.now = SEED_NOW;
  }
  assert.deepEqual(await cardOf(db.sql, 'cd-a-83'), before);
});
