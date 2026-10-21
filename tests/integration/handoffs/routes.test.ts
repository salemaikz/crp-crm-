// Маршруты входящих передач (B6b, §6): коды ответов через обёртку route(): 200, 400 с кодом, 409 с кодом,
// 404 чужому и РОП, 423 директору, флаг PURCHASES выключен — 404.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as listRoute from '../../../src/app/api/handoffs/route';
import * as oneRoute from '../../../src/app/api/handoffs/[id]/route';
import * as acceptRoute from '../../../src/app/api/handoffs/[id]/accept/route';
import * as declineRoute from '../../../src/app/api/handoffs/[id]/decline/route';
import * as assignRoute from '../../../src/app/api/handoffs/[id]/assign/route';
import * as membersRoute from '../../../src/app/api/handoffs/[id]/members/route';
import { OTHER_HEAD, U, actAs, buy, closeHandoffsWorld, openHandoffsWorld, uuid } from './helpers';

const ORIGIN = 'http://crm.test';
type Handler = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;

let db: TestDb;
before(async () => {
  db = await openHandoffsWorld();
});
after(() => closeHandoffsWorld(db));

async function call(handler: Handler, method: string, o: { as: string | null; body?: unknown; id?: string; url?: string }) {
  actAs(o.as);
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = ORIGIN;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(o.url ?? `${ORIGIN}/x`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), {
    params: Promise.resolve(o.id ? { id: o.id } : {}),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* тело не JSON */
  }
  return { status: res.status, json };
}

test('глава: список по группам, принять 200, повтор 200, второй раз с другим ключом — 409 already_handled', async () => {
  const { handoffId } = await buy(30);
  const list = await call(listRoute.GET as Handler, 'GET', { as: U.mktHead, url: `${ORIGIN}/api/handoffs?group=waiting` });
  assert.equal(list.status, 200);
  assert.ok((list.json.items as { id: string }[]).some((x) => x.id === handoffId));
  const opId = uuid();
  const a = await call(acceptRoute.POST as Handler, 'POST', { as: U.mktHead, id: handoffId, body: { opId } });
  assert.deepEqual([a.status, a.json.status], [200, 'accepted']);
  assert.equal((await call(acceptRoute.POST as Handler, 'POST', { as: U.mktHead, id: handoffId, body: { opId } })).status, 200);
  const dup = await call(acceptRoute.POST as Handler, 'POST', { as: U.mktHead, id: handoffId, body: { opId: uuid() } });
  assert.deepEqual([dup.status, dup.json.detail], [409, 'already_handled']);
});

test('отклонить без причины — 400; назначить не сотрудника — 400; список сотрудников', async () => {
  const { handoffId } = await buy(31);
  const d = await call(declineRoute.POST as Handler, 'POST', { as: U.mktHead, id: handoffId, body: { opId: uuid(), reason: ' ' } });
  assert.equal(d.status, 400);
  const bad = await call(assignRoute.POST as Handler, 'POST', { as: U.mktHead, id: handoffId, body: { opId: uuid(), userId: U.opA } });
  assert.equal(bad.status, 400);
  const m = await call(membersRoute.GET as Handler, 'GET', { as: U.mktHead, id: handoffId });
  assert.deepEqual([m.status, (m.json.items as unknown[]).length], [200, 2]);
  const ok = await call(assignRoute.POST as Handler, 'POST', { as: U.mktHead, id: handoffId, body: { opId: uuid(), userId: U.marketer } });
  assert.deepEqual([ok.status, ok.json.assigneeUserId], [200, U.marketer]);
});

test('чужой отдел, РОП, маркетолог — 404 с одним телом; директор — 423; без входа — отказ', async () => {
  const { handoffId } = await buy(32);
  const missing = await call(acceptRoute.POST as Handler, 'POST', { as: U.mktHead, id: 'нет-такой', body: { opId: uuid() } });
  for (const who of [OTHER_HEAD, U.rop, U.marketer]) {
    const r = await call(acceptRoute.POST as Handler, 'POST', { as: who, id: handoffId, body: { opId: uuid() } });
    assert.deepEqual([r.status, r.json], [missing.status, missing.json], who);
  }
  assert.equal(missing.status, 404);
  assert.equal((await call(acceptRoute.POST as Handler, 'POST', { as: U.director, id: handoffId, body: { opId: uuid() } })).status, 423);
  const anon = await call(oneRoute.GET as Handler, 'GET', { as: null, id: handoffId });
  assert.ok([401, 403].includes(anon.status));
  assert.equal((await call(oneRoute.GET as Handler, 'GET', { as: U.rop, id: handoffId })).status, 200);
});

test('флаг PURCHASES выключен — маршруты отвечают 404', async () => {
  const { handoffId } = await buy(33);
  delete process.env['FEATURE_PURCHASES'];
  try {
    assert.equal((await call(listRoute.GET as Handler, 'GET', { as: U.mktHead })).status, 404);
    assert.equal((await call(acceptRoute.POST as Handler, 'POST', { as: U.mktHead, id: handoffId, body: { opId: uuid() } })).status, 404);
  } finally {
    process.env['FEATURE_PURCHASES'] = '1';
  }
});
