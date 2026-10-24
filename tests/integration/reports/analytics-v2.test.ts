// Аналитика воронки v2 (R2, D-343, D-344): средняя конверсия операторов, поимённый список явки, причины перезвона и
// списания, воронка по видам. Каждый блок считается на своём периоде, чтобы данные не мешали друг другу. Только синтетика.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as exportRoute from '../../../src/app/api/reports/[key]/export/route';
import * as reportRoute from '../../../src/app/api/reports/[key]/route';
import { getDirectorDashboard, getReport } from '../../../src/server/domain/reports';
import type { AttendanceListReport, ReportQuery } from '../../../src/server/domain/reports/reportTypes';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { closeClientsWorld, openClientsWorld } from '../clients/world';
import { SEED_NOW, SPACE, U, actAs, enterReportsConfig, leaveReportsConfig, seedCall, viewerOf } from './helpers';

let db: TestDb;
const clock = { now: SEED_NOW };
const NO_FILTERS = { userIds: null, sourceKey: null };
/** Местное время Алматы (UTC+5) → epoch-мс. */
const at = (month: number, day: number, h: number, m = 0) => Date.UTC(2026, month - 1, day, h - 5, m);
const day = (month: number, d: number) => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// Периоды блоков
const CONV = { from: '2026-10-05', to: '2026-10-11' }; // конверсии
const REAS = { from: '2026-10-01', to: '2026-10-04' }; // причины
const LIST = { from: '2026-09-07', to: '2026-09-13' }; // список явки

async function booking(o: {
  id: string;
  type: string;
  client: string;
  card: string;
  date: string;
  startsAt: number;
  status: string;
  by: string;
  createdAt: number;
  kind?: 'group' | 'individual';
  eventId?: string;
  resource?: string | null;
  cancelReason?: string;
  reserve?: boolean;
  dealId?: string;
}): Promise<void> {
  await db.sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at,
                          duration_min, is_reserve, status, cancel_reason, via, booked_by_user_id, responsible_user_id, created_at, updated_at)
    VALUES (${o.id}, ${SPACE}, ${o.kind ?? 'individual'}, ${o.type}, ${o.eventId ?? null}, ${o.resource ?? null}, ${o.client}, ${o.card}, ${o.dealId ?? null}, ${o.date}, '11:00',
            ${o.startsAt}, 60, ${o.reserve ?? false}, ${o.status}, ${o.cancelReason ?? ''}, 'ui', ${o.by}, ${o.by}, ${o.createdAt}, ${o.createdAt})`;
}

async function wonDeal(id: string, client: string, card: string, owner: string, wonAt: number, amount: number): Promise<void> {
  await db.sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at,
                       stage_changed_at, created_by, created_at, updated_at)
    VALUES (${id}, ${SPACE}, 'sales', 'won', 'won', ${client}, ${card}, ${owner}, 'consult', ${amount}, ${wonAt}, ${wonAt}, ${owner}, ${wonAt}, ${wonAt})`;
}

async function history(bookingId: string, to: 'attended' | 'no_show', actor: string | null, atMs: number): Promise<void> {
  await db.sql`
    INSERT INTO booking_history (id, booking_id, action, from_status, to_status, actor_id, meta, created_at)
    VALUES (${`h-${bookingId}`}, ${bookingId}, 'status', 'confirmed', ${to}, ${actor}, '{}', ${atMs})`;
}

/** n звонков «договорились» с канала `via` на одной карточке оператора. */
async function connects(prefix: string, n: number, userId: string, card: string, client: string, via = 'ui'): Promise<void> {
  for (let i = 0; i < n; i++) await seedCall(db.sql, { id: `${prefix}-${i}`, cardId: card, clientId: client, userId, at: at(10, 5 + (i % 5), 10, i), kind: 'agreed', via });
}

