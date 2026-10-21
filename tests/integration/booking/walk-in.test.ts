// Гость без записи (B4, §2.6, D-241): найден / новый, повторы, счётчик проверок номера, стоп-лист, вместимость.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../../src/server/access';
import type { Viewer } from '../../../src/server/access/types';
import { BookingDomainError } from '../../../src/server/domain/booking/errors';
import { registerWalkIn } from '../../../src/server/domain/booking/walkIn';
import type { BookingDeps } from '../../../src/server/domain/booking/types';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U, SPACE, phoneOf } from '../../isolation/harness/seed';
import { SEED_NOW, clientsOf, closeDutyWorld, fakeCardPort, makeDeps, openDutyWorld, seedBookings, seedEvent, setCardState, uuid, viewerOf } from './helpers';

let db: TestDb;
let deps: BookingDeps;
let duty: Viewer;
let opA: Viewer;
const port = fakeCardPort();

const failsWith = (code: string) => (e: unknown) => e instanceof BookingDomainError && e.code === code;
/** Номер синтетики оператора A в виде, как его вводит дежурный. */
const dialA = (i: number) => `+7 ${phoneOf('a', i).slice(1, 4)} ${phoneOf('a', i).slice(4, 7)} ${phoneOf('a', i).slice(7, 9)} ${phoneOf('a', i).slice(9)}`;
const guest = (eventId: string, phone: string, over: { name?: string; company?: string; requestId?: string } = {}) => ({
  eventId,
  requestId: over.requestId ?? uuid(),
  phone,
  name: over.name ?? 'Гость Синтетик',
  company: over.company ?? '',
});
const probes = async () => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${U.duty}`)[0]!.n;
const countClients = async () => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM clients`)[0]!.n;
const bookingOf = async (id: string) => (await db.sql<{ status: string; via: string; bookedByUserId: string | null; responsibleUserId: string | null; clientId: string; eventId: string }>`SELECT * FROM bookings WHERE id = ${id}`)[0]!;
/** Запись попытки гостя: ответ дежурному её id не несёт, тест берёт его из истории (id строки = ключ попытки). */
const attemptBooking = async (requestId: string): Promise<string | null> =>
  (await db.sql<{ bookingId: string }>`SELECT booking_id FROM booking_history WHERE id = ${requestId}`)[0]?.bookingId ?? null;
const walkIn = async (v: Viewer, input: ReturnType<typeof guest>) => {
  const r = await registerWalkIn(deps, v, input);
  return { ...r, bookingId: await attemptBooking(input.requestId) };
};
const openTasks = async (key: string) => db.sql<{ assigneeUserId: string | null; source: string; kind: string }>`SELECT assignee_user_id, source, kind FROM tasks WHERE source_key = ${key} AND status = 'open'`;

before(async () => {
  db = await openDutyWorld();
  deps = makeDeps({ now: SEED_NOW }, port);
  duty = await viewerOf(U.duty);
  opA = await viewerOf(U.opA);
  await seedEvent(db.sql, { id: 'ev-w', date: '2026-10-28', time: '09:00' }); // идёт сейчас
  await seedEvent(db.sql, { id: 'ev-small', date: '2026-10-28', time: '09:00', capacity: 1 });
  await seedEvent(db.sql, { id: 'ev-next', date: '2026-10-29', time: '15:00' });
  await seedEvent(db.sql, { id: 'ev-nod', date: '2026-10-28', time: '09:00' }); // дежурный не назначен
  for (const ev of ['ev-w', 'ev-small', 'ev-next']) await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES (${ev}, ${U.duty}, ${SEED_NOW})`;
});
after(() => closeDutyWorld(db));

test('найден («Договорились»): запись walk_in/attended, заслуга владельцу, событие «Пришёл», ответ без данных клиента', async () => {
  port.reset();
  const before = { probes: await probes(), clients: await countClients() };
  const attempt = guest('ev-w', dialA(5));
  const raw = await registerWalkIn(deps, duty, attempt);
  assert.deepEqual(Object.keys(raw).sort(), ['answer', 'replayed']);
  const r = { ...raw, bookingId: await attemptBooking(attempt.requestId) };
  assert.equal(r.answer, 'found');
  assert.equal(r.replayed, false);
  const b = await bookingOf(r.bookingId!);
  assert.deepEqual([b.status, b.via, b.bookedByUserId, b.responsibleUserId, b.clientId, b.eventId], ['attended', 'walk_in', U.opA, U.opA, 'cl-a-5', 'ev-w']);
  assert.equal(port.calls.length, 1);
  const e = port.calls[0]!.event;
  assert.ok(e.type === 'attended' && e.eventDay === '2026-10-28' && e.bookingId === r.bookingId && e.facts.hasNextFutureBooking === false);
  assert.equal(port.calls[0]!.result.status, 'applied');
  assert.equal(await probes(), before.probes + 1);
  assert.equal(await countClients(), before.clients, 'нового клиента нет');
  const h = await db.sql<{ action: string; meta: { walkIn: string; ambiguous: boolean } }>`SELECT action, meta FROM booking_history WHERE booking_id = ${r.bookingId!}`;
  assert.deepEqual(h.map((x) => [x.action, x.meta.walkIn, x.meta.ambiguous]), [['walk_in', 'found', false]]);
});

test('найден с записью «Не пришёл» на это мероприятие: исправление № 31, вторая запись не создана', async () => {
  port.reset();
  const [bk] = await seedBookings(db.sql, 'ev-w', clientsOf('a', 6, 6), { status: 'no_show', bookedBy: U.opA });
  await setCardState(db.sql, 'cd-a-6', 'callback');
  const r = await walkIn(duty, guest('ev-w', dialA(6)));
  assert.equal(r.answer, 'found');
  assert.equal(r.bookingId, bk);
  assert.equal((await bookingOf(bk!)).status, 'attended');
  const n = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = 'ev-w' AND client_id = 'cl-a-6'`;
  assert.equal(n[0]?.n, 1);
  assert.ok(port.calls.some((c) => c.event.type === 'attendance_corrected'));
});

