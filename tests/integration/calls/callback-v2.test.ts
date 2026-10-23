// Воронка v2, линия C2: итог «Перезвонить» пишет причину, касания и точность; флаги решают, что принимается (§8.3).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { JsonObject } from '@crm/core/config';
import type { Viewer } from '../../../src/server/access/types';
import { CallsDomainError } from '../../../src/server/domain/calls/errors';
import { submitOutcome } from '../../../src/server/domain/calls/outcomes';
import type { CallsDeps } from '../../../src/server/domain/calls';
import { resetConfigCache } from '../../../src/server/platform/config/active';
import { writeConfig } from '../../../src/server/platform/config/write';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { U } from '../../isolation/harness/seed';
import { snapshotTables } from '../../isolation/runner/snapshot';
import { DAY, HOUR, SEED_NOW, callsConfig, callsDeps, closeCallsWorld, openCallsWorld, outcomeReq, setCard, viewerOf } from './world';

let db: TestDb;
let deps: CallsDeps;
let opA: Viewer;
let rop: Viewer;
const clock = { now: SEED_NOW };
const t = (ru: string): JsonObject => ({ ru });
/** Начало местных суток 28.10.2026 (Алматы, UTC+5) и срок «в течение дня» на начало окна звонков. */
const DAY_START = Date.UTC(2026, 9, 27, 19, 0);
const reasonOf = (key: string, extra: Record<string, unknown> = {}) => ({ key, label: t(key), needsText: false, softness: 'soft', ...extra });

const fails = (code: string) => (e: unknown) => e instanceof CallsDomainError && e.code === code;
/** Без NODE_ENV флаги выключены (fail closed): сценарии включают нужные явно. */
const setFlag = (v: '0' | '1' | undefined, board: '0' | '1' | undefined = v) => {
  for (const [k, x] of [['FEATURE_CALLBACK_V2', v], ['FEATURE_OP_BOARD', board]] as const) {
    if (x === undefined) delete process.env[k];
    else process.env[k] = x;
  }
};

before(async () => {
  db = await openCallsWorld();
  const c = callsConfig();
  const sp = c.spaces.sales as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any -- документ правится по путям
  sp.reasons = {
    ...sp.reasons,
    callback: [reasonOf('think'), reasonOf('ret', { system: 'client_return', manual: false }), reasonOf('other', { needsText: true })],
  };
  sp.calling.callbackReason = { required: true };
  sp.calling.callbackSchedule = { steps: ['+3d', '+7d'] };
  resetConfigCache();
  await writeConfig({ docs: c, source: 'cli', authorId: null, project: true, note: 'C2: причины перезвона' });
  deps = callsDeps(clock);
  opA = await viewerOf(U.opA);
  rop = await viewerOf(U.rop);
});
after(async () => {
  setFlag(undefined);
  await closeCallsWorld(db);
});

const cardCols = async (id: string) =>
  (await db.sql<{ callbackReason: string; callbackTouches: number; nextCallPrecision: string; nextCallAt: number | null }>`
    SELECT callback_reason, callback_touches, next_call_precision, next_call_at FROM cards WHERE id = ${id}`)[0]!;
const callCols = async (id: string) =>
  (await db.sql<{ callbackPrecision: string; reasonCode: string; via: string }>`SELECT callback_precision, reason_code, via FROM calls WHERE id = ${id}`)[0]!;

