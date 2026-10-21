// Автор итога и пропуска (D-291): заголовок X-Call-Author сверяется с сессией. Не совпал — 409 wrong_user, и ничего
// не пишется (ни calls, ни карточка, ни статус устройства). Совпал — обычный итог; повтор того же opId от того же
// автора идемпотентен. Нет заголовка — запрос от сессии как есть. Чтения экрана «Звонить» (очередь, «Сегодня») с чужим
// автором тоже 409 (D-292): вкладка прежнего сотрудника не получает карточки нового.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { POST as postOutcome } from '../../../src/app/api/calls/outcomes/route';
import { POST as postSkip } from '../../../src/app/api/calls/skips/route';
import { GET as getQueue } from '../../../src/app/api/calls/queue/route';
import { GET as getToday } from '../../../src/app/api/calls/today/route';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { actAs } from '../../isolation/harness/actors';
import { cardOf, closeCallsWorld, MIN, openCallsWorld, outcomeReq, setCard, uuid } from './world';

const ORIGIN = 'http://crm.test';
let db: TestDb;

async function call(handler: typeof postOutcome, path: string, as: string, body: unknown, headers: Record<string, string> = {}) {
  actAs(as);
  const res = await handler(
    new Request(`${ORIGIN}${path}`, { method: 'POST', headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }),
    { params: Promise.resolve({}) },
  );
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

const outcome = (cardId: string) => outcomeReq({ cardId, occurredAt: Date.now() - MIN });
const n = async (q: Promise<Array<{ n: number }>>) => (await q)[0]!.n;
const callsOf = (opId: string) => n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ${opId}`);
const devices = (deviceId: string) => n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM device_status WHERE device_id = ${deviceId}`);

before(async () => {
  db = await openCallsWorld();
  for (const id of ['cd-a-91', 'cd-a-92', 'cd-a-93', 'cd-a-94']) await setCard(db.sql, id, { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
});
after(() => closeCallsWorld(db));

test('итог outbox автора A под сессией B: 409 wrong_user, ни calls, ни карточки, ни статуса устройства', async () => {
  const req = outcome('cd-a-91');
  const before = await cardOf(db.sql, 'cd-a-91');
  const r = await call(postOutcome, '/api/calls/outcomes', U.opB, req, { 'x-call-author': U.opA, 'x-device-id': 'dev-author-1', 'x-outbox-pending': '1' });
  assert.equal(r.status, 409);
  assert.equal(r.json?.code, 'wrong_user');
  assert.equal(await callsOf(req.opId), 0);
  assert.deepEqual(await cardOf(db.sql, 'cd-a-91'), before);
  assert.equal(await devices('dev-author-1'), 0);
});

test('тот же итог под сессией автора принимается; повтор того же opId от того же автора — duplicate, одна строка', async () => {
  const req = outcome('cd-a-92');
  const first = await call(postOutcome, '/api/calls/outcomes', U.opA, req, { 'x-call-author': U.opA });
  assert.equal(first.status, 200);
  assert.equal(first.json?.status, 'applied');
  const card = await cardOf(db.sql, 'cd-a-92');
  const again = await call(postOutcome, '/api/calls/outcomes', U.opA, req, { 'x-call-author': U.opA });
  assert.equal(again.status, 200);
  assert.equal(again.json?.status, 'duplicate');
  assert.equal(await callsOf(req.opId), 1);
  assert.deepEqual(await cardOf(db.sql, 'cd-a-92'), card, 'повтор карточку не двигает');
  // Тот же opId под чужой сессией с автором A — по-прежнему 409, строка одна
  const wrong = await call(postOutcome, '/api/calls/outcomes', U.opB, req, { 'x-call-author': U.opA });
  assert.equal(wrong.status, 409);
  assert.equal(await callsOf(req.opId), 1);
});

test('итог, задержанный из-за wrong_user, уходит после входа автора: одна строка', async () => {
  const req = outcome('cd-a-93');
  assert.equal((await call(postOutcome, '/api/calls/outcomes', U.opB, req, { 'x-call-author': U.opA })).status, 409);
  assert.equal((await call(postOutcome, '/api/calls/outcomes', U.opA, req, { 'x-call-author': U.opA })).status, 200);
  assert.equal(await callsOf(req.opId), 1);
});

test('пропуск: автор не совпал — 409 wrong_user и строки в skips нет', async () => {
  const opId = uuid();
  const r = await call(postSkip, '/api/calls/skips', U.opB, { opId, cardId: 'cd-a-94' }, { 'x-call-author': U.opA });
  assert.equal(r.status, 409);
  assert.equal(r.json?.code, 'wrong_user');
  assert.equal(await n(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM skips WHERE id = ${opId}`), 0);
});

test('без заголовка автора — итог от сессии как есть (скрипты и интеграции)', async () => {
  await setCard(db.sql, 'cd-a-95', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcome('cd-a-95');
  const r = await call(postOutcome, '/api/calls/outcomes', U.opA, req);
  assert.equal(r.status, 200);
  assert.equal(await callsOf(req.opId), 1);
});

async function read(handler: typeof getQueue, path: string, as: string, headers: Record<string, string> = {}) {
  actAs(as);
  const res = await handler(new Request(`${ORIGIN}${path}`, { headers }), { params: Promise.resolve({}) });
  return { status: res.status, json: (await res.json().catch(() => null)) as Record<string, unknown> | null };
}

test('очередь и «Сегодня» под сессией B с автором A: 409 wrong_user, карточек B в ответе нет, статус устройства не пишется', async () => {
  for (const [handler, path] of [[getQueue, '/api/calls/queue?limit=4'], [getToday, '/api/calls/today']] as const) {
    const r = await read(handler, path, U.opB, { 'x-call-author': U.opA, 'x-device-id': 'dev-author-read', 'x-outbox-pending': '0' });
    assert.equal(r.status, 409, path);
    assert.deepEqual(r.json, { error: 'wrong_user', code: 'wrong_user' }, path);
  }
  assert.equal(await devices('dev-author-read'), 0);
});

test('очередь и «Сегодня» под сессией автора и без заголовка — обычный ответ', async () => {
  for (const [handler, path] of [[getQueue, '/api/calls/queue?limit=4'], [getToday, '/api/calls/today']] as const) {
    assert.equal((await read(handler, path, U.opB, { 'x-call-author': U.opB })).status, 200, path);
    assert.equal((await read(handler, path, U.opB)).status, 200, path);
  }
});