test('найден в «Перезвонить»: задача «следующий шаг» владельцу, состояние карточки то же', async () => {
  port.reset();
  await setCardState(db.sql, 'cd-a-7', 'callback');
  const r = await walkIn(duty, guest('ev-w', dialA(7)));
  assert.equal(r.answer, 'found');
  const t = await openTasks(`next_step:${r.bookingId}`);
  assert.deepEqual(t.map((x) => [x.assigneeUserId, x.source, x.kind]), [[U.opA, 'next_step', 'call']]);
  assert.equal((await db.sql<{ state: string }>`SELECT state FROM cards WHERE id = 'cd-a-7'`)[0]?.state, 'callback');
  assert.equal(port.calls.length, 0, 'в таблице переходов события нет');
});

test('найден в «Не звонить»: задача РОП, состояние не меняется', async () => {
  await setCardState(db.sql, 'cd-a-8', 'do_not_call');
  const r = await walkIn(duty, guest('ev-w', dialA(8)));
  const t = await openTasks(`walk_in:${r.bookingId}`);
  assert.deepEqual(t.map((x) => [x.assigneeUserId, x.source, x.kind]), [[U.rop, 'review', 'check']]);
  assert.equal((await db.sql<{ state: string }>`SELECT state FROM cards WHERE id = 'cd-a-8'`)[0]?.state, 'do_not_call');
});

