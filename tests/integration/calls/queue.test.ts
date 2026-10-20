// Очередь «Звонить» (docs/calls-design.md §8, D-177): порядок групп, будущие перезвоны, exclude, временный владелец,
// пропущенные в конце, мобильные первыми, номера и поля только своей карточки.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { getQueue } from '../../../src/server/domain/calls/queue';
import { submitSkip } from '../../../src/server/domain/calls/skips';
import type { CallsDeps } from '../../../src/server/domain/calls';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U, phoneOf } from '../../isolation/harness/seed';
import { HOUR, MIN, SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, setCard, uuid, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
let opB: Viewer;
const clock = { now: SEED_NOW };

const ask = (v: Viewer, q: Partial<{ limit: number; exclude: string[]; group: 'all' | 'callbacks' | 'retries' | 'new' | 'returns' }> = {}) =>
  getQueue(deps, v, { limit: 4, exclude: [], group: 'all', ...q });
const ids = (r: Awaited<ReturnType<typeof ask>>) => r.items.map((i) => i.cardId);

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  // чистый лист: все карточки A списаны, нужные поднимаются в тестах
  await db.sql`UPDATE cards SET state = 'written_off' WHERE owner_user_id = ${U.opA}`;
  await setCard(db.sql, 'cd-a-1', { state: 'new', nextCallAt: null });
  await setCard(db.sql, 'cd-a-2', { state: 'retry', nextCallAt: SEED_NOW - HOUR, attempts: 1 });
  await setCard(db.sql, 'cd-a-3', { state: 'callback', nextCallAt: SEED_NOW - 2 * HOUR });
  await setCard(db.sql, 'cd-a-4', { state: 'callback', nextCallAt: SEED_NOW + HOUR }); // будущий перезвон
  await setCard(db.sql, 'cd-a-5', { state: 'new', nextCallAt: null, holdReason: 'dup_pair' }); // задержана
  await setCard(db.sql, 'cd-a-6', { state: 'agreed', nextCallAt: null });
});
after(() => closeCallsWorld(db));

test('порядок групп по queue.order: перезвоны → повторы → новые; будущие перезвоны и задержанные не видны', async () => {
  const r = await ask(opA);
  assert.deepEqual(ids(r), ['cd-a-3', 'cd-a-2', 'cd-a-1']);
  assert.deepEqual(r.items.map((i) => i.group), ['callbacks', 'retries', 'new']);
  assert.deepEqual(
    { dueNow: r.counts.dueNow, callbacks: r.counts.callbacks, retries: r.counts.retries, new: r.counts.new, returns: r.counts.returns, skipLimit: r.counts.skipLimit },
    { dueNow: 3, callbacks: 1, retries: 1, new: 1, returns: 0, skipLimit: 10 },
  );
});

test('просрочка перезвона: считается от tasks.overdueAlertMinutes (60 мин)', async () => {
  const r = await ask(opA);
  assert.equal(r.counts.overdue, 1, 'cd-a-3 просрочен на 2 часа, остальные нет');
  await setCard(db.sql, 'cd-a-3', { nextCallAt: SEED_NOW - 30 * MIN });
  assert.equal((await ask(opA)).counts.overdue, 0);
  await setCard(db.sql, 'cd-a-3', { nextCallAt: SEED_NOW - 2 * HOUR });
});

test('limit и group: вкладки и одна карточка по умолчанию', async () => {
  assert.deepEqual(ids(await ask(opA, { limit: 1 })), ['cd-a-3']);
  assert.deepEqual(ids(await ask(opA, { group: 'retries' })), ['cd-a-2']);
  assert.deepEqual(ids(await ask(opA, { group: 'new' })), ['cd-a-1']);
  assert.deepEqual(ids(await ask(opA, { group: 'returns' })), [], 'возвращённые появятся в C6c');
  const tab = await ask(opA, { group: 'new' });
  assert.equal(tab.counts.dueNow, 3, 'счётчики не зависят от вкладки');
});

