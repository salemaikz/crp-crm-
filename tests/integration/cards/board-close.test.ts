// № 32 «Не отвечает» (ручное списание) и очередь по горячести (C5, pipeline-v2 §3.3, §6.3), а также маршруты доски на
// уровне обёрток: чужая карточка — 404 без изменений, директор — 423, консультант и отдел передачи — 404, флаг — 404/400.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import { actAs } from '../../isolation/harness/actors';
import type { Viewer } from '../../../src/server/access/types';
import { getQueue } from '../../../src/server/domain/calls/queue';
import type { CallsDeps } from '../../../src/server/domain/calls';
import { BadRequestError } from '../../../src/server/access';
import { CardActionError } from '../../../src/server/domain/cards/errors';
import { closeCard } from '../../../src/server/domain/cards/menu';
import { loadCallingContext } from '../../../src/server/domain/cards/settings';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { GET as boardGet } from '../../../src/app/api/cards/board/route';
import { GET as columnGet } from '../../../src/app/api/cards/board/column/route';
import { POST as closePost } from '../../../src/app/api/cards/[id]/close/route';
import { U, cardOf } from '../../isolation/harness/seed';
import { HOUR, SEED_NOW, clearOwner, closeBoardWorld, openBoardWorld } from './boardWorld';
import { viewerOf } from '../../isolation/harness/actors';

let db: TestDb;
let opA: Viewer;
let opB: Viewer;
let rop: Viewer;

before(async () => {
  db = await openBoardWorld();
  opA = await viewerOf(U.opA);
  opB = await viewerOf(U.opB);
  rop = await viewerOf(U.rop);
});
after(() => closeBoardWorld(db));

const opId = () => crypto.randomUUID();
const body = (version: number, over: Record<string, unknown> = {}) => ({ opId: opId(), version, kind: 'written_off' as const, reasonCode: 'unreachable', alsoDncPhoneIds: [], ...over });
const cardRow = async (id: string) =>
  (await db.sql<{ state: string; version: number; attempts: number; closedAt: number | null; closeReasonCode: string }>`SELECT state, version, attempts, closed_at, close_reason_code FROM cards WHERE id = ${id}`)[0]!;

test('№ 32: оператору при attempts = 0 — 409 write_off_needs_no_answer, карточка не тронута', async () => {
  const id = cardOf('a', 31);
  await db.sql`UPDATE cards SET state = 'retry', attempts = 0 WHERE id = ${id}`;
  const before1 = await cardRow(id);
  await assert.rejects(closeCard(opA, id, body(before1.version)), (e: unknown) => {
    assert.ok(e instanceof CardActionError);
    assert.deepEqual([e.status, e.body.error], [409, 'write_off_needs_no_answer']);
    return true;
  });
  assert.deepEqual(await cardRow(id), before1);
});

test('№ 32: при attempts = 1 карточка «Списан», открытая сделка проиграна, срок снят; второе списание отклонено', async () => {
  const id = cardOf('a', 1);
  await db.sql`UPDATE cards SET state = 'retry', attempts = 1, next_call_at = ${SEED_NOW + HOUR} WHERE id = ${id}`;
  const v = (await cardRow(id)).version;
  const req = body(v);
  const res = await closeCard(opA, id, req);
  assert.equal(res.state, 'written_off');
  const after1 = await cardRow(id);
  assert.equal(after1.state, 'written_off');
  assert.equal(after1.closeReasonCode, 'unreachable');
  assert.ok(after1.closedAt !== null);
  const deal = (await db.sql<{ status: string; lostReasonCode: string }>`SELECT status, lost_reason_code FROM deals WHERE id = 'dl-a-1'`)[0]!;
  assert.equal(deal.status, 'lost');
  assert.notEqual(deal.lostReasonCode, '', 'у проигрыша есть системная причина');
  const next = (await db.sql<{ n: number | null }>`SELECT next_call_at AS n FROM cards WHERE id = ${id}`)[0]!;
  assert.equal(next.n, null);
  // карточка с «Списан» уже не принимает второе списание
  await assert.rejects(closeCard(opA, id, body(after1.version)), CardActionError);
});

test('№ 32: РОП списывает и без недозвона; причина не из группы — 400; чужой оператор — 404', async () => {
  const id = cardOf('a', 32);
  await db.sql`UPDATE cards SET state = 'new', attempts = 0 WHERE id = ${id}`;
  const v = (await cardRow(id)).version;
  await assert.rejects(closeCard(opB, id, body(v)), NotFoundError, 'чужая карточка = несуществующая');
  await assert.rejects(closeCard(rop, id, body(v, { reasonCode: 'auto_limit' })), (e: unknown) => e instanceof CardActionError && e.code === 'reason_unknown');
  assert.equal((await closeCard(rop, id, body(v))).state, 'written_off');
});

test('№ 32 при выключенном OP_BOARD: вида нет — 400, как у прежней схемы тела', async () => {
  const id = cardOf('a', 33);
  await db.sql`UPDATE cards SET state = 'retry', attempts = 2 WHERE id = ${id}`;
  const v = (await cardRow(id)).version;
  process.env['FEATURE_OP_BOARD'] = '0';
  try {
    await assert.rejects(closeCard(opA, id, body(v)), BadRequestError);
  } finally {
    process.env['FEATURE_OP_BOARD'] = '1';
  }
  assert.equal((await cardRow(id)).state, 'retry');
});

