// Отчёты за период (R3a): определения PROCESS 10.1 на синтетике у границ суток. Период 12–14 октября 2026
// (местное время Алматы, UTC+5), чтобы не пересекаться с синтетикой мира изоляции. Только синтетика.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as reportRoute from '../../../src/app/api/reports/[key]/route';
import { getReport } from '../../../src/server/domain/reports';
import type { ReportQuery } from '../../../src/server/domain/reports/reportTypes';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SPACE, U, actAs, closeWorld, enterReportsConfig, leaveReportsConfig, openWorld, seedCall, viewerOf } from './helpers';

let db: TestDb;
const clock = { now: SEED_NOW };
const PERIOD = { from: '2026-10-12', to: '2026-10-14' };
const NO_FILTERS = { userIds: null, sourceKey: null };
/** Местное время Алматы (UTC+5) → epoch-мс. */
const at = (day: number, h: number, m = 0) => Date.UTC(2026, 9, day, h - 5, m);

const op = (over: { userIds?: string[] | null; sourceKey?: string | null; grouping?: 'total' | 'day' | 'week' } = {}): ReportQuery => ({
  key: 'operators',
  period: PERIOD,
  filters: { userIds: over.userIds ?? null, sourceKey: over.sourceKey ?? null },
  grouping: over.grouping ?? 'total',
});

async function insertBooking(o: {
  id: string;
  kind: 'group' | 'individual';
  type: string;
  client: string;
  card: string;
  date: string;
  startsAt: number;
  status: string;
  by: string;
  createdAt: number;
  eventId?: string;
  resource?: string;
  cancelReason?: string;
  via?: string;
  reserve?: boolean;
  movedFrom?: string;
  dealId?: string;
}): Promise<void> {
  await db.sql`
    INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, resource_id, client_id, card_id, deal_id, booking_date, start_time, starts_at,
                          duration_min, is_reserve, status, cancel_reason, via, booked_by_user_id, responsible_user_id, moved_from_id, created_at, updated_at)
    VALUES (${o.id}, ${SPACE}, ${o.kind}, ${o.type}, ${o.eventId ?? null}, ${o.resource ?? null}, ${o.client}, ${o.card}, ${o.dealId ?? null}, ${o.date}, '11:00', ${o.startsAt},
            60, ${o.reserve ?? false}, ${o.status}, ${o.cancelReason ?? ''}, ${o.via ?? 'ui'}, ${o.by}, ${o.by}, ${o.movedFrom ?? null}, ${o.createdAt}, ${o.createdAt})`;
}

