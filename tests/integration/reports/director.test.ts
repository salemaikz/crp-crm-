// Панель директора (R4, D-265): числа недели и прошлой недели, запас, права и маршрут. Только синтетика.
// Блокировку мутаций директору (423) проверяет прогон изоляции: tests/isolation/runner/runner.ts.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as directorRoute from '../../../src/app/api/reports/director/route';
import { ForbiddenError } from '../../../src/server/access';
import { getDirectorDashboard, getSummary } from '../../../src/server/domain/reports';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { DAY, MIN, SEED_NOW, SEED_TODAY, SPACE, U, actAs, closeWorld, enterReportsConfig, leaveReportsConfig, openWorld, seedCall, seedPool, viewerOf } from './helpers';

let db: TestDb;
let base: Awaited<ReturnType<typeof getDirectorDashboard>>; // числа мира изоляции до собственных звонков
const clock = { now: SEED_NOW };

before(async () => {
  db = await openWorld();
  enterReportsConfig(clock);
  await seedPool(db.sql, 20);
  base = await getDirectorDashboard(await viewerOf(U.director));
  // Эта неделя (пн 26.10 … ср 28.10): два итога A, один из них дозвон; прошлая неделя: один итог 22.10
  await seedCall(db.sql, { id: 'd1', cardId: 'cd-a-2', clientId: 'cl-a-2', userId: U.opA, at: SEED_NOW - 2 * 60 * MIN, kind: 'no_answer' });
  await seedCall(db.sql, { id: 'd2', cardId: 'cd-a-3', clientId: 'cl-a-3', userId: U.opA, at: SEED_NOW - 90 * MIN, kind: 'agreed' });
  await seedCall(db.sql, { id: 'd3', cardId: 'cd-a-4', clientId: 'cl-a-4', userId: U.opA, at: SEED_NOW - 6 * DAY, kind: 'agreed' });
});
after(async () => {
  leaveReportsConfig();
  await closeWorld(db);
});

test('итог с канала board увеличивает итоги, но не дозвоны', async () => {
  const v = await viewerOf(U.director);
  const before = await getDirectorDashboard(v);
  await seedCall(db.sql, { id: 'd4', cardId: 'cd-a-5', clientId: 'cl-a-5', userId: U.opA, at: SEED_NOW - 30 * MIN, kind: 'agreed', via: 'board' });
  const after = await getDirectorDashboard(v);
  assert.equal(after.calls.outcomes, before.calls.outcomes + 1);
  assert.equal(after.calls.connects, before.calls.connects);
  assert.equal(typeof after.calls.prevConnects, 'number');
  assert.deepEqual(Object.keys(after.eventLabels).sort(), ['group', 'individual']);
  await db.sql`DELETE FROM calls WHERE id = 'd4'`;
});

test('в плитке «Явка» unmarked равен числу записей недели с прошедшей датой без отметки', async () => {
  const v = await viewerOf(U.director);
  const before = await getDirectorDashboard(v);
  const mk = async (id: string, status: string, startsAt: number, card: string, client: string) => {
    await db.sql`
      INSERT INTO bookings (id, space_id, kind, event_type_key, client_id, card_id, booking_date, start_time, starts_at, duration_min, status, via,
                            booked_by_user_id, responsible_user_id, created_at, updated_at)
      VALUES (${id}, ${SPACE}, 'individual', 'consult', ${client}, ${card}, ${before.week.to}, '09:00', ${startsAt}, 60, ${status}, 'ui', ${U.opA}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW})`;
  };
  // две прошедшие без отметки, одна будущая (не «не отмечено») и одна отмеченная
  await mk('bk-um-1', 'registered', SEED_NOW - 3 * 60 * MIN, 'cd-a-2', 'cl-a-2');
  await mk('bk-um-2', 'confirmed', SEED_NOW - 2 * 60 * MIN, 'cd-a-3', 'cl-a-3');
  await mk('bk-um-3', 'registered', SEED_NOW + 60 * MIN, 'cd-a-4', 'cl-a-4');
  await mk('bk-um-4', 'attended', SEED_NOW - 4 * 60 * MIN, 'cd-a-5', 'cl-a-5');
  try {
    const d = await getDirectorDashboard(v);
    assert.equal(d.attendance.unmarked, before.attendance.unmarked + 2);
    assert.equal(d.attendance.attended, before.attendance.attended + 1);
  } finally {
    await db.sql`DELETE FROM bookings WHERE id LIKE 'bk-um-%'`;
  }
});

