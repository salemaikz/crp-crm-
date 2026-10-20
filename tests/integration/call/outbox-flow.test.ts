// Outbox устройства против настоящего домена обзвона: офлайн → сеть → ни потерь, ни дублей (ARCHITECTURE §7, D-063).
// Транспорт — прямой вызов submitOutcome от лица оператора A, ответы переводятся в статусы так же, как маршрут.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { CallsDomainError, httpFailure } from '../../../src/server/domain/calls/errors';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { Outbox, type OutcomeSender } from '../../../src/ui/call/outbox';
import { createMemoryStore } from '../../../src/ui/call/outboxStore';
import type { OutcomeRequest } from '../../../src/ui/call/types';
import { U } from '../../isolation/harness/seed';
import { MIN, SEED_NOW, callsDeps, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from '../calls/world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
const clock = { now: SEED_NOW };
const net = { online: true, dropResponses: 0 };

const sender = (viewer: Viewer): OutcomeSender => async (req: OutcomeRequest) => {
  if (!net.online) throw new Error('нет сети');
  try {
    await submitOutcome(deps, viewer, req);
  } catch (e) {
    if (!(e instanceof CallsDomainError)) return { status: 500 };
    const f = httpFailure(e);
    if (f.kind === 'not_found') return { status: 404 };
    if (f.kind === 'forbidden') return { status: 403 };
    return { status: f.status, code: String((f.body as { code?: unknown }).code ?? f.body.error) };
  }
  if (net.dropResponses > 0) {
    net.dropResponses--;
    throw new Error('ответ потерян');
  }
  return { status: 200 };
};

const rowsOf = async (ids: string[]): Promise<number> => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ANY(${ids})`)[0]!.n;
const newCards = async (from: number, n: number): Promise<string[]> => {
  const ids: string[] = [];
  for (let i = from; i < from + n; i++) {
    const id = `cd-a-${i}`;
    await setCard(db.sql, id, { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
    ids.push(id);
  }
  return ids;
};

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
});
after(() => closeCallsWorld(db));

test('5 итогов без сети → сеть вернулась → 5 строк на сервере, без дублей; потерянный ответ не создаёт второй строки', async () => {
  const cards = await newCards(10, 5);
  const t = { now: Date.now() };
  const outbox = new Outbox({ store: createMemoryStore(), userId: U.opA, now: () => t.now, send: sender(opA) });
  net.online = false;
  const reqs = cards.map((cardId, i) => outcomeReq({ cardId, occurredAt: SEED_NOW - (10 - i) * MIN, via: 'offline' }));
  for (const r of reqs) await outbox.enqueue({ request: r, title: r.cardId, kind: 'no_answer', undoMs: 0 });
  await outbox.flush();
  assert.equal(await rowsOf(reqs.map((r) => r.opId)), 0, 'без сети на сервере ничего нет');
  assert.equal(outbox.pendingCount(), 5);

  // Сеть вернулась, но первый ответ теряется после приёма сервером
  net.online = true;
  net.dropResponses = 1;
  const lost = await outbox.flush({ ignoreBackoff: true });
  assert.equal(lost.offline, true, 'потеря ответа неотличима от обрыва сети');
  assert.equal(outbox.pendingCount(), 5, 'запись с потерянным ответом осталась, остальные ждут');
  await outbox.flush({ ignoreBackoff: true });
  assert.equal(outbox.pendingCount(), 0);
  assert.equal(await rowsOf(reqs.map((r) => r.opId)), 5, 'ровно 5 строк');

  // Повторный проход и повторная отправка тех же итогов ничего не добавляют
  for (const r of reqs) await outbox.enqueue({ request: r, title: r.cardId, kind: 'no_answer', undoMs: 0 });
  await outbox.flush({ force: true });
  assert.equal(await rowsOf(reqs.map((r) => r.opId)), 5);
  assert.equal((await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'call' AND ref_id = ANY(${reqs.map((r) => r.opId)})`)[0]!.n, 5, 'лента без дублей');
});

test('отмена за окно: итог не доходит до сервера', async () => {
  const [cardId] = await newCards(20, 1);
  const store = createMemoryStore();
  const outbox = new Outbox({ store, userId: U.opA, send: sender(opA) });
  const req = outcomeReq({ cardId: cardId! });
  await outbox.enqueue({ request: req, title: 't', kind: 'no_answer', undoMs: 5000 });
  await outbox.flush();
  assert.equal(await rowsOf([req.opId]), 0, 'окно не прошло');
  assert.equal(await outbox.cancel(req.opId), true);
  await outbox.flush({ force: true });
  assert.equal(await rowsOf([req.opId]), 0);
});

test('чужая карточка: сервер отвечает 404, итог уходит в «не принят» и не повторяется', async () => {
  const req = outcomeReq({ cardId: 'cd-b-1' });
  const outbox = new Outbox({ store: createMemoryStore(), userId: U.opA, send: sender(opA) });
  await outbox.enqueue({ request: req, title: 'Чужая', kind: 'no_answer', undoMs: 0 });
  const rep = await outbox.flush();
  assert.deepEqual(rep.rejected, [{ opId: req.opId, code: 'not_found' }]);
  assert.equal(outbox.pendingCount(), 0);
  assert.equal(await rowsOf([req.opId]), 0);
});

test('отказ проверки шторки (нет срока у «Перезвонить») приходит кодом и не теряет остальные итоги', async () => {
  const [a, b] = await newCards(30, 2);
  const bad = outcomeReq({ cardId: a!, outcomeKey: 'callback', callbackAt: null });
  const good = outcomeReq({ cardId: b! });
  const outbox = new Outbox({ store: createMemoryStore(), userId: U.opA, send: sender(opA) });
  await outbox.enqueue({ request: bad, title: 'x', kind: 'callback', undoMs: 0 });
  await outbox.enqueue({ request: good, title: 'y', kind: 'no_answer', undoMs: 0 });
  const rep = await outbox.flush();
  assert.deepEqual(rep.rejected, [{ opId: bad.opId, code: 'callback_at_required' }]);
  assert.deepEqual(rep.sent, [good.opId]);
  assert.equal(await rowsOf([bad.opId, good.opId]), 1);
});
