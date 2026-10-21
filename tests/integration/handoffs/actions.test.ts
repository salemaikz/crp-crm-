// Действия над входящими передачами (B6b, §7.3, §7.5, D-250): принять, отклонить, назначить.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { NotFoundError } from '../../../src/server/access';
import { DealDomainError } from '../../../src/server/domain/deals/errors';
import { HandoffDomainError, acceptHandoff, assignHandoff, declineHandoff } from '../../../src/server/domain/handoffs';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { OTHER_HEAD, U, buy, closeHandoffsWorld, openHandoffsWorld, uuid, viewerOf } from './helpers';

let db: TestDb;
before(async () => {
  db = await openHandoffsWorld();
});
after(() => closeHandoffsWorld(db));

const taskStatus = async (key: string) => (await db.sql<{ status: string; assigneeUserId: string; dueAt: number | null }>`SELECT status, assignee_user_id, due_at FROM tasks WHERE source_key = ${key} ORDER BY created_at DESC`)[0];
const handoffRow = async (id: string) => (await db.sql<{ status: string; assigneeUserId: string | null; acceptedBy: string | null; declinedReason: string }>`SELECT * FROM handoffs WHERE id = ${id}`)[0]!;
const rejects = (p: Promise<unknown>, code: string) =>
  assert.rejects(p, (e: unknown) => (e instanceof HandoffDomainError || e instanceof DealDomainError) && e.code === code);

test('принять: статус, задача закрыта, лента; повтор opId — то же без новых эффектов', async () => {
  const { handoffId } = await buy(50);
  const head = await viewerOf(U.mktHead);
  assert.equal((await taskStatus(`handoff:${handoffId}`))?.status, 'open');
  const opId = uuid();
  const r = await acceptHandoff(head, { handoffId, opId });
  assert.deepEqual([r.status, r.can.accept, r.can.assign], ['accepted', false, true]);
  assert.equal((await taskStatus(`handoff:${handoffId}`))?.status, 'cancelled');
  const h = await handoffRow(handoffId);
  assert.deepEqual([h.status, h.acceptedBy], ['accepted', U.mktHead]);

  const again = await acceptHandoff(head, { handoffId, opId });
  assert.equal(again.status, 'accepted');
  const feed = await db.sql`SELECT 1 FROM client_events WHERE ref_id = ${handoffId} AND kind = 'handoff.accepted'`;
  assert.equal(feed.length, 1);
});

test('параллельный повтор того же opId — одна запись ленты', async () => {
  const { handoffId } = await buy(51);
  const head = await viewerOf(U.mktHead);
  const opId = uuid();
  const rs = await Promise.all([acceptHandoff(head, { handoffId, opId }), acceptHandoff(head, { handoffId, opId })]);
  assert.deepEqual(rs.map((r) => r.status), ['accepted', 'accepted']);
  assert.equal((await db.sql`SELECT 1 FROM client_events WHERE ref_id = ${handoffId} AND kind = 'handoff.accepted'`).length, 1);
});

test('принять уже принятую другим действием — already_handled; чужой opId — request_reused', async () => {
  const { handoffId } = await buy(52);
  const head = await viewerOf(U.mktHead);
  const opId = uuid();
  await acceptHandoff(head, { handoffId, opId });
  await rejects(acceptHandoff(head, { handoffId, opId: uuid() }), 'already_handled');
  await rejects(declineHandoff(head, { handoffId, opId: uuid(), reason: 'Синтетическая причина' }), 'already_handled');
  // тот же opId, но другое действие
  await rejects(assignHandoff(head, { handoffId, opId, userId: U.marketer }), 'request_reused');
});

test('другой отдел и РОП: принять, отклонить, назначить — 404', async () => {
  const { handoffId } = await buy(53);
  for (const who of [OTHER_HEAD, U.rop, U.director, U.marketer, U.opA]) {
    const v = await viewerOf(who);
    await assert.rejects(() => acceptHandoff(v, { handoffId, opId: uuid() }), NotFoundError, `accept ${who}`);
    await assert.rejects(() => declineHandoff(v, { handoffId, opId: uuid(), reason: 'Синтетическая причина' }), NotFoundError, `decline ${who}`);
    await assert.rejects(() => assignHandoff(v, { handoffId, opId: uuid(), userId: U.marketer }), NotFoundError, `assign ${who}`);
  }
  assert.equal((await handoffRow(handoffId)).status, 'pending');
});