test('?week=prev: прошлая неделя целиком, сравнение с предыдущей, те же числа, что в сравнении текущей недели', async () => {
  const v = await viewerOf(U.director);
  const cur = await getDirectorDashboard(v);
  const prev = await getDirectorDashboard(v, { week: 'prev' });
  assert.equal(cur.weekKey, 'current');
  assert.equal(prev.weekKey, 'prev');
  assert.deepEqual([prev.week.from, prev.week.to], [cur.prevWeek.from, cur.prevWeek.to]);
  assert.deepEqual([prev.prevWeek.from, prev.prevWeek.to], ['2026-10-12', '2026-10-18']);
  assert.equal(prev.calls.outcomes, cur.calls.prevOutcomes);
  assert.equal(prev.calls.connects, cur.calls.prevConnects);
  // неизвестное значение — текущая неделя
  assert.equal((await getDirectorDashboard(v, { week: 'next' as never })).weekKey, 'current');
});

test('причины на панели: топ-5 колонки «Мусор» по убыванию, оператору панели нет', async () => {
  const v = await viewerOf(U.director);
  for (const [i, code] of ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].entries()) {
    for (let k = 0; k <= i; k++) {
      await db.sql`
        INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, lpr, applied, fact_reason, occurred_at, received_at, config_rev, reason_code)
        VALUES (${`rs-${code}-${k}`}, ${SPACE}, 'cd-a-2', 'cl-a-2', ${U.opA}, 'ui', '', 'not_interested', 'not_interested', '', 'applied', '', ${SEED_NOW - 30 * MIN}, ${SEED_NOW - 30 * MIN}, 1, ${code})`;
    }
  }
  try {
    const d = await getDirectorDashboard(v);
    const trash = d.reasons.trash;
    assert.ok(trash, 'колонка «Мусор» из настроек');
    assert.equal(trash.key, 'trash');
    assert.equal(trash.top.length, 5);
    assert.deepEqual(trash.top.map((r) => r.reasonCode), ['r7', 'r6', 'r5', 'r4', 'r3']);
    assert.ok(trash.total >= 28);
    const sum = trash.top.reduce((s, r) => s + r.count, 0);
    assert.ok(sum <= trash.total);
    // доля — от итога блока (колонки), а не от всех причин
    assert.equal(trash.top[0]!.share, Math.round((trash.top[0]!.count / trash.total) * 1000) / 10);
    await assert.rejects(getDirectorDashboard(await viewerOf(U.opA)), ForbiddenError);
  } finally {
    await db.sql`DELETE FROM calls WHERE id LIKE 'rs-r%'`;
  }
});

test('«В пуле»: только число готовых к раздаче, без запаса в днях (требование руководителя)', async () => {
  const d = await getDirectorDashboard(await viewerOf(U.director));
  assert.deepEqual(Object.keys(d.stock), ['poolReady']);
  const s = await getSummary(await viewerOf(U.rop));
  assert.equal(d.stock.poolReady, s.tiles.pool.ready);
});

