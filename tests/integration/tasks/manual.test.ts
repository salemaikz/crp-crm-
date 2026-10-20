// Экран задач B7 (docs/tasks-team-design.md §4, §10): ручные задачи, исполнители, «Готово» и автозадачи, комментарии,
// отмена, «взять себе», вкладки, временный владелец (D-252). Синтетика: «ТОО Синтетика …», номера +7 709 ….
// «Сейчас» мира — среда 28.10.2026 11:00 по Алматы.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { time } from '@crm/core';
import { BadRequestError, ForbiddenError, NotFoundError } from '../../../src/server/access';
import { DetailedConflictError } from '../../../src/server/domain/clients';
import {
  addComment,
  cancelTask,
  completeTask,
  createTask,
  getTask,
  listAssignees,
  listTasks,
  updateTask,
} from '../../../src/server/domain/tasks';
import type { TestDb } from '../../../src/server/platform/db/testing';
import { viewerOf } from '../../isolation/harness/actors';
import { FX, SEED_NOW, SEED_TZ, SPACE, U, clientOf } from '../../isolation/harness/seed';
import { closeClientsWorld, openClientsWorld } from '../clients/world';

let db: TestDb;
before(async () => {
  db = await openClientsWorld();
});
after(() => closeClientsWorld(db));

const uid = (n: number) => `00000000-0000-4000-8000-0000000b7${String(n).padStart(3, '0')}`;
const at = (day: string, hhmm: string) => time.fromLocalTime(day, hhmm, SEED_TZ);
const isBad = (detail: string) => (e: unknown) => e instanceof BadRequestError && e.detail === detail;
const isConflict = (detail: string) => (e: unknown) => e instanceof DetailedConflictError && e.detail === detail;
const base = { kind: 'call' as const, title: 'Отправить КП', dueAt: null };

test('оператор: задача себе по своему клиенту — в «Мои» с корзиной, событие ленты без текста, без уведомления', async () => {
  const a = await viewerOf(U.opA);
  const cl = clientOf('a', 20);
  const r = await createTask(a, { ...base, opId: uid(1), clientId: cl, dueAt: at('2026-10-28', '17:00'), assigneeUserId: U.opA });
  assert.deepEqual(r.warnings, []);
  assert.equal(r.task.bucket, 'today');
  assert.equal(r.task.clientName, 'ТОО Синтетика Альфа 20');
  assert.equal(r.task.closable, true);
  assert.equal(r.task.source, 'manual');
  const mine = await listTasks(a, { view: 'mine' });
  assert.ok(mine.items.some((x) => x.id === uid(1)));
  assert.ok(mine.counts.today >= 1);
  const ev = await db.sql<{ kind: string; data: Record<string, unknown> }>`SELECT kind, data FROM client_events WHERE client_id = ${cl} AND kind LIKE 'task.%'`;
  assert.equal(ev.length, 1);
  assert.equal(ev[0]!.kind, 'task.created');
  assert.equal(JSON.stringify(ev[0]!.data).includes('КП'), false, 'заголовок задачи не попадает в ленту');
  const n = await db.sql`SELECT 1 FROM notifications WHERE entity_type = 'task' AND entity_id = ${uid(1)}`;
  assert.equal(n.length, 0);
});

test('повтор opId — та же задача; чужой автор или другой клиент — 400 op_id', async () => {
  const a = await viewerOf(U.opA);
  const again = await createTask(a, { ...base, opId: uid(1), clientId: clientOf('a', 20), title: 'другое', assigneeUserId: U.opA });
  assert.equal(again.task.title, 'Отправить КП');
  assert.equal((await db.sql`SELECT 1 FROM tasks WHERE id = ${uid(1)}`).length, 1);
  await assert.rejects(() => createTask(a, { ...base, opId: uid(1), clientId: clientOf('a', 21), assigneeUserId: U.opA }), isBad('op_id'));
  const rop = await viewerOf(U.rop);
  await assert.rejects(() => createTask(rop, { ...base, opId: uid(1), clientId: clientOf('a', 20), assigneeUserId: U.rop }), isBad('op_id'));
});

test('оператор не может назначить другому (403) и поставить задачу на чужого клиента (404)', async () => {
  const a = await viewerOf(U.opA);
  await assert.rejects(() => createTask(a, { ...base, opId: uid(2), clientId: clientOf('a', 22), assigneeUserId: U.opB }), ForbiddenError);
  await assert.rejects(() => createTask(a, { ...base, opId: uid(3), clientId: clientOf('b', 22), assigneeUserId: U.opA }), NotFoundError);
  await assert.rejects(() => listAssignees(a, clientOf('b', 22)), NotFoundError);
  assert.deepEqual((await listAssignees(a, clientOf('a', 22))).map((x) => x.userId), [U.opA]);
  assert.equal((await db.sql`SELECT 1 FROM tasks WHERE id IN (${uid(2)}, ${uid(3)})`).length, 0);
});