test('exclude: карточки с итогом в outbox устройства не отдаются', async () => {
  assert.deepEqual(ids(await ask(opA, { exclude: ['cd-a-3'] })), ['cd-a-2', 'cd-a-1']);
});

test('наступивший перезвон появляется в очереди', async () => {
  clock.now = SEED_NOW + 2 * HOUR;
  try {
    assert.deepEqual(ids(await ask(opA)).slice(0, 2), ['cd-a-3', 'cd-a-4']);
  } finally {
    clock.now = SEED_NOW;
  }
});

test('временный владелец ведёт карточку отсутствующего как свою; карточки B в очереди A никогда', async () => {
  await setCard(db.sql, 'cd-b-1', { state: 'new', nextCallAt: null, acting: U.opA });
  await setCard(db.sql, 'cd-b-2', { state: 'new', nextCallAt: null });
  const r = await ask(opA);
  assert.ok(ids(r).includes('cd-b-1'));
  assert.ok(!ids(r).includes('cd-b-2'));
  assert.ok(!JSON.stringify(r).includes(phoneOf('b', 2)), 'номер чужой карточки в ответе A отсутствует');
  const rb = await ask(opB);
  assert.ok(ids(rb).includes('cd-b-2'));
  await setCard(db.sql, 'cd-b-1', { acting: null });
});

test('пропущенная сегодня карточка уходит в конец; счётчик пропусков растёт', async () => {
  await submitSkip(deps, opA, { opId: uuid(), cardId: 'cd-a-3' });
  const r = await ask(opA);
  assert.deepEqual(ids(r), ['cd-a-2', 'cd-a-1', 'cd-a-3']);
  assert.equal(r.items[2]!.skippedToday, true);
  assert.equal(r.counts.skippedToday, 1);
});

test('mobileFirst: среди новых сначала карточки с рабочим мобильным', async () => {
  await db.sql`UPDATE cards SET state = 'written_off' WHERE owner_user_id = ${U.opA}`;
  await setCard(db.sql, 'cd-a-10', { state: 'new', nextCallAt: null });
  await setCard(db.sql, 'cd-a-11', { state: 'new', nextCallAt: null });
  await db.sql`UPDATE cards SET assigned_at = ${SEED_NOW - 2 * HOUR} WHERE id = 'cd-a-10'`;
  await db.sql`UPDATE cards SET assigned_at = ${SEED_NOW - HOUR} WHERE id = 'cd-a-11'`;
  await db.sql`UPDATE client_phones SET kind = 'landline' WHERE id = 'ph-a-10'`;
  assert.deepEqual(ids(await ask(opA)), ['cd-a-11', 'cd-a-10'], 'мобильный раньше, хотя назначен позже');
});

test('номера: только рабочие и не из стоп-листа; поля — по правам; ответ без чужих данных', async () => {
  await db.sql`UPDATE cards SET state = 'written_off' WHERE owner_user_id = ${U.opA}`;
  await setCard(db.sql, 'cd-a-12', { state: 'new', nextCallAt: null });
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, is_working, created_at) VALUES ('ph-a-12x', 'cl-a-12', '77090900099', 'mobile', FALSE, ${SEED_NOW})`;
  await db.sql`INSERT INTO client_phones (id, client_id, digits, kind, created_at) VALUES ('ph-a-12y', 'cl-a-12', '77090900098', 'mobile', ${SEED_NOW})`;
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac('77090900098')}, 'asked', 'outcome', ${SEED_NOW})`;
  await db.sql`UPDATE clients SET custom = ${db.json({ segment: 'розница', secret: 'скрытое' })} WHERE id = 'cl-a-12'`;
  const r = await ask(opA);
  assert.equal(r.items.length, 1);
  const card = r.items[0]!;
  assert.deepEqual(card.phones.map((p) => p.id), ['ph-a-12']);
  assert.equal(card.phones[0]!.digits, phoneOf('a', 12));
  assert.equal(card.name, 'ТОО Синтетика Альфа 12');
  assert.equal(card.fields.segment, 'розница');
  assert.ok(!('secret' in card.fields), 'поле, скрытое от оператора, не отдаётся');
});
