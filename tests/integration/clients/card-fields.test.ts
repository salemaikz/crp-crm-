// Поля карточки обзвона (C8 §3.2): проекция, правка с версией, события «было → стало», фильтр «История правок».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { DetailedConflictError, FieldIssuesError, getClientCard, getClientFeed, updateCardFields, type PatchCardBody } from '../../../src/server/domain/clients';
import { ForbiddenError, NotFoundError } from '../../../src/server/access';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const body = (version: number, set: Record<string, unknown>, expect: Record<string, unknown>): PatchCardBody => ({
  version,
  set: { custom: set },
  expect: { custom: expect },
});

test('шапка карточки отдаёт версию, владельца и только видимые поля карточки', async () => {
  const v = await viewerOf(U.opA);
  const card = await getClientCard(v, clientOf('a', 20));
  assert.ok(card.card);
  assert.equal(card.card.version, 0);
  assert.equal(card.card.ownerUserId, U.opA);
  const keys = card.card.fields.fields.map((f) => f.key).sort();
  assert.deepEqual(keys, ['budget', 'plan']);
  assert.equal(card.can.editCard, true);
  const budget = card.card.fields.fields.find((f) => f.key === 'budget');
  assert.equal(budget?.access, 'read');
});

test('правка поля карточки растит версию и пишет событие field.changed {obj: card}', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 21);
  const r = await updateCardFields(v, id, body(0, { plan: 'расширение' }, { plan: null }));
  assert.equal(r.version, 1);
  assert.equal(r.fields.values.plan, 'расширение');
  const rows = await db.sql<{ data: Record<string, unknown>; actorId: string }>`
    SELECT data, actor_id FROM client_events WHERE client_id = ${clientOf('a', 21)} AND kind = 'field.changed'`;
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]?.data, { obj: 'card', sys: false, field: 'plan', before: null, after: 'расширение' });
  assert.equal(rows[0]?.actorId, U.opA);
  const card = await getClientCard(v, clientOf('a', 21));
  assert.equal(card.card?.version, 1);
  assert.equal(card.card?.fields.values.plan, 'расширение');
});

test('устаревшая версия карточки — 409 card_changed, ничего не пишется', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 22);
  await updateCardFields(v, id, body(0, { plan: 'один' }, { plan: null }));
  await assert.rejects(
    () => updateCardFields(v, id, body(0, { plan: 'два' }, { plan: 'один' })),
    (e: unknown) => e instanceof DetailedConflictError && e.detail === 'card_changed',
  );
  const [row] = await db.sql<{ custom: Record<string, unknown>; version: number }>`SELECT custom, version FROM cards WHERE id = ${id}`;
  assert.equal(row?.custom.plan, 'один');
  assert.equal(row?.version, 1);
});

test('expect, не совпавший с текущим значением, — 409 card_changed', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 23);
  await updateCardFields(v, id, body(0, { plan: 'один' }, { plan: null }));
  await assert.rejects(
    () => updateCardFields(v, id, body(1, { plan: 'два' }, { plan: 'другое' })),
    (e: unknown) => e instanceof DetailedConflictError,
  );
});

test('повторная запись того же значения — без события и без роста версии', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 24);
  await updateCardFields(v, id, body(0, { plan: 'х' }, { plan: null }));
  const r = await updateCardFields(v, id, body(1, { plan: 'х' }, { plan: 'х' }));
  assert.equal(r.version, 1);
  const rows = await db.sql`SELECT 1 FROM client_events WHERE client_id = ${clientOf('a', 24)} AND kind = 'field.changed'`;
  assert.equal(rows.length, 1);
});

test('поле «только чтение» оператору и скрытое — 400 с ключом поля, значение не записано', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 25);
  for (const key of ['budget', 'hush']) {
    await assert.rejects(
      () => updateCardFields(v, id, body(0, { [key]: key === 'budget' ? 100 : 'x' }, { [key]: null })),
      (e: unknown) => e instanceof FieldIssuesError && e.issues.some((i) => i.key === key),
    );
  }
  const [row] = await db.sql<{ custom: Record<string, unknown> }>`SELECT custom FROM cards WHERE id = ${id}`;
  assert.deepEqual(row?.custom, {});
});

test('РОП правит доступное ему поле; оператор не видит скрытое поле в ленте и в шапке', async () => {
  const rop = await viewerOf(U.rop);
  const id = cardOf('a', 26);
  const r = await updateCardFields(rop, id, body(0, { budget: 500000 }, { budget: null }));
  assert.equal(r.version, 1);
  // Событие скрытого от оператора поля (его мог записать, например, импорт): оператору оно не видно
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, data)
               VALUES ('ed-hush', ${clientOf('a', 26)}, 'sp-sales', 'field.changed', ${U.rop}, 7,
                       '{"obj":"card","sys":false,"field":"hush","before":null,"after":"тайна"}'::jsonb)`;
  const op = await viewerOf(U.opA);
  const card = await getClientCard(op, clientOf('a', 26));
  assert.ok(!card.card?.fields.fields.some((f) => f.key === 'hush'));
  assert.equal(card.card?.fields.values.hush, undefined);
  const feed = await getClientFeed(op, clientOf('a', 26), { cursor: null, groups: null, group: 'edits' });
  const fields = feed.items.map((i) => i.data.field);
  assert.ok(fields.includes('budget'));
  assert.ok(!fields.includes('hush'));
});

test('чужая карточка — 404 как несуществующая; без права правки — 403', async () => {
  const v = await viewerOf(U.opA);
  await assert.rejects(() => updateCardFields(v, cardOf('b', 20), body(0, { plan: 'х' }, { plan: null })), NotFoundError);
  await assert.rejects(() => updateCardFields(v, 'cd-нет-такой', body(0, { plan: 'х' }, { plan: null })), NotFoundError);
  const dir = await viewerOf(U.director);
  await assert.rejects(() => updateCardFields(dir, cardOf('a', 27), body(0, { plan: 'х' }, { plan: null })), (e: unknown) => e instanceof ForbiddenError || e instanceof NotFoundError);
});

test('«История правок»: group=edits отдаёт правки полей, номеров и контактов, но не звонки и заметки', async () => {
  const v = await viewerOf(U.opA);
  const id = cardOf('a', 28);
  const cl = clientOf('a', 28);
  await updateCardFields(v, id, body(0, { plan: 'а' }, { plan: null }));
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, data) VALUES ('ed-call', ${cl}, 'sp-sales', 'call', ${U.opA}, 5, '{}'::jsonb)`;
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, actor_id, at, data) VALUES ('ed-ph', ${cl}, 'sp-sales', 'phone.added', ${U.opA}, 6, '{}'::jsonb)`;
  const edits = await getClientFeed(v, cl, { cursor: null, groups: null, group: 'edits' });
  const kinds = new Set(edits.items.map((i) => i.kind));
  assert.deepEqual([...kinds].sort(), ['field.changed', 'phone.added']);
  await assert.rejects(() => getClientFeed(v, cl, { cursor: null, groups: null, group: 'nope' }));
});