test('перезвон с причиной: колонки карточки и звонка записаны, касание растёт', async () => {
  setFlag('1');
  await setCard(db.sql, 'cd-a-31', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const first = outcomeReq({ cardId: 'cd-a-31', outcomeKey: 'callback', reasonCode: 'think', callbackAt: SEED_NOW + DAY, callbackPrecision: 'time' });
  await submitOutcome(deps, opA, first);
  assert.deepEqual(await cardCols('cd-a-31'), { callbackReason: 'think', callbackTouches: 1, nextCallPrecision: 'time', nextCallAt: SEED_NOW + DAY });
  assert.deepEqual(await callCols(first.opId), { callbackPrecision: 'time', reasonCode: 'think', via: 'ui' });

  const second = outcomeReq({ cardId: 'cd-a-31', outcomeKey: 'callback', occurredAt: SEED_NOW - 30_000, reasonCode: 'think', callbackAt: SEED_NOW + 2 * DAY, callbackPrecision: 'time' });
  await submitOutcome(deps, opA, second);
  assert.equal((await cardCols('cd-a-31')).callbackTouches, 2);
});

test('срок «день»: карточка, звонок и задача-проекция хранят точность day', async () => {
  setFlag('1');
  await setCard(db.sql, 'cd-a-32', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-32', outcomeKey: 'callback', reasonCode: 'think', callbackAt: DAY_START + DAY + 9 * HOUR, callbackPrecision: 'day' });
  await submitOutcome(deps, opA, req);
  assert.equal((await cardCols('cd-a-32')).nextCallPrecision, 'day');
  assert.equal((await callCols(req.opId)).callbackPrecision, 'day');
  const [task] = await db.sql<{ duePrecision: string }>`SELECT due_precision FROM tasks WHERE source_key = ${`callback:${req.opId}`}`;
  assert.equal(task?.duePrecision, 'day');
});

test('без callbackPrecision при включённом флаге: принят по старому контракту, причина пустая', async () => {
  setFlag('1');
  await setCard(db.sql, 'cd-a-33', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-33', outcomeKey: 'callback', reasonCode: '', callbackAt: SEED_NOW + DAY });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'applied');
  assert.equal((await cardCols('cd-a-33')).callbackReason, '');
  assert.equal((await callCols(req.opId)).callbackPrecision, 'time');
});

test('флаг CALLBACK_V2 выключен: точность day — 400 precision_unsupported, ничего не записано', async () => {
  setFlag('0');
  await setCard(db.sql, 'cd-a-34', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-34', outcomeKey: 'callback', reasonCode: 'think', callbackAt: DAY_START + DAY + 9 * HOUR, callbackPrecision: 'day' });
  await assert.rejects(submitOutcome(deps, opA, req), fails('precision_unsupported'));
  assert.equal((await db.sql`SELECT 1 FROM calls WHERE id = ${req.opId}`).length, 0);
  assert.equal((await cardCols('cd-a-34')).nextCallPrecision, 'time');
});

test('флаг выключен: точность time принимается как прежний итог, причина не требуется и не пишется', async () => {
  setFlag('0');
  await setCard(db.sql, 'cd-a-35', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-35', outcomeKey: 'callback', reasonCode: '', callbackAt: SEED_NOW + DAY, callbackPrecision: 'time' });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'applied');
  assert.deepEqual(await cardCols('cd-a-35'), { callbackReason: '', callbackTouches: 1, nextCallPrecision: 'time', nextCallAt: SEED_NOW + DAY });
});

test('обязательная причина: пустая — reason_required; системная (manual: false) и неизвестная — reason_unknown', async () => {
  setFlag('1');
  await setCard(db.sql, 'cd-a-36', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const base = { cardId: 'cd-a-36', outcomeKey: 'callback', callbackAt: SEED_NOW + DAY, callbackPrecision: 'time' as const };
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ ...base, reasonCode: '' })), fails('reason_required'));
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ ...base, reasonCode: 'ret' })), fails('reason_unknown'));
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ ...base, reasonCode: 'nope' })), fails('reason_unknown'));
});

test('канал board: оператор (охват own) принят и записан как board; РОП — 400 via_unsupported', async () => {
  setFlag('1');
  await setCard(db.sql, 'cd-a-37', { state: 'new', attempts: 0, nextCallAt: null, lastOutcomeAt: null });
  const req = outcomeReq({ cardId: 'cd-a-37', outcomeKey: 'callback', via: 'board', reasonCode: 'think', callbackAt: SEED_NOW + DAY, callbackPrecision: 'time' });
  const r = await submitOutcome(deps, opA, req);
  assert.equal(r.status, 'applied');
  assert.equal((await callCols(req.opId)).via, 'board');
  await assert.rejects(submitOutcome(deps, rop, outcomeReq({ cardId: 'cd-a-38', outcomeKey: 'no_answer', via: 'board' })), fails('via_unsupported'));
});

test('канал board при выключенной доске: 400 via_unsupported даже у оператора', async () => {
  setFlag('1', '0');
  await assert.rejects(submitOutcome(deps, opA, outcomeReq({ cardId: 'cd-a-39', outcomeKey: 'no_answer', via: 'board' })), fails('via_unsupported'));
});

test('изоляция: итог по чужой карточке — 404 (not_found), таблицы не изменились', async () => {
  setFlag('1');
  const tables = ['cards', 'calls', 'tasks', 'client_events', 'assign_log', 'audit_log'];
  const before = await snapshotTables(db.sql, tables);
  const req = outcomeReq({ cardId: 'cd-b-31', outcomeKey: 'callback', via: 'board', reasonCode: 'think', callbackAt: SEED_NOW + DAY, callbackPrecision: 'day' });
  await assert.rejects(submitOutcome(deps, opA, req), fails('not_found'));
  assert.deepEqual(await snapshotTables(db.sql, tables), before);
});