const ORIGIN = 'http://crm.test';
async function post(userId: string, id: string, payload: unknown): Promise<Response> {
  actAs(userId);
  const req = new Request(`${ORIGIN}/api/cards/${id}/close`, { method: 'POST', headers: { host: 'crm.test', origin: ORIGIN, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  return closePost(req, { params: Promise.resolve({ id }) });
}
async function get(userId: string, handler: typeof boardGet, path: string): Promise<Response> {
  actAs(userId);
  return handler(new Request(`${ORIGIN}${path}`, { headers: { host: 'crm.test' } }), { params: Promise.resolve({}) });
}

test('маршрут close: чужая карточка и несуществующая — 404 с тем же телом, снимок таблиц не изменился; директор — 423', async () => {
  const foreign = cardOf('b', 40);
  await db.sql`UPDATE cards SET state = 'retry', attempts = 2 WHERE id = ${foreign}`;
  const snap = async () => JSON.stringify(await db.sql`SELECT * FROM cards ORDER BY id`) + JSON.stringify(await db.sql`SELECT * FROM deals ORDER BY id`);
  const before1 = await snap();
  const a = await post(U.opA, foreign, body(0));
  const missing = await post(U.opA, 'zz-no-such-card', body(0));
  assert.equal(a.status, 404);
  assert.equal(missing.status, 404);
  assert.equal(await a.text(), await missing.text());
  assert.equal(await snap(), before1);
  const d = await post(U.director, foreign, body(0));
  assert.equal(d.status, 423);
  assert.equal(await snap(), before1);
  // свой оператор B доходит до ядра: версия верна — списание проходит
  const v = (await cardRow(foreign)).version;
  const own = await post(U.opB, foreign, body(v));
  assert.equal(own.status, 200);
});

test('маршруты доски: оператор 200; консультант и отдел передачи — 404; фильтр owner у оператора — 400; без сессии — 401', async () => {
  const board = await get(U.opA, boardGet, '/api/cards/board');
  assert.equal(board.status, 200);
  const json = (await board.json()) as { columns: Array<{ key: string }> };
  assert.ok(json.columns.length >= 5);
  assert.equal((await get(U.opA, columnGet, '/api/cards/board/column?column=callback')).status, 200);
  assert.equal((await get(U.opA, boardGet, `/api/cards/board?owner=${U.opB}`)).status, 400);
  assert.equal((await get(U.opA, columnGet, `/api/cards/board/column?column=callback&owner=${U.opB}`)).status, 400);
  assert.equal((await get(U.opA, columnGet, '/api/cards/board/column?column=callback&cursor=xx')).status, 400);
  for (const u of [U.consultant, U.marketer, U.mktHead]) {
    assert.equal((await get(u, boardGet, '/api/cards/board')).status, 404, u);
    assert.equal((await get(u, columnGet, '/api/cards/board/column?column=callback')).status, 404, u);
  }
  assert.equal((await get(U.director, boardGet, '/api/cards/board')).status, 200);
  actAs(null);
  const guest = await boardGet(new Request(`${ORIGIN}/api/cards/board`, { headers: { host: 'crm.test' } }), { params: Promise.resolve({}) });
  assert.equal(guest.status, 401);
  process.env['FEATURE_OP_BOARD'] = '0';
  try {
    assert.equal((await get(U.opA, boardGet, '/api/cards/board')).status, 404);
    assert.equal((await get(U.opA, columnGet, '/api/cards/board/column?column=callback')).status, 404);
  } finally {
    process.env['FEATURE_OP_BOARD'] = '1';
  }
});

test('очередь «Звонить подряд»: queue.sort = heat даёт порядок колонки «Перезвон»; без OP_BOARD — прежние группы', async () => {
  await clearOwner(db.sql, U.opA);
  const set = async (id: string, state: string, heat: number, nextCallAt: number | null) =>
    db.sql`UPDATE cards SET state = ${state}, heat = ${heat}, next_call_at = ${nextCallAt}, attempts = 1, closed_at = NULL WHERE id = ${id}`;
  await set(cardOf('a', 51), 'callback', 100, SEED_NOW - 2 * HOUR);
  await set(cardOf('a', 52), 'retry', 0, SEED_NOW - 3 * HOUR);
  await set(cardOf('a', 53), 'callback', 300, SEED_NOW - HOUR);
  await set(cardOf('a', 54), 'new', 20, null);
  await set(cardOf('a', 55), 'callback', 100, SEED_NOW - HOUR);
  const deps = { context: loadCallingContext, now: () => SEED_NOW } as unknown as CallsDeps;
  const ids = async () => (await getQueue(deps, opA, { limit: 10, exclude: [], group: 'all' })).items.map((i) => i.cardId);
  const [a51, a52, a53, a54, a55] = [51, 52, 53, 54, 55].map((i) => cardOf('a', i));
  assert.deepEqual(await ids(), [a53, a51, a55, a52, a54], 'огонёк → heat ↓ → срок ↑; новая (не огонёк) — после рабочих');
  process.env['FEATURE_OP_BOARD'] = '0';
  try {
    assert.deepEqual(await ids(), [a51, a53, a55, a52, a54], 'группы: перезвоны по сроку, затем повторы, затем новые');
  } finally {
    process.env['FEATURE_OP_BOARD'] = '1';
  }
});