test('два клиента с номером: запись к последнему по активности и задача walk_in_review', async () => {
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, search_norm, source_kind, created_at, updated_at)
               VALUES ('cl-dup', 'company', 'ТОО Синтетика Дубль', 'синтетика дубль', 'синтетика дубль', 'import', ${SEED_NOW}, ${SEED_NOW})`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES ('ph-dup', 'cl-dup', ${phoneOf('a', 9)}, 'mobile', TRUE, ${SEED_NOW})`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, owner_user_id, state, last_touch_at, created_at, updated_at)
               VALUES ('cd-dup', ${SPACE}, 'cl-dup', ${U.opA}, 'agreed', ${SEED_NOW}, ${SEED_NOW}, ${SEED_NOW})`;
  await db.sql`UPDATE cards SET last_touch_at = ${SEED_NOW - 1000} WHERE id = 'cd-a-9'`;
  const r = await walkIn(duty, guest('ev-w', dialA(9)));
  assert.equal((await bookingOf(r.bookingId!)).clientId, 'cl-dup');
  const t = await openTasks(`walk_in_review:${r.bookingId}`);
  assert.deepEqual(t.map((x) => x.assigneeUserId), [U.rop]);
});

test('не найден: новый клиент walk_in, карточка new в «Задержаны правилом», запись без заслуги, задача РОП, ответ без имён', async () => {
  const before = await countClients();
  const r = await walkIn(duty, guest('ev-w', '+7 709 123 45 67', { name: 'Гостья Синтетик' }));
  assert.equal(r.answer, 'new');
  assert.equal(JSON.stringify(r).includes('Синтетик'), false);
  assert.equal(await countClients(), before + 1);
  const b = await bookingOf(r.bookingId!);
  assert.deepEqual([b.status, b.via, b.bookedByUserId, b.responsibleUserId], ['attended', 'walk_in', null, null]);
  const c = (await db.sql<{ kind: string; name: string; sourceKind: string; sourceKey: string; searchNorm: string }>`SELECT kind, name, source_kind, source_key, search_norm FROM clients WHERE id = ${b.clientId}`)[0]!;
  assert.deepEqual([c.kind, c.name, c.sourceKind, c.sourceKey], ['person', 'Гостья Синтетик', 'walk_in', 'walk_in']);
  assert.ok(c.searchNorm.includes('77091234567'));
  const card = (await db.sql<{ state: string; ownerUserId: string | null; holdReason: string; holdCode: string }>`SELECT state, owner_user_id, hold_reason, hold_code FROM cards WHERE client_id = ${b.clientId}`)[0]!;
  assert.deepEqual([card.state, card.ownerUserId, card.holdReason, card.holdCode], ['new', null, 'rule', 'walk_in']);
  const ph = await db.sql<{ digits: string; isPrimary: boolean }>`SELECT digits, is_primary FROM client_phones WHERE client_id = ${b.clientId}`;
  assert.deepEqual(ph.map((p) => [p.digits, p.isPrimary]), [['77091234567', true]]);
  assert.equal((await db.sql`SELECT 1 FROM client_sources WHERE client_id = ${b.clientId} AND source_kind = 'walk_in'`).length, 1);
  assert.equal((await openTasks(`walk_in_new:${b.clientId}`)).length, 1);
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE client_id = ${b.clientId} AND kind = 'card.created'`).length, 1);
});

test('не найден, назвал компанию: клиент-компания с названием компании, гость — контакт', async () => {
  const r = await walkIn(duty, guest('ev-w', '+7 709 123 45 68', { name: 'Гость Контактов', company: 'ТОО «Пример Синтетика»' }));
  const b = await bookingOf(r.bookingId!);
  const c = (await db.sql<{ kind: string; name: string; nameNorm: string }>`SELECT kind, name, name_norm FROM clients WHERE id = ${b.clientId}`)[0]!;
  assert.deepEqual([c.kind, c.name], ['company', 'ТОО «Пример Синтетика»']);
  assert.ok(c.nameNorm.includes('пример'));
  assert.equal((await db.sql<{ name: string }>`SELECT name FROM contacts WHERE client_id = ${b.clientId}`)[0]?.name, 'Гость Контактов');
});

test('номер в стоп-листе без клиента: ничего не создано, ответ «новый», проверка засчитана', async () => {
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77091234569')}, 'x', 'manual', ${SEED_NOW})`;
  const before = { clients: await countClients(), probes: await probes() };
  const attempt = guest('ev-w', '+7 709 123 45 69');
  const r = await registerWalkIn(deps, duty, attempt);
  assert.equal(r.answer, 'new');
  assert.equal(await attemptBooking(attempt.requestId), null, 'записи нет');
  assert.equal(await countClients(), before.clients);
  assert.equal(await probes(), before.probes + 1);
  const a = await db.sql<{ action: string; meta: { eventId: string } }>`SELECT action, meta FROM audit_log WHERE action = 'booking.walk_in_skipped'`;
  assert.deepEqual(a.map((x) => [x.action, x.meta.eventId]), [['booking.walk_in_skipped', 'ev-w']]);
});

test('ответ дежурному у номера из стоп-листа и у нового гостя одинаков: стоп-лист не различим', async () => {
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77091234572')}, 'x', 'manual', ${SEED_NOW})`;
  const stopped = await registerWalkIn(deps, duty, guest('ev-w', '+7 709 123 45 72'));
  const fresh = await registerWalkIn(deps, duty, guest('ev-w', '+7 709 123 45 73'));
  assert.deepEqual(stopped, fresh);
  assert.deepEqual(fresh, { answer: 'new', replayed: false });
});