test('РОП: консультант без окна — 400 assignee, с записью клиента в окне — можно; срок в субботу — предупреждение', async () => {
  const rop = await viewerOf(U.rop);
  await assert.rejects(
    () => createTask(rop, { ...base, opId: uid(4), clientId: clientOf('a', 23), assigneeUserId: U.consultant }),
    isBad('assignee'),
  );
  const list = await listAssignees(rop, FX.bkInWindow.client);
  const ids = list.map((x) => x.userId);
  assert.equal(ids[0], U.rop);
  assert.ok(ids.includes(U.opB), 'владелец карточки');
  assert.ok(ids.includes(U.consultant), 'консультант с записью в окне');
  assert.equal(ids.includes(U.director), false, 'только чтение — не исполнитель');
  assert.equal(ids.includes(U.opA), false, 'оператор без отношения к клиенту');
  assert.equal(ids.includes(U.disabled), false);
  const r = await createTask(rop, { ...base, opId: uid(5), clientId: FX.bkInWindow.client, dueAt: at('2026-10-31', '12:00'), assigneeUserId: U.consultant });
  assert.deepEqual(r.warnings, ['due_outside_work_hours']);
  const n = await db.sql<{ kind: string; params: unknown }>`SELECT kind, params FROM notifications WHERE user_id = ${U.consultant} AND entity_id = ${uid(5)}`;
  assert.deepEqual(n, [{ kind: 'task_assigned', params: {} }]);
  // Консультант видит свою задачу (клиент в окне)
  const cons = await viewerOf(U.consultant);
  assert.ok((await listTasks(cons, { view: 'mine' })).items.some((x) => x.id === uid(5)));
});

test('«Готово» у проекции срока — 409 auto_task, у ручной — выполнена; повтор — прежний ответ', async () => {
  const a = await viewerOf(U.opA);
  await assert.rejects(() => completeTask(a, 'tk-a-1', {}), isConflict('auto_task'));
  const d = await completeTask(a, uid(1), { comment: 'Отправил' });
  assert.equal(d.task.status, 'done');
  assert.equal(d.askNext, false);
  assert.equal(d.task.comments, 1);
  const again = await completeTask(a, uid(1), {});
  assert.equal(again.task.status, 'done');
  assert.equal((await db.sql`SELECT 1 FROM task_comments WHERE task_id = ${uid(1)}`).length, 1);
  const kinds = await db.sql<{ kind: string }>`SELECT kind FROM client_events WHERE ref_id = ${uid(1)} ORDER BY kind`;
  assert.deepEqual(kinds.map((k) => k.kind), ['task.comment', 'task.created', 'task.done']);
  assert.ok((await listTasks(a, { view: 'done' })).items.some((x) => x.id === uid(1)));
  // Правка закрытой — 409 closed
  await assert.rejects(() => updateTask(a, uid(1), { title: 'ещё' }), isConflict('closed'));
});

test('срок и заголовок правятся только у ручных; чужая задача — 404', async () => {
  const a = await viewerOf(U.opA);
  await assert.rejects(() => updateTask(a, 'tk-a-1', { dueAt: null }), isConflict('auto_task'));
  await assert.rejects(() => updateTask(a, 'tk-b-1', { dueAt: null }), NotFoundError);
  const r = await createTask(a, { ...base, opId: uid(6), clientId: clientOf('a', 24), assigneeUserId: U.opA });
  const u = await updateTask(a, r.task.id, { title: 'Позвонить бухгалтеру', dueAt: at('2026-10-29', '10:00') });
  assert.equal(u.task.title, 'Позвонить бухгалтеру');
  assert.equal(u.task.bucket, 'tomorrow');
});

test('комментарий: повтор opId — один; чужая задача — 404 и таблица не меняется; уведомление исполнителю', async () => {
  const a = await viewerOf(U.opA);
  const rop = await viewerOf(U.rop);
  const c1 = await addComment(a, uid(6), { opId: uid(7), body: ' Перенёс на завтра ' });
  const c2 = await addComment(a, uid(6), { opId: uid(7), body: 'другое' });
  assert.equal(c1.body, 'Перенёс на завтра');
  assert.equal(c2.id, c1.id);
  assert.equal(c2.body, 'Перенёс на завтра');
  assert.equal((await db.sql`SELECT 1 FROM task_comments WHERE task_id = ${uid(6)}`).length, 1);

  const before = await db.sql`SELECT count(*)::int AS n FROM task_comments`;
  await assert.rejects(() => addComment(a, 'tk-b-1', { opId: uid(8), body: 'чужое' }), NotFoundError);
  assert.deepEqual(await db.sql`SELECT count(*)::int AS n FROM task_comments`, before);

  await addComment(rop, uid(6), { opId: uid(9), body: 'Проверь срок' });
  const n = await db.sql<{ kind: string }>`SELECT kind FROM notifications WHERE user_id = ${U.opA} AND entity_id = ${uid(6)}`;
  assert.deepEqual(n.map((x) => x.kind), ['task_comment']);
  const d = await getTask(a, uid(6));
  assert.deepEqual(d.comments.map((c) => c.body), ['Перенёс на завтра', 'Проверь срок']);
  assert.equal(d.can.done, true);
  assert.equal(d.can.edit, true);
});

