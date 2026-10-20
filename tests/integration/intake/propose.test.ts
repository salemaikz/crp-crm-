// «Предложить контакт» (docs/tasks-team-design.md §5.4, D-258): свободный номер при авто-режиме — клиент и карточка
// сразу; номер у другого клиента, стоп-лист, исчерпанный лимит и ручной режим — предложение на разбор РОП. Ответ
// всегда один «принято». Счётчик проверок общий с «добавить номер». Только синтетика (+7 709 …).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestError } from '../../../src/server/access';
import { proposeContact } from '../../../src/server/domain/intake';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import { phoneHmac } from '../../../src/server/platform/hmac';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { SEED_NOW, SEED_TODAY, U, phoneOf } from '../../isolation/harness/seed';
import { callsConfig, closeCallsWorld, openCallsWorld, uuid, viewerOf } from '../calls/world';

let db: TestDb;

async function setMode(mode: 'auto_even' | 'manual'): Promise<void> {
  const c = callsConfig();
  (c.spaces.sales as { distribution: { mode: string } }).distribution.mode = mode;
  resetConfigCache();
  await writeConfig({ docs: c, source: 'cli', authorId: null, project: true, note: `режим ${mode}` });
}

before(async () => {
  db = await openCallsWorld();
  await setMode('auto_even');
});
after(() => closeCallsWorld(db));

const pending = () => db.sql<{ status: string; matchedClientId: string | null; clientId: string | null; userId: string }>`
  SELECT status, matched_client_id, client_id, user_id FROM proposals ORDER BY created_at, id`;

