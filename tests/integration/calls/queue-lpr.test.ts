// Очередь «Звонить»: ЛПР (имя, должность, телефон) и последняя заметка в карточке очереди; сводка «Сегодня».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { getQueue } from '../../../src/server/domain/calls/queue';
import { submitSkip } from '../../../src/server/domain/calls/skips';
import { getToday } from '../../../src/server/domain/calls/today';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U, phoneOf } from '../../isolation/harness/seed';
import { HOUR, MIN, SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
let opB: Viewer;
const clock = { now: SEED_NOW };
const ask = (v: Viewer, limit = 4) => getQueue(deps, v, { limit, exclude: [], group: 'all' });
const item = async (cardId: string) => (await ask(opA)).items.find((i) => i.cardId === cardId);

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  await db.sql`UPDATE cards SET state = 'written_off' WHERE owner_user_id = ${U.opA}`;
  for (const id of ['cd-a-95', 'cd-a-96', 'cd-a-97', 'cd-a-98']) await setCard(db.sql, id, { state: 'new', nextCallAt: null });
  // у клиента 95: ЛПР с должностью и своим номером, а также контакт не-ЛПР и архивный ЛПР
  await db.sql`INSERT INTO contacts (id, client_id, name, position, is_decision_maker, created_at, archived_at) VALUES
    ('ct-95-old', 'cl-a-95', 'Бывший Синтетик', 'Директор', TRUE, ${SEED_NOW - 3 * HOUR}, ${SEED_NOW - HOUR}),
    ('ct-95-acc', 'cl-a-95', 'Бухгалтер Синтетик', 'Бухгалтер', FALSE, ${SEED_NOW - 2 * HOUR}, NULL),
    ('ct-95', 'cl-a-95', 'Асель Синтетик', 'Директор', TRUE, ${SEED_NOW - HOUR}, NULL)`;
  await db.sql`INSERT INTO client_phones (id, client_id, contact_id, digits, kind, is_primary, created_at)
               VALUES ('ph-95-lpr', 'cl-a-95', 'ct-95', '77091990001', 'mobile', FALSE, ${SEED_NOW})`;
  // у клиента 96: ЛПР без телефона
  await db.sql`INSERT INTO contacts (id, client_id, name, position, is_decision_maker, created_at) VALUES ('ct-96', 'cl-a-96', 'Данияр Синтетик', '', TRUE, ${SEED_NOW})`;
});
after(() => closeCallsWorld(db));

test('ЛПР: первый не архивный контакт с признаком; должность и рабочий телефон контакта; нет ЛПР — null', async () => {
  const a = await item('cd-a-95');
  assert.deepEqual(a?.decisionMaker, { contactId: 'ct-95', name: 'Асель Синтетик', position: 'Директор', phone: '77091990001' });
  const b = await item('cd-a-96');
  assert.deepEqual(b?.decisionMaker, { contactId: 'ct-96', name: 'Данияр Синтетик', position: '', phone: null });
  assert.equal((await item('cd-a-97'))?.decisionMaker, null);
});

test('телефон ЛПР из стоп-листа не отдаётся', async () => {
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77091990001')}, 'do_not_call', 'manual', ${SEED_NOW})`;
  try {
    assert.equal((await item('cd-a-95'))?.decisionMaker?.phone, null);
  } finally {
    await db.sql`DELETE FROM stop_list WHERE phone_hmac = ${phoneHmac('77091990001')}`;
  }
});

test('последняя заметка: свежайшая из заметок клиента и заметок итогов, усечена до 300 символов', async () => {
  assert.equal((await item('cd-a-97'))?.lastNote, null);
  await db.sql`INSERT INTO notes (id, client_id, space_id, author_id, body, created_at)
               VALUES ('nt-97-a', 'cl-a-97', 'sp-sales', ${U.opA}, 'старая заметка', ${SEED_NOW - 5 * HOUR}),
                      ('nt-97-b', 'cl-a-97', 'sp-sales', ${U.opA}, '   ', ${SEED_NOW - MIN})`;
  assert.deepEqual((await item('cd-a-97'))?.lastNote, { text: 'старая заметка', at: SEED_NOW - 5 * HOUR });
  // заметка итога звонка новее — она и показывается
  await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, note, applied, occurred_at, received_at, config_rev)
               VALUES ('call-97', 'sp-sales', 'cd-a-97', 'cl-a-97', ${U.opA}, 'ui', ${phoneOf('a', 97)}, 'no_answer', 'no_answer', ${'д'.repeat(400)}, 'applied', ${SEED_NOW - 2 * HOUR}, ${SEED_NOW - 2 * HOUR}, 1)`;
  const n = (await item('cd-a-97'))?.lastNote;
  assert.equal(n?.at, SEED_NOW - 2 * HOUR);
  assert.equal(n?.text.length, 300);
});

test('чужой оператор не видит ЛПР и заметок карточек A', async () => {
  const r = await ask(opB);
  assert.ok(r.items.every((i) => !['cd-a-95', 'cd-a-96', 'cd-a-97'].includes(i.cardId)));
});

test('сводка «Сегодня»: итоги, дозвоны, записи и пропуски оператора за местные сутки', async () => {
  const before = await getToday(deps, opA);
  assert.equal(before.skipLimit, 10);
  assert.match(before.day, /^\d{4}-\d{2}-\d{2}$/);
  await setCard(db.sql, 'cd-a-98', { state: 'new', nextCallAt: null, attempts: 0, lastOutcomeAt: null });
  await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-98', outcomeKey: 'no_answer' }));
  const after1 = await getToday(deps, opA);
  assert.equal(after1.outcomes, before.outcomes + 1);
  assert.equal(after1.connected, before.connected, '«Не берёт» — не дозвон');
  // чужие итоги в сводку оператора не попадают: у B только его собственные звонки
  const own = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE user_id = ${U.opB} AND via <> 'import'`;
  assert.ok((await getToday(deps, opB)).outcomes <= own[0]!.n);
});

test('сводка «Сегодня»: итог вчерашних суток не считается', async () => {
  const t0 = await getToday(deps, opA);
  await db.sql`INSERT INTO calls (id, space_id, card_id, client_id, user_id, via, phone_digits, outcome_code, outcome_kind, applied, occurred_at, received_at, config_rev)
               VALUES ('call-yday', 'sp-sales', 'cd-a-98', 'cl-a-98', ${U.opA}, 'ui', ${phoneOf('a', 98)}, 'agreed', 'agreed', 'applied', ${SEED_NOW - 48 * HOUR}, ${SEED_NOW - 48 * HOUR}, 1)`;
  assert.equal((await getToday(deps, opA)).outcomes, t0.outcomes);
});

test('сводка «Сегодня»: пропуски сегодня и лимит из настроек', async () => {
  await setCard(db.sql, 'cd-a-96', { state: 'new', nextCallAt: null });
  const t0 = await getToday(deps, opA);
  await submitSkip(deps, opA, { opId: crypto.randomUUID(), cardId: 'cd-a-96' });
  const t1 = await getToday(deps, opA);
  assert.equal(t1.skips, t0.skips + 1);
  assert.equal(t1.skipLimit, 10);
});
