// Отношения и роли на Postgres: окно консультанта (PROCESS §8.4), дежурный, отдел маркетинга,
// директор «только чтение», администратор без роли (ARCHITECTURE §5.3, строки прогона изоляции).
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { scopeSql, scoped } from '../../../src/server/access/scope';
import { route } from '../../../src/server/access/wrappers';
import type { ScopedEntity, Viewer } from '../../../src/server/access/types';
import type { Permission } from '../../../packages/core/src/access';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { actAs, enterSeedWorld, viewerOf } from '../../isolation/harness/actors';
import { FX, SEED_NOW, U, cardOf, clientOf } from '../../isolation/harness/seed';
import { closeWorld, openWorld } from './world';

let db: TestDb;
before(async () => {
  db = await openWorld();
});
after(() => closeWorld(db));

/** id строк сущности, доступных по разрешению. */
async function visible(v: Viewer, entity: ScopedEntity, perm: Permission): Promise<string[]> {
  const scope = scopeSql(v, entity, perm);
  const sql = scoped(db.sql);
  let rows: { id: string }[];
  switch (entity) {
    case 'card': rows = await sql`SELECT c.id FROM cards c WHERE ${scope} ORDER BY 1`; break;
    case 'client': rows = await sql`SELECT cl.id FROM clients cl WHERE ${scope} ORDER BY 1`; break;
    case 'deal': rows = await sql`SELECT d.id FROM deals d WHERE ${scope} ORDER BY 1`; break;
    case 'booking': rows = await sql`SELECT b.id FROM bookings b WHERE ${scope} ORDER BY 1`; break;
    case 'task': rows = await sql`SELECT t.id FROM tasks t WHERE ${scope} ORDER BY 1`; break;
    case 'handoff': rows = await sql`SELECT h.id FROM handoffs h WHERE ${scope} ORDER BY 1`; break;
    case 'event': rows = await sql`SELECT e.id FROM events e WHERE ${scope} ORDER BY 1`; break;
    case 'note': rows = await sql`SELECT n.id FROM notes n WHERE ${scope} ORDER BY 1`; break;
    default: throw new Error(`нет запроса для ${entity}`);
  }
  return rows.map((r) => r.id);
}

test('консультант видит клиента только в окне своей БК: завтра — да, через 2 дня и 31 день назад — нет', async () => {
  const c = await viewerOf(U.consultant);
  assert.deepEqual(await visible(c, 'card', 'card.read'), [FX.bkInWindow.card]);
  assert.deepEqual(await visible(c, 'client', 'client.read'), [FX.bkInWindow.client]);
  assert.deepEqual(await visible(c, 'booking', 'booking.read'), [FX.bkInWindow.booking]);
  // чужая БК (у другого консультанта) сегодня не открывает клиента
  assert.ok(!(await visible(c, 'client', 'client.read')).includes(FX.bkOther.client));
});

test('консультант: окно сдвигается со временем — на следующий день открывается БК «через 2 дня»', async () => {
  enterSeedWorld({ now: SEED_NOW + 86_400_000 });
  try {
    const c = await viewerOf(U.consultant);
    assert.deepEqual((await visible(c, 'card', 'card.read')).sort(), [FX.bkFuture.card, FX.bkInWindow.card].sort());
  } finally {
    enterSeedWorld();
  }
});

test('консультант меняет только свою БК в окне; чужие карточки и записи — 0 строк', async () => {
  const c = await viewerOf(U.consultant);
  const sql = scoped(db.sql);
  const attend = (id: string) =>
    sql`UPDATE bookings b SET status = 'attended' WHERE b.id = ${id} AND ${scopeSql(c, 'booking', 'booking.attend')} RETURNING b.id`;
  for (const id of [FX.bkFuture.booking, FX.bkPast.booking, FX.bkOther.booking, FX.eventToday.booking]) {
    assert.deepEqual(await attend(id), [], id);
  }
  assert.equal((await attend(FX.bkInWindow.booking)).length, 1);
  // покупка и смена этапа — по сделкам клиента в окне; правка карточки — нет
  for (const [deal, b] of [['dl-b2', FX.bkInWindow], ['dl-b3', FX.bkFuture]] as const) {
    await db.sql`INSERT INTO deals (id, space_id, pipeline_key, stage_key, status, client_id, card_id, owner_user_id,
                                    stage_changed_at, created_by, created_at, updated_at)
                 VALUES (${deal}, 'sp-sales', 'sales', 'meeting', 'open', ${b.client}, ${b.card}, ${U.opB}, 1, ${U.opB}, 1, 1)`;
    await db.sql`INSERT INTO notes (id, client_id, space_id, author_id, body, created_at)
                 VALUES (${'nt-' + deal}, ${b.client}, 'sp-sales', ${U.opB}, 'синтетика', 1)`;
  }
  assert.deepEqual(await visible(c, 'card', 'card.edit'), []);
  assert.deepEqual(await visible(c, 'deal', 'deal.purchase'), ['dl-b2']);
  assert.deepEqual(await visible(c, 'deal', 'deal.edit'), ['dl-b2']);
  assert.deepEqual(await visible(c, 'deal', 'deal.move_back'), []);
  assert.deepEqual(await visible(c, 'note', 'note.write'), ['nt-dl-b2']);
});