before(async () => {
  db = await openClientsWorld();
  enterReportsConfig(clock);
  const sql = db.sql;
  const [A, B, D] = [U.opA, U.opB, U.duty];

  // --- Конверсии: A — ровно 20 дозвонов, B — 25, дежурный — 19 (в среднюю не входит) ---
  await connects('ca', 20, A, 'cd-a-50', 'cl-a-50');
  await connects('ca-board', 5, A, 'cd-a-50', 'cl-a-50', 'board'); // перенос плитки без звонка: итог есть, дозвона нет
  await connects('cb', 25, B, 'cd-b-50', 'cl-b-50');
  await connects('cd', 19, D, 'cd-a-52', 'cl-a-52');
  // A: 4 записи (2 пришли, 1 не пришёл, 1 не отмечена), покупка по первой записи
  const mk = (id: string, cl: string, st: string, d: number, by: string, deal?: string) =>
    booking({ id, type: 'consult', client: cl, card: cl.replace('cl-', 'cd-'), date: day(10, d), startsAt: at(10, d, 11), status: st, by, createdAt: at(10, 6, 9), dealId: deal });
  await wonDeal('dv-a', 'cl-a-51', 'cd-a-51', A, at(10, 8, 12), 100_000);
  await mk('v-a1', 'cl-a-51', 'attended', 7, A, 'dv-a');
  await mk('v-a2', 'cl-a-53', 'attended', 8, A);
  await mk('v-a3', 'cl-a-54', 'no_show', 8, A);
  await mk('v-a4', 'cl-a-55', 'confirmed', 9, A);
  // B: 10 записей, 5 пришли
  for (let i = 0; i < 10; i++) await mk(`v-b${i}`, `cl-b-${51 + i}`, i < 5 ? 'attended' : 'confirmed', 7 + (i % 3), B);
  // дежурный: 19 записей — в среднюю не идёт, в командную входит
  for (let i = 0; i < 19; i++) await mk(`v-d${i}`, `cl-a-${60 + i}`, 'confirmed', 9, D);

  // --- Причины ---
  const reason = async (id: string, card: string, client: string, userId: string, kind: string, code: string, via = 'ui') => {
    await seedCall(sql, { id, cardId: card, clientId: client, userId, at: at(10, 2, 11), kind, via });
    await sql`UPDATE calls SET reason_code = ${code} WHERE id = ${id}`;
  };
  await reason('r1', 'cd-a-56', 'cl-a-56', A, 'callback', 'later');
  await reason('r2', 'cd-b-60', 'cl-b-60', B, 'callback', 'later');
  await reason('r3', 'cd-a-57', 'cl-a-57', A, 'callback', '');
  await reason('r4', 'cd-a-58', 'cl-a-58', A, 'callback', 'think', 'board'); // с доски — в причинах есть
  // списанные: система (3 недозвона) и вручную
  for (const [card, code] of [['cd-a-70', 'no_answer_limit'], ['cd-a-71', 'unreachable'], ['cd-b-70', 'no_answer_limit']] as const) {
    await sql`UPDATE cards SET state = 'written_off', close_reason_code = ${code}, closed_at = ${at(10, 3, 12)}, owner_user_id = ${card.startsWith('cd-a') ? A : B} WHERE id = ${card}`;
  }
  // карточка списана вне периода — не считается
  await sql`UPDATE cards SET state = 'written_off', close_reason_code = 'unreachable', closed_at = ${at(10, 20, 12)} WHERE id = 'cd-a-72'`;
  // неявки по видам
  await booking({ id: 'n1', type: 'consult', client: 'cl-a-73', card: 'cd-a-73', date: day(10, 3), startsAt: at(10, 3, 11), status: 'no_show', by: A, createdAt: at(10, 1, 9) });
  await booking({ id: 'n2', type: 'consult', client: 'cl-a-74', card: 'cd-a-74', date: day(10, 3), startsAt: at(10, 3, 11), status: 'no_show', by: A, createdAt: at(10, 1, 9) });
  await booking({ id: 'n3', type: 'other', client: 'cl-a-75', card: 'cd-a-75', date: day(10, 4), startsAt: at(10, 4, 11), status: 'no_show', by: B, createdAt: at(10, 1, 9) });

  // --- Список явки: 21–27 сентября ---
  await wonDeal('dl-1', 'cl-a-80', 'cd-a-80', A, at(9, 14, 12), 70_000);
  const lst = (id: string, cl: string, d: number, st: string, by: string, extra: Partial<Parameters<typeof booking>[0]> = {}) =>
    booking({ id, type: 'consult', client: cl, card: cl.replace('cl-', 'cd-'), date: day(9, d), startsAt: at(9, d, 11), status: st, by, createdAt: at(9, 1, 9), ...extra });
  await lst('l1', 'cl-a-80', 8, 'attended', A, { resource: 'rs-cons', dealId: 'dl-1' });
  await lst('l2', 'cl-b-80', 9, 'no_show', B, { resource: 'rs-cons' });
  await lst('l3', 'cl-a-81', 10, 'confirmed', A);
  await lst('l4', 'cl-a-82', 11, 'cancelled', A, { cancelReason: 'client' });
  await lst('l5', 'cl-a-83', 11, 'cancelled', A, { cancelReason: 'operator_error' }); // не показывается
  await lst('l6', 'cl-a-84', 12, 'attended', B, { reserve: true }); // резерв — не показывается
  await lst('l7', 'cl-b-81', 12, 'attended', B);
  await lst('l8', 'cl-b-82', 13, 'confirmed', B, { type: 'other' });
  await history('l1', 'attended', U.consultant, at(9, 8, 13));
  await history('l2', 'no_show', U.rop, at(9, 9, 13));
  // l7: явку отметила система — истории с автором нет
});
after(async () => {
  leaveReportsConfig();
  await closeClientsWorld(db);
});

