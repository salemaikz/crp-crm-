/* eslint-disable @typescript-eslint/no-explicit-any -- строки БД и ответы читаются по путям */
// Импорт «Записей» и спорные пары (PROCESS 7.6, D-038, D-174, D-330): карточка без владельца в паре `open|distinct`
// не уходит автору записи, если пару держит оператор или её блокирует «Не звонить» / задержка напарника.
// Только синтетика (+7 709 …, выдуманные компании).
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { distribution } from '@crm/core';
import { resetAccessForTests } from '../../../src/server/access/testing';
import { classifyCandidates } from '../../../src/server/domain/distribution/pool';
import { ImportError, importApi, type BookingApplyResult, type BookingPreviewSummary } from '../../../src/server/domain/import';
import { newId } from '../../../src/server/platform/db';
import { createTestDb, type TestDb } from '../../../src/server/platform/db/testing';
import { T0, actorOf, makeBookingsWorld, mkClient, upload, type BookingsWorld } from './bookingsWorld';

let db: TestDb;
let w: BookingsWorld;
let tick = 0;
const t = () => T0 + 10_000 + 1000 * ++tick;

const HEAD = ['Наименование', 'Телефон', 'БИН', 'Дата', 'Время', 'Оператор', 'Мероприятие'];
let seq = 600;
const ph = () => `+7 709 ${++seq} 00 33`;
const authors = (): Record<string, string | null> => ({ 'Оператор-01': w.staff.op1, 'Оператор-02': w.staff.op2 });

before(async () => {
  db = await createTestDb();
  w = await makeBookingsWorld(db);
});
after(async () => {
  resetAccessForTests();
  await db.close();
});

async function pair(x: string, y: string, status: 'open' | 'distinct'): Promise<void> {
  const [a, b] = [x, y].sort();
  await db.sql`INSERT INTO dup_pairs (id, a_client_id, b_client_id, reason, status, created_at) VALUES (${newId()}, ${a}, ${b}, 'name_and_head', ${status}, ${T0})`;
}
async function preview(rows: string[][]) {
  const actor = await actorOf(w);
  const up = await upload(actor, [HEAD, ...rows], { now: t() });
  const s = (await importApi.preview(actor, up.importId, { ownerMap: {}, authorMap: authors() }, t())) as BookingPreviewSummary;
  return { actor, up, s };
}
const applyOf = async (x: Awaited<ReturnType<typeof preview>>) =>
  (await importApi.apply(x.actor, x.up.importId, { fingerprint: x.s.fingerprint, ownerMap: {}, authorMap: authors() }, t())) as BookingApplyResult;
const rowsOf = async (importId: string) => (await importApi.listRows(await actorOf(w), importId, { filter: 'all', offset: 0, limit: 50 }, t())).rows as any[];
const cardOf = async (cardId: string) => (await db.sql<any>`SELECT owner_user_id, state, hold_reason FROM cards WHERE id = ${cardId}`)[0];
const bookingsOf = (clientId: string) => db.sql<any>`SELECT booked_by_user_id FROM bookings WHERE client_id = ${clientId}`;
const line = (name: string, phone: string, op = 'Оператор-02') => [name, phone, '', '05.11.2026', '', op, 'БР'];

test('пара «Разные — тому же оператору»: напарник у op1, строка автора op2 — карточка уходит op1, пара не делится', async () => {
  const yPhone = ph();
  const xPhone = ph();
  const y = await mkClient(db, w.spaceId, { name: 'ТОО «Пара-Y»', phone: yPhone, state: 'callback', ownerUserId: w.staff.op1 });
  const x = await mkClient(db, w.spaceId, { name: 'ТОО «Пара-X»', phone: xPhone, state: 'new', ownerUserId: null });
  await pair(x.clientId, y.clientId, 'distinct');
  const p = await preview([line('ТОО «Пара-X»', xPhone)]);
  assert.deepEqual(p.s.blockers, []);
  const [r] = await rowsOf(p.up.importId);
  assert.deepEqual([r.action, r.flags], ['create', ['owner_from_pair']]);
  const res = await applyOf(p);
  assert.equal(res.written.ownersAssigned, 1);
  assert.equal(res.written.cardsAgreed, 1);
  const [cx, cy] = [await cardOf(x.cardId), await cardOf(y.cardId)];
  assert.equal(cx.ownerUserId, w.staff.op1, 'владелец X — тот же оператор, что у напарника');
  assert.equal(cx.state, 'agreed');
  assert.deepEqual([cy.ownerUserId, cy.state], [w.staff.op1, 'callback']);
  assert.deepEqual((await bookingsOf(x.clientId)).map((b) => b.bookedByUserId), [w.staff.op2], 'автор записи остаётся автором (заслуга)');
});

