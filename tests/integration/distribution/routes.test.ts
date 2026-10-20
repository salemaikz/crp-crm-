// Маршруты раздачи через обёртку route() (docs/distribution-design.md §6): права, коды ответов, страницы пула, журнал.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { overrideDistributionDepsForTests } from '../../../src/server/domain/distribution/deps';
import { runTick } from '../../../src/server/domain/distribution/tick';
import type { TestDb } from '../../../src/server/platform/db/testing';
import * as poolRoute from '../../../src/app/api/distribution/pool/route';
import * as participantsRoute from '../../../src/app/api/distribution/participants/route';
import * as participantRoute from '../../../src/app/api/distribution/participants/[userId]/route';
import * as issueRoute from '../../../src/app/api/distribution/issue/route';
import * as logRoute from '../../../src/app/api/distribution/log/route';
import {
  SEED_NOW,
  SEED_TODAY,
  U,
  actAs,
  closeWorld,
  makeDeps,
  openDistributionWorld,
  resetPool,
  seedIssued,
  seedPair,
  seedPool,
  system,
  testConfig,
  tickInput,
  uuid,
  type Clock,
} from './helpers';

const ORIGIN = 'http://crm.test';
type Handler = (req: Request, ctx: { params: Promise<unknown> }) => Promise<Response>;
interface Reply {
  status: number;
  json: Record<string, any> & any[]; // eslint-disable-line @typescript-eslint/no-explicit-any -- тела ответов разных маршрутов
}

let db: TestDb;
const clock: Clock = { now: SEED_NOW };

async function call(handler: Handler, method: string, path: string, o: { as: string | null; body?: unknown; params?: Record<string, string> }): Promise<Reply> {
  actAs(o.as);
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers.origin = ORIGIN;
  if (o.body !== undefined) headers['content-type'] = 'application/json';
  const res = await handler(new Request(`${ORIGIN}${path}`, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) }), {
    params: Promise.resolve(o.params ?? {}),
  });
  const text = await res.text();
  let json: Reply['json'];
  try {
    json = JSON.parse(text);
  } catch {
    json = {} as Reply['json'];
  }
  return { status: res.status, json };
}

before(async () => {
  db = await openDistributionWorld();
  await seedPool(db.sql, 120);
  overrideDistributionDepsForTests(makeDeps(clock, testConfig()));
});
after(async () => {
  overrideDistributionDepsForTests(null);
  await closeWorld(db);
});

test('оператор без прав раздела получает 403 на все маршруты, гость — 401', async () => {
  const cases: Array<[Handler, string, string, unknown?, Record<string, string>?]> = [
    [poolRoute.GET, 'GET', '/api/distribution/pool'],
    [participantsRoute.GET, 'GET', '/api/distribution/participants'],
    [participantRoute.PUT, 'PUT', '/api/distribution/participants/u-op-b', { inDistribution: false }, { userId: U.opB }],
    [issueRoute.POST, 'POST', '/api/distribution/issue', { opId: uuid(), toUserId: U.opB, count: 1 }],
    [logRoute.GET, 'GET', `/api/distribution/log?from=${SEED_TODAY}&to=${SEED_TODAY}`],
  ];
  for (const [h, m, p, body, params] of cases) {
    const op = await call(h, m, p, { as: U.opA, ...(body ? { body } : {}), ...(params ? { params } : {}) });
    assert.equal(op.status, 403, `${m} ${p}`);
    const guest = await call(h, m, p, { as: null, ...(body ? { body } : {}), ...(params ? { params } : {}) });
    assert.equal(guest.status, 401, `${m} ${p} гость`);
  }
  assert.equal(await db.sql<{ n: number }>`SELECT count(*)::int AS n FROM assign_log`.then((r) => r[0]?.n), 0);
});

test('директор (только чтение): мутации → 423, чтение раздела без права → 403', async () => {
  const issue = await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.director, body: { opId: uuid(), toUserId: U.opB, count: 1 } });
  assert.equal(issue.status, 423);
  const put = await call(participantRoute.PUT, 'PUT', '/api/distribution/participants/u-op-b', { as: U.director, body: { inDistribution: false }, params: { userId: U.opB } });
  assert.equal(put.status, 423);
  const pool = await call(poolRoute.GET, 'GET', '/api/distribution/pool', { as: U.director });
  assert.equal(pool.status, 403);
});