const ops = async (who = U.rop) => getReport(await viewerOf(who), { key: 'operators', period: CONV, filters: NO_FILTERS, grouping: 'total' });
const rowOf = (r: Awaited<ReturnType<typeof ops>>, id: string) => r.rows.find((x) => x.userId === id)!;

// ---------------------------------------------------------------------------
// Операторы: конверсии и средняя
// ---------------------------------------------------------------------------

test('операторы: конверсии запись/дозвон, явка/запись, покупка/явка по каждому', async () => {
  const r = await ops();
  const a = rowOf(r, U.opA);
  assert.equal(a.connects, 20, 'итоги с канала board в дозвоны не входят');
  assert.equal(a.outcomes, 25, 'но входят в итоги');
  assert.deepEqual([a.bookedPerConnect, a.attendedPerBooked, a.purchasedPerAttended], [20, 50, 50]);
  const b = rowOf(r, U.opB);
  assert.deepEqual([b.connects, b.bookedPerConnect, b.attendedPerBooked, b.purchasedPerAttended], [25, 40, 50, 0]);
  const d = rowOf(r, U.duty);
  assert.deepEqual([d.connects, d.bookedPerConnect, d.attendedPerBooked, d.purchasedPerAttended], [19, 100, 0, null]);
});

test('средняя по операторам ≠ конверсия команды; оператор с 19 дозвонами не входит, с 20 — входит', async () => {
  const r = await ops();
  assert.equal(r.average.minConnects, 20);
  assert.equal(r.average.operators, 2, 'A (ровно 20) и B (25); дежурный с 19 — нет');
  assert.equal(r.average.bookedPerConnect, 30); // (20 + 40) / 2
  assert.equal(r.average.attendedPerBooked, 50);
  assert.equal(r.average.purchasedPerAttended, 25); // (50 + 0) / 2
  // конверсия команды — отношение сумм: 33 записи / 64 дозвона
  assert.equal(r.totals.bookedPerConnect, 51.6);
  assert.notEqual(r.average.bookedPerConnect, r.totals.bookedPerConnect);
});

test('средняя считается по операторам, а не по корзинам группировки; фильтр сотрудников сужает её', async () => {
  const day = await getReport(await viewerOf(U.rop), { key: 'operators', period: CONV, filters: NO_FILTERS, grouping: 'day' });
  assert.deepEqual(day.average, (await ops()).average);
  const only = await getReport(await viewerOf(U.rop), { key: 'operators', period: CONV, filters: { userIds: [U.opA], sourceKey: null }, grouping: 'total' });
  assert.equal(only.average.operators, 1);
  assert.equal(only.average.bookedPerConnect, 20);
});

test('панель директора: плитка «Средняя конверсия операторов» и конверсия команды', async () => {
  // неделя панели — текущая; сдвигаем часы на неделю с данными
  const keep = clock.now;
  clock.now = at(10, 9, 12);
  try {
    const dash = await getDirectorDashboard(await viewerOf(U.director));
    assert.deepEqual(dash.conversion, { average: 30, team: 51.6, operators: 2, minConnects: 20 });
  } finally {
    clock.now = keep;
  }
});