async function insertDeal(o: { id: string; client: string; card: string; owner: string; status: 'won' | 'lost'; at: number; amount?: number; service?: string; lostReason?: string }): Promise<void> {
  await db.sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at, lost_at,
                       lost_reason_code, stage_changed_at, created_by, created_at, updated_at)
    VALUES (${o.id}, ${SPACE}, 'sales', ${o.status}, ${o.status}, ${o.client}, ${o.card}, ${o.owner}, ${o.service ?? ''}, ${o.amount ?? 0},
            ${o.status === 'won' ? o.at : null}, ${o.status === 'lost' ? o.at : null}, ${o.lostReason ?? ''}, ${o.at}, ${o.owner}, ${o.at}, ${o.at})`;
}

before(async () => {
  db = await openWorld();
  enterReportsConfig(clock);
  const sql = db.sql;
  const A = U.opA;
  const B = U.opB;
  // Клиенты и карточки, которых нет в мире: cl-a-30…35 уже есть у A; для B берём cl-b-30…35 (мир создаёт 100 штук)
  // Источники: у cl-a-30 первый — new_base (позже появился второй, он не считается), у cl-a-31 — только вид import
  await sql`INSERT INTO client_sources (id, client_id, source_kind, source_key, first_seen_at) VALUES
            ('s1', 'cl-a-30', 'ingest', 'new_base', 1000), ('s2', 'cl-a-30', 'manual', 'manual', 2000), ('s3', 'cl-a-31', 'import', '', 1000)`;

  // Выдачи: kinds merge и release в «Выдано» не входят
  const al = (id: string, card: string, to: string, kind: string, day: string) =>
    sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
        VALUES (${id}, ${SPACE}, ${card}, NULL, ${to}, ${kind}, TRUE, 'seed', ${day}, NULL, ${at(Number(day.slice(8)), 9)})`;
  await al('al1', 'cd-a-30', A, 'auto', '2026-10-12');
  await al('al2', 'cd-a-31', A, 'auto', '2026-10-12');
  await al('al3', 'cd-a-32', A, 'merge', '2026-10-12');
  await al('al4', 'cd-a-33', A, 'manual', '2026-10-13');
  await al('al5', 'cd-b-30', B, 'inbound', '2026-10-13');
  await al('al6', 'cd-b-31', B, 'release', '2026-10-12');

  // Звонки. A, 12-е: 09:05, 09:40, 10:05, 15:00 — 3 часа; импортный в 10:20 не считается; 13-е: offline в 14:00
  await seedCall(sql, { id: 'c1', cardId: 'cd-a-30', clientId: 'cl-a-30', userId: A, at: at(12, 9, 5), kind: 'no_answer' });
  await seedCall(sql, { id: 'c2', cardId: 'cd-a-31', clientId: 'cl-a-31', userId: A, at: at(12, 9, 40), kind: 'callback' });
  await seedCall(sql, { id: 'c3', cardId: 'cd-a-30', clientId: 'cl-a-30', userId: A, at: at(12, 10, 5), kind: 'agreed', lpr: 'yes' });
  await seedCall(sql, { id: 'c4', cardId: 'cd-a-30', clientId: 'cl-a-30', userId: A, at: at(12, 10, 20), kind: 'agreed', via: 'import' });
  await seedCall(sql, { id: 'c9', cardId: 'cd-a-32', clientId: 'cl-a-32', userId: A, at: at(12, 15, 0), kind: 'not_target' });
  await sql`UPDATE calls SET reason_code = 'ip' WHERE id = 'c9'`;
  await seedCall(sql, { id: 'c5', cardId: 'cd-a-30', clientId: 'cl-a-30', userId: A, at: at(13, 14, 0), kind: 'agreed', lpr: 'yes', via: 'offline' });
  // B, 13-е: 10:00, 11:00, 11:30, 12:00 — 3 часа
  await seedCall(sql, { id: 'c8', cardId: 'cd-b-32', clientId: 'cl-b-32', userId: B, at: at(13, 10, 0), kind: 'agreed', lpr: 'yes' });
  await seedCall(sql, { id: 'c6', cardId: 'cd-b-30', clientId: 'cl-b-30', userId: B, at: at(13, 11, 0), kind: 'not_interested' });
  await seedCall(sql, { id: 'c7', cardId: 'cd-b-30', clientId: 'cl-b-30', userId: B, at: at(13, 11, 30), kind: 'no_answer' });
  await seedCall(sql, { id: 'c11', cardId: 'cd-b-31', clientId: 'cl-b-31', userId: B, at: at(13, 12, 0), kind: 'agreed', lpr: 'yes' });
  // Первый «ЛПР да» карточки cd-b-32 был раньше периода (11-е): в периоде этот «да» уже не первый
  await seedCall(sql, { id: 'c10', cardId: 'cd-b-32', clientId: 'cl-b-32', userId: A, at: at(11, 12, 0), kind: 'agreed', lpr: 'yes' });
  // РОП вносит итоги вручную (manual_entry): сотрудник вне раздачи, но с числами; один из них — только факт
  await seedCall(sql, { id: 'c12', cardId: 'cd-a-34', clientId: 'cl-a-34', userId: U.rop, at: at(13, 10, 0), kind: 'not_interested', via: 'manual_entry' });
  await seedCall(sql, { id: 'c13', cardId: 'cd-a-35', clientId: 'cl-a-35', userId: U.rop, at: at(13, 10, 30), kind: 'not_interested', via: 'manual_entry' });
  await seedCall(sql, { id: 'c14', cardId: 'cd-a-36', clientId: 'cl-a-36', userId: U.rop, at: at(13, 11, 0), kind: 'not_interested', via: 'manual_entry', applied: 'fact_only' });
  await sql`UPDATE calls SET reason_code = 'busy' WHERE id IN ('c6', 'c12', 'c14')`;
  await sql`UPDATE calls SET reason_code = 'later' WHERE id = 'c13'`;

  // Сделки (до записей: у записи есть ссылка на сделку)
  await insertDeal({ id: 'd1', client: 'cl-a-30', card: 'cd-a-30', owner: B, status: 'won', at: at(13, 12), amount: 100_000, service: 'consult' });
  await insertDeal({ id: 'd2', client: 'cl-a-30', card: 'cd-a-30', owner: B, status: 'won', at: at(14, 12), amount: 50_000, service: 'consult' });
  await insertDeal({ id: 'd3', client: 'cl-a-31', card: 'cd-a-31', owner: A, status: 'won', at: at(14, 13), amount: 400_000, service: 'master' });
  await insertDeal({ id: 'd4', client: 'cl-a-33', card: 'cd-a-33', owner: A, status: 'lost', at: at(13, 15), lostReason: 'price' });

  // Групповое мероприятие для записи bk1
  await sql`INSERT INTO events (id, space_id, event_type_key, event_date, start_time, starts_at, duration_min, capacity, created_at, updated_at)
            VALUES ('ev-r3a', ${SPACE}, 'group', '2026-10-13', '15:00', ${at(13, 15)}, 180, 30, ${at(10, 9)}, ${at(10, 9)})`;
  // Записи. bk1 — групповая, посещена, с покупкой d1 (автор записи A, владелец сделки B)
  await insertBooking({ id: 'bk1', kind: 'group', type: 'group', client: 'cl-a-30', card: 'cd-a-30', date: '2026-10-13', startsAt: at(13, 15), status: 'attended', by: A, createdAt: at(12, 10, 30), eventId: 'ev-r3a', dealId: 'd1' });
  await insertBooking({ id: 'bk2', kind: 'individual', type: 'consult', client: 'cl-a-31', card: 'cd-a-31', date: '2026-10-13', startsAt: at(13, 11), status: 'no_show', by: A, createdAt: at(12, 11), resource: 'rs-cons' });
  // Цепочка переноса: bk3a → bk3b; считается голова bk3a, bk3b (создана 13-го) — нет
  await insertBooking({ id: 'bk3b', kind: 'individual', type: 'consult', client: 'cl-a-32', card: 'cd-a-32', date: '2026-10-14', startsAt: at(14, 11), status: 'confirmed', by: A, createdAt: at(13, 9) });
  await insertBooking({ id: 'bk3a', kind: 'individual', type: 'consult', client: 'cl-a-32', card: 'cd-a-32', date: '2026-10-13', startsAt: at(13, 11), status: 'moved', by: A, createdAt: at(12, 12) });
  await sql`UPDATE bookings SET moved_from_id = 'bk3a' WHERE id = 'bk3b'`;
  await sql`UPDATE bookings SET moved_to_id = 'bk3b' WHERE id = 'bk3a'`;
  // Отмена «ошибка оператора» — не считается нигде
  await insertBooking({ id: 'bk4', kind: 'individual', type: 'consult', client: 'cl-a-33', card: 'cd-a-33', date: '2026-10-13', startsAt: at(13, 11), status: 'cancelled', cancelReason: 'operator_error', by: A, createdAt: at(12, 13) });
  // Импортная запись: не в «Записях», но в явке
  await insertBooking({ id: 'bk5', kind: 'individual', type: 'consult', client: 'cl-b-33', card: 'cd-b-33', date: '2026-10-12', startsAt: at(12, 11), status: 'attended', by: B, createdAt: at(10, 9), via: 'import', resource: 'rs-cons' });
  // Отмена клиентом: считается в «Записях» (создана) и в «отменено»
  await insertBooking({ id: 'bk6', kind: 'individual', type: 'consult', client: 'cl-b-34', card: 'cd-b-34', date: '2026-10-14', startsAt: at(14, 11), status: 'cancelled', cancelReason: 'client', by: B, createdAt: at(13, 10) });
  // Резерв в явке не участвует
  await insertBooking({ id: 'bk7', kind: 'individual', type: 'consult', client: 'cl-b-35', card: 'cd-b-35', date: '2026-10-13', startsAt: at(13, 11), status: 'attended', by: B, createdAt: at(13, 11), reserve: true });

  // Пропуски A: два 12-го, один 13-го; B вне периода
  await sql`INSERT INTO skips (id, space_id, user_id, card_id, day, created_at) VALUES
            ('k1', ${SPACE}, ${A}, 'cd-a-40', '2026-10-12', ${at(12, 9)}), ('k2', ${SPACE}, ${A}, 'cd-a-41', '2026-10-12', ${at(12, 9)}),
            ('k3', ${SPACE}, ${A}, 'cd-a-42', '2026-10-13', ${at(13, 9)}), ('k4', ${SPACE}, ${B}, 'cd-b-40', '2026-10-20', ${at(20, 9)})`;
});
after(async () => {
  leaveReportsConfig();
  await closeWorld(db);
});

