// № 33 «Выход из «Договорились» без звонка» (C6, pipeline-v2 §3.3): явка и переход в одной транзакции, повтор opId,
// версия, смена статуса записи, откат явки при сбое ядра, охват (чужое = 404), директор — 423, флаг — 404.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { actAs } from '../../isolation/harness/actors';
import { POST as movePost } from '../../../src/app/api/cards/[id]/move/route';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U, cardOf, clientOf } from '../../isolation/harness/seed';
import { seedDeal } from '../deals/helpers';
import { seedBookings, seedEvent } from '../booking/helpers';
import { DAY, HOUR, closeBoardWorld, openBoardWorld } from './boardWorld';

let db: TestDb;
before(async () => {
  db = await openBoardWorld();
});
after(() => closeBoardWorld(db));

const ORIGIN = 'http://crm.test';
async function post(userId: string, id: string, payload: unknown): Promise<Response> {
  actAs(userId);
  const req = new Request(`${ORIGIN}/api/cards/${id}/move`, { method: 'POST', headers: { host: 'crm.test', origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return movePost(req, { params: Promise.resolve({ id }) });
}

const uuid = (): string => crypto.randomUUID();
const card = async (id: string) => (await db.sql<{ state: string; version: number; nextCallAt: number | null; callbackReason: string; callbackTouches: number }>`SELECT state, version, next_call_at, callback_reason, callback_touches FROM cards WHERE id = ${id}`)[0]!;
const bookingStatus = async (id: string) => (await db.sql<{ status: string; cancelReason: string }>`SELECT status, cancel_reason FROM bookings WHERE id = ${id}`)[0]!;
const dealRow = async (id: string) => (await db.sql<{ status: string; stageKey: string; lostReasonCode: string; needsRebook: boolean }>`SELECT status, stage_key, lost_reason_code, needs_rebook FROM deals WHERE id = ${id}`)[0]!;
const tasksOf = async (client: string) => db.sql<{ source: string; sourceKey: string; status: string }>`SELECT source, source_key, status FROM tasks WHERE client_id = ${client} ORDER BY source_key`;
const snap = async () => JSON.stringify(await db.sql`SELECT * FROM cards ORDER BY id`) + JSON.stringify(await db.sql`SELECT * FROM bookings ORDER BY id`) + JSON.stringify(await db.sql`SELECT * FROM deals ORDER BY id`) + JSON.stringify(await db.sql`SELECT id FROM booking_history ORDER BY id`);

/** Карточка оператора A в «Договорились» с открытой сделкой и записью: прошедшей (`past`) или будущей. */
async function setup(n: number, when: 'past' | 'future', over: { dealStatus?: 'open' | 'lost'; booking?: 'registered' | 'attended' } = {}): Promise<{ card: string; client: string; deal: string; booking: string }> {
  const c = cardOf('a', n);
  const cl = clientOf('a', n);
  await db.sql`UPDATE cards SET state = 'agreed', attempts = 0, next_call_at = NULL WHERE id = ${c}`;
  await seedEvent(db.sql, { id: `ev-mv-${n}`, date: '2026-10-28', time: '09:00' });
  await db.sql`UPDATE events SET starts_at = ${Date.now() + (when === 'past' ? -4 * HOUR : 2 * DAY)} WHERE id = ${`ev-mv-${n}`}`;
  const [booking] = await seedBookings(db.sql, `ev-mv-${n}`, [{ client: cl, card: c }], { bookedBy: U.opA, ...(over.booking ? { status: over.booking } : {}) });
  const deal = `dl-mv-${n}`;
  await seedDeal(db.sql, { id: deal, client: cl, card: c, stage: 'booked', owner: U.opA, status: over.dealStatus ?? 'open' });
  await db.sql`UPDATE bookings SET deal_id = ${deal} WHERE id = ${booking!}`;
  return { card: c, client: cl, deal, booking: booking! };
}

const AT = () => Date.now() + 2 * DAY;
const cb = (version: number, over: Record<string, unknown> = {}) => ({ opId: uuid(), version, to: 'callback', reasonCode: 'think', callbackAt: AT(), callbackPrecision: 'time', ...over });

test('неявка → перезвон: явка, состояние, задача no_show, значок и срок в одной транзакции; повтор opId — тот же ответ 200', async () => {
  const s = await setup(30, 'past');
  const body = cb((await card(s.card)).version, { attendance: { bookingId: s.booking, to: 'no_show' } });
  const r = await post(U.rop, s.card, body);
  assert.equal(r.status, 200);
  const j = (await r.json()) as { card: { state: string; version: number } };
  assert.equal(j.card.state, 'callback');
  const c = await card(s.card);
  assert.deepEqual([c.state, c.callbackReason, c.callbackTouches], ['callback', 'think', 1]);
  assert.equal(c.nextCallAt, body.callbackAt);
  assert.equal((await bookingStatus(s.booking)).status, 'no_show');
  assert.equal((await dealRow(s.deal)).needsRebook, true);
  const t = await tasksOf(s.client);
  assert.deepEqual(t.filter((x) => x.status === 'open').map((x) => x.sourceKey), [`no_show:${s.booking}`]);
  // автор явки — РОП, строка истории с id = opId
  const h = await db.sql<{ actorId: string }>`SELECT actor_id FROM booking_history WHERE id = ${body.opId}`;
  assert.equal(h[0]?.actorId, U.rop);

  const before = await snap();
  const again = await post(U.rop, s.card, body);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), j);
  assert.equal(await snap(), before, 'повтор ничего не меняет');
});

test('«Пришёл» → перезвон: сделка вперёд, запись attended; оператор без права явки — 403 attendance_forbidden и ничего не меняется', async () => {
  const s = await setup(31, 'past');
  const v = (await card(s.card)).version;
  const before = await snap();
  const denied = await post(U.opA, s.card, cb(v, { attendance: { bookingId: s.booking, to: 'attended' } }));
  assert.equal(denied.status, 403);
  assert.equal(((await denied.json()) as { detail?: string }).detail, 'attendance_forbidden');
  assert.equal(await snap(), before);

  const ok = await post(U.rop, s.card, cb(v, { attendance: { bookingId: s.booking, to: 'attended' } }));
  assert.equal(ok.status, 200);
  assert.equal((await bookingStatus(s.booking)).status, 'attended');
  const d = await dealRow(s.deal);
  assert.notEqual(d.stageKey, 'booked');
  assert.equal(d.status, 'open');
  assert.equal((await card(s.card)).state, 'callback');
});

test('сбой на шаге ядра откатывает явку: срок в прошлом → 400, запись и карточка не тронуты', async () => {
  const s = await setup(32, 'past');
  const before = await snap();
  const r = await post(U.rop, s.card, cb((await card(s.card)).version, { callbackAt: Date.now() - 3 * DAY, attendance: { bookingId: s.booking, to: 'no_show' } }));
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { error: string }).error, 'callback_in_past');
  assert.equal(await snap(), before);
  assert.equal((await bookingStatus(s.booking)).status, 'registered');
});

