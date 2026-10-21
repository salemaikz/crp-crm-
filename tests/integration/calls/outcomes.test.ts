// Итог звонка (C5, docs/calls-design.md §4, §12): идемпотентность, повтор, факт без смены состояния, цепочка «Не берёт».
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Viewer } from '../../../src/server/access/types';
import { CallsDomainError } from '../../../src/server/domain/calls/errors';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { DAY, HOUR, MIN, SEED_NOW, callsDeps, cardOf, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
let opB: Viewer;
const clock = { now: SEED_NOW };

const fails = (code: string) => (e: unknown) => e instanceof CallsDomainError && e.code === code;
const cnt = async (q: Promise<Array<{ n: number }>>): Promise<number> => (await q)[0]!.n;
const callsWhere = (id: string) => cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE id = ${id}`);
const callsAll = () => cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls`);
const feedOf = (opId: string) => cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM client_events WHERE kind = 'call' AND ref_id = ${opId}`);

before(async () => {
  db = await openCallsWorld();
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
});
after(() => closeCallsWorld(db));

test('«Не берёт»: первое событие → retry через 2 часа, звонок и лента записаны', async () => {
  await setCard(db.sql, 'cd-a-1', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-1' });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'applied');
  assert.equal(r.card?.state, 'retry');
  assert.equal(r.card?.nextCallAt, SEED_NOW - MIN + 2 * HOUR, 'шаг считается от времени звонка');
  const card = await cardOf(db.sql, 'cd-a-1');
  assert.equal(card.attempts, 1);
  assert.equal(card.lastOutcomeCode, 'no_answer');
  assert.equal(await callsWhere(req.opId), 1);
  assert.equal(await feedOf(req.opId), 1);
});

test('повтор того же opId подряд и параллельно: одна строка calls, ответ duplicate, состояние не двигается', async () => {
  await setCard(db.sql, 'cd-a-2', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-2' });
  const first = await submitOutcome(deps, opA, req);
  const again = await submitOutcome(deps, opA, req);
  assert.equal(again.status, 'duplicate');
  assert.equal(again.applied, first.applied);
  assert.equal(again.card?.version, first.card?.version);

  await setCard(db.sql, 'cd-a-3', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const par = outcomeReq({ cardId: 'cd-a-3' });
  const rs = await Promise.all([submitOutcome(deps, opA, par), submitOutcome(deps, opA, par), submitOutcome(deps, opA, par)]);
  assert.deepEqual(rs.map((x) => x.status).sort(), ['applied', 'duplicate', 'duplicate']);
  assert.equal(await callsWhere(par.opId), 1);
  assert.equal(await feedOf(par.opId), 1);
  assert.equal((await cardOf(db.sql, 'cd-a-3')).attempts, 1);
});

test('opId чужого звонка — как несуществующий: ни данных, ни изменений', async () => {
  const req = outcomeReq({ cardId: 'cd-a-4' });
  await setCard(db.sql, 'cd-a-4', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  await submitOutcome(deps, opA, req);
  await assert.rejects(submitOutcome(deps, opB, { ...req, cardId: 'cd-b-4' }), fails('opid_reused'));
  await assert.rejects(submitOutcome(deps, opA, { ...req, cardId: 'cd-a-5' }), fails('opid_reused'));
});

test('чужая карточка и несуществующая — один и тот же not_found, таблицы не меняются', async () => {
  const before = await callsAll();
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-b-1' })), fails('not_found'));
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'нет-такой' })), fails('not_found'));
  assert.equal(await callsAll(), before);
});

test('«Не берёт» ×3: retry по шагам из настроек и written_off no_answer_limit; повтор в праздник → пятница 10:00', async () => {
  await setCard(db.sql, 'cd-a-6', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const a1 = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-6', occurredAt: SEED_NOW - 10 * MIN }));
  assert.equal(a1.card?.nextCallAt, SEED_NOW - 10 * MIN + 2 * HOUR);
  clock.now = SEED_NOW + 3 * HOUR;
  const a2 = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-6', occurredAt: clock.now - MIN }));
  // следующий рабочий день: четверг 29.10 — праздник, значит пятница 30.10 10:00 (UTC+5)
  assert.equal(a2.card?.nextCallAt, Date.UTC(2026, 9, 30, 5, 0));
  clock.now = SEED_NOW + 2 * DAY;
  const a3 = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-6', occurredAt: clock.now - MIN }));
  assert.equal(a3.card?.state, 'written_off');
  assert.equal((await cardOf(db.sql, 'cd-a-6')).closeReasonCode, 'no_answer_limit');
  clock.now = SEED_NOW;
});

test('stale: итог раньше последнего применённого — факт, состояние прежнее', async () => {
  await setCard(db.sql, 'cd-a-7', { state: 'retry', attempts: 1, nextCallAt: SEED_NOW - HOUR, lastOutcomeAt: SEED_NOW - 30 * MIN, version: 3 });
  const r = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-7', occurredAt: SEED_NOW - 2 * HOUR }));
  assert.equal(r.status, 'fact_only');
  assert.equal(r.factReason, 'stale');
  const card = await cardOf(db.sql, 'cd-a-7');
  assert.equal(card.state, 'retry');
  assert.equal(card.attempts, 1);
  assert.equal(card.lastOutcomeAt, SEED_NOW - 30 * MIN);
  assert.equal(await cnt(db.sql<{ n: number }>`SELECT count(*)::int AS n FROM calls WHERE card_id = 'cd-a-7' AND applied = 'fact_only' AND fact_reason = 'stale'`), 1);
});

test('офлайн-итог 3 часа назад: retry считается от времени звонка; будущее время ограничено с предупреждением', async () => {
  await setCard(db.sql, 'cd-a-8', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const old = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-8', via: 'offline', occurredAt: SEED_NOW - 3 * HOUR }));
  assert.equal(old.card?.nextCallAt, SEED_NOW - HOUR, 'звонок в 08:00 → следующий в 10:00 (+2 ч от времени звонка)');
  await setCard(db.sql, 'cd-a-9', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const fut = await submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-9', occurredAt: SEED_NOW + 10 * MIN }));
  assert.deepEqual(fut.warnings, ['occurred_at_clamped']);
  const row = await db.sql<{ occurredAt: number }>`SELECT occurred_at FROM calls WHERE card_id = 'cd-a-9'`;
  assert.equal(row[0]?.occurredAt, SEED_NOW + 5 * MIN);
});

test('проверки шторки: причина, ЛПР-номер и «перезвонить в прошлое» → отказ без записи', async () => {
  await setCard(db.sql, 'cd-a-10', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const calls0 = await callsAll();
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-10', outcomeKey: 'not_interested' })), fails('reason_required'));
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-10', outcomeKey: 'callback', callbackAt: SEED_NOW - 10 * MIN })), fails('callback_in_past'));
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-10', outcomeKey: 'do_not_call' })), fails('phone_required'));
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-10', outcomeKey: 'bad_number', phoneId: 'ph-b-10' })), fails('phone_not_on_card'));
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-10', outcomeKey: 'нет_такого' })), fails('outcome_unknown'));
  assert.equal(await callsAll(), calls0);
  assert.equal((await cardOf(db.sql, 'cd-a-10')).state, 'new');
});

test('manual_entry (B8, D-266): РОП вносит итог за оператора; в ленте пометка «вручную», оператор не получает выдачу', async () => {
  const rop = await viewerOf(U.rop);
  await setCard(db.sql, 'cd-a-6', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-6', via: 'manual_entry' });
  const r = await submitOutcome(deps, rop, req);
  assert.equal(r.status, 'applied');
  assert.equal(r.card?.state, 'retry');
  const calls = await db.sql<{ via: string; userId: string }>`SELECT via, user_id FROM calls WHERE id = ${req.opId}`;
  assert.deepEqual([calls[0]?.via, calls[0]?.userId], ['manual_entry', U.rop]);
  const feed = await db.sql<{ data: { via?: string } }>`SELECT data FROM client_events WHERE kind = 'call' AND ref_id = ${req.opId}`;
  assert.equal(feed[0]?.data.via, 'manual_entry');
  // повтор того же opId не задваивает
  assert.equal((await submitOutcome(deps, rop, req)).status, 'duplicate');
});

test('manual_entry от оператора на чужую карточку — как несуществующая', async () => {
  await setCard(db.sql, 'cd-b-6', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-b-6', via: 'manual_entry' })), fails('not_found'));
});

test('seenVersion с устаревшей доски: 409 version_conflict, итог не записан; актуальная версия проходит', async () => {
  await setCard(db.sql, 'cd-a-30', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null, version: 4 });
  const stale = outcomeReq({ cardId: 'cd-a-30', via: 'manual_entry', seenVersion: 3 });
  await assert.rejects(() => submitOutcome(deps, opA, stale), fails('version_conflict'));
  assert.equal(await callsWhere(stale.opId), 0);
  assert.equal((await cardOf(db.sql, 'cd-a-30')).attempts, 0);
  const fresh = outcomeReq({ cardId: 'cd-a-30', via: 'manual_entry', seenVersion: 4 });
  assert.equal((await submitOutcome(deps, opA, fresh)).status, 'applied');
  const none = outcomeReq({ cardId: 'cd-a-30' });
  assert.notEqual((await submitOutcome(deps, opA, none)).status, undefined);
});