test('причины панели: «не придёт» через № 33 попадает в блок «Перезвон», старые события без кода не считаются', async () => {
  const v = await viewerOf(U.director);
  const before = await getDirectorDashboard(v);
  assert.ok(before.reasons.callback, 'колонка «Перезвон» из настроек');
  const ev = async (id: string, clientId: string, data: Record<string, unknown>, at = SEED_NOW - 20 * MIN) => {
    await db.sql`
      INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
      VALUES (${id}, ${clientId}, ${SPACE}, 'card.state', ${U.opA}, ${at}, 'card_move', ${id}, ${db.json(data)})`;
  };
  const exit = (toState: string, reasonCode?: string) => ({ fromState: 'agreed', toState, cause: 'agreed_exit', ...(reasonCode === undefined ? {} : { reasonCode }) });
  await ev('x33-a', 'cl-a-2', exit('callback', 'declined_br'));
  await ev('x33-b', 'cl-a-3', exit('callback', 'declined_br'));
  await ev('x33-old', 'cl-a-4', exit('callback')); // до D-355 кода не было: не считается
  await ev('x33-other', 'cl-a-5', { fromState: 'new', toState: 'callback', cause: 'call' }); // не № 33
  await ev('x33-week', 'cl-a-2', exit('callback', 'declined_br'), SEED_NOW - 20 * DAY); // не эта неделя
  try {
    const d = await getDirectorDashboard(v);
    const cb = d.reasons.callback!;
    assert.equal(cb.total, before.reasons.callback!.total + 2);
    const top = cb.top.find((r) => r.reasonCode === 'declined_br');
    assert.ok(top, 'причина № 33 в топе');
    assert.equal(top.count, 2);
    assert.equal(top.group, 'callback');
    // блок «Мусор» от выходов в «Перезвон» не меняется
    assert.equal(d.reasons.trash!.total, before.reasons.trash!.total);
    // охват: оператор панель не видит
    await assert.rejects(getDirectorDashboard(await viewerOf(U.opA)), ForbiddenError);
  } finally {
    await db.sql`DELETE FROM client_events WHERE id LIKE 'x33-%'`;
  }
});