test('открытая пара с «Не звонить»: запись создаётся, карточка без перехода и владельца, строка на разбор', async () => {
  const xPhone = ph();
  const y = await mkClient(db, w.spaceId, { name: 'ТОО «Стоп-Y»', phone: ph(), state: 'do_not_call', ownerUserId: w.staff.op1 });
  const x = await mkClient(db, w.spaceId, { name: 'ТОО «Стоп-X»', phone: xPhone, state: 'new', ownerUserId: null });
  await pair(x.clientId, y.clientId, 'open');
  const p = await preview([line('ТОО «Стоп-X»', xPhone)]);
  const [r] = await rowsOf(p.up.importId);
  assert.deepEqual([r.action, r.flags, r.groups], ['create', ['pair_hold'], ['review']]);
  assert.equal(p.s.counts.byGroup.review, 1);
  const res = await applyOf(p);
  assert.deepEqual([res.written.bookingsCreated, res.written.ownersAssigned, res.written.cardsAgreed], [1, 0, 0]);
  assert.deepEqual(await cardOf(x.cardId), { ownerUserId: null, state: 'new', holdReason: '' });
});

test('два необработанных дубля в пуле: старый (hold пуст) заблокирован новым задержанным — импорт его не раздаёт', async () => {
  const oldPhone = ph();
  const old = await mkClient(db, w.spaceId, { name: 'ТОО «Дубль-Старый»', phone: oldPhone, state: 'new', ownerUserId: null });
  const fresh = await mkClient(db, w.spaceId, { name: 'ТОО «Дубль-Новый»', phone: ph(), state: 'new', ownerUserId: null, holdReason: 'dup_pair' });
  await pair(old.clientId, fresh.clientId, 'open');
  const p = await preview([line('ТОО «Дубль-Старый»', oldPhone)]);
  const [r] = await rowsOf(p.up.importId);
  assert.deepEqual(r.flags, ['pair_hold']);
  await applyOf(p);
  assert.deepEqual(await cardOf(old.cardId), { ownerUserId: null, state: 'new', holdReason: '' });
});

test('напарник сменил оператора между предпросмотром и применением → preview_stale, ничего не записано', async () => {
  const xPhone = ph();
  const y = await mkClient(db, w.spaceId, { name: 'ТОО «Гонка-Y»', phone: ph(), state: 'callback', ownerUserId: w.staff.op1 });
  const x = await mkClient(db, w.spaceId, { name: 'ТОО «Гонка-X»', phone: xPhone, state: 'new', ownerUserId: null });
  await pair(x.clientId, y.clientId, 'distinct');
  const p = await preview([line('ТОО «Гонка-X»', xPhone, 'Оператор-01')]);
  await db.sql`UPDATE cards SET owner_user_id = ${w.staff.op2}, version = version + 1 WHERE id = ${y.cardId}`;
  await assert.rejects(applyOf(p), (e: unknown) => e instanceof ImportError && e.code === 'preview_stale');
  assert.equal((await bookingsOf(x.clientId)).length, 0);
  assert.equal((await cardOf(x.cardId)).ownerUserId, null);
});

// ---------- цепочки через свободного напарника (D-330: одно правило с раздачей) ----------

/** Что раздача сделала бы с карточками пула: группы и держатели — как тик (classifyCandidates + planAllocation). */
async function planOf(cardIds: string[]) {
  const rows = await db.sql<any>`
    SELECT c.id, c.client_id, c.version, c.created_at, true AS has_mobile FROM cards c
     WHERE c.id = ANY(${cardIds}::text[]) AND c.owner_user_id IS NULL ORDER BY c.created_at, c.id`;
  const candidates = await classifyCandidates(db.sql, w.spaceId, rows);
  const ops = [w.staff.op1, w.staff.op2].map((userId) => ({ userId, status: 'working' as const, open: 0, issuedToday: {} }));
  return distribution.planAllocation(ops, candidates, { dailyCap: 100, capIncludes: ['auto'] });
}