test('отмена: ручная — автор или РОП; оператор не отменяет поставленную ему РОП (403), автозадачу — 409', async () => {
  const a = await viewerOf(U.opA);
  const rop = await viewerOf(U.rop);
  const byRop = await createTask(rop, { ...base, opId: uid(10), clientId: clientOf('a', 25), assigneeUserId: U.opA });
  await assert.rejects(() => cancelTask(a, byRop.task.id), ForbiddenError);
  assert.equal((await getTask(a, byRop.task.id)).can.cancel, false);
  const c = await cancelTask(rop, byRop.task.id);
  assert.equal(c.task.status, 'cancelled');
  assert.equal((await cancelTask(rop, byRop.task.id)).task.status, 'cancelled');
  await assert.rejects(() => cancelTask(a, 'tk-a-1'), isConflict('auto_task'));
});

test('вкладки: оператору «Команда» — 403, в его списке нет задач B; РОП — фильтр по сотруднику, «Без исполнителя», «Взять себе»', async () => {
  const a = await viewerOf(U.opA);
  await assert.rejects(() => listTasks(a, { view: 'team' }), ForbiddenError);
  await assert.rejects(() => listTasks(a, { view: 'unassigned' }), ForbiddenError);
  const mine = await listTasks(a, { view: 'mine' });
  assert.equal(mine.items.some((x) => x.id === 'tk-b-1'), false);

  const rop = await viewerOf(U.rop);
  const team = await listTasks(rop, { view: 'team', userId: U.opB });
  assert.ok(team.items.length > 0);
  assert.ok(team.items.every((x) => x.assigneeUserId === U.opB));

  await db.sql`INSERT INTO tasks (id, space_id, client_id, kind, source, title, assignee_user_id, created_at)
               VALUES ('tk-unassigned', ${SPACE}, ${clientOf('a', 26)}, 'check', 'stoplist_confirm', '', NULL, ${SEED_NOW})`;
  const un = await listTasks(rop, { view: 'unassigned' });
  assert.deepEqual(un.items.map((x) => x.id), ['tk-unassigned']);
  const d = await getTask(rop, 'tk-unassigned');
  assert.equal(d.can.take, true);
  const taken = await updateTask(rop, 'tk-unassigned', { assigneeUserId: U.rop });
  assert.equal(taken.task.assigneeUserId, U.rop);
  assert.equal((await listTasks(rop, { view: 'unassigned' })).items.length, 0);
});

test('директор (только чтение): видит «Команду», но создать задачу не может', async () => {
  const dir = await viewerOf(U.director);
  assert.ok((await listTasks(dir, { view: 'team' })).items.length > 0);
  await assert.rejects(() => createTask(dir, { ...base, opId: uid(11), clientId: clientOf('a', 27), assigneeUserId: U.director }), ForbiddenError);
  await assert.rejects(() => completeTask(dir, 'tk-unassigned', {}), (e: unknown) => e instanceof ForbiddenError || e instanceof DetailedConflictError);
});

test('временный владелец видит задачи владельца по своей временной карточке в «Мои»; после снятия — 404', async () => {
  const a = await viewerOf(U.opA);
  const cl = clientOf('a', 28);
  const r = await createTask(a, { ...base, opId: uid(12), clientId: cl, assigneeUserId: U.opA });
  await db.sql`UPDATE cards SET acting_user_id = ${U.opB}, acting_until_day = '2026-10-30' WHERE client_id = ${cl}`;
  const b = await viewerOf(U.opB);
  const mine = await listTasks(b, { view: 'mine' });
  assert.ok(mine.items.some((x) => x.id === r.task.id));
  assert.equal(mine.items.find((x) => x.id === r.task.id)?.clientName, 'ТОО Синтетика Альфа 28');
  await addComment(b, r.task.id, { opId: uid(13), body: 'Позвонил вместо коллеги' });
  await db.sql`UPDATE cards SET acting_user_id = NULL, acting_until_day = '' WHERE client_id = ${cl}`;
  await assert.rejects(() => getTask(b, r.task.id), NotFoundError);
  assert.equal((await listTasks(b, { view: 'mine' })).items.some((x) => x.id === r.task.id), false);
});

test('панель карточки: открытые задачи клиента, видимые зрителю (не только мои)', async () => {
  const rop = await viewerOf(U.rop);
  const r = await listTasks(rop, { view: 'mine', clientId: clientOf('a', 1) });
  assert.ok(r.items.some((x) => x.id === 'tk-a-1'));
  const a = await viewerOf(U.opA);
  assert.deepEqual((await listTasks(a, { view: 'mine', clientId: clientOf('b', 1) })).items, []);
});