const asOperators = async (q: ReportQuery, who: string = U.rop) => (await getReport(await viewerOf(who), q)) as Awaited<ReturnType<typeof getReport<Extract<ReportQuery, { key: 'operators' }>>>>;
const rowOf = (r: { rows: { userId: string }[] }, id: string) => r.rows.find((x) => x.userId === id) as unknown as Record<string, number | string | boolean | null>;

test('операторы: оператор A — все определения за период', async () => {
  const r = await asOperators(op());
  const a = rowOf(r, U.opA);
  assert.equal(a.issued, 3); // auto×2 + manual; merge не входит
  assert.equal(a.outcomes, 5); // импортный итог не считается, итог 11-го — вне периода; offline — считается
  assert.equal(a.connects, 4); // callback, agreed, not_target, agreed
  assert.equal(a.lpr, 1); // первый «ЛПР да» карточки cd-a-30; повторный 13-го и «да» по cd-b-32 (первый был 11-го) не считаются
  assert.equal(a.groups, 1);
  assert.equal(a.consults, 2); // bk2 и голова цепочки bk3a; bk3b и «ошибка оператора» нет
  assert.equal(a.attended, 1);
  assert.equal(a.noShow, 1);
  assert.equal(a.attendanceRate, 50);
  assert.equal(a.purchases, 2); // d1 — автору первой записи (A, хотя владелец B); d3 — владельцу (записей нет)
  assert.equal(a.purchaseSumKzt, 500_000);
  assert.equal(a.skips, 3);
  assert.equal(a.workedHours, 4); // 12-е: 09, 10, 15; 13-е: 14
  assert.equal(a.callsPerHour, 1.3);
  assert.equal(a.belowTarget, true); // норма 10: мягкая отметка
});

