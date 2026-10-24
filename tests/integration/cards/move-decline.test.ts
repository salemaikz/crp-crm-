// № 33 с причиной «не придёт» (booking.confirmCall.declineReason, D-355): причина применима, только пока у клиента есть
// будущая активная запись подтверждаемого вида. Выход — в «Перезвон», запись отменена (client), сделка «нужна перезапись»,
// в ленте reasonCode; повтор opId ничего не меняет; без записи — 400 reason_not_applicable; чужая карточка — 404.
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
const DECLINE = 'wont_come_br';
const uuid = (): string => crypto.randomUUID();

async function post(userId: string, id: string, payload: unknown): Promise<Response> {
  actAs(userId);
  const req = new Request(`${ORIGIN}/api/cards/${id}/move`, { method: 'POST', headers: { host: 'crm.test', origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return movePost(req, { params: Promise.resolve({ id }) });
}

const card = async (id: string) => (await db.sql<{ state: string; version: number; callbackReason: string; callbackTouches: number }>`SELECT state, version, callback_reason, callback_touches FROM cards WHERE id = ${id}`)[0]!;
const bookingRow = async (id: string) => (await db.sql<{ status: string; cancelReason: string }>`SELECT status, cancel_reason FROM bookings WHERE id = ${id}`)[0]!;
const dealRow = async (id: string) => (await db.sql<{ needsRebook: boolean }>`SELECT needs_rebook FROM deals WHERE id = ${id}`)[0]!;
const snap = async () =>
  JSON.stringify(await db.sql`SELECT * FROM cards ORDER BY id`) + JSON.stringify(await db.sql`SELECT * FROM bookings ORDER BY id`) + JSON.stringify(await db.sql`SELECT id FROM booking_history ORDER BY id`) + JSON.stringify(await db.sql`SELECT id FROM client_events ORDER BY id`);

/** Карточка оператора A в «Договорились»: открытая сделка и запись вида `type` в будущем (`future`) или в прошлом. */
async function setup(n: number, opts: { type?: string; future?: boolean; withBooking?: boolean } = {}): Promise<{ card: string; client: string; deal: string; booking: string | null }> {
  const c = cardOf('a', n);
  const cl = clientOf('a', n);
  await db.sql`UPDATE cards SET state = 'agreed', attempts = 0, next_call_at = NULL WHERE id = ${c}`;
  const deal = `dl-dc-${n}`;
  await seedDeal(db.sql, { id: deal, client: cl, card: c, stage: 'booked', owner: U.opA });
  if (opts.withBooking === false) return { card: c, client: cl, deal, booking: null };
  await seedEvent(db.sql, { id: `ev-dc-${n}`, date: '2026-10-28', time: '09:00', type: opts.type ?? 'br' });
  await db.sql`UPDATE events SET starts_at = ${Date.now() + (opts.future === false ? -4 * HOUR : 2 * DAY)} WHERE id = ${`ev-dc-${n}`}`;
  const [booking] = await seedBookings(db.sql, `ev-dc-${n}`, [{ client: cl, card: c }], { bookedBy: U.opA });
  await db.sql`UPDATE bookings SET deal_id = ${deal}, starts_at = (SELECT starts_at FROM events WHERE id = ${`ev-dc-${n}`}) WHERE id = ${booking!}`;
  return { card: c, client: cl, deal, booking: booking! };
}

const decline = (version: number, over: Record<string, unknown> = {}) => ({ opId: uuid(), version, to: 'callback', reasonCode: DECLINE, callbackAt: Date.now() + 2 * DAY, callbackPrecision: 'day', ...over });

test('«не придёт»: Перезвон с причиной declineReason, касание +1, запись отменена (client), «нужна перезапись», reasonCode в ленте', async () => {
  const s = await setup(40);
  const body = decline((await card(s.card)).version);
  const r = await post(U.opA, s.card, body);
  assert.equal(r.status, 200, await r.clone().text());
  const j = (await r.json()) as { card?: unknown; state?: string };
  const c = await card(s.card);
  assert.deepEqual([c.state, c.callbackReason, c.callbackTouches], ['callback', DECLINE, 1]);
  assert.deepEqual(await bookingRow(s.booking!), { status: 'cancelled', cancelReason: 'client' });
  assert.equal((await dealRow(s.deal)).needsRebook, true);
  const feed = await db.sql<{ data: Record<string, unknown> }>`SELECT data FROM client_events WHERE client_id = ${s.client} AND kind = 'card.state' AND ref_id = ${body.opId}`;
  assert.equal(feed.length, 1);
  assert.deepEqual(feed[0]!.data, { fromState: 'agreed', toState: 'callback', cause: 'agreed_exit', reasonCode: DECLINE });

  // повтор opId: тот же ответ, вторая отмена не пишется
  const before = await snap();
  const again = await post(U.opA, s.card, body);
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), j);
  assert.equal(await snap(), before, 'повтор ничего не меняет');
});

test('без будущей записи подтверждаемого вида — 400 reason_not_applicable, ничего не меняется', async () => {
  const cases: Array<[string, Awaited<ReturnType<typeof setup>>]> = [
    ['нет записи', await setup(41, { withBooking: false })],
    ['запись в прошлом', await setup(42, { future: false })],
    ['будущая запись другого вида', await setup(43, { type: 'bk' })],
  ];
  for (const [label, s] of cases) {
    const before = await snap();
    const r = await post(U.opA, s.card, decline((await card(s.card)).version));
    assert.equal(r.status, 400, label);
    assert.match(await r.text(), /reason_not_applicable/, label);
    assert.equal(await snap(), before, `${label}: ничего не изменилось`);
  }
});

test('другая причина перезвона без записи проходит (контроль: проверка касается только declineReason)', async () => {
  const s = await setup(44, { withBooking: false });
  const r = await post(U.opA, s.card, decline((await card(s.card)).version, { reasonCode: 'think' }));
  assert.equal(r.status, 200, await r.clone().text());
  assert.equal((await card(s.card)).callbackReason, 'think');
});

test('чужая карточка с причиной declineReason — 404 тем же телом, что и несуществующая (проверка применимости после охвата)', async () => {
  const foreign = await setup(45, { withBooking: false });
  await db.sql`UPDATE cards SET owner_user_id = ${U.opB} WHERE id = ${foreign.card}`;
  const before = await snap();
  const f = await post(U.opA, foreign.card, decline(0));
  const m = await post(U.opA, 'zz-no-such-card', decline(0));
  assert.equal(f.status, 404);
  assert.equal((await f.text()).replaceAll(foreign.card, '<id>'), (await m.text()).replaceAll('zz-no-such-card', '<id>'));
  assert.equal(await snap(), before);
});