test('пул: сводка и постраничный обход без повторов', async () => {
  await db.sql`UPDATE cards SET hold_reason = 'dup_pair' WHERE id IN ('pc-118', 'pc-119')`;
  await db.sql`UPDATE cards SET hold_reason = 'rule' WHERE id = 'pc-120'`;
  await db.sql`UPDATE cards SET state = 'do_not_call' WHERE id = 'cd-a-1'`;
  await seedPair(db.sql, 'cl-a-1', 'pl-117');
  const first = await call(poolRoute.GET, 'GET', '/api/distribution/pool?limit=50', { as: U.rop });
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.summary.held, { 'hold:dup_pair': 2, 'hold:import_conflict': 0, 'hold:no_working_phone': 0, 'hold:rule': 1, pair_blocked: 1 });
  assert.equal(first.json.summary.ready, 116);
  assert.equal(first.json.summary.roomToday, 120);
  assert.equal(first.json.summary.overCap, 0);
  assert.equal(first.json.items.length, 50);
  assert.equal(first.json.items[0].name, 'ТОО Пул 1');
  const seen = new Set<string>(first.json.items.map((i: { cardId: string }) => i.cardId));
  let next: string | null = first.json.next;
  while (next) {
    const page = await call(poolRoute.GET, 'GET', `/api/distribution/pool?limit=50&cursor=${encodeURIComponent(next)}`, { as: U.rop });
    assert.equal(page.status, 200);
    for (const i of page.json.items as Array<{ cardId: string }>) {
      assert.ok(!seen.has(i.cardId), 'повтор на следующей странице');
      seen.add(i.cardId);
    }
    next = page.json.next;
  }
  assert.equal(seen.size, 116, 'задержанные и заблокированные парой в список не входят');
  assert.ok(!seen.has('pc-117') && !seen.has('pc-118'));
  const bad = await call(poolRoute.GET, 'GET', '/api/distribution/pool?cursor=%25%25', { as: U.rop });
  assert.equal(bad.status, 400);
  assert.equal((await call(poolRoute.GET, 'GET', '/api/distribution/pool?limit=101', { as: U.rop })).status, 400);
  await db.sql`UPDATE cards SET hold_reason = '' WHERE id LIKE 'pc-%'`;
  await db.sql`UPDATE cards SET state = 'retry' WHERE id = 'cd-a-1'`;
  await db.sql`DELETE FROM dup_pairs`;
});

test('сводка: «сверх лимита» = готовые − свободно по лимитам', async () => {
  await seedIssued(db.sql, U.opA, 'auto', 40, ['cd-a-1']);
  const r = await call(poolRoute.GET, 'GET', '/api/distribution/pool?limit=1', { as: U.rop });
  assert.equal(r.json.summary.roomToday, 80);
  assert.equal(r.json.summary.overCap, 40);
  await resetPool(db.sql);
});

test('участники: статус, нагрузка и остаток; переключатель меняет только in_distribution и пишет аудит', async () => {
  await seedIssued(db.sql, U.opA, 'manual', 12, ['cd-a-1']);
  await db.sql`UPDATE memberships SET paused_on = ${SEED_TODAY} WHERE user_id = ${U.opB}`;
  const list = await call(participantsRoute.GET, 'GET', '/api/distribution/participants', { as: U.rop });
  assert.equal(list.status, 200);
  const byId = Object.fromEntries((list.json as unknown as Array<{ userId: string }>).map((p) => [p.userId, p])) as Record<string, Record<string, unknown>>;
  assert.deepEqual(Object.keys(byId).sort(), [U.duty, U.opA, U.opB].sort());
  assert.deepEqual([byId[U.opA]?.status, byId[U.opA]?.capUsed, byId[U.opA]?.remaining, byId[U.opA]?.cap], ['working', 12, 28, 40]);
  assert.equal(byId[U.opB]?.status, 'paused');
  await db.sql`UPDATE memberships SET paused_on = '' WHERE user_id = ${U.opB}`;

  const put = await call(participantRoute.PUT, 'PUT', `/api/distribution/participants/${U.duty}`, { as: U.rop, body: { inDistribution: false }, params: { userId: U.duty } });
  assert.equal(put.status, 200);
  assert.equal(put.json.inDistribution, false);
  const audit = await db.sql<{ entityId: string; meta: { inDistribution: boolean } }>`SELECT entity_id, meta FROM audit_log WHERE action = 'distribution.participant'`;
  assert.deepEqual(audit.map((a) => [a.entityId, a.meta.inDistribution]), [[U.duty, false]]);
  await db.sql`UPDATE memberships SET in_distribution = TRUE WHERE user_id = ${U.duty}`;

  for (const userId of [U.director, U.marketer, 'zz-no-such-user']) {
    const r = await call(participantRoute.PUT, 'PUT', `/api/distribution/participants/${userId}`, { as: U.rop, body: { inDistribution: true }, params: { userId } });
    assert.equal(r.status, 404, userId);
  }
  const badBody = await call(participantRoute.PUT, 'PUT', `/api/distribution/participants/${U.opA}`, { as: U.rop, body: { inDistribution: 'yes', extra: 1 }, params: { userId: U.opA } });
  assert.equal(badBody.status, 400);
  await resetPool(db.sql);
});

