// «Чужое = несуществующее» на Postgres (D-017, PROCESS §8.3): оператор A не видит объектов
// оператора B ни по id, ни в списках и счётчиках, ни в поиске, и не может их изменить.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeSql, scoped, throwNotFoundOrConflict } from '../../../src/server/access/scope';
import { route } from '../../../src/server/access/wrappers';
import type { Viewer } from '../../../src/server/access/types';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { actAs, viewerOf } from '../../isolation/harness/actors';
import { FX, U, cardOf, clientOf, nameOf, phoneOf } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from './world';

let db: TestDb;
let A: Viewer;
let B: Viewer;
before(async () => {
  db = await openWorld();
  A = await viewerOf(U.opA);
  B = await viewerOf(U.opB);
});
after(() => closeWorld(db));

const q = () => scoped(db.sql);

async function cardById(v: Viewer, id: string) {
  return q()<{ id: string }>`SELECT c.id FROM cards c WHERE c.id = ${id} AND ${scopeSql(v, 'card', 'card.read')}`;
}

test('чтение по id: своя карточка видна, чужая — как несуществующая', async () => {
  assert.equal((await cardById(A, cardOf('a', 1))).length, 1);
  assert.equal((await cardById(A, cardOf('b', 1))).length, 0);
  assert.equal((await cardById(A, 'cd-nonexistent')).length, 0);
  assert.equal((await cardById(B, cardOf('b', 1))).length, 1);
});

test('списки и счётчики A не содержат id B — по всем сущностям', async () => {
  const [cnt] = await q()<{ n: number }>`SELECT count(*)::int AS n FROM cards c WHERE ${scopeSql(A, 'card', 'card.read')}`;
  assert.equal(cnt?.n, 100);
  const checks: Array<[string, () => Promise<{ id: string }[]>]> = [
    ['cards', () => q()`SELECT c.id FROM cards c WHERE ${scopeSql(A, 'card', 'card.read')}`],
    ['clients', () => q()`SELECT cl.id FROM clients cl WHERE ${scopeSql(A, 'client', 'client.read')}`],
    ['phones', () => q()`SELECT cp.id FROM client_phones cp WHERE ${scopeSql(A, 'client_phone', 'client.read')}`],
    ['deals', () => q()`SELECT d.id FROM deals d WHERE ${scopeSql(A, 'deal', 'deal.read')}`],
    ['bookings', () => q()`SELECT b.id FROM bookings b WHERE ${scopeSql(A, 'booking', 'booking.read')}`],
    ['calls', () => q()`SELECT ca.id FROM calls ca WHERE ${scopeSql(A, 'call', 'card.read')}`],
    ['notes', () => q()`SELECT n.id FROM notes n WHERE ${scopeSql(A, 'note', 'card.read')}`],
    ['events', () => q()`SELECT ev.id FROM client_events ev WHERE ${scopeSql(A, 'client_event', 'card.read')}`],
    ['tasks', () => q()`SELECT t.id FROM tasks t WHERE ${scopeSql(A, 'task', 'task.read')}`],
    ['handoffs', () => q()`SELECT h.id FROM handoffs h WHERE ${scopeSql(A, 'handoff', 'handoff.read')}`],
    ['chats', () => q()`SELECT mc.id FROM messenger_chats mc WHERE ${scopeSql(A, 'messenger_chat', 'card.read')}`],
  ];
  for (const [what, run] of checks) {
    const ids = (await run()).map((r) => r.id);
    assert.ok(
      ids.every((id) => !/-b-|^bk-|^ho-|^chat-b|^dl-b/.test(id)),
      `${what}: у A не должно быть объектов B: ${ids.filter((id) => /-b-|^bk-|^ho-|^chat-b|^dl-b/.test(id)).join(', ')}`,
    );
  }
  const chats = (await checks[10]![1]()).map((r) => r.id).sort();
  assert.deepEqual(chats, ['chat-a1', 'chat-free']);
});

