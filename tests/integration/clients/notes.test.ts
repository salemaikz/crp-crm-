// Заметки клиента (C8 §3.3): повтор opId, закрепление с лимитом, охват, привязка к сделке, текст в ленте.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../src/server/access';
import { DetailedConflictError, getClientFeed, loadClientPage } from '../../../src/server/domain/clients';
import { createNote, pinNote } from '../../../src/server/domain/timeline';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const uid = (n: number) => `00000000-0000-4000-8000-0000000c8${String(n).padStart(3, '0')}`;

test('заметка пишется с событием ленты; повтор opId возвращает прежнюю без второго события', async () => {
  const v = await viewerOf(U.opA);
  const cl = clientOf('a', 50);
  const a = await createNote(v, cl, { opId: uid(1), body: '  Просили КП до пятницы  ' });
  assert.equal(a.body, 'Просили КП до пятницы');
  assert.equal(a.pinned, false);
  assert.equal(a.authorName, 'Оператор Синтетик А');
  const again = await createNote(v, cl, { opId: uid(1), body: 'другой текст при повторе' });
  assert.equal(again.id, a.id);
  assert.equal(again.body, 'Просили КП до пятницы');
  const notes = await db.sql`SELECT 1 FROM notes WHERE client_id = ${cl}`;
  assert.equal(notes.length, 1);
  const ev = await db.sql<{ refType: string; refId: string }>`SELECT ref_type, ref_id FROM client_events WHERE client_id = ${cl} AND kind = 'note.created'`;
  assert.deepEqual(ev, [{ refType: 'note', refId: uid(1) }]);
});

test('opId чужого клиента или чужого автора — 400 op_id', async () => {
  const a = await viewerOf(U.opA);
  await createNote(a, clientOf('a', 51), { opId: uid(2), body: 'раз' });
  // тот же opId, другой клиент того же автора
  await assert.rejects(() => createNote(a, clientOf('a', 52), { opId: uid(2), body: 'два' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'op_id');
  // тот же opId от РОП (видит клиента, но заметка не его)
  const rop = await viewerOf(U.rop);
  await assert.rejects(() => createNote(rop, clientOf('a', 51), { opId: uid(2), body: 'три' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'op_id');
});

test('пустой и слишком длинный текст — 400', async () => {
  const v = await viewerOf(U.opA);
  await assert.rejects(() => createNote(v, clientOf('a', 53), { opId: uid(3), body: '   ' }), BadRequestError);
  await assert.rejects(() => createNote(v, clientOf('a', 53), { opId: uid(4), body: 'я'.repeat(4001) }), BadRequestError);
  const ok = await createNote(v, clientOf('a', 53), { opId: uid(5), body: 'я'.repeat(4000) });
  assert.equal(ok.body.length, 4000);
});

test('чужой клиент — 404 и ни заметки, ни события', async () => {
  const v = await viewerOf(U.opA);
  const cl = clientOf('b', 50);
  await assert.rejects(() => createNote(v, cl, { opId: uid(6), body: 'чужому' }), NotFoundError);
  await assert.rejects(() => createNote(v, 'cl-нет-такого', { opId: uid(6), body: 'никому' }), NotFoundError);
  assert.equal((await db.sql`SELECT 1 FROM notes WHERE client_id = ${cl}`).length, 0);
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE client_id = ${cl} AND kind = 'note.created'`).length, 0);
});

test('закрепить: до трёх, четвёртая — 409 pin_limit; открепить освобождает место; повтор безопасен', async () => {
  const v = await viewerOf(U.opA);
  const cl = clientOf('a', 54);
  const ids: string[] = [];
  for (let k = 0; k < 4; k++) ids.push((await createNote(v, cl, { opId: uid(10 + k), body: `заметка ${k}` })).id);
  for (const id of ids.slice(0, 3)) assert.equal((await pinNote(v, id, true)).pinned, true);
  assert.equal((await pinNote(v, ids[0]!, true)).pinned, true); // повтор не считается новым закреплением
  await assert.rejects(() => pinNote(v, ids[3]!, true), (e: unknown) => e instanceof DetailedConflictError && e.detail === 'pin_limit');
  assert.equal((await pinNote(v, ids[0]!, false)).pinned, false);
  assert.equal((await pinNote(v, ids[3]!, true)).pinned, true);
  const page = await loadClientPage(v, cl);
  assert.equal(page.kind, 'ok');
  if (page.kind === 'ok') assert.deepEqual(page.pinnedNotes.map((n) => n.id).sort(), [ids[1]!, ids[2]!, ids[3]!].sort());
});

test('закрепить чужую заметку — 404; несуществующую — 404', async () => {
  const v = await viewerOf(U.opA);
  await assert.rejects(() => pinNote(v, 'nt-b-1', true), NotFoundError);
  await assert.rejects(() => pinNote(v, 'нет-такой', true), NotFoundError);
  const [row] = await db.sql<{ pinned: boolean }>`SELECT pinned FROM notes WHERE id = 'nt-b-1'`;
  assert.equal(row?.pinned, false);
});

test('закрепить заметку, видимую только на чтение, — 403', async () => {
  // Директор читает карточки пространства, но заметки не пишет
  const dir = await viewerOf(U.director);
  await assert.rejects(() => pinNote(dir, 'nt-a-1', true), (e: unknown) => e instanceof ForbiddenError || e instanceof NotFoundError);
});

test('заметка к сделке: сделка того же клиента — да, чужая — 400 deal', async () => {
  const v = await viewerOf(U.opA);
  const cl = clientOf('a', 1);
  const n = await createNote(v, cl, { opId: uid(20), body: 'по сделке', dealId: 'dl-a-1' });
  assert.equal(n.dealId, 'dl-a-1');
  await assert.rejects(() => createNote(v, cl, { opId: uid(21), body: 'не та сделка', dealId: 'dl-b-1' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'deal');
  const [ev] = await db.sql<{ dealId: string | null }>`SELECT deal_id FROM client_events WHERE ref_id = ${uid(20)}`;
  assert.equal(ev?.dealId, 'dl-a-1');
});

test('в ленте у note.created подтягивается текст и автор; лента сделки отдаёт только её события', async () => {
  const v = await viewerOf(U.opA);
  const cl = clientOf('a', 1);
  const feed = await getClientFeed(v, cl, { cursor: null, groups: 'notes' });
  const mine = feed.items.find((i) => i.refId === uid(20));
  assert.equal(mine?.note?.body, 'по сделке');
  assert.equal(mine?.note?.authorName, 'Оператор Синтетик А');
  const deal = await getClientFeed(v, cl, { cursor: null, groups: null, dealId: 'dl-a-1' });
  assert.ok(deal.items.length >= 1);
  assert.ok(deal.items.every((i) => i.dealId === 'dl-a-1'));
  await assert.rejects(() => getClientFeed(v, cl, { cursor: null, groups: null, dealId: 'dl-b-1' }), NotFoundError);
});