for (const status of ['distinct', 'open'] as const) {
  test(`цепочка X–Y–Z (${status}): Y свободен в пуле, Z у op2 — X уходит op2, как в раздаче; Y потом раздаётся op2 же`, async () => {
    const z = await mkClient(db, w.spaceId, { name: `ТОО «Цепь-Z-${status}»`, phone: ph(), state: 'callback', ownerUserId: w.staff.op2 });
    const y = await mkClient(db, w.spaceId, { name: `ТОО «Цепь-Y-${status}»`, phone: ph(), state: 'new', ownerUserId: null });
    const xPhone = ph();
    const x = await mkClient(db, w.spaceId, { name: `ТОО «Цепь-X-${status}»`, phone: xPhone, state: 'new', ownerUserId: null });
    await pair(x.clientId, y.clientId, status);
    await pair(y.clientId, z.clientId, status);
    // раздача до импорта отдаёт всю группу держателю Z
    assert.deepEqual((await planOf([x.cardId, y.cardId])).byOperator[w.staff.op2], [x.cardId, y.cardId].sort());

    const p = await preview([line(`ТОО «Цепь-X-${status}»`, xPhone, 'Оператор-01')]);
    assert.deepEqual(p.s.blockers, []);
    const [r] = await rowsOf(p.up.importId);
    assert.deepEqual([r.action, r.flags], ['create', ['owner_from_pair']]);
    const res = await applyOf(p);
    assert.equal(res.written.ownersAssigned, 1);
    assert.deepEqual(await cardOf(x.cardId), { ownerUserId: w.staff.op2, state: 'agreed', holdReason: '' });
    assert.deepEqual((await bookingsOf(x.clientId)).map((b) => b.bookedByUserId), [w.staff.op1], 'автор записи остаётся автором');
    // после импорта раздача отдаёт Y тому же оператору: пара X–Y не разделена
    const after = await planOf([y.cardId]);
    assert.deepEqual([after.byOperator[w.staff.op2], after.heldBack], [[y.cardId], []]);
  });
}

test('группа X–Y с двумя держателями (op1 через A, op2 через Z): запись есть, карточка на разбор без владельца', async () => {
  const a = await mkClient(db, w.spaceId, { name: 'ТОО «Двое-A»', phone: ph(), state: 'agreed', ownerUserId: w.staff.op1 });
  const z = await mkClient(db, w.spaceId, { name: 'ТОО «Двое-Z»', phone: ph(), state: 'retry', ownerUserId: w.staff.op2 });
  const y = await mkClient(db, w.spaceId, { name: 'ТОО «Двое-Y»', phone: ph(), state: 'new', ownerUserId: null });
  const xPhone = ph();
  const x = await mkClient(db, w.spaceId, { name: 'ТОО «Двое-X»', phone: xPhone, state: 'new', ownerUserId: null });
  await pair(x.clientId, a.clientId, 'distinct');
  await pair(x.clientId, y.clientId, 'open');
  await pair(y.clientId, z.clientId, 'distinct');
  // раздача такую группу не выдаёт: ждёт РОП
  assert.deepEqual((await planOf([x.cardId, y.cardId])).heldBack.sort(), [x.cardId, y.cardId].sort());

  const p = await preview([line('ТОО «Двое-X»', xPhone, 'Оператор-01')]);
  const [r] = await rowsOf(p.up.importId);
  assert.deepEqual([r.action, r.flags, r.groups], ['create', ['pair_hold'], ['review']]);
  const res = await applyOf(p);
  assert.deepEqual([res.written.bookingsCreated, res.written.ownersAssigned, res.written.cardsAgreed], [1, 0, 0]);
  assert.deepEqual(await cardOf(x.cardId), { ownerUserId: null, state: 'new', holdReason: '' });
});

test('цепочка: держатель дальнего звена сменился между предпросмотром и применением → preview_stale', async () => {
  const z = await mkClient(db, w.spaceId, { name: 'ТОО «Гонка-Цепь-Z»', phone: ph(), state: 'callback', ownerUserId: w.staff.op2 });
  const y = await mkClient(db, w.spaceId, { name: 'ТОО «Гонка-Цепь-Y»', phone: ph(), state: 'new', ownerUserId: null });
  const xPhone = ph();
  const x = await mkClient(db, w.spaceId, { name: 'ТОО «Гонка-Цепь-X»', phone: xPhone, state: 'new', ownerUserId: null });
  await pair(x.clientId, y.clientId, 'distinct');
  await pair(y.clientId, z.clientId, 'distinct');
  const p = await preview([line('ТОО «Гонка-Цепь-X»', xPhone, 'Оператор-01')]);
  await db.sql`UPDATE cards SET owner_user_id = ${w.staff.op1}, version = version + 1 WHERE id = ${z.cardId}`;
  await assert.rejects(applyOf(p), (e: unknown) => e instanceof ImportError && e.code === 'preview_stale');
  assert.equal((await bookingsOf(x.clientId)).length, 0);
});