test('воронка по дозвонам не считает канал board', async () => {
  const f = await getReport(await viewerOf(U.rop), { key: 'funnel', period: CONV, filters: NO_FILTERS, by: 'source' });
  assert.equal(f.total.counts.connected, 64);
  const byUser = await getReport(await viewerOf(U.rop), { key: 'funnel', period: CONV, filters: NO_FILTERS, by: 'operator' });
  assert.equal(byUser.rows.find((x) => x.key === U.opA)!.counts.connected, 20);
});

// ---------------------------------------------------------------------------
// Воронка по видам
// ---------------------------------------------------------------------------

test('воронка: запись и явка по видам; сумма видов равна общему шагу', async () => {
  const f = await getReport(await viewerOf(U.rop), { key: 'funnel', period: CONV, filters: NO_FILTERS, by: 'operator' });
  const a = f.rows.find((x) => x.key === U.opA)!;
  assert.deepEqual(a.kinds, { group: { booked: 0, attended: 0 }, individual: { booked: 4, attended: 2 } });
  assert.equal(a.kinds.group.booked + a.kinds.individual.booked, a.counts.booked);
  assert.equal(a.kindRates.individual.attended, 50);
  assert.equal(a.kindRates.group.attended, null);
  assert.equal(f.total.kinds.individual.booked, 33);
  assert.equal(f.total.kinds.individual.attended, 7);
  const src = await getReport(await viewerOf(U.rop), { key: 'funnel', period: CONV, filters: NO_FILTERS, by: 'source' });
  assert.equal(src.total.kinds.individual.booked, 33);
});

// ---------------------------------------------------------------------------
// Причины
// ---------------------------------------------------------------------------

test('причины: перезвон (в том числе «без причины» и с доски), списание, неявки по видам', async () => {
  const r = await getReport(await viewerOf(U.rop), { key: 'reasons', period: REAS, filters: NO_FILTERS });
  assert.deepEqual(
    r.rows.map((x) => [x.group, x.reasonCode, x.count, x.share]),
    [
      ['callback', 'later', 2, 50],
      ['callback', '', 1, 25],
      ['callback', 'think', 1, 25],
      ['written_off', 'no_answer_limit', 2, 66.7], // списанная вне периода (20.10) не считается
      ['written_off', 'unreachable', 1, 33.3],
      ['no_show', 'consult', 2, 66.7],
      ['no_show', 'other', 1, 33.3],
    ],
  );
});

test('причины: блоки по колонкам доски — доли от итога блока, оператору нельзя', async () => {
  const r = await getReport(await viewerOf(U.rop), { key: 'reasons', period: REAS, filters: NO_FILTERS });
  assert.deepEqual(r.blocks.map((b) => [b.key, b.label, b.total]), [['callback', 'Перезвон', 4], ['trash', 'Мусор', 3]]);
  const trash = r.blocks.find((b) => b.key === 'trash')!;
  assert.deepEqual(trash.rows.map((x) => [x.group, x.reasonCode, x.count, x.share]), [['written_off', 'no_answer_limit', 2, 66.7], ['written_off', 'unreachable', 1, 33.3]]);
  assert.equal(r.blocks.find((b) => b.key === 'callback')!.rows.reduce((s, x) => s + (x.share ?? 0), 0), 100);
  await assert.rejects(getReport(await viewerOf(U.opA), { key: 'reasons', period: REAS, filters: NO_FILTERS }), (e: { code?: string }) => e.code === 'forbidden');
});

test('причины: фильтр по сотруднику и охват пространства', async () => {
  const onlyB = await getReport(await viewerOf(U.rop), { key: 'reasons', period: REAS, filters: { userIds: [U.opB], sourceKey: null } });
  assert.deepEqual(onlyB.rows.map((x) => [x.group, x.reasonCode, x.count]), [['callback', 'later', 1], ['written_off', 'no_answer_limit', 1], ['no_show', 'other', 1]]);
  await assert.rejects(getReport(await viewerOf(U.opA), { key: 'reasons', period: REAS, filters: NO_FILTERS }), (e: { code?: string }) => e.code === 'forbidden');
});

// ---------------------------------------------------------------------------
// Явка — список
// ---------------------------------------------------------------------------

