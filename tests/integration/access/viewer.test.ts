// Сборка Viewer из БД и настроек: роль перечитывается на каждом запросе, отключение действует сразу,
// настройки без раздела ролей не открывают ничего; аудит обёртки; лента слитого клиента.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildViewer } from '../../../src/server/access/viewer';
import { scopeSql, scoped } from '../../../src/server/access/scope';
import { route } from '../../../src/server/access/wrappers';
import { overrideAccessForTests } from '../../../src/server/access/testing';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { actAs, enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { configDoc } from '../../isolation/harness/config';
import { SEED_TODAY, SPACE, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openWorld();
});
after(() => closeWorld(db));

test('Viewer оператора: роль, охваты, отношения, пояс и местная дата', async () => {
  const v = await viewerOf(U.opA);
  assert.equal(v.kind, 'user');
  assert.equal(v.roleKey, 'operator');
  assert.equal(v.spaceId, SPACE);
  assert.deepEqual(v.spaceIds, [SPACE]);
  assert.equal(v.grants.get('card.read'), 'own');
  assert.deepEqual(v.relations.map((r) => r.key), ['duty_today']);
  assert.equal(v.today, SEED_TODAY);
  assert.equal(v.readOnly, false);
  assert.equal(v.license, 'valid');
  assert.equal(v.configRev, 1);
});

test('смена роли и отключение членства действуют со следующего запроса', async () => {
  await db.sql`UPDATE memberships SET role_key = 'rop' WHERE user_id = ${U.opB}`;
  assert.equal((await viewerOf(U.opB)).grants.get('card.read'), 'space');
  await db.sql`UPDATE memberships SET status = 'disabled' WHERE user_id = ${U.opB}`;
  const v = await viewerOf(U.opB);
  assert.equal(v.spaceId, null);
  assert.equal(v.grants.size, 0);
  await db.sql`UPDATE memberships SET status = 'active', role_key = 'operator' WHERE user_id = ${U.opB}`;
});

test('отключённая учётка и неизвестный пользователь — 401', async () => {
  for (const id of [U.disabled, 'u-nobody']) {
    actAs(id);
    await assert.rejects(buildViewer(), { code: 'unauthorized' });
  }
});

test('роль, которой нет в настройках, или архивная — без прав', async () => {
  const doc = configDoc() as { global: { roles: Array<{ key: string; archived?: boolean }> } };
  const noOperator = { ...doc, global: { ...doc.global, roles: doc.global.roles.filter((r) => r.key !== 'operator') } };
  overrideAccessForTests({ config: async () => noOperator });
  try {
    const v = await viewerOf(U.opA);
    assert.equal(v.roleKey, null);
    assert.equal(v.grants.size, 0);
    const archived = { ...doc, global: { ...doc.global, roles: doc.global.roles.map((r) => (r.key === 'operator' ? { ...r, archived: true } : r)) } };
    overrideAccessForTests({ config: async () => archived });
    assert.equal((await viewerOf(U.opA)).grants.size, 0);
  } finally {
    enterSeedWorld();
  }
});

test('настройки с опасной ролью или без пояса не принимаются (fail closed)', async () => {
  const doc = configDoc() as { global: { roles: Array<{ key: string; grants: unknown[] }> } };
  const dangerous = {
    ...doc,
    global: {
      ...doc.global,
      roles: doc.global.roles.map((r) => (r.key === 'operator' ? { ...r, grants: [...r.grants, { perm: 'pool.read', scope: 'space' }] } : r)),
    },
  };
  for (const bad of [dangerous, { global: { roles: doc.global.roles } }, null]) {
    overrideAccessForTests({ config: async () => bad });
    await assert.rejects(viewerOf(U.opA), /раздел ролей настроек/);
  }
  enterSeedWorld();
});

test('запрос пространства без членства — 404', async () => {
  actAs(U.opA);
  await assert.rejects(buildViewer({ spaceId: 'sp-elsewhere' }), { code: 'not_found' });
});

test('лента слитого клиента видна владельцу выжившего (цепочка merged_into_id, D-068)', async () => {
  // Клиент A8 слит в A7: его карточка уже перенесена (её больше нет), лента осталась на A8.
  await db.sql`DELETE FROM client_phones WHERE client_id = ${clientOf('a', 8)}`;
  await db.sql`DELETE FROM cards WHERE id = ${cardOf('a', 8)}`;
  await db.sql`UPDATE clients SET merged_into_id = ${clientOf('a', 7)} WHERE id = ${clientOf('a', 8)}`;
  await db.sql`INSERT INTO client_events (id, client_id, space_id, kind, at) VALUES ('ce-merged', ${clientOf('a', 8)}, ${SPACE}, 'call', 1)`;
  const feed = async (who: string) =>
    (await scoped(db.sql)`SELECT ev.id FROM client_events ev WHERE ev.id = 'ce-merged' AND ${scopeSql(await viewerOf(who), 'client_event', 'card.read')}`).length;
  assert.equal(await feed(U.opA), 1);
  assert.equal(await feed(U.opB), 0);
});

test('аудит обёртки: чувствительное действие пишется в audit_log без ПДн', async () => {
  actAs(U.rop);
  const h = route(
    { perm: 'card.unblock', target: 'object', audit: { action: 'session.logout_all', entity: 'user', entityId: ({ params }) => String(params.id), meta: () => ({ n: 1 }) } },
    async () => ({ ok: true }),
  );
  const r = await h(new Request('http://crm.test/api/x', { method: 'POST', headers: { origin: 'http://crm.test' } }), {
    params: Promise.resolve({ id: 'obj-1' }),
  });
  assert.equal(r.status, 200);
  const rows = await db.sql<{ actorId: string; entityId: string; spaceId: string; meta: unknown }>`
    SELECT actor_id, entity_id, space_id, meta FROM audit_log WHERE entity_id = 'obj-1'`;
  assert.deepEqual(rows, [{ actorId: U.rop, entityId: 'obj-1', spaceId: SPACE, meta: { n: 1 } }]);
  // отказ аудит не пишет
  actAs(U.opA);
  const denied = await h(new Request('http://crm.test/api/x', { method: 'POST', headers: { origin: 'http://crm.test' } }), {
    params: Promise.resolve({ id: 'obj-2' }),
  });
  assert.equal(denied.status, 404);
  assert.equal((await db.sql`SELECT 1 FROM audit_log WHERE entity_id = 'obj-2'`).length, 0);
});