test('операторы: оператор B — импортная запись в явке, не в записях; покупка владельцу без записи', async () => {
  const b = rowOf(await asOperators(op()), U.opB);
  assert.equal(b.issued, 1); // inbound; release не входит
  assert.equal(b.outcomes, 4);
  assert.equal(b.connects, 3);
  assert.equal(b.lpr, 1); // cd-b-31 — первый «да» 13-го
  assert.equal(b.groups, 0);
  assert.equal(b.consults, 2); // bk6 (отмена клиентом считается созданной) и резерв bk7 (запись создана); импорт bk5 — нет
  assert.equal(b.attended, 1); // bk5 импорт — в явке; резерв bk7 — нет
  assert.equal(b.attendanceRate, 100);
  assert.equal(b.purchases, 1); // d2
  assert.equal(b.purchaseSumKzt, 50_000);
  assert.equal(b.workedHours, 3);
  assert.equal(b.callsPerHour, 1.3);
});

test('операторы: сотрудник вне раздачи с итогами manual_entry виден; дежурный без данных — нулевая строка', async () => {
  const r = await asOperators(op());
  const rop = rowOf(r, U.rop);
  assert.equal(rop.outcomes, 3);
  assert.equal(rop.workedHours, 2);
  const duty = rowOf(r, U.duty);
  assert.equal(duty.outcomes, 0);
  assert.equal(duty.callsPerHour, null);
  assert.equal(duty.belowTarget, false);
  assert.equal(r.totals.outcomes, 5 + 4 + 3);
});

test('операторы: корзины по дням и неделям; неделя с понедельника', async () => {
  const byDay = await asOperators(op({ grouping: 'day', userIds: [U.opA] }));
  assert.deepEqual(byDay.rows.map((x) => [x.bucket, x.outcomes]), [['2026-10-12', 4], ['2026-10-13', 1], ['2026-10-14', 0]]); // 14-го у A только покупка (d3);
  const byWeek = await asOperators(op({ grouping: 'week', userIds: [U.opA] }));
  assert.deepEqual(byWeek.rows.map((x) => [x.bucket, x.outcomes]), [['2026-10-12', 5]]); // 12.10.2026 — понедельник
});