test('свободный номер при авто-режиме: клиент, номер, карточка без владельца, лента; ответ «принято»', async () => {
  const op = await viewerOf(U.opA);
  const opId = uuid();
  const res = await proposeContact(op, { opId, phone: '+7 709 555 01 01', name: 'ТОО Предложенная Один' });
  assert.deepEqual(res, { status: 'accepted' });
  const [p] = await pending();
  assert.equal(p?.status, 'created');
  assert.ok(p?.clientId);
  const [card] = await db.sql<{ state: string; ownerUserId: string | null; holdReason: string }>`SELECT state, owner_user_id, hold_reason FROM cards WHERE client_id = ${p!.clientId}`;
  assert.deepEqual(card, { state: 'new', ownerUserId: null, holdReason: '' });
  const [cl] = await db.sql<{ sourceKind: string }>`SELECT source_kind FROM clients WHERE id = ${p!.clientId}`;
  assert.equal(cl?.sourceKind, 'proposal');
  const ev = await db.sql<{ kind: string }>`SELECT kind FROM client_events WHERE client_id = ${p!.clientId} ORDER BY kind`;
  assert.deepEqual(ev.map((e) => e.kind), ['card.created', 'client.created']);
  const probes = await db.sql<{ path: string; matched: boolean }>`SELECT path, matched FROM phone_probes WHERE user_id = ${U.opA}`;
  assert.deepEqual(probes, [{ path: 'proposal', matched: false }]);

  // повтор того же opId — «принято», второго клиента нет
  assert.deepEqual(await proposeContact(op, { opId, phone: '+7 709 555 01 01', name: 'ТОО Предложенная Один' }), { status: 'accepted' });
  assert.equal((await pending()).length, 1);
  // чужой opId — ошибка запроса
  const other = await viewerOf(U.opB);
  await assert.rejects(proposeContact(other, { opId, phone: '+7 709 555 01 02', name: 'ТОО Другая' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'op_id');
});

test('номер у другого клиента: ответ тот же, клиента нет, предложение ушло на разбор с совпадением', async () => {
  const op = await viewerOf(U.opA);
  const digits = phoneOf('b', 1);
  const res = await proposeContact(op, { opId: uuid(), phone: `+${digits}`, name: 'ТОО Дубль' });
  assert.deepEqual(res, { status: 'accepted' });
  const rows = await pending();
  const review = rows.find((r) => r.status === 'review');
  assert.ok(review);
  assert.equal(review.clientId, null);
  assert.equal(review.matchedClientId, 'cl-b-1');
  const [n] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM clients WHERE name = 'ТОО Дубль'`;
  assert.equal(n?.n, 0);
  const probe = await db.sql<{ matched: boolean }>`SELECT matched FROM phone_probes WHERE user_id = ${U.opA} ORDER BY created_at DESC, id LIMIT 1`;
  assert.equal(probe[0]?.matched, true);
});

test('стоп-лист: предложение на разбор без клиента', async () => {
  const op = await viewerOf(U.opA);
  const digits = '77095550202';
  await db.sql`INSERT INTO stop_list (phone_hmac, reason_code, source, created_at) VALUES (${phoneHmac(digits)}, 'asked', 'manual', ${SEED_NOW}) ON CONFLICT DO NOTHING`;
  assert.deepEqual(await proposeContact(op, { opId: uuid(), phone: `+${digits}`, name: 'ТОО Из Стоп-листа' }), { status: 'accepted' });
  const [n] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM clients WHERE name = 'ТОО Из Стоп-листа'`;
  assert.equal(n?.n, 0);
  const [p] = await db.sql<{ status: string }>`SELECT status FROM proposals WHERE digits = ${digits}`;
  assert.equal(p?.status, 'review');
});

test('не номер: 400 phone_invalid, проверка не тратится, предложения нет', async () => {
  const op = await viewerOf(U.opB);
  const before = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${U.opB}`)[0]!.n;
  await assert.rejects(proposeContact(op, { opId: uuid(), phone: '12345', name: 'ТОО Мусор' }), (e: unknown) => e instanceof BadRequestError && e.detail === 'phone_invalid');
  const after = (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM phone_probes WHERE user_id = ${U.opB}`)[0]!.n;
  assert.equal(after, before);
});

test('лимит проверок общий: исчерпан — на разбор, РОП получает probe_limit один раз за сутки', async () => {
  const op = await viewerOf(U.duty);
  // phoneProbesPerDay = 20 в настройках мира: заполняем счётчик «добавить номер» и «предложить»
  for (let i = 0; i < 20; i++) {
    await db.sql`INSERT INTO phone_probes (id, user_id, day, path, matched, created_at) VALUES (${uuid()}, ${U.duty}, ${SEED_TODAY}, ${i % 2 === 0 ? 'add_phone' : 'proposal'}, FALSE, ${SEED_NOW})`;
  }
  for (const digits of ['77095550301', '77095550302']) {
    assert.deepEqual(await proposeContact(op, { opId: uuid(), phone: `+${digits}`, name: `ТОО Лимит ${digits}` }), { status: 'accepted' });
    const [p] = await db.sql<{ status: string }>`SELECT status FROM proposals WHERE digits = ${digits}`;
    assert.equal(p?.status, 'review');
  }
  const notes = await db.sql<{ userId: string; dedupeKey: string; params: { count: number } }>`SELECT user_id, dedupe_key, params FROM notifications WHERE kind = 'probe_limit'`;
  assert.equal(notes.length, 1);
  assert.equal(notes[0]?.userId, U.rop);
  assert.equal(notes[0]?.dedupeKey, `probe_limit:${U.duty}:${SEED_TODAY}`);
});

test('ручной режим раздачи: даже свободный номер идёт на разбор', async () => {
  await setMode('manual');
  try {
    const op = await viewerOf(U.opB);
    assert.deepEqual(await proposeContact(op, { opId: uuid(), phone: '+7 709 555 04 04', name: 'ТОО Ручной Режим' }), { status: 'accepted' });
    const [p] = await db.sql<{ status: string }>`SELECT status FROM proposals WHERE digits = '77095550404'`;
    assert.equal(p?.status, 'review');
    const [n] = await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM clients WHERE name = 'ТОО Ручной Режим'`;
    assert.equal(n?.n, 0);
  } finally {
    await setMode('auto_even');
  }
});
