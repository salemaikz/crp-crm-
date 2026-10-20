// Контакты клиента (5.4): добавление (повтор opId безопасен), правка с событиями, архив, права.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { FieldIssuesError, addContact, archiveContactById, getClientCard, updateContact } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

let seq = 0;
const op = () => `00000000-0000-4000-8000-c${String(++seq).padStart(11, '0')}`;
const events = (clientId: string, kind: string) =>
  db.sql<{ data: Record<string, unknown>; refType: string; refId: string }>`SELECT data, ref_type, ref_id FROM client_events WHERE client_id = ${clientId} AND kind = ${kind} ORDER BY id`;

test('добавление контакта: поля, ЛПР, событие; повтор того же opId — один контакт', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 50);
  const opId = op();
  const input = { opId, system: { name: ' Алия ', position: 'Директор', is_decision_maker: true, call_hint: 'после 15:00' }, custom: { mood: 'дружелюбная' } };
  const c = await addContact(v, id, input);
  assert.equal(c.name, 'Алия');
  assert.equal(c.isDecisionMaker, true);
  assert.equal(c.fields.values.mood, 'дружелюбная');
  const again = await addContact(v, id, input);
  assert.equal(again.id, c.id);
  assert.equal((await db.sql`SELECT 1 FROM contacts WHERE client_id = ${id}`).length, 1);
  assert.equal((await events(id, 'contact.added')).length, 1);
  const card = await getClientCard(v, id);
  assert.deepEqual(card.decisionMaker, { contactId: opId, name: 'Алия' });
  // шаблон полей контакта нужен форме нового контакта
  assert.deepEqual(card.contactFields.fields.map((f) => f.key), ['mood']);
});

test('контакт без имени и с чужими полями — 400; чужой клиент — 404; opId чужого контакта — 400', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 51);
  const issues = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (e instanceof FieldIssuesError) return e.issues.map((i) => `${i.key}:${i.code}`);
      throw e;
    }
    return [];
  };
  assert.deepEqual(await issues(addContact(v, id, { opId: op(), system: {}, custom: {} })), ['name:required']);
  assert.deepEqual(await issues(addContact(v, id, { opId: op(), system: { name: 'А', bogus: 1 }, custom: { nope: 1 } })), ['bogus:unknown_field', 'nope:unknown_field']);
  assert.deepEqual(await issues(addContact(v, id, { opId: op(), system: { name: 'А' }, custom: { mood: 'x'.repeat(600) } })), ['mood:too_long']);
  await assert.rejects(addContact(v, clientOf('b', 50), { opId: op(), system: { name: 'А' }, custom: {} }), { code: 'not_found' });
  assert.equal((await db.sql`SELECT 1 FROM contacts WHERE client_id = ${clientOf('b', 50)}`).length, 0);
  const taken = op();
  await addContact(v, id, { opId: taken, system: { name: 'Первый' }, custom: {} });
  await assert.rejects(addContact(v, clientOf('a', 52), { opId: taken, system: { name: 'Второй' }, custom: {} }), { code: 'bad_request' });
});

test('правка контакта: события obj=contact с contactId, expect, без изменений — без событий', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 53);
  const opId = op();
  await addContact(v, id, { opId, system: { name: 'Булат', position: 'Бухгалтер' }, custom: {} });
  const c = await updateContact(v, opId, {
    set: { system: { position: 'Главный бухгалтер', is_decision_maker: true }, custom: { mood: 'занят' } },
    expect: { system: { position: 'Бухгалтер', is_decision_maker: false }, custom: { mood: null } },
  });
  assert.equal(c.position, 'Главный бухгалтер');
  const ev = await events(id, 'field.changed');
  assert.equal(ev.length, 3);
  assert.ok(ev.every((e) => e.data.obj === 'contact' && e.data.contactId === opId && e.refType === 'contact' && e.refId === opId));
  assert.deepEqual(ev.find((e) => e.data.field === 'position')?.data, { obj: 'contact', sys: true, field: 'position', before: 'Бухгалтер', after: 'Главный бухгалтер', contactId: opId });
  assert.deepEqual(ev.find((e) => e.data.field === 'mood')?.data.sys, false);
  await updateContact(v, opId, { set: { system: { position: 'Главный бухгалтер' }, custom: {} }, expect: { system: { position: 'Главный бухгалтер' }, custom: {} } });
  assert.equal((await events(id, 'field.changed')).length, 3);
  await assert.rejects(updateContact(v, opId, { set: { system: { position: 'Новый' }, custom: {} }, expect: { system: { position: 'устарело' }, custom: {} } }), { code: 'conflict' });
});

test('архив: контакт уходит из карточки, повтор и чужой — 404; событие одно', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 54);
  const opId = op();
  await addContact(v, id, { opId, system: { name: 'Временный' }, custom: {} });
  assert.deepEqual(await archiveContactById(v, opId), { id: opId, archived: true });
  assert.deepEqual((await getClientCard(v, id)).contacts, []);
  assert.equal((await events(id, 'contact.archived')).length, 1);
  await assert.rejects(archiveContactById(v, opId), { code: 'not_found' });
  await assert.rejects(updateContact(v, opId, { set: { system: { name: 'Х' }, custom: {} }, expect: { system: { name: '' }, custom: {} } }), { code: 'not_found' });
  // чужой контакт
  await db.sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES ('ct-b-1', ${clientOf('b', 54)}, 'Чужой', 1)`;
  await assert.rejects(archiveContactById(v, 'ct-b-1'), { code: 'not_found' });
  await assert.rejects(updateContact(v, 'ct-b-1', { set: { system: { name: 'Х' }, custom: {} }, expect: { system: { name: 'Чужой' }, custom: {} } }), { code: 'not_found' });
  assert.equal((await db.sql<{ archivedAt: number | null }>`SELECT archived_at FROM contacts WHERE id = 'ct-b-1'`)[0]?.archivedAt, null);
});

test('контакт виден, но не правится — 403 (консультант в окне записи)', async () => {
  await db.sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES ('ct-b-2', ${clientOf('b', 2)}, 'Гость', 1)`;
  const cons = await viewerOf(U.consultant);
  await assert.rejects(updateContact(cons, 'ct-b-2', { set: { system: { name: 'Х' }, custom: {} }, expect: { system: { name: 'Гость' }, custom: {} } }), { code: 'forbidden' });
  await assert.rejects(archiveContactById(cons, 'ct-b-2'), { code: 'forbidden' });
});