const listQ = (over: { users?: string[] | null; eventType?: string; status?: 'attended' | 'no_show' | 'unmarked' | 'planned' | 'cancelled'; consultant?: string; cursor?: string; limit?: number } = {}): ReportQuery => ({
  key: 'attendance',
  view: 'list',
  period: LIST,
  filters: { userIds: over.users ?? null, sourceKey: null },
  list: { eventType: over.eventType ?? null, status: over.status ?? null, consultant: over.consultant ?? null, cursor: over.cursor ?? null, limit: over.limit ?? 50 },
});
const list = async (q: ReportQuery, who: string = U.rop): Promise<AttendanceListReport> => (await getReport(await viewerOf(who), q)) as AttendanceListReport;

test('список явки: поимённо, новые сверху; резерв и «ошибка оператора» не показываются', async () => {
  const r = await list(listQ());
  assert.deepEqual(r.rows.map((x) => x.bookingId), ['l8', 'l7', 'l4', 'l3', 'l2', 'l1']);
  assert.equal(r.next, null);
  const l1 = r.rows.find((x) => x.bookingId === 'l1')!;
  assert.equal(l1.clientName, 'ТОО Синтетика Альфа 80');
  assert.equal(l1.bookedByUserId, U.opA);
  assert.equal(l1.bookedByName, 'Оператор Синтетик А');
  assert.equal(l1.status, 'attended');
  assert.equal(l1.markedByUserId, U.consultant);
  assert.equal(l1.consultantUserId, U.consultant);
  assert.equal(l1.purchaseSumKzt, 70_000, 'покупка той же сделки');
  assert.equal(l1.eventTypeKey, 'consult');
});

test('список явки: статусы — «не отмечено» для прошедших, отметивший явку, система без автора', async () => {
  const r = await list(listQ());
  const by = Object.fromEntries(r.rows.map((x) => [x.bookingId, x]));
  assert.equal(by.l2!.status, 'no_show');
  assert.equal(by.l2!.markedByUserId, U.rop);
  assert.equal(by.l3!.status, 'unmarked');
  assert.equal(by.l3!.markedByUserId, null);
  assert.equal(by.l4!.status, 'cancelled');
  assert.equal(by.l7!.status, 'attended');
  assert.equal(by.l7!.markedByUserId, null, 'явку отметила система');
  assert.equal(by.l7!.purchaseSumKzt, null);
});

test('список явки: фильтры вид, статус, сотрудник (автор записи), консультант', async () => {
  const ids = async (q: ReportQuery) => (await list(q)).rows.map((x) => x.bookingId);
  assert.deepEqual(await ids(listQ({ status: 'attended' })), ['l7', 'l1']);
  assert.deepEqual(await ids(listQ({ status: 'unmarked' })), ['l8', 'l3']);
  assert.deepEqual(await ids(listQ({ eventType: 'other' })), ['l8']);
  assert.deepEqual(await ids(listQ({ users: [U.opA] })), ['l4', 'l3', 'l1']);
  assert.deepEqual(await ids(listQ({ consultant: U.consultant })), ['l2', 'l1']);
  assert.deepEqual(await ids(listQ({ users: [U.opB], status: 'attended' })), ['l7']);
});

test('список явки: счётчики по статусам для чипов — те же фильтры, кроме статуса; на следующих страницах их нет', async () => {
  const all = { attended: 2, no_show: 1, unmarked: 2, planned: 0, cancelled: 1 };
  assert.deepEqual((await list(listQ())).counts, all);
  assert.deepEqual((await list(listQ({ status: 'attended' }))).counts, all, 'выбранный статус чипы не сужает');
  assert.deepEqual((await list(listQ({ eventType: 'other' }))).counts, { attended: 0, no_show: 0, unmarked: 1, planned: 0, cancelled: 0 });
  assert.deepEqual((await list(listQ({ consultant: U.consultant }))).counts, { attended: 1, no_show: 1, unmarked: 0, planned: 0, cancelled: 0 });
  assert.deepEqual((await list(listQ({ users: [U.opA] }))).counts, { attended: 1, no_show: 0, unmarked: 1, planned: 0, cancelled: 1 });
  const p1 = await list(listQ({ limit: 4 }));
  assert.deepEqual(p1.counts, all);
  assert.equal((await list(listQ({ limit: 4, cursor: p1.next! }))).counts, null);
});

