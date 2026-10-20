// Передача клиента (PROCESS §8.5): прежний оператор теряет доступ сразу — права считаются по
// текущему владельцу на каждом запросе, кэша нет. Открытая у него карточка на следующем действии
// получает тот же 404, что и несуществующая.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeSql, scoped, throwNotFoundOrConflict } from '../../../src/server/access/scope';
import type { Viewer } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openWorld();
});
after(() => closeWorld(db));

const card = cardOf('a', 5);
const client = clientOf('a', 5);

async function seesAnything(v: Viewer): Promise<Record<string, number>> {
  const q = scoped(db.sql);
  const count = async (rows: Promise<unknown[]>) => (await rows).length;
  return {
    card: await count(q`SELECT 1 FROM cards c WHERE c.id = ${card} AND ${scopeSql(v, 'card', 'card.read')}`),
    client: await count(q`SELECT 1 FROM clients cl WHERE cl.id = ${client} AND ${scopeSql(v, 'client', 'client.read')}`),
    deals: await count(q`SELECT 1 FROM deals d WHERE d.client_id = ${client} AND ${scopeSql(v, 'deal', 'deal.read')}`),
    tasks: await count(q`SELECT 1 FROM tasks t WHERE t.client_id = ${client} AND ${scopeSql(v, 'task', 'task.read')}`),
    bookings: await count(q`SELECT 1 FROM bookings b WHERE b.client_id = ${client} AND ${scopeSql(v, 'booking', 'booking.read')}`),
    notes: await count(q`SELECT 1 FROM notes n WHERE n.client_id = ${client} AND ${scopeSql(v, 'note', 'card.read')}`),
    feed: await count(q`SELECT 1 FROM client_events ev WHERE ev.client_id = ${client} AND ${scopeSql(v, 'client_event', 'card.read')}`),
  };
}

test('после передачи от A к B: у A сразу 404 и пустые списки, у B — всё видно', async () => {
  const t = 1_800_000_000_000;
  // Объекты клиента A5: сделка, задача, запись, заметка, лента — всё у A.
  await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id,
                                  stage_changed_at, created_by, created_at, updated_at)
               VALUES ('dl-a5', 'sp-sales', 'sales', 'meeting', 'open', ${client}, ${card}, ${U.opA}, ${t}, ${U.opA}, ${t}, ${t})`;
  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
               VALUES ('tk-a5', 'sp-sales', ${client}, 'call', 'callback', 'Перезвонить', ${U.opA}, ${t})`;
  await db.sql`INSERT INTO bookings (id, space_id, kind, event_type_key, event_id, client_id, card_id, booking_date, start_time,
                                     starts_at, duration_min, booked_by_user_id, responsible_user_id, created_at, updated_at)
               VALUES ('bk-a5', 'sp-sales', 'group', 'group', 'ev-tomorrow', ${client}, ${card}, '2026-10-29', '15:00', ${t}, 180,
                       ${U.opA}, ${U.opA}, ${t}, ${t})`;
  await db.sql`INSERT INTO notes (id, client_id, space_id, author_id, body, created_at) VALUES ('nt-a5', ${client}, 'sp-sales', ${U.opA}, 'синтетика', ${t})`;
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at) VALUES ('ce-a5', ${client}, 'sp-sales', 'call', ${U.opA}, ${t})`;

  const A = await viewerOf(U.opA);
  assert.deepEqual(await seesAnything(A), { card: 1, client: 1, deals: 1, tasks: 1, bookings: 1, notes: 1, feed: 1 });

  // Передача делает РОП: охват card.assign = пространство. Одним действием — владелец карточки,
  // исполнитель открытых задач, ответственный за записи, владелец открытых сделок (PROCESS §8.5).
  const rop = await viewerOf(U.rop);
  const q = scoped(db.sql);
  await db.tx(async (sql) => {
    const s = scoped(sql);
    const moved = await s`UPDATE cards c SET owner_user_id = ${U.opB}, version = c.version + 1
                          WHERE c.id = ${card} AND ${scopeSql(rop, 'card', 'card.assign')} RETURNING c.id`;
    assert.equal(moved.length, 1);
    await s`UPDATE tasks t SET assignee_user_id = ${U.opB} WHERE t.client_id = ${client} AND t.status = 'open' AND ${scopeSql(rop, 'task', 'task.assign_others')}`;
    await s`UPDATE bookings b SET responsible_user_id = ${U.opB} WHERE b.client_id = ${client} AND ${scopeSql(rop, 'booking', 'booking.manage')}`;
    await s`UPDATE deals d SET owner_user_id = ${U.opB} WHERE d.client_id = ${client} AND d.status = 'open' AND ${scopeSql(rop, 'deal', 'deal.edit')}`;
  });

  // Тот же объект Viewer A (запрос, начатый до передачи) уже ничего не видит: охват — в SQL по
  // текущему владельцу, а не по снимку прав.
  assert.deepEqual(await seesAnything(A), { card: 0, client: 0, deals: 0, tasks: 0, bookings: 0, notes: 0, feed: 0 });
  const A2 = await viewerOf(U.opA);
  assert.deepEqual(await seesAnything(A2), { card: 0, client: 0, deals: 0, tasks: 0, bookings: 0, notes: 0, feed: 0 });
  await assert.rejects(throwNotFoundOrConflict(A2, db.sql, 'card', card), { code: 'not_found' });
  const edit = await q`UPDATE cards c SET lpr = 'no' WHERE c.id = ${card} AND ${scopeSql(A2, 'card', 'card.edit')} RETURNING c.id`;
  assert.deepEqual(edit, []);

  const B = await viewerOf(U.opB);
  assert.deepEqual(await seesAnything(B), { card: 1, client: 1, deals: 1, tasks: 1, bookings: 1, notes: 1, feed: 1 });
});

test('«Отсутствует»: временный владелец видит карточку, по окончании (acting снят) — нет', async () => {
  const c = cardOf('a', 6);
  const B = await viewerOf(U.opB);
  const sees = async () => (await scoped(db.sql)`SELECT 1 FROM cards c WHERE c.id = ${c} AND ${scopeSql(B, 'card', 'card.read')}`).length;
  assert.equal(await sees(), 0);
  await db.sql`UPDATE cards SET acting_user_id = ${U.opB}, acting_until_day = '2026-10-30' WHERE id = ${c}`;
  assert.equal(await sees(), 1);
  await db.sql`UPDATE cards SET acting_user_id = NULL, acting_until_day = '' WHERE id = ${c}`;
  assert.equal(await sees(), 0);
});