test('причины панели: тот же код в звонке и в выходе № 33 даёт одну строку с суммой; выход в «Не заинтересован» входит в «Мусор»', async () => {
  const v = await viewerOf(U.director);
  const before = await getDirectorDashboard(v);
  const cnt = (blk: { top: { group: string; reasonCode: string; count: number }[] }, group: string, code: string) => blk.top.find((r) => r.group === group && r.reasonCode === code)?.count ?? 0;
  const ev = async (id: string, clientId: string, data: Record<string, unknown>) => {
    await db.sql`
      INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, ref_type, ref_id, data)
      VALUES (${id}, ${clientId}, ${SPACE}, 'card.state', ${U.opA}, ${SEED_NOW - 20 * MIN}, 'card_move', ${id}, ${db.json(data)})`;
  };
  const exit = (toState: string, reasonCode: string) => ({ fromState: 'agreed', toState, cause: 'agreed_exit', reasonCode });
  // звонки с тем же кодом, что и у выходов, и с кодом, которого у выходов нет
  const callRow = async (id: string, kind: string, reason: string) => {
    await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, reason_code, lpr, applied, occurred_at, received_at, config_rev)
      SELECT ${id}, ${SPACE}, c.id, c.client_id, ${U.opA}, 'ui', '', ${kind}, ${kind}, ${reason}, '', 'applied', ${SEED_NOW - 10 * MIN}, ${SEED_NOW}, 1
        FROM cards c WHERE c.space_id = ${SPACE} LIMIT 1`;
  };
  await callRow('x33dup-c1', 'callback', 'x33dup_code');
  await callRow('x33dup-c2', 'callback', 'x33dup_code');
  await callRow('x33dup-c3', 'callback', 'x33dup_code');
  await ev('x33dup-a', 'cl-a-2', exit('callback', 'x33dup_code'));
  await ev('x33dup-b', 'cl-a-3', exit('callback', 'x33dup_code'));
  await ev('x33dup-n', 'cl-a-4', exit('not_interested', 'x33dup_trash'));
  try {
    const d = await getDirectorDashboard(v);
    const cb = d.reasons.callback!;
    const rows = cb.top.filter((r) => r.group === 'callback' && r.reasonCode === 'x33dup_code');
    assert.equal(rows.length, 1, 'одна строка, а не две');
    assert.equal(rows[0]!.count, cnt(before.reasons.callback!, 'callback', 'x33dup_code') + 5);
    assert.equal(cb.total, before.reasons.callback!.total + 5);
    const tr = d.reasons.trash!;
    assert.equal(tr.total, before.reasons.trash!.total + 1, 'выход № 33 в «Не заинтересован» входит в «Мусор»');
    assert.equal(cnt(tr, 'not_interested', 'x33dup_trash'), 1);
  } finally {
    await db.sql`DELETE FROM client_events WHERE id LIKE 'x33dup-%'`;
    await db.sql`DELETE FROM calls WHERE id LIKE 'x33dup-%'`;
  }
});

test('директор: неделя, прошлая неделя, запас', async () => {
  const v = await viewerOf(U.director);
  const d = await getDirectorDashboard(v);
  assert.deepEqual([d.week.from, d.week.to], ['2026-10-26', SEED_TODAY]);
  assert.deepEqual([d.prevWeek.from, d.prevWeek.to], ['2026-10-19', '2026-10-25']);
  assert.equal(d.generatedAt, SEED_NOW);
  assert.equal(d.calls.outcomes, base.calls.outcomes + 2);
  assert.equal(d.calls.connects, base.calls.connects + 1);
  assert.equal(d.calls.prevOutcomes, base.calls.prevOutcomes + 1);
  assert.equal(d.funnel.counts.connected, base.funnel.counts.connected + 1);
  assert.deepEqual(d.revenue, base.revenue);
  assert.equal(d.purchases.count, base.purchases.count);
  // запас согласован с плитками сводки РОП
  const s = await getSummary(await viewerOf(U.rop));
  assert.equal(d.stock.poolReady, s.tiles.pool.ready);
});

test('покупки без записи считаются отдельно и входят в покупки недели (D-261)', async () => {
  const v = await viewerOf(U.director);
  const before = await getDirectorDashboard(v);
  assert.equal(typeof before.purchases.withoutBooking, 'number');
  await db.sql`
    INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id, service_type_key, amount_kzt, won_at,
                       stage_changed_at, created_by, created_at, updated_at)
    VALUES ('dl-nobook', 'sp-sales', 'sales', 'won', 'won', 'cl-a-5', 'cd-a-5', ${U.opA}, 'consult', 90000, ${SEED_NOW - 60 * MIN}, ${SEED_NOW}, ${U.opA}, ${SEED_NOW}, ${SEED_NOW})`;
  try {
    const after = await getDirectorDashboard(v);
    assert.equal(after.purchases.withoutBooking, before.purchases.withoutBooking + 1);
    assert.equal(after.purchases.count, before.purchases.count + 1);
  } finally {
    await db.sql`DELETE FROM deals WHERE id = 'dl-nobook'`;
  }
});

test('РОП тоже видит панель; оператор — 403', async () => {
  assert.equal((await getDirectorDashboard(await viewerOf(U.rop))).calls.outcomes, base.calls.outcomes + 2);
  await assert.rejects(getDirectorDashboard(await viewerOf(U.opA)), ForbiddenError);
});

test('маршрут: директору 200 без кэша; оператору 403; без сессии 401', async () => {
  const call = () => directorRoute.GET(new Request('http://crm.test/api/reports/director', { headers: { host: 'crm.test' } }), { params: Promise.resolve({}) });
  actAs(U.director);
  const ok = await call();
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.equal(((await ok.json()) as { calls: { outcomes: number } }).calls.outcomes, base.calls.outcomes + 2);
  actAs(U.opA);
  assert.equal((await call()).status, 403);
  actAs(null);
  assert.equal((await call()).status, 401);
});