test('поиск A по 5+ цифрам номера, названию и имени клиента B — пусто; своё находится', async () => {
  const search = (v: Viewer, needle: string) =>
    q()<{ id: string }>`SELECT cl.id FROM clients cl
                         WHERE cl.search_norm LIKE ${'%' + needle.toLowerCase() + '%'} AND ${scopeSql(v, 'client', 'client.read')}
                         ORDER BY cl.id LIMIT 20`;
  assert.deepEqual(await search(A, phoneOf('b', 17).slice(-7)), []);
  // 5 цифр совпадают и со своими номерами: свои находятся, чужие — нет
  const five = (await search(A, phoneOf('b', 17).slice(-5))).map((r) => r.id);
  assert.ok(five.length > 0 && five.every((id) => id.startsWith('cl-a-')), five.join(','));
  assert.deepEqual(await search(A, nameOf('b', 17)), []);
  assert.deepEqual((await search(A, phoneOf('a', 17).slice(-7))).map((r) => r.id), [clientOf('a', 17)]);
  assert.deepEqual((await search(B, phoneOf('b', 17).slice(-7))).map((r) => r.id), [clientOf('b', 17)]);
  // по номеру в client_phones — то же
  const byPhone = await q()<{ id: string }>`SELECT cp.client_id AS id FROM client_phones cp
                                            WHERE cp.digits LIKE ${'%' + phoneOf('b', 17).slice(-7)} AND ${scopeSql(A, 'client_phone', 'client.read')}`;
  assert.deepEqual(byPhone, []);
});

test('обновление чужого: 0 строк, данные не меняются, ответ — 404, как у несуществующего', async () => {
  const update = (v: Viewer, id: string) =>
    q()<{ id: string }>`UPDATE cards c SET lpr = 'yes', version = c.version + 1
                        WHERE c.id = ${id} AND ${scopeSql(v, 'card', 'card.edit')} AND c.version = 0 RETURNING c.id`;
  assert.deepEqual(await update(A, cardOf('b', 10)), []);
  const [row] = await db.sql<{ lpr: string; version: number }>`SELECT lpr, version FROM cards WHERE id = ${cardOf('b', 10)}`;
  assert.deepEqual(row, { lpr: '', version: 0 });
  await assert.rejects(throwNotFoundOrConflict(A, db.sql, 'card', cardOf('b', 10)), { code: 'not_found' });
  await assert.rejects(throwNotFoundOrConflict(A, db.sql, 'card', 'cd-nonexistent'), { code: 'not_found' });
  // своя карточка с устаревшей версией — 409
  assert.equal((await update(A, cardOf('a', 10))).length, 1);
  assert.deepEqual(await update(A, cardOf('a', 10)), []);
  await assert.rejects(throwNotFoundOrConflict(A, db.sql, 'card', cardOf('a', 10)), { code: 'conflict' });
  // удаление тоже с охватом
  const del = await q()`DELETE FROM notes n WHERE n.id = ${'nt-b-1'} AND ${scopeSql(A, 'note', 'note.write')} RETURNING n.id`;
  assert.deepEqual(del, []);
  assert.equal((await db.sql`SELECT 1 FROM notes WHERE id = 'nt-b-1'`).length, 1);
});

test('маршрут под route(): чужой и несуществующий id дают байт-в-байт одинаковый 404', async () => {
  const get = route({ perm: 'card.read', target: 'object' }, async ({ viewer, params }) => {
    const rows = await q()<{ id: string; name: string }>`SELECT c.id, cl.name FROM cards c JOIN clients cl ON cl.id = c.client_id
                                                          WHERE c.id = ${String(params.id)} AND ${scopeSql(viewer, 'card', 'card.read')}`;
    if (!rows[0]) await throwNotFoundOrConflict(viewer, db.sql, 'card', String(params.id));
    return rows[0];
  });
  actAs(U.opA);
  const call = (id: string) => get(new Request(`http://crm.test/api/cards/${id}`), { params: Promise.resolve({ id }) });
  const own = await call(cardOf('a', 3));
  assert.equal(own.status, 200);
  assert.equal(((await own.json()) as { name: string }).name, nameOf('a', 3));
  const foreign = await call(cardOf('b', 3));
  const missing = await call('cd-nonexistent');
  assert.equal(foreign.status, 404);
  assert.equal(missing.status, 404);
  const [fb, mb] = [await foreign.text(), await missing.text()];
  assert.equal(fb, mb);
  assert.ok(!fb.includes(nameOf('b', 3)));
});

test('сотрудник с отключённой учёткой и без сессии не проходит обёртку (401)', async () => {
  const h = route({ perm: 'card.read' }, async () => 'data');
  for (const who of [U.disabled, null]) {
    actAs(who);
    const r = await h(new Request('http://crm.test/api/cards'), { params: Promise.resolve({}) });
    assert.equal(r.status, 401);
  }
  void FX;
});