test('повтор requestId: replayed, одна запись, счётчик проверок не растёт; чужой гость тем же ключом — request_reused', async () => {
  const input = guest('ev-w', dialA(10));
  const first = await walkIn(duty, input);
  const n = await probes();
  const again = await walkIn(duty, input);
  assert.deepEqual([again.replayed, again.bookingId, again.answer], [true, first.bookingId, first.answer]);
  assert.equal(await probes(), n);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE client_id = 'cl-a-10' AND event_id = 'ev-w'`)[0]?.n, 1);
  await assert.rejects(registerWalkIn(deps, duty, { ...input, eventId: 'ev-small' }), failsWith('request_reused'));
});

test('вместимость 1/1: гость всё равно записан', async () => {
  await seedBookings(db.sql, 'ev-small', clientsOf('a', 30, 30), { bookedBy: U.opA });
  const r = await walkIn(duty, guest('ev-small', dialA(31)));
  assert.equal(r.answer, 'found');
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM bookings WHERE event_id = 'ev-small'`)[0]?.n, 2);
});

test('21-я проверка за день: ответ «recorded», запись всё равно создана', async () => {
  const have = await probes();
  for (let i = have; i < 20; i++) {
    await db.sql`INSERT INTO phone_probes (id, user_id, day, path, matched, created_at) VALUES (${`pp-fill-${i}`}, ${U.duty}, '2026-10-28', 'walk_in', FALSE, ${SEED_NOW})`;
  }
  assert.equal(await probes(), 20);
  const r = await walkIn(duty, guest('ev-w', dialA(32)));
  assert.equal(r.answer, 'recorded');
  assert.equal((await bookingOf(r.bookingId!)).status, 'attended');
  const r2 = await walkIn(duty, guest('ev-w', '+7 709 123 45 70'));
  assert.equal(r2.answer, 'recorded', 'и новый гость при превышении — тот же нейтральный ответ');
});

test('сверх лимита проверок: повтор попытки с номером из стоп-листа отвечает так же, как повтор нового гостя', async () => {
  assert.ok((await probes()) >= 20, 'лимит уже превышен предыдущим тестом');
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77091234574')}, 'x', 'manual', ${SEED_NOW})`;
  const stoppedIn = guest('ev-w', '+7 709 123 45 74');
  const freshIn = guest('ev-w', '+7 709 123 45 75');
  const stopped = [await registerWalkIn(deps, duty, stoppedIn), await registerWalkIn(deps, duty, stoppedIn)];
  const fresh = [await registerWalkIn(deps, duty, freshIn), await registerWalkIn(deps, duty, freshIn)];
  assert.deepEqual(stopped, fresh);
  assert.deepEqual(stopped, [
    { answer: 'recorded', replayed: false },
    { answer: 'recorded', replayed: true },
  ]);
  // тот же ключ на другом мероприятии — как у обычного гостя
  await assert.rejects(registerWalkIn(deps, duty, { ...stoppedIn, eventId: 'ev-small' }), failsWith('request_reused'));
});

test('двое дежурных вводят один новый номер одновременно: один клиент и одна запись', async () => {
  await db.sql`INSERT INTO event_duty (event_id, user_id, created_at) VALUES ('ev-w', ${U.rop}, ${SEED_NOW}) ON CONFLICT DO NOTHING`;
  const rop = await viewerOf(U.rop);
  const results = await Promise.all([
    walkIn(duty, guest('ev-w', '+7 709 123 45 71')),
    walkIn(rop, guest('ev-w', '+7 709 123 45 71')),
  ]);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_phones WHERE digits = '77091234571'`)[0]?.n, 1);
  const ids = new Set(results.map((r) => r.bookingId));
  assert.equal(ids.size, 1, 'вторая попытка нашла клиента первой и отметила ту же запись');
});

test('мероприятие не сегодня: РОП — walk_in_closed, дежурный завтрашнего — 404; не дежурный — 404; плохой номер — 400', async () => {
  await assert.rejects(registerWalkIn(deps, await viewerOf(U.rop), guest('ev-next', dialA(40))), failsWith('walk_in_closed'));
  await assert.rejects(registerWalkIn(deps, duty, guest('ev-next', dialA(40))), failsWith('event_not_found'));
  await assert.rejects(registerWalkIn(deps, duty, guest('ev-nod', dialA(40))), failsWith('event_not_found'));
  await assert.rejects(registerWalkIn(deps, opA, guest('ev-w', dialA(40))), failsWith('event_not_found'));
  await assert.rejects(registerWalkIn(deps, duty, guest('ev-w', '12345')), (e: unknown) => e instanceof BadRequestError);
  await assert.rejects(registerWalkIn(deps, duty, guest('ev-w', dialA(40), { name: '  ' })), (e: unknown) => e instanceof BadRequestError);
});
