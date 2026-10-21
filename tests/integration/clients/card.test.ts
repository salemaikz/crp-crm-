// Карточка клиента: шапка, счётчики с карточки, главный номер, ЛПР, слитый клиент, чужой клиент.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { findSurvivor, getClientCard, loadClientPage } from '../../../src/server/domain/clients';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, cardOf, clientOf, phoneOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

/** Действия, которые подключат B7, C9, B9a: до их влития сервер отдаёт false. */
const CAN_OFF = { edit: false, editIdentity: false, editCard: false, note: false, book: false, task: false, closeFromMenu: false, reopen: false, unblock: false, transfer: false };

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

test('оператор видит карточку своего клиента: шапка, номер, права', async () => {
  const v = await viewerOf(U.opA);
  const c = await getClientCard(v, clientOf('a', 1));
  assert.equal(c.name, 'ТОО Синтетика Альфа 1');
  assert.equal(c.kind, 'company');
  assert.equal(c.card?.state, 'retry');
  assert.equal(c.card?.ownerName, 'Оператор Синтетик А');
  assert.deepEqual(c.can, { ...CAN_OFF, edit: true, editIdentity: false, editCard: true, note: true, task: true, closeFromMenu: true });
  assert.equal(c.phones.length, 1);
  assert.equal(c.primaryPhone?.e164, `+${phoneOf('a', 1)}`);
  assert.equal(c.decisionMaker, null);
  assert.deepEqual(c.contacts, []);
});

test('РОП видит право на изменение названия и БИН', async () => {
  const v = await viewerOf(U.rop);
  const c = await getClientCard(v, clientOf('a', 1));
  assert.deepEqual(c.can, { ...CAN_OFF, edit: true, editIdentity: true, editCard: true, note: true, task: true, closeFromMenu: true, transfer: true });
});

test('счётчики берутся с карточки, без пересчёта', async () => {
  await db.sql`UPDATE cards SET calls_total = 7, no_answer_total = 4, connects_total = 3, last_connect_at = 1790000000000, next_call_at = 1790000100000 WHERE id = ${cardOf('a', 2)}`;
  const c = await getClientCard(await viewerOf(U.opA), clientOf('a', 2));
  assert.deepEqual(c.card?.counters, {
    callsTotal: 7,
    noAnswerTotal: 4,
    connectsTotal: 3,
    firstConnectAt: null,
    lastConnectAt: 1790000000000,
    lastTouchAt: null,
  });
  assert.equal(c.card?.nextCallAt, 1790000100000);
});

test('ЛПР первым; главный номер — рабочий основной, иначе первый рабочий', async () => {
  const id = clientOf('a', 3);
  await db.sql`INSERT INTO contacts (id, client_id, name, position, is_decision_maker, created_at) VALUES ('ct-a3-1', ${id}, 'Помощник', '', FALSE, 1), ('ct-a3-2', ${id}, 'Директор', 'Директор', TRUE, 2)`;
  await db.sql`UPDATE client_phones SET is_working = FALSE, is_primary = FALSE WHERE client_id = ${id}`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_primary, created_at) VALUES ('ph-a3-x', ${id}, '77091110000', 'mobile', FALSE, 5)`;
  const c = await getClientCard(await viewerOf(U.opA), id);
  assert.equal(c.contacts[0]?.name, 'Директор');
  assert.deepEqual(c.decisionMaker, { contactId: 'ct-a3-2', name: 'Директор' });
  assert.equal(c.primaryPhone?.e164, '+77091110000');
  assert.equal(c.phones.find((p) => !p.working)?.id, 'ph-a-3');
});

test('архивный контакт в карточке не показывается', async () => {
  const id = clientOf('a', 3);
  await db.sql`UPDATE contacts SET archived_at = 9 WHERE id = 'ct-a3-1'`;
  const c = await getClientCard(await viewerOf(U.opA), id);
  assert.deepEqual(c.contacts.map((x) => x.id), ['ct-a3-2']);
});

test('чужой и несуществующий клиент: одинаковый 404', async () => {
  const v = await viewerOf(U.opA);
  await assert.rejects(getClientCard(v, clientOf('b', 1)), { code: 'not_found' });
  await assert.rejects(getClientCard(v, 'cl-nope'), { code: 'not_found' });
  assert.deepEqual(await loadClientPage(v, clientOf('b', 1)), { kind: 'missing' });
  assert.deepEqual(await loadClientPage(v, 'cl-nope'), { kind: 'missing' });
});

test('слитый клиент: в API 404, страница ведёт к выжившему, чужому выжившему — нет', async () => {
  // A5 слит в A4 (карточка A5 уже перенесена), A7 слит в B1 (чужой выживший)
  await db.sql`DELETE FROM client_phones WHERE client_id = ANY(${[clientOf('a', 5), clientOf('a', 7)]})`;
  await db.sql`DELETE FROM cards WHERE id = ANY(${[cardOf('a', 5), cardOf('a', 7)]})`;
  await db.sql`UPDATE clients SET merged_into_id = ${clientOf('a', 4)} WHERE id = ${clientOf('a', 5)}`;
  await db.sql`UPDATE clients SET merged_into_id = ${clientOf('b', 1)} WHERE id = ${clientOf('a', 7)}`;
  const v = await viewerOf(U.opA);
  await assert.rejects(getClientCard(v, clientOf('a', 5)), { code: 'not_found' });
  assert.equal(await findSurvivor(v, clientOf('a', 5)), clientOf('a', 4));
  assert.deepEqual(await loadClientPage(v, clientOf('a', 5)), { kind: 'redirect', to: `/clients/${clientOf('a', 4)}` });
  // выжившего оператор не видит — страницы нет, адрес чужого клиента не раскрывается
  assert.deepEqual(await loadClientPage(v, clientOf('a', 7)), { kind: 'missing' });
  assert.equal(await findSurvivor(v, clientOf('a', 7)), null);
  // и сам выживший открывается обычной карточкой
  const ok = await loadClientPage(v, clientOf('a', 4));
  assert.equal(ok.kind, 'ok');
});

test('директор (только чтение) видит карточку без права правки', async () => {
  const c = await getClientCard(await viewerOf(U.director), clientOf('a', 1));
  assert.equal(c.can.edit, false);
});

test('«Записать» (can.book): только в состоянии «Договорились»/«Клиент» и при праве записи', async () => {
  const a = await viewerOf(U.opA);
  assert.equal((await getClientCard(a, clientOf('a', 3))).can.book, false, 'повторный звонок — рано');
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = ${cardOf('a', 3)}`;
  assert.equal((await getClientCard(a, clientOf('a', 3))).can.book, true);
  await db.sql`UPDATE cards SET state = 'client' WHERE id = ${cardOf('a', 3)}`;
  assert.equal((await getClientCard(a, clientOf('a', 3))).can.book, true);
  await db.sql`UPDATE cards SET state = 'not_target' WHERE id = ${cardOf('a', 3)}`;
  assert.equal((await getClientCard(a, clientOf('a', 3))).can.book, false);
  await db.sql`UPDATE cards SET state = 'agreed' WHERE id = ${cardOf('a', 3)}`;
  const dir = await viewerOf(U.director);
  assert.equal((await getClientCard(dir, clientOf('a', 3))).can.book, false, 'директор только читает');
});
