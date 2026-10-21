// Автозадачи (D-050): создать и закрыть по `source_key` в транзакции события. Контракт — tasks/types.ts,
// дизайн — docs/calls-design.md §6. Вызывающий уже заблокировал карточку и проверил охват: здесь охвата нет,
// кроме `listMyOpenTasks` (чтение своих задач).
import { scopeSql, scoped } from '@/server/access/scope';
import { getDb, newId } from '@/server/platform/db';
import type { CloseAutoTaskByKey, CloseAutoTasks, EnsureAutoTask, ListMyOpenTasks, MyOpenTask, ReassignOpenTasks, TaskActor } from './types';

const actorId = (a: TaskActor): string | null => (a.kind === 'user' ? a.userId : null);

export const ensureAutoTask: EnsureAutoTask = async (tx, actor, input) => {
  const id = newId();
  // title пустой: подпись строит интерфейс по source и kind (в задаче нет ни ПДн, ни строк в коде)
  const rows = await tx<{ id: string }>`
    INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_by, created_at)
    VALUES (${id}, ${input.spaceId}, ${input.clientId}, ${input.dealId ?? null}, ${input.kind}, ${input.source}, '', ${input.dueAt},
            ${input.assigneeUserId}, 'open', ${input.sourceKey}, ${actorId(actor)}, ${input.at})
    ON CONFLICT (source_key) WHERE source_key IS NOT NULL AND status = 'open' DO NOTHING
    RETURNING id`;
  if (rows[0]) return { id: rows[0].id, created: true };
  const existing = await tx<{ id: string }>`SELECT id FROM tasks WHERE source_key = ${input.sourceKey} AND status = 'open'`;
  if (!existing[0]) throw new Error('tasks: автозадача не создана и открытой с этим ключом нет');
  return { id: existing[0].id, created: false };
};

export const closeAutoTasks: CloseAutoTasks = async (tx, _actor, input) => {
  const rows =
    input.sources === 'all'
      ? await tx<{ id: string }>`
          UPDATE tasks SET status = 'done', done_at = ${input.at}
           WHERE space_id = ${input.spaceId} AND client_id = ${input.clientId} AND status = 'open' RETURNING id`
      : await tx<{ id: string }>`
          UPDATE tasks SET status = 'done', done_at = ${input.at}
           WHERE space_id = ${input.spaceId} AND client_id = ${input.clientId} AND status = 'open' AND source = ANY(${[...input.sources]})
          RETURNING id`;
  return rows.length;
};

export const closeAutoTaskByKey: CloseAutoTaskByKey = async (tx, _actor, input) => {
  const rows = await tx<{ id: string }>`
    UPDATE tasks SET status = 'done', done_at = ${input.at} WHERE source_key = ${input.sourceKey} AND status = 'open' RETURNING id`;
  return rows.length;
};

export const reassignOpenTasks: ReassignOpenTasks = async (tx, _actor, input) => {
  if (input.fromUserIds.length === 0) return 0;
  const rows = await tx<{ id: string }>`
    UPDATE tasks SET assignee_user_id = ${input.toUserId}
     WHERE space_id = ${input.spaceId} AND client_id = ${input.clientId} AND status = 'open'
       AND assignee_user_id = ANY(${[...input.fromUserIds]}::text[]) RETURNING id`;
  return rows.length;
};

export const listMyOpenTasks: ListMyOpenTasks = async (viewer, input) => {
  const db = await getDb();
  const sources = input.sources ? [...input.sources] : null;
  return scoped(db.sql)<MyOpenTask>`
    SELECT t.id, t.client_id, t.deal_id, t.source, t.kind, t.due_at, t.created_at
      FROM tasks t
     WHERE t.status = 'open' AND t.assignee_user_id = ${viewer.userId} AND ${scopeSql(viewer, 'task', 'task.read')}
       AND (${sources}::text[] IS NULL OR t.source = ANY(${sources}::text[]))
     ORDER BY t.due_at NULLS LAST, t.created_at, t.id
     LIMIT ${input.limit}`;
};