test('отклонить без причины — 400; с причиной: клиент главе 404, задача и колокол РОП, текста нет в ленте и аудите', async () => {
  const { handoffId, dealId } = await buy(54);
  const head = await viewerOf(U.mktHead);
  await rejects(declineHandoff(head, { handoffId, opId: uuid(), reason: '   ' }), 'reason_required');
  await rejects(declineHandoff(head, { handoffId, opId: uuid(), reason: 'я'.repeat(501) }), 'reason_too_long');
  const secret = 'Секретная синтетическая причина 7709';
  const opId = uuid();
  const r = await declineHandoff(head, { handoffId, opId, reason: secret });
  assert.equal(r.status, 'declined');
  assert.equal((await handoffRow(handoffId)).status, 'declined');
  assert.equal((await taskStatus(`handoff:${handoffId}`))?.status, 'cancelled');
  const t = await taskStatus(`handoff_declined:${handoffId}`);
  assert.deepEqual([t?.status, t?.assigneeUserId], ['open', U.rop]);
  const bell = await db.sql<{ userId: string }>`SELECT user_id FROM notifications WHERE kind = 'handoff_declined' AND entity_id = ${handoffId}`;
  assert.deepEqual(bell.map((b) => b.userId), [U.rop]);
  // повтор после отказа — то же, без новых эффектов
  const again = await declineHandoff(head, { handoffId, opId, reason: secret });
  assert.equal(again.status, 'declined');
  assert.equal((await db.sql`SELECT 1 FROM notifications WHERE kind = 'handoff_declined' AND entity_id = ${handoffId}`).length, 1);
  // текст — только в колонке причины
  const leaks = await db.sql`SELECT 1 FROM client_events WHERE data::text LIKE ${'%' + secret + '%'}
                             UNION ALL SELECT 1 FROM audit_log WHERE meta::text LIKE ${'%' + secret + '%'}
                             UNION ALL SELECT 1 FROM notifications WHERE params::text LIKE ${'%' + secret + '%'}
                             UNION ALL SELECT 1 FROM tasks WHERE title LIKE ${'%' + secret + '%'}`;
  assert.equal(leaks.length, 0);
  const clientId = (await db.sql<{ clientId: string }>`SELECT client_id FROM deals WHERE id = ${dealId}`)[0]!.clientId;
  const visible = await db.sql`SELECT 1 FROM handoffs h WHERE h.client_id = ${clientId} AND h.status IN ('pending', 'accepted')`;
  assert.equal(visible.length, 0);
});

test('назначить: не сотрудник отдела — not_team_member; из pending → accepted + задача исполнителю', async () => {
  const { handoffId } = await buy(55);
  const head = await viewerOf(U.mktHead);
  await rejects(assignHandoff(head, { handoffId, opId: uuid(), userId: U.opA }), 'not_team_member');
  await rejects(assignHandoff(head, { handoffId, opId: uuid(), userId: OTHER_HEAD }), 'not_team_member');
  assert.equal((await handoffRow(handoffId)).status, 'pending');

  const r = await assignHandoff(head, { handoffId, opId: uuid(), userId: U.marketer });
  assert.deepEqual([r.status, r.assigneeUserId], ['accepted', U.marketer]);
  assert.equal((await taskStatus(`handoff:${handoffId}`))?.status, 'cancelled');
  const work = await taskStatus(`handoff_work:${handoffId}`);
  // чт 29.10 14:00 → пт 30.10 с начала окна звонков (09:00 по Алматы)
  assert.deepEqual([work?.status, work?.assigneeUserId, work?.dueAt], ['open', U.marketer, Date.UTC(2026, 9, 30, 4, 0)]);
  const bell = await db.sql`SELECT 1 FROM notifications WHERE kind = 'handoff_assigned' AND entity_id = ${handoffId} AND user_id = ${U.marketer}`;
  assert.equal(bell.length, 1);
  // исполнитель видит передачу и свои задачи
  assert.equal((await handoffRow(handoffId)).acceptedBy, U.mktHead);
});

test('переназначить: та же задача у нового исполнителя', async () => {
  const { handoffId } = await buy(56);
  const head = await viewerOf(U.mktHead);
  await assignHandoff(head, { handoffId, opId: uuid(), userId: U.marketer });
  const r = await assignHandoff(head, { handoffId, opId: uuid(), userId: U.mktHead });
  assert.equal(r.assigneeUserId, U.mktHead);
  const tasks = await db.sql<{ assigneeUserId: string }>`SELECT assignee_user_id FROM tasks WHERE source_key = ${`handoff_work:${handoffId}`} AND status = 'open'`;
  assert.deepEqual(tasks.map((x) => x.assigneeUserId), [U.mktHead]);
});

test('без руководителя отдела задача «назначьте» закрывается при назначении', async () => {
  const { handoffId } = await buy(57);
  await db.sql`INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, assignee_user_id, team_id, status, source_key, created_at)
               SELECT 'tk-nolead-117', 'sp-sales', h.client_id, h.deal_id, 'check', 'handoff', '', ${U.rop}, h.team_id, 'open', ${`handoff_nolead:${handoffId}`}, 1 FROM handoffs h WHERE h.id = ${handoffId}`;
  const head = await viewerOf(U.mktHead);
  await acceptHandoff(head, { handoffId, opId: uuid() });
  assert.equal((await taskStatus(`handoff_nolead:${handoffId}`))?.status, 'cancelled');
});

test('повтор opId сменённым главой отдела — 404: ответ повтора только в охвате действия', async () => {
  const { handoffId } = await buy(58);
  const head = await viewerOf(U.mktHead);
  const opId = uuid();
  await acceptHandoff(head, { handoffId, opId });
  const team = (await db.sql<{ teamId: string }>`SELECT team_id FROM handoffs WHERE id = ${handoffId}`)[0]!.teamId;
  // главу сменили: отдел ведёт другой сотрудник
  await db.sql`UPDATE teams SET lead_user_id = ${OTHER_HEAD} WHERE id = ${team}`;
  try {
    await assert.rejects(() => acceptHandoff(head, { handoffId, opId }), NotFoundError);
  } finally {
    await db.sql`UPDATE teams SET lead_user_id = ${U.mktHead} WHERE id = ${team}`;
  }
  // вернули — повтор снова отдаёт текущее состояние
  assert.equal((await acceptHandoff(head, { handoffId, opId })).status, 'accepted');
});
