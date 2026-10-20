// Добавление и правка номеров (5.2–5.3, D-126): свободный номер, свой повтор, чужой номер и стоп-лист
// (одинаковый ответ `review`), лимит проверок, параллельные добавления, «не работает» и «основной».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { addPhone, getClientCard, updatePhone } from '../../../src/server/domain/clients';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { U, clientOf, phoneOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

let seq = 0;
const op = () => `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;


const phonesOf = async (clientId: string) =>
  db.sql<{ id: string; digits: string; isPrimary: boolean; isWorking: boolean }>`SELECT id, digits, is_primary, is_working FROM client_phones WHERE client_id = ${clientId} ORDER BY created_at, id`;
const probes = async () => db.sql<{ userId: string; matched: boolean; path: string }>`SELECT user_id, matched, path FROM phone_probes ORDER BY created_at, id`;
const tasks = async () => db.sql<{ sourceKey: string; title: string; kind: string; source: string; clientId: string; assigneeUserId: string | null }>`SELECT source_key, title, kind, source, client_id, assignee_user_id FROM tasks WHERE source = 'review' ORDER BY id`;
const events = async (clientId: string, kind: string) => db.sql`SELECT id FROM client_events WHERE client_id = ${clientId} AND kind = ${kind}`;

test('свободный номер добавляется; основным становится, если основного нет; событие и поиск', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 30);
  await db.sql`DELETE FROM client_phones WHERE client_id = ${id}`;
  const opId = op();
  const r = await addPhone(v, id, { opId, phone: '+7 709 555 01 01' });
  assert.equal(r.status, 'added');
  assert.ok(r.status === 'added' && r.phone.primary && r.phone.working && r.phone.e164 === '+77095550101');
  // второй номер — не основной
  const r2 = await addPhone(v, id, { opId: op(), phone: '8 (709) 555-01-02' });
  assert.ok(r2.status === 'added' && !r2.phone.primary);
  assert.equal((await events(id, 'phone.added')).length, 2);
  const [row] = await db.sql<{ searchNorm: string }>`SELECT search_norm FROM clients WHERE id = ${id}`;
  assert.ok(row?.searchNorm.includes('77095550101') && row.searchNorm.includes('77095550102'));
  const [p] = await probes();
  assert.deepEqual(p, { userId: U.opA, matched: false, path: 'add_phone' });
});

test('повтор с тем же opId и тот же номер — одна строка, одно событие', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 31);
  const opId = op();
  const a = await addPhone(v, id, { opId, phone: '+7 709 555 02 02' });
  const b = await addPhone(v, id, { opId, phone: '+7 709 555 02 02' });
  assert.equal(a.status, 'added');
  assert.deepEqual(a, b);
  assert.equal((await phonesOf(id)).filter((p) => p.digits === '77095550202').length, 1);
  assert.equal((await events(id, 'phone.added')).length, 1);
  // свой номер другим opId: тоже без дубля и без проверки номера
  const before = (await probes()).length;
  const c = await addPhone(v, id, { opId: op(), phone: '7095550202' });
  assert.equal(c.status, 'added');
  assert.equal((await probes()).length, before);
  assert.equal((await phonesOf(id)).filter((p) => p.digits === '77095550202').length, 1);
});

test('opId, который уже занят другим номером, — 400', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 32);
  const opId = op();
  await addPhone(v, id, { opId, phone: '+7 709 555 03 03' });
  await assert.rejects(addPhone(v, id, { opId, phone: '+7 709 555 03 04' }), { code: 'bad_request' });
  await assert.rejects(addPhone(v, clientOf('a', 33), { opId, phone: '+7 709 555 03 05' }), { code: 'bad_request' });
});

test('номер другого клиента: review, строки номера нет, проверка matched, задача РОП', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 34);
  const opId = op();
  const other = phoneOf('b', 5);
  const matchedBefore = (await probes()).filter((p) => p.matched).length;
  const r = await addPhone(v, id, { opId, phone: `+${other}` });
  assert.deepEqual(r, { status: 'review' });
  assert.equal((await phonesOf(id)).filter((p) => p.digits === other).length, 0);
  const after = await probes();
  assert.equal(after.filter((p) => p.matched).length, matchedBefore + 1);
  assert.ok(after.every((p) => p.path === 'add_phone'));
  const t = (await tasks()).find((x) => x.sourceKey === `add_phone:${opId}`);
  assert.deepEqual(t, { sourceKey: `add_phone:${opId}`, title: `+${other}`, kind: 'check', source: 'review', clientId: id, assigneeUserId: null });
  // повтор той же попытки задачу не дублирует
  await addPhone(v, id, { opId, phone: `+${other}` });
  assert.equal((await tasks()).filter((x) => x.sourceKey === `add_phone:${opId}`).length, 1);
  // в ленту ничего не пишется
  assert.equal((await events(id, 'phone.added')).length, 0);
});

test('номер из стоп-листа: review, неотличимо от занятого', async () => {
  const v = await viewerOf(U.opA);
  const digits = '77095559999';
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac(digits)}, 'do_not_call', 'manual', 1)`;
  const id = clientOf('a', 35);
  const stopped = await addPhone(v, id, { opId: op(), phone: `+${digits}` });
  const taken = await addPhone(v, id, { opId: op(), phone: `+${phoneOf('b', 6)}` });
  assert.deepEqual(stopped, { status: 'review' });
  assert.deepEqual(stopped, taken);
  assert.equal((await phonesOf(id)).filter((p) => p.digits === digits).length, 0);
});

