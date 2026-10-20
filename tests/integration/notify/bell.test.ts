// Колокол: адресат видит и отмечает только своё; счётчик для бейджа; страницы; маршруты через обёртку route().
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { listMine, markMineRead, unreadCount } from '../../../src/server/domain/notify/bell';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as listRoute from '../../../src/app/api/notify/route';
import * as readRoute from '../../../src/app/api/notify/read/route';
import { SEED_NOW, U, closeWorld, openWorld } from './helpers';
import { actAs, viewerOf } from '../../isolation/harness/actors';

const ORIGIN = 'http://crm.test';
let db: TestDb;

async function add(id: string, userId: string, at: number): Promise<void> {
  await db.sql`INSERT INTO notifications (id, user_id, kind, params, not_before, created_at)
               VALUES (${id}, ${userId}, 'digest_operator', '{"callbacks":1,"bookings":0}'::jsonb, ${at}::bigint, ${at}::bigint)`;
}
const unreadOf = async (u: string) => (await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM notifications WHERE user_id = ${u} AND read_at IS NULL`)[0]?.n;

async function call(handler: (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>, method: string, path: string, o: { as: string | null; body?: unknown }) {
  actAs(o.as);
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = ORIGIN;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), { params: Promise.resolve({}) });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Record<string, any>) : {} }; // eslint-disable-line @typescript-eslint/no-explicit-any -- тела разных ответов
}

before(async () => {
  db = await openWorld();
  for (let i = 1; i <= 5; i++) await add(`n-a-${i}`, U.opA, SEED_NOW - (6 - i) * 1000);
  for (let i = 1; i <= 2; i++) await add(`n-b-${i}`, U.opB, SEED_NOW - i * 1000);
});
after(async () => closeWorld(db));

test('список и счётчик — только свои; новые сверху; курсор листает без повторов', async () => {
  const a = await viewerOf(U.opA);
  assert.equal(await unreadCount(a), 5);
  const p1 = await listMine(a, { limit: 3 });
  assert.deepEqual(p1.items.map((i) => i.id), ['n-a-5', 'n-a-4', 'n-a-3']);
  assert.equal(p1.unread, 5);
  assert.ok(p1.next);
  const p2 = await listMine(a, { limit: 3, cursor: p1.next });
  assert.deepEqual(p2.items.map((i) => i.id), ['n-a-2', 'n-a-1']);
  assert.equal(p2.next, null);
  assert.equal(await unreadCount(await viewerOf(U.rop)), 0);
});

test('чужие id в «прочитано» молча пропускаются, чужое остаётся непрочитанным', async () => {
  const a = await viewerOf(U.opA);
  const r = await markMineRead(a, ['n-a-1', 'n-b-1', 'нет-такого']);
  assert.deepEqual(r, { marked: 1, unread: 4 });
  assert.equal(await unreadOf(U.opB), 2);
});

test('«прочитать все» отмечает только свои', async () => {
  const a = await viewerOf(U.opA);
  assert.deepEqual(await markMineRead(a, null), { marked: 4, unread: 0 });
  assert.equal(await unreadOf(U.opB), 2);
  assert.deepEqual(await markMineRead(a, null), { marked: 0, unread: 0 }, 'повтор безвреден');
});

test('маршруты: гость 401; GET отдаёт свои; POST read — проверка тела и действие', async () => {
  assert.equal((await call(listRoute.GET, 'GET', '/api/notify', { as: null })).status, 401);
  assert.equal((await call(readRoute.POST, 'POST', '/api/notify/read', { as: null, body: { all: true } })).status, 401);

  const g = await call(listRoute.GET, 'GET', '/api/notify?limit=1', { as: U.opB });
  assert.equal(g.status, 200);
  assert.deepEqual(g.json.items.map((i: { id: string }) => i.id), ['n-b-1']);
  assert.equal(g.json.unread, 2);
  assert.equal(JSON.stringify(g.json).includes('n-a-'), false);

  assert.equal((await call(listRoute.GET, 'GET', '/api/notify?limit=0', { as: U.opB })).status, 400);
  assert.equal((await call(readRoute.POST, 'POST', '/api/notify/read', { as: U.opB, body: { ids: [] } })).status, 400);
  assert.equal((await call(readRoute.POST, 'POST', '/api/notify/read', { as: U.opB, body: { all: true, ids: ['x'] } })).status, 400);

  const done = await call(readRoute.POST, 'POST', '/api/notify/read', { as: U.opB, body: { ids: ['n-b-2', 'n-a-1'] } });
  assert.equal(done.status, 200);
  assert.deepEqual(done.json, { marked: 1, unread: 1 });
});