test('список явки: курсорная пагинация без пропусков и повторов', async () => {
  const p1 = await list(listQ({ limit: 4 }));
  assert.equal(p1.rows.length, 4);
  assert.ok(p1.next);
  const p2 = await list(listQ({ limit: 4, cursor: p1.next! }));
  assert.equal(p2.rows.length, 2);
  assert.equal(p2.next, null);
  assert.deepEqual([...p1.rows, ...p2.rows].map((x) => x.bookingId), ['l8', 'l7', 'l4', 'l3', 'l2', 'l1']);
});

test('список явки: оператор, консультант и руководитель отдела — 403; директор — видит', async () => {
  for (const id of [U.opA, U.consultant, U.mktHead, U.marketer]) {
    await assert.rejects(getReport(await viewerOf(id), listQ()), (e: { code?: string }) => e.code === 'forbidden', id);
  }
  assert.equal((await list(listQ(), U.director)).rows.length, 6);
});

test('маршрут /api/reports/attendance: список — 200 с названием клиента, оператор 403, плохие параметры 400', async () => {
  const get = async (as: string | null, qs: string) => {
    actAs(as);
    return reportRoute.GET(new Request(`http://crm.test/api/reports/attendance?from=${LIST.from}&to=${LIST.to}${qs}`), { params: Promise.resolve({ key: 'attendance' }) });
  };
  const ok = await get(U.rop, '&view=list&status=attended');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = (await ok.json()) as AttendanceListReport;
  assert.deepEqual(body.rows.map((x) => x.bookingId), ['l7', 'l1']);
  assert.equal((await get(U.opA, '&view=list')).status, 403);
  assert.equal((await get(null, '&view=list')).status, 401);
  assert.equal((await get(U.rop, '&view=list&cursor=%27%3B--')).status, 400, 'чужая форма курсора');
  assert.equal((await get(U.rop, '&status=attended')).status, 400, 'фильтр списка без view=list');
  assert.equal((await get(U.rop, '&view=list&status=nope')).status, 400);
  // сводка прежняя: без view
  const summary = (await (await get(U.rop, '&by=event_type')).json()) as { by: string; rows: unknown[] };
  assert.equal(summary.by, 'event_type');
});

test('выгрузка списка явки: все страницы, журнал с кодами фильтров без значений; оператору — 403', async () => {
  const exp = async (as: string, qs: string) => {
    actAs(as);
    return exportRoute.GET(new Request(`http://crm.test/api/reports/attendance/export?from=${LIST.from}&to=${LIST.to}&${qs}`, { headers: { 'sec-fetch-site': 'same-origin' } }), {
      params: Promise.resolve({ key: 'attendance' }),
    });
  };
  const before = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'export.report'`)[0]!.n;
  assert.equal((await exp(U.opA, 'format=csv&view=list')).status, 403);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM audit_log WHERE action = 'export.report'`)[0]!.n, before, 'отказ в журнал не пишется');

  const res = await exp(U.rop, `format=csv&view=list&status=attended&consultant=${U.consultant}`);
  assert.equal(res.status, 200);
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
  assert.ok(text.includes('ТОО Синтетика Альфа 80'));
  assert.ok(!text.includes('ТОО Синтетика Бета 81'), 'фильтр применён');
  const rows = await db.sql<{ meta: Record<string, unknown> }>`SELECT meta FROM audit_log WHERE action = 'export.report' ORDER BY created_at DESC, id DESC LIMIT 1`;
  const meta = rows[0]!.meta;
  assert.deepEqual(meta.filterKeys, ['consultant', 'status', 'view']);
  assert.equal(meta.rows, 1);
  assert.equal(meta.reportKey, 'attendance');
  const dump = JSON.stringify(meta);
  assert.ok(!dump.includes(U.consultant) && !dump.includes('attended') && !dump.includes('list'), 'значений фильтров в журнале нет');

  // без фильтров — все шесть строк (страницы собираются подряд)
  const all = new TextDecoder().decode(new Uint8Array(await (await exp(U.rop, 'format=csv&view=list')).arrayBuffer()));
  assert.equal(all.trim().split('\r\n').length, 1 + 6);
});