test('выдача: 201, повтор opId — 200; плохое тело и not_participant — 400; over_cap — 409 с остатком; mode_off — 409', async () => {
  const opId = uuid();
  const first = await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.rop, body: { opId, toUserId: U.opA, cardIds: ['pc-1', 'pc-2'] } });
  assert.equal(first.status, 201);
  assert.deepEqual(first.json.issued.sort(), ['pc-1', 'pc-2']);
  const again = await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.rop, body: { opId, toUserId: U.opA, cardIds: ['pc-1', 'pc-2'] } });
  assert.equal(again.status, 200);
  assert.equal(again.json.replayed, true);

  for (const body of [{ opId, toUserId: U.opA }, { opId: 'x', toUserId: U.opA, count: 1 }, { opId: uuid(), toUserId: U.opA, count: 1, cardIds: ['a'] }, { opId: uuid(), toUserId: U.opA, count: 0 }, { opId: uuid(), toUserId: U.opA, cardIds: [] }]) {
    assert.equal((await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.rop, body })).status, 400, JSON.stringify(body));
  }
  const np = await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.rop, body: { opId: uuid(), toUserId: U.director, count: 1 } });
  assert.deepEqual([np.status, np.json.error], [400, 'not_participant']);

  await seedIssued(db.sql, U.opB, 'auto', 38, ['cd-b-1']);
  const over = await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.rop, body: { opId: uuid(), toUserId: U.opB, count: 5 } });
  assert.deepEqual([over.status, over.json], [409, { error: 'over_cap', remaining: 2, cap: 40 }]);

  overrideDistributionDepsForTests(makeDeps(clock, testConfig({ mode: 'off' })));
  const off = await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.rop, body: { opId: uuid(), toUserId: U.duty, count: 1 } });
  assert.deepEqual([off.status, off.json.error], [409, 'mode_off']);
  overrideDistributionDepsForTests(makeDeps(clock, testConfig()));
});

test('журнал: группировка по прогону и виду; период > 31 дня и перевёрнутый — 400; фильтр по сотруднику', async () => {
  await resetPool(db.sql);
  await runTick(system(), tickInput(clock), makeDeps(clock));
  await call(issueRoute.POST, 'POST', '/api/distribution/issue', { as: U.rop, body: { opId: uuid(), toUserId: U.opA, count: 0 + 1 } }); // лимит A исчерпан тиком → 409
  const log = await call(logRoute.GET, 'GET', `/api/distribution/log?from=${SEED_TODAY}&to=${SEED_TODAY}`, { as: U.rop });
  assert.equal(log.status, 200);
  const rows = log.json as unknown as Array<{ kind: string; count: number; toName: string; countsToCap: number; fromName: null; runId: string }>;
  assert.equal(rows.length, 3, 'один прогон × три получателя');
  assert.ok(rows.every((r) => r.kind === 'auto' && r.count === 40 && r.countsToCap === 40 && r.fromName === null && r.toName.length > 0));
  assert.equal(new Set(rows.map((r) => r.runId)).size, 1);
  const own = await call(logRoute.GET, 'GET', `/api/distribution/log?from=${SEED_TODAY}&to=${SEED_TODAY}&userId=${U.opA}`, { as: U.rop });
  assert.equal(own.json.length, 1);
  assert.equal((await call(logRoute.GET, 'GET', `/api/distribution/log?from=2026-09-01&to=${SEED_TODAY}`, { as: U.rop })).status, 400);
  assert.equal((await call(logRoute.GET, 'GET', `/api/distribution/log?from=${SEED_TODAY}&to=2026-10-01`, { as: U.rop })).status, 400);
  assert.equal((await call(logRoute.GET, 'GET', '/api/distribution/log?from=2026-10-01&to=2026-10-31', { as: U.rop })).status, 200, '31 день — предел включительно');
  assert.equal((await call(logRoute.GET, 'GET', '/api/distribution/log?from=bad&to=bad', { as: U.rop })).status, 400);
});