test('фильтры: сотрудники и источник (первый источник клиента по first_seen_at)', async () => {
  const only = await asOperators(op({ userIds: [U.opB] }));
  assert.deepEqual(only.rows.map((x) => x.userId), [U.opB]);
  const src = await asOperators(op({ sourceKey: 'new_base', userIds: [U.opA, U.opB] }));
  const a = rowOf(src, U.opA);
  assert.equal(a.outcomes, 3); // c1, c3, c5 по клиенту cl-a-30; импортный не считается
  assert.equal(a.groups, 1); // bk1
  assert.equal(a.issued, 1); // cd-a-30
  assert.equal(rowOf(src, U.opB).purchases, 1); // d2 — клиент cl-a-30
  // второй источник клиента (manual) первым не считается
  const manual = await asOperators(op({ sourceKey: 'manual', userIds: [U.opA] }));
  assert.equal(rowOf(manual, U.opA).outcomes, 0);
  // клиент без ключа источника — по виду
  const imp = await asOperators(op({ sourceKey: 'import', userIds: [U.opA] }));
  assert.equal(rowOf(imp, U.opA).outcomes, 1); // c2
});

test('воронка по операторам: шаги и конверсия к предыдущему шагу', async () => {
  const f = (await getReport(await viewerOf(U.rop), { key: 'funnel', period: PERIOD, filters: NO_FILTERS, by: 'operator' }));
  const a = f.rows.find((x) => x.key === U.opA)!;
  assert.deepEqual(a.counts, { issued: 3, connected: 4, lpr: 1, booked: 3, attended: 1, purchased: 2 });
  assert.equal(a.rates.issued, null);
  assert.equal(a.rates.connected, 133.3);
  assert.equal(a.rates.lpr, 25);
  assert.equal(f.total.counts.issued, 4);
  assert.equal(f.total.counts.purchased, 3);
});

test('воронка по источникам: первый источник клиента, без источника — пустой ключ', async () => {
  const f = (await getReport(await viewerOf(U.rop), { key: 'funnel', period: PERIOD, filters: NO_FILTERS, by: 'source' }));
  const by = Object.fromEntries(f.rows.map((r) => [r.key, r.counts]));
  assert.deepEqual(by.new_base, { issued: 1, connected: 2, lpr: 1, booked: 1, attended: 1, purchased: 2 });
  assert.deepEqual(by.import, { issued: 1, connected: 1, lpr: 0, booked: 1, attended: 0, purchased: 1 });
  assert.equal(by['']?.issued, 2);
  assert.equal(f.total.counts.connected, 10); // A 4 + B 3 + РОП 3 (manual_entry)
});

test('выручка: типы услуг, первые и повторные покупки клиента', async () => {
  const r = (await getReport(await viewerOf(U.rop), { key: 'revenue', period: PERIOD, filters: NO_FILTERS }));
  assert.deepEqual(r.rows.map((x) => x.serviceTypeKey), ['master', 'consult']);
  const consult = r.rows[1]!;
  assert.deepEqual([consult.purchases, consult.sumKzt, consult.firstPurchases, consult.firstSumKzt, consult.repeatPurchases, consult.repeatSumKzt], [2, 150_000, 1, 100_000, 1, 50_000]);
  assert.equal(r.total.sumKzt, 550_000);
  // «повторная» — по всей истории клиента: период с 14-го видит d2 как повторную покупку
  const day14 = (await getReport(await viewerOf(U.rop), { key: 'revenue', period: { from: '2026-10-14', to: '2026-10-14' }, filters: NO_FILTERS }));
  const c14 = day14.rows.find((x) => x.serviceTypeKey === 'consult')!;
  assert.deepEqual([c14.purchases, c14.firstPurchases, c14.repeatPurchases], [1, 0, 1]);
  // по автору покупки: только B → d2
  const byB = (await getReport(await viewerOf(U.rop), { key: 'revenue', period: PERIOD, filters: { userIds: [U.opB], sourceKey: null } }));
  assert.deepEqual(byB.rows.map((x) => [x.serviceTypeKey, x.sumKzt]), [['consult', 50_000]]);
});

test('явка по типам событий: без резерва, «не отмечено» только по прошедшим; отмена «ошибка оператора» не считается', async () => {
  const r = (await getReport(await viewerOf(U.rop), { key: 'attendance', period: PERIOD, filters: NO_FILTERS, by: 'event_type' }));
  const consult = r.rows.find((x) => x.key === 'consult')!;
  assert.deepEqual([consult.booked, consult.attended, consult.noShow, consult.unmarked, consult.cancelled, consult.rate], [3, 1, 1, 1, 1, 50]);
  const group = r.rows.find((x) => x.key === 'group')!;
  assert.deepEqual([group.booked, group.attended, group.rate, group.purchases], [1, 1, 100, 1]);
  assert.equal(r.total.purchases, 1);
});

