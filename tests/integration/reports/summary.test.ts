// Сводка дня РОП (R1a): плитки, таблица операторов, права и маршрут. Синтетика мира изоляции + свои строки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as summaryRoute from '../../../src/app/api/reports/summary/route';
import { getSummary } from '../../../src/server/domain/reports';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { MIN, SEED_NOW, SEED_TODAY, SPACE, U, actAs, closeWorld, enterReportsConfig, leaveReportsConfig, openWorld, seedCall, seedPool, viewerOf } from './helpers';

let db: TestDb;
const clock = { now: SEED_NOW };
const rowOf = (s: Awaited<ReturnType<typeof getSummary>>, id: string) => s.operators.find((o) => o.userId === id)!;

before(async () => {
  db = await openWorld();
  enterReportsConfig(clock);
  const sql = db.sql;
  await seedPool(sql, 20);
  await sql`UPDATE cards SET hold_reason = 'dup_pair' WHERE id IN ('pc-19', 'pc-20')`;
  await sql`UPDATE cards SET hold_reason = 'import_conflict' WHERE id = 'pc-18'`;

  // Выдано сегодня: оператору A 3 ручных (входят в лимит), дежурному — 1 «слияние» (не лимит)
  for (let i = 0; i < 3; i++) {
    await sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
              VALUES (${`al-${i}`}, ${SPACE}, ${`pc-${i + 1}`}, NULL, ${U.opA}, 'manual', TRUE, 'seed', ${SEED_TODAY}, NULL, ${SEED_NOW - 3 * 60 * MIN})`;
  }
  await sql`INSERT INTO assign_log (id, space_id, card_id, from_user_id, to_user_id, kind, counts_to_cap, run_id, day, actor_id, created_at)
            VALUES ('al-merge', ${SPACE}, 'pc-4', NULL, ${U.duty}, 'merge', FALSE, 'seed', ${SEED_TODAY}, NULL, ${SEED_NOW})`;

  // Звонки оператора A: два в один местный час (10:xx), два в другой (09:xx) — 2 часа в работе;
  // импортный звонок и звонок вчера не считаются
  const at = (h: number, m: number) => Date.UTC(2026, 9, 28, h - 5, m); // местное время Алматы (UTC+5)
  await seedCall(sql, { id: 'c1', cardId: 'cd-a-2', clientId: 'cl-a-2', userId: U.opA, at: at(9, 5), kind: 'no_answer' });
  await seedCall(sql, { id: 'c2', cardId: 'cd-a-3', clientId: 'cl-a-3', userId: U.opA, at: at(9, 40), kind: 'callback' });
  await seedCall(sql, { id: 'c3', cardId: 'cd-a-4', clientId: 'cl-a-4', userId: U.opA, at: at(10, 5), kind: 'agreed', lpr: 'yes' });
  await seedCall(sql, { id: 'c4', cardId: 'cd-a-4', clientId: 'cl-a-4', userId: U.opA, at: at(10, 20), kind: 'not_interested', lpr: 'yes' });
  await seedCall(sql, { id: 'c5', cardId: 'cd-a-5', clientId: 'cl-a-5', userId: U.opA, at: at(10, 25), kind: 'agreed', via: 'import' });
  await seedCall(sql, { id: 'c6', cardId: 'cd-a-5', clientId: 'cl-a-5', userId: U.opA, at: at(10, 26) - 24 * 60 * MIN, kind: 'agreed' });

  // Просроченные перезвоны: у A две (порог 60 мин), одна свежая; у B одна
  await sql`UPDATE cards SET state = 'callback', next_call_at = ${SEED_NOW - 2 * 60 * MIN} WHERE id IN ('cd-a-10', 'cd-a-11', 'cd-b-10')`;
  await sql`UPDATE cards SET state = 'callback', next_call_at = ${SEED_NOW - 10 * MIN} WHERE id = 'cd-a-12'`;

  // Устройства: у A два с неотправленным, у B ноль
  await sql`INSERT INTO device_status (user_id, device_id, pending_outbox, last_flush_at, seen_at) VALUES
            (${U.opA}, 'dev-a1', 3, ${SEED_NOW - 30 * MIN}, ${SEED_NOW - MIN}),
            (${U.opA}, 'dev-a2', 2, NULL, ${SEED_NOW - 20 * MIN}),
            (${U.opB}, 'dev-b1', 0, ${SEED_NOW - 5 * MIN}, ${SEED_NOW - 5 * MIN})`;

  // Пропуски A сегодня: 2; вчера — не считаются
  await sql`INSERT INTO skips (id, space_id, user_id, card_id, day, created_at) VALUES
            ('sk1', ${SPACE}, ${U.opA}, 'cd-a-6', ${SEED_TODAY}, ${SEED_NOW}), ('sk2', ${SPACE}, ${U.opA}, 'cd-a-7', ${SEED_TODAY}, ${SEED_NOW}),
            ('sk3', ${SPACE}, ${U.opA}, 'cd-a-8', '2026-10-27', ${SEED_NOW - 86_400_000})`;

  // Пауза B сегодня, отсутствие дежурного
  await sql`UPDATE memberships SET paused_on = ${SEED_TODAY} WHERE user_id = ${U.opB}`;
  await sql`INSERT INTO absences (id, space_id, user_id, from_day, to_day, created_at) VALUES ('ab1', ${SPACE}, ${U.duty}, '2026-10-27', '2026-10-30', ${SEED_NOW - 86_400_000})`;

  // Записи, созданные A сегодня: групповая (гость мероприятия) и «серая» консультация без консультанта; отменённая не считается
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, booking_date, start_time, starts_at, duration_min, status,
                                  booked_by_user_id, responsible_user_id, created_at, updated_at)
            VALUES ('bk-group', ${SPACE}, 'group', 'group', 'ev-today', 'cl-a-20', 'cd-a-20', ${SEED_TODAY}, '15:00', ${SEED_NOW}, 180, 'confirmed', ${U.opA}, ${U.opA}, ${SEED_NOW - 30 * MIN}, ${SEED_NOW}),
                   ('bk-cancel', ${SPACE}, 'group', 'group', 'ev-today', 'cl-a-21', 'cd-a-21', ${SEED_TODAY}, '15:00', ${SEED_NOW}, 180, 'cancelled', ${U.opA}, ${U.opA}, ${SEED_NOW - 30 * MIN}, ${SEED_NOW})`;
  await sql`INSERT INTO bookings (id, space_id, kind, event_type_key, client_id, card_id, booking_date, start_time, starts_at, duration_min, status,
                                  booked_by_user_id, responsible_user_id, created_at, updated_at)
            VALUES ('bk-grey', ${SPACE}, 'individual', 'consult', 'cl-a-22', 'cd-a-22', '2026-10-29', '11:00', ${SEED_NOW + 86_400_000}, 45, 'registered', ${U.opA}, ${U.opA}, ${SEED_NOW - 20 * MIN}, ${SEED_NOW}),
                   ('bk-grey-old', ${SPACE}, 'individual', 'consult', 'cl-a-23', 'cd-a-23', '2026-10-20', '11:00', ${SEED_NOW - 8 * 86_400_000}, 45, 'registered', ${U.opA}, ${U.opA}, ${SEED_NOW - 9 * 86_400_000}, ${SEED_NOW})`;
});
after(async () => {
  leaveReportsConfig();
  await closeWorld(db);
});

test('РОП: плитки сводки', async () => {
  const s = await getSummary(await viewerOf(U.rop));
  assert.equal(s.day, SEED_TODAY);
  // подписи видов записи для колонок «Записи на {event}» (A6): объект с двумя строками, без настроек — пустые
  assert.deepEqual(Object.keys(s.eventLabels).sort(), ['group', 'individual']);
  // пул: 17 готовых (20 − 2 дубля − 1 конфликт), три выдано A выше из pc-1..3 только в журнале, карточки остались в пуле
  assert.equal(s.tiles.pool.ready, 17);
  assert.equal(s.tiles.pool.duplicates, 2);
  assert.equal(s.tiles.pool.disputed, 1);
  // запас: A 37 + (B на паузе, дежурный отсутствует — не считаются) = 37; сверх лимита max(0, 17 − 37) = 0
  assert.equal(s.tiles.pool.overCap, 0);
  // лимит: участвуют A и B (дежурный отсутствует) → 2 × 40
  assert.deepEqual(s.tiles.issued, { issued: 3, cap: 80, operators: 2 });
  // серая консультация: одна на 29.10; просроченная прошлая и записи с консультантом не считаются
  assert.equal(s.tiles.grey.waiting, 1);
  // сегодня: bk-other (seed), гость мероприятия (seed), bk-group; отменённая не в счёт; подтвердили — bk-groups
  assert.deepEqual(s.tiles.bookings.today, { total: 3, confirmed: 1 });
  // завтра: bk-in (seed), гость завтрашнего мероприятия, bk-grey
  assert.deepEqual(s.tiles.bookings.tomorrow, { total: 3, confirmed: 0 });
  assert.deepEqual(s.tiles.overdue, { cards: 3, operators: 2 });
  assert.equal(s.alarm, true);
  assert.deepEqual(s.tiles.unsent, { pending: 5, operators: 1 });
});

test('ссылки на доску (К1): колонка перезвона при OP_BOARD, без флага — ссылок нет', async () => {
  const rop = await viewerOf(U.rop);
  process.env.FEATURE_OP_BOARD = '0';
  try {
    assert.deepEqual((await getSummary(rop)).board, { on: false, callbackTab: null });
    process.env.FEATURE_OP_BOARD = '1';
    assert.deepEqual((await getSummary(rop)).board, { on: true, callbackTab: 'callback' });
  } finally {
    delete process.env.FEATURE_OP_BOARD;
  }
});

test('РОП: таблица операторов', async () => {
  const s = await getSummary(await viewerOf(U.rop));
  assert.deepEqual(s.operators.map((o) => o.userId).sort(), [U.duty, U.opA, U.opB].sort());
  const a = rowOf(s, U.opA);
  assert.equal(a.status, 'working');
  assert.deepEqual([a.issued, a.cap], [3, 40]);
  // итогов 4 (импорт и вчерашний не считаются), дозвонов 3 (callback, agreed, not_interested), ЛПР — по карточкам: 1
  assert.deepEqual([a.outcomes, a.connects, a.lpr], [4, 3, 1]);
  assert.deepEqual([a.workedHours, a.callsPerHour, a.belowTarget], [2, 2, true]);
  assert.deepEqual([a.groups, a.consults, a.skips, a.overdue], [1, 1, 2, 2]);
  assert.deepEqual([a.unsent, a.lastSeenAt, a.lastFlushAt], [5, SEED_NOW - MIN, SEED_NOW - 30 * MIN]);
  const b = rowOf(s, U.opB);
  assert.equal(b.status, 'paused');
  assert.deepEqual([b.outcomes, b.callsPerHour, b.belowTarget, b.overdue, b.unsent], [0, null, false, 1, 0]);
  const duty = rowOf(s, U.duty);
  assert.equal(duty.status, 'absent');
  assert.equal(duty.absentUntil, '2026-10-30');
  assert.equal(duty.issued, 0); // «слияние» в лимит не входит
});

test('без нормы в настройках отметки «ниже нормы» нет', async () => {
  enterReportsConfig(clock, { callsPerHourTarget: null });
  const s = await getSummary(await viewerOf(U.rop));
  assert.equal(s.callsPerHourTarget, null);
  assert.ok(s.operators.every((o) => !o.belowTarget));
  enterReportsConfig(clock);
});

test('порог просрочки из настроек: 5 минут добавляет свежий перезвон', async () => {
  enterReportsConfig(clock, { overdueAlertMinutes: 5 });
  const s = await getSummary(await viewerOf(U.rop));
  assert.deepEqual(s.tiles.overdue, { cards: 4, operators: 2 });
  enterReportsConfig(clock);
});

test('красной тревоги нет, когда просрочки нет', async () => {
  await db.sql`UPDATE cards SET next_call_at = ${SEED_NOW + 60 * MIN} WHERE state = 'callback'`;
  const s = await getSummary(await viewerOf(U.rop));
  assert.equal(s.alarm, false);
  assert.deepEqual(s.tiles.overdue, { cards: 0, operators: 0 });
  await db.sql`UPDATE cards SET next_call_at = ${SEED_NOW - 2 * 60 * MIN} WHERE id IN ('cd-a-10', 'cd-a-11', 'cd-b-10')`;
});

test('директор видит ту же сводку; пул — по чтению карточек', async () => {
  const rop = await getSummary(await viewerOf(U.rop));
  const dir = await getSummary(await viewerOf(U.director));
  assert.deepEqual(dir.operators, rop.operators);
  assert.deepEqual(dir.tiles.issued, rop.tiles.issued);
  assert.deepEqual(dir.tiles.overdue, rop.tiles.overdue);
  assert.deepEqual(dir.tiles.bookings, rop.tiles.bookings);
  assert.equal(dir.tiles.pool.ready, 17);
  assert.equal(dir.tiles.pool.duplicates, 2);
  assert.equal(dir.tiles.pool.disputed, 1);
});

test('оператор, консультант и руководитель отдела сводку не получают', async () => {
  for (const id of [U.opA, U.consultant, U.mktHead, U.marketer]) {
    await assert.rejects(getSummary(await viewerOf(id)), (e: { code?: string; name?: string }) => e.name === 'ForbiddenError' || e.code === 'forbidden', id);
  }
});

test('маршрут /api/reports/summary: РОП и директор — 200 без кэша, оператор — 403, гость — 401', async () => {
  const get = async (as: string | null) => {
    actAs(as);
    return summaryRoute.GET(new Request('http://crm.test/api/reports/summary'), { params: Promise.resolve({}) });
  };
  const rop = await get(U.rop);
  assert.equal(rop.status, 200);
  assert.equal(rop.headers.get('cache-control'), 'no-store');
  const body = (await rop.json()) as { tiles: { pool: { ready: number } }; operators: unknown[] };
  assert.equal(body.tiles.pool.ready, 17);
  assert.equal(body.operators.length, 3);
  assert.equal((await get(U.director)).status, 200);
  assert.equal((await get(U.opA)).status, 403);
  assert.equal((await get(null)).status, 401);
});

test('в ответе нет данных клиентов: ни названий, ни номеров', async () => {
  const text = JSON.stringify(await getSummary(await viewerOf(U.rop)));
  assert.ok(!text.includes('Синтетика Альфа'));
  assert.ok(!text.includes('7709'));
});
