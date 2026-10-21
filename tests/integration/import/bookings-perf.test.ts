/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД читаются по путям */
// Профиль «Записи»: объём пилота. 500 строк — предпросмотр и применение укладываются в порог (запись идёт через
// createBooking построчно, D-324: бюджет 500 строк ≤ 10 с на стенде, в тесте порог шире — на машине с нагрузкой).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { importApi, type BookingApplyResult, type BookingPreviewSummary } from '../../../src/server/domain/import';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { T0, actorOf, makeBookingsWorld, mkClient, mkEvent, upload, type BookingsWorld } from './bookingsWorld';

let db: TestDb;
let w: BookingsWorld;
const N = 500;
const LIMIT_MS = 30_000;

before(async () => {
  db = await createTestDb();
  w = await makeBookingsWorld(db);
});
after(async () => {
  resetAccessForTests();
  await db.close();
});

test(`${N} строк: предпросмотр и применение ≤ ${LIMIT_MS / 1000} с, места и карточки сходятся`, async () => {
  const day = '2026-12-01';
  const ev = await mkEvent(db, w.spaceId, { date: day, capacity: 1000 });
  const rows: string[][] = [];
  for (let i = 0; i < N; i++) {
    const phone = `+7 709 ${String(1000 + i).padStart(7, '0').replace(/^(\d{3})(\d{2})(\d{2})$/, '$1 $2 $3')}`;
    await mkClient(db, w.spaceId, { name: `ТОО «Объём-${i}»`, phone, state: 'callback', ownerUserId: i % 2 === 0 ? w.staff.op1 : w.staff.op2 });
    rows.push([`ТОО «Объём-${i}»`, phone, '', '01.12.2026', '', i % 2 === 0 ? 'Оператор-01' : 'Оператор-02', 'БР']);
  }
  // задачи «Уточнить договорённость» — как после таблицы клиентов
  await db.sql`
    INSERT INTO tasks (id, space_id, client_id, kind, source, title, status, source_key, created_at)
    SELECT gen_random_uuid()::text, ${w.spaceId}, c.client_id, 'call', 'clarify_import', '', 'open', 'clarify_import:perf:' || c.client_id, ${T0}
      FROM cards c WHERE c.state = 'callback'`;
  const map = { 'Оператор-01': w.staff.op1, 'Оператор-02': w.staff.op2 };
  const actor = await actorOf(w);
  const up = await upload(actor, [['Наименование', 'Телефон', 'БИН', 'Дата', 'Время', 'Оператор', 'Мероприятие'], ...rows]);

  const t0 = Date.now();
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: map }, T0 + 5000)) as BookingPreviewSummary;
  const previewMs = Date.now() - t0;
  assert.equal(s.counts.byAction.create, N);
  assert.deepEqual(s.blockers, []);

  const t1 = Date.now();
  const res = (await importApi.apply(actor, up.importId, { fingerprint: s.fingerprint, ownerMap: {}, authorMap: map }, T0 + 6000)) as BookingApplyResult;
  const applyMs = Date.now() - t1;
  console.log(`bookings ${N}: предпросмотр ${previewMs} мс, применение ${applyMs} мс`);
  assert.equal(res.written.bookingsCreated, N);
  assert.equal(res.written.cardsAgreed, N);
  assert.ok(previewMs + applyMs <= LIMIT_MS, `${previewMs + applyMs} мс`);

  const [e] = await db.sql<any>`SELECT count(*)::int AS n FROM bookings WHERE event_id = ${ev} AND status = 'registered'`;
  assert.equal(e.n, N);
  const [c] = await db.sql<any>`SELECT count(*) FILTER (WHERE state = 'agreed')::int AS agreed FROM cards`;
  assert.equal(c.agreed, N);
  const [t] = await db.sql<any>`SELECT count(*) FILTER (WHERE status = 'open')::int AS open FROM tasks WHERE source = 'clarify_import'`;
  assert.equal(t.open, 0);
});