test('явка по консультантам и авторам: серые консультации — пустой ключ', async () => {
  const c = (await getReport(await viewerOf(U.rop), { key: 'attendance', period: PERIOD, filters: NO_FILTERS, by: 'consultant' }));
  const cons = c.rows.find((x) => x.key === U.consultant);
  assert.equal(cons?.name, 'Консультант Синтетик');
  assert.equal(cons?.attended, 1); // bk5 у ресурса консультанта (импорт — в явке)
  assert.ok(c.rows.some((x) => x.key === '')); // записи без ресурса
  const au = (await getReport(await viewerOf(U.rop), { key: 'attendance', period: PERIOD, filters: NO_FILTERS, by: 'author' }));
  assert.equal(au.rows.find((x) => x.key === U.opA)?.booked, 3);
});

test('причины: доля внутри группы; факт без применения и импорт не считаются; потерянные сделки', async () => {
  const r = (await getReport(await viewerOf(U.rop), { key: 'reasons', period: PERIOD, filters: NO_FILTERS }));
  assert.deepEqual(
    r.rows.map((x) => [x.group, x.reasonCode, x.count, x.share]),
    [
      ['not_interested', 'busy', 2, 66.7], // c6, c12; c14 — только факт
      ['not_interested', 'later', 1, 33.3],
      ['not_target', 'ip', 1, 100],
      ['deal_lost', 'price', 1, 100],
    ],
  );
});

test('доступ: РОП и директор — да; оператор, консультант, руководитель отдела — 403', async () => {
  assert.equal((await asOperators(op(), U.director)).rows.length, 4);
  for (const id of [U.opA, U.consultant, U.mktHead, U.marketer]) {
    await assert.rejects(getReport(await viewerOf(id), op()), (e: { code?: string }) => e.code === 'forbidden', id);
  }
});

test("период: больше 92 дней, from > to, будущее дальше завтра — 400 period_invalid", async () => {
  const viewer = await viewerOf(U.rop);
  for (const [from, to] of [["2026-07-01", "2026-10-01"], ["2026-10-14", "2026-10-12"], ["2026-10-28", "2026-10-30"]] as const) {
    await assert.rejects(getReport(viewer, { key: "revenue", period: { from, to }, filters: NO_FILTERS }), (e: { code?: string; detail?: string }) => e.code === "bad_request" && e.detail === "period_invalid", `${from}…${to}`);
  }
});

test('в ответах нет данных клиентов: ни названий, ни номеров', async () => {
  const viewer = await viewerOf(U.rop);
  for (const q of [op(), { key: 'funnel', period: PERIOD, filters: NO_FILTERS, by: 'source' }, { key: 'attendance', period: PERIOD, filters: NO_FILTERS, by: 'author' }] as ReportQuery[]) {
    const text = JSON.stringify(await getReport(viewer, q));
    assert.ok(!text.includes('Синтетика Альфа') && !text.includes('Синтетика Бета'));
    assert.ok(!/7709\d{6}/.test(text));
  }
});

test('маршрут /api/reports/[key]: РОП 200 без кэша; неизвестный отчёт 404; плохие параметры 400; оператор 403; гость 401', async () => {
  const get = async (as: string | null, key: string, qs = '') => {
    actAs(as);
    return reportRoute.GET(new Request(`http://crm.test/api/reports/${key}?from=2026-10-12&to=2026-10-14${qs}`), { params: Promise.resolve({ key }) });
  };
  const ok = await get(U.rop, 'operators', '&group=day');
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = (await ok.json());
  assert.equal(body.grouping, 'day');
  assert.ok(body.rows.length > 0);
  assert.equal((await get(U.director, 'revenue')).status, 200);
  assert.equal((await get(U.rop, 'nope')).status, 404);
  assert.equal((await get(U.rop, 'revenue', '&group=day')).status, 400); // лишний параметр
  const wide = await get(U.rop, 'revenue', '&from=2026-01-01');
  assert.equal(wide.status, 400);
  assert.deepEqual(await wide.json(), { error: 'bad_request', detail: 'period_invalid' });
  assert.equal((await get(U.opA, 'operators')).status, 403);
  assert.equal((await get(null, 'operators')).status, 401);
});