test('устаревшая версия — 409 card_changed без отметки явки', async () => {
  const s = await setup(33, 'past');
  const before = await snap();
  const r = await post(U.rop, s.card, cb(99, { attendance: { bookingId: s.booking, to: 'no_show' } }));
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'card_changed');
  assert.equal(await snap(), before);
});

test('запись уже в другом конечном статусе — 409 attendance_changed; в том же — changed:false, переход проходит', async () => {
  const s = await setup(34, 'past', { booking: 'attended' });
  const v = (await card(s.card)).version;
  const before = await snap();
  const bad = await post(U.rop, s.card, cb(v, { attendance: { bookingId: s.booking, to: 'no_show' } }));
  assert.equal(bad.status, 409);
  assert.equal(((await bad.json()) as { detail?: string }).detail, 'attendance_changed');
  assert.equal(await snap(), before);

  const same = await post(U.rop, s.card, cb(v, { attendance: { bookingId: s.booking, to: 'attended' } }));
  assert.equal(same.status, 200);
  assert.equal((await card(s.card)).state, 'callback');
});

test('без явки: будущая запись отменена с причиной client, значок «нужна перезапись», задача перезвона', async () => {
  const s = await setup(35, 'future');
  const r = await post(U.opA, s.card, cb((await card(s.card)).version));
  assert.equal(r.status, 200);
  const b = await bookingStatus(s.booking);
  assert.deepEqual([b.status, b.cancelReason], ['cancelled', 'client']);
  assert.equal((await dealRow(s.deal)).needsRebook, true);
  assert.deepEqual((await tasksOf(s.client)).filter((x) => x.status === 'open').map((x) => x.source), ['callback']);
});