test('слитый клиент номер «занятым» не делает', async () => {
  const v = await viewerOf(U.opA);
  const digits = phoneOf('b', 7);
  await db.sql`UPDATE clients SET merged_into_id = ${clientOf('b', 8)} WHERE id = ${clientOf('b', 7)}`;
  const r = await addPhone(v, clientOf('a', 36), { opId: op(), phone: `+${digits}` });
  assert.equal(r.status, 'added');
});

test('не номер и заглушка — 400 phone_invalid, следов нет', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 37);
  const n = (await probes()).length;
  for (const bad of ['abc', '12345', '+7 709 000 00 00', '+1 202 555 0100', '']) {
    await assert.rejects(addPhone(v, id, { opId: op(), phone: bad || ' ' }), { code: 'bad_request' }, bad);
  }
  assert.equal((await probes()).length, n);
});

test('лимит проверок в сутки: после лимита даже свободный номер уходит на проверку', async () => {
  const v = await viewerOf(U.opA);
  // у оператора A уже есть проверки с прошлых тестов; доводим до лимита текущими сутками
  const n = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${U.opA} AND day = ${v.today}`)[0]?.n ?? 0;
  for (let i = n; i < 20; i++) {
    await db.sql`INSERT INTO phone_probes (id, user_id, day, path, matched, created_at) VALUES (${`pp-fill-${i}`}, ${U.opA}, ${v.today}, 'add_phone', FALSE, ${v.now})`;
  }
  const id = clientOf('a', 38);
  const r = await addPhone(v, id, { opId: op(), phone: '+7 709 555 04 04' });
  assert.deepEqual(r, { status: 'review' });
  assert.equal((await phonesOf(id)).filter((p) => p.digits === '77095550404').length, 0);
  // другой оператор не затронут, у него свой счёт
  const other = await addPhone(await viewerOf(U.opB), clientOf('b', 40), { opId: op(), phone: '+7 709 555 04 05' });
  assert.equal(other.status, 'added');
  // вчерашние проверки не считаются
  await db.sql`UPDATE phone_probes SET day = '2026-10-27' WHERE user_id = ${U.opA}`;
  const again = await addPhone(v, id, { opId: op(), phone: '+7 709 555 04 04' });
  assert.equal(again.status, 'added');
});

test('два параллельных добавления одного номера двум клиентам: ровно одно «добавлено»', async () => {
  const v = await viewerOf(U.opA);
  const digits = '+7 709 555 05 05';
  const results = await Promise.all([
    addPhone(v, clientOf('a', 41), { opId: op(), phone: digits }),
    addPhone(v, clientOf('a', 42), { opId: op(), phone: digits }),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), ['added', 'review']);
  const rows = await db.sql`SELECT 1 FROM client_phones WHERE digits = '77095550505'`;
  assert.equal(rows.length, 1);
});

test('чужой и несуществующий клиент: 404 до всяких проверок, следов нет', async () => {
  const v = await viewerOf(U.opA);
  const n = (await probes()).length;
  const t = (await tasks()).length;
  await assert.rejects(addPhone(v, clientOf('b', 20), { opId: op(), phone: '+7 709 555 06 06' }), { code: 'not_found' });
  await assert.rejects(addPhone(v, 'cl-nope', { opId: op(), phone: '+7 709 555 06 06' }), { code: 'not_found' });
  assert.equal((await probes()).length, n);
  assert.equal((await tasks()).length, t);
  assert.equal((await db.sql`SELECT 1 FROM client_phones WHERE digits = '77095550606'`).length, 0);
});

test('контакт для номера — только этого клиента и не в архиве', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 43);
  await db.sql`INSERT INTO contacts (id, client_id, name, created_at) VALUES ('ct-43', ${id}, 'Контакт', 1), ('ct-43x', ${clientOf('a', 44)}, 'Чужой контакт', 1)`;
  await assert.rejects(addPhone(v, id, { opId: op(), phone: '+7 709 555 07 07', contactId: 'ct-43x' }), { code: 'bad_request' });
  await assert.rejects(addPhone(v, id, { opId: op(), phone: '+7 709 555 07 07', contactId: 'ct-none' }), { code: 'bad_request' });
  const r = await addPhone(v, id, { opId: op(), phone: '+7 709 555 07 07', contactId: 'ct-43' });
  assert.ok(r.status === 'added' && r.phone.contactId === 'ct-43');
  const card = await getClientCard(v, id);
  assert.equal(card.phones.find((p) => p.e164 === '+77095550707')?.contactId, 'ct-43');
});

test('«не работает» у основного: основным становится следующий рабочий; события', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 45);
  await db.sql`DELETE FROM client_phones WHERE client_id = ${id}`;
  const a = await addPhone(v, id, { opId: op(), phone: '+7 709 555 08 01' });
  await addPhone(v, id, { opId: op(), phone: '+7 709 555 08 02' });
  await addPhone(v, id, { opId: op(), phone: '+7 709 555 08 03' });
  assert.ok(a.status === 'added');
  const list = await updatePhone(v, a.status === 'added' ? a.phone.id : '', { working: false });
  assert.equal(list.find((p) => p.e164 === '+77095550801')?.working, false);
  assert.equal(list.find((p) => p.e164 === '+77095550801')?.primary, false);
  assert.equal(list.find((p) => p.e164 === '+77095550802')?.primary, true);
  assert.equal(list.filter((p) => p.primary).length, 1);
  assert.equal((await events(id, 'phone.not_working')).length, 1);
  assert.equal((await events(id, 'phone.primary')).length, 1);
  // повтор безопасен: ни события, ни изменений
  await updatePhone(v, a.status === 'added' ? a.phone.id : '', { working: false });
  assert.equal((await events(id, 'phone.not_working')).length, 1);
  // последний рабочий основной не остаётся без замены, пока есть рабочие
  const card = await getClientCard(v, id);
  assert.equal(card.primaryPhone?.e164, '+77095550802');
});

test('«сделать основным»: прежний снимается; нерабочий — 400; уже основной — без событий', async () => {
  const v = await viewerOf(U.opA);
  const id = clientOf('a', 46);
  await db.sql`DELETE FROM client_phones WHERE client_id = ${id}`;
  await addPhone(v, id, { opId: op(), phone: '+7 709 555 09 01' });
  const b = await addPhone(v, id, { opId: op(), phone: '+7 709 555 09 02' });
  const bId = b.status === 'added' ? b.phone.id : '';
  const list = await updatePhone(v, bId, { primary: true });
  assert.deepEqual(list.filter((p) => p.primary).map((p) => p.e164), ['+77095550902']);
  const n = (await events(id, 'phone.primary')).length;
  await updatePhone(v, bId, { primary: true });
  assert.equal((await events(id, 'phone.primary')).length, n);
  await updatePhone(v, bId, { working: false });
  await assert.rejects(updatePhone(v, bId, { primary: true }), { code: 'bad_request' });
});

test('номер чужого клиента и несуществующий: 404, без изменений', async () => {
  const v = await viewerOf(U.opA);
  const [theirs] = await phonesOf(clientOf('b', 1));
  await assert.rejects(updatePhone(v, theirs?.id ?? '', { working: false }), { code: 'not_found' });
  await assert.rejects(updatePhone(v, 'ph-nope', { primary: true }), { code: 'not_found' });
  assert.equal((await phonesOf(clientOf('b', 1)))[0]?.isWorking, true);
});