test('дежурный: гости своего мероприятия сегодня; завтрашнее — нет; карточку и клиента не открывает', async () => {
  const d = await viewerOf(U.duty);
  const guests = await visible(d, 'booking', 'booking.read');
  assert.ok(guests.includes(FX.eventToday.booking));
  assert.ok(!guests.includes(FX.eventTomorrow.booking));
  const attend = await visible(d, 'booking', 'booking.attend');
  assert.deepEqual(attend, [FX.eventToday.booking]);
  assert.ok(!(await visible(d, 'client', 'client.read')).includes(FX.eventToday.client));
  assert.deepEqual(await visible(d, 'event', 'booking.walk_in'), [FX.eventToday.event]);
});

test('руководитель отдела: только переданные (живые) клиенты, приём передачи; отклонённая — не видна', async () => {
  const h = await viewerOf(U.mktHead);
  assert.deepEqual(await visible(h, 'client', 'client.read'), [FX.handoffLive.client]);
  assert.deepEqual(await visible(h, 'handoff', 'handoff.accept'), [FX.handoffLive.handoff]);
  assert.deepEqual(await visible(h, 'task', 'task.write'), [FX.handoffLive.task]);
  assert.deepEqual(await visible(h, 'card', 'card.edit'), []);
});

test('маркетолог: клиенты, где он исполнитель передачи; задачи передачи; принять передачу не может', async () => {
  const m = await viewerOf(U.marketer);
  assert.deepEqual(await visible(m, 'client', 'client.read'), [FX.handoffLive.client]);
  assert.deepEqual(await visible(m, 'task', 'task.read'), [FX.handoffLive.task]);
  assert.deepEqual(await visible(m, 'handoff', 'handoff.accept'), []);
});

test('директор: читает всё пространство, писать нечем (FALSE) и мутации маршрутов → 423', async () => {
  const dir = await viewerOf(U.director);
  assert.equal((await visible(dir, 'card', 'card.read')).length, 200);
  assert.deepEqual(await visible(dir, 'card', 'card.edit'), []);
  actAs(U.director);
  const patch = route({ perm: 'card.edit', target: 'object' }, async () => 'changed');
  const r = await patch(new Request('http://crm.test/api/cards/x', { method: 'PATCH', headers: { origin: 'http://crm.test' } }), {
    params: Promise.resolve({ id: cardOf('a', 1) }),
  });
  assert.equal(r.status, 423);
});

test('администратор без роли: ни карточек, ни клиентов, ни выгрузки — ни через scope, ни через обёртки', async () => {
  const adm = await viewerOf(U.admin);
  assert.equal(adm.isAdmin, true);
  assert.equal(adm.spaceId, null);
  for (const [e, p] of [['card', 'card.read'], ['client', 'client.read'], ['deal', 'deal.read'], ['booking', 'booking.read'], ['task', 'task.read']] as const) {
    assert.deepEqual(await visible(adm, e, p), [], e);
  }
  actAs(U.admin);
  const get = route({ perm: 'card.read', target: 'object' }, async () => 'data');
  const exp = route({ perm: 'data.export_all', securityMutation: 'data.export_all' }, async () => 'dump');
  const settings = route({ perm: 'admin' }, async () => 'ok');
  const req = (m: string) => new Request('http://crm.test/api/x', { method: m, headers: m === 'GET' ? {} : { origin: 'http://crm.test' } });
  assert.equal((await get(req('GET'), { params: Promise.resolve({ id: cardOf('a', 1) }) })).status, 404);
  assert.equal((await exp(req('POST'), { params: Promise.resolve({}) })).status, 403);
  assert.equal((await settings(req('POST'), { params: Promise.resolve({}) })).status, 200);
});

test('РОП видит всё пространство, включая пул; оператор пула не видит', async () => {
  await db.sql`INSERT INTO clients (id, kind, name, name_norm, source_kind, created_at, updated_at) VALUES ('cl-pool', 'company', 'ТОО Пул', 'пул', 'import', 1, 1)`;
  await db.sql`INSERT INTO cards (id, space_id, client_id, created_at, updated_at) VALUES ('cd-pool', 'sp-sales', 'cl-pool', 1, 1)`;
  const rop = await viewerOf(U.rop);
  assert.ok((await visible(rop, 'card', 'pool.read')).includes('cd-pool'));
  const a = await viewerOf(U.opA);
  assert.ok(!(await visible(a, 'card', 'card.read')).includes('cd-pool'));
  assert.deepEqual(await visible(a, 'card', 'pool.read'), []);
  void clientOf;
});