test('«Пришёл» → «Списан»: сделка проиграна причиной write_off, без продвижения вперёд; причина не из группы — 400', async () => {
  const s = await setup(36, 'past');
  const v = (await card(s.card)).version;
  const bad = await post(U.rop, s.card, { opId: uuid(), version: v, to: 'written_off', reasonCode: 'think', attendance: { bookingId: s.booking, to: 'attended' } });
  assert.equal(bad.status, 400);
  assert.equal((await bookingStatus(s.booking)).status, 'registered');
  const r = await post(U.rop, s.card, { opId: uuid(), version: v, to: 'written_off', reasonCode: 'unreachable', attendance: { bookingId: s.booking, to: 'attended' } });
  assert.equal(r.status, 200);
  assert.equal((await card(s.card)).state, 'written_off');
  const d = await dealRow(s.deal);
  assert.deepEqual([d.status, d.lostReasonCode], ['lost', 'no_show_unreachable']);
});

test('в «Не заинтересован»: сделка проиграна той же причиной, будущая запись отменена', async () => {
  const s = await setup(37, 'future');
  const r = await post(U.opA, s.card, { opId: uuid(), version: (await card(s.card)).version, to: 'not_interested', reasonCode: 'expensive' });
  assert.equal(r.status, 200);
  assert.equal((await card(s.card)).state, 'not_interested');
  const d = await dealRow(s.deal);
  assert.deepEqual([d.status, d.lostReasonCode], ['lost', 'expensive']);
  assert.equal((await bookingStatus(s.booking)).status, 'cancelled');
});

test('охват: чужая карточка и несуществующая — 404 с одним телом; запись клиента B и запись не открытой сделки — 404; директор — 423', async () => {
  const foreign = cardOf('b', 41);
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = ${foreign}`;
  const missing = await post(U.opA, 'zz-no-such-card', cb(0));
  const missingText = await missing.text();
  const f = await post(U.opA, foreign, cb(0));
  assert.equal(f.status, 404);
  assert.equal(await f.text(), missingText);

  // своя карточка, запись клиента B (его сделка открыта): для оператора A записи нет
  const own = await setup(38, 'past');
  await seedEvent(db.sql, { id: 'ev-mv-b', date: '2026-10-28', time: '09:00' });
  await db.sql`UPDATE events SET starts_at = ${Date.now() - 4 * HOUR} WHERE id = 'ev-mv-b'`;
  const [bB] = await seedBookings(db.sql, 'ev-mv-b', [{ client: clientOf('b', 41), card: foreign }], { bookedBy: U.opB });
  await seedDeal(db.sql, { id: 'dl-mv-b', client: clientOf('b', 41), card: foreign, stage: 'booked', owner: U.opB });
  await db.sql`UPDATE bookings SET deal_id = 'dl-mv-b' WHERE id = ${bB!}`;
  const missingBooking = await post(U.rop, own.card, cb((await card(own.card)).version, { attendance: { bookingId: 'bk-нет', to: 'attended' } }));
  assert.equal(missingBooking.status, 404);
  const missingBookingText = await missingBooking.text();
  const before = await snap();
  const viaB = await post(U.rop, own.card, cb((await card(own.card)).version, { attendance: { bookingId: bB!, to: 'attended' } }));
  assert.equal(viaB.status, 404);
  assert.equal(await viaB.text(), missingBookingText);
  assert.equal(await snap(), before);

  // запись своей карточки, но сделка закрыта
  const closed = await setup(39, 'past', { dealStatus: 'lost' });
  const v = await post(U.rop, closed.card, cb((await card(closed.card)).version, { attendance: { bookingId: closed.booking, to: 'attended' } }));
  assert.equal(v.status, 404);
  assert.equal(await v.text(), missingBookingText);
  assert.equal((await bookingStatus(closed.booking)).status, 'registered');

  const snapBefore = await snap();
  const d = await post(U.director, own.card, cb((await card(own.card)).version));
  assert.equal(d.status, 423);
  assert.equal(await snap(), snapBefore);
});

test('выключенный OP_BOARD: маршрута нет — 404, карточка не тронута', async () => {
  const s = await setup(40, 'future');
  process.env['FEATURE_OP_BOARD'] = '0';
  try {
    const r = await post(U.opA, s.card, cb((await card(s.card)).version));
    assert.equal(r.status, 404);
  } finally {
    process.env['FEATURE_OP_BOARD'] = '1';
  }
  assert.equal((await card(s.card)).state, 'agreed');
});

test('не из «Договорились» — 409 invalid_state', async () => {
  const c = cardOf('a', 42);
  await db.sql`UPDATE cards SET state = 'callback' WHERE id = ${c}`;
  const r = await post(U.opA, c, cb((await card(c)).version));
  assert.equal(r.status, 409);
  assert.equal(((await r.json()) as { error: string }).error, 'invalid_state');
});
