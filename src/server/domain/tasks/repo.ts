// SQL экрана задач (B7, docs/tasks-team-design.md §4.4). Охват — только scopeSql: задача (`task.read`/`task.write`),
// название клиента (`client.read`) и карточка (`card.read`) — каждое своим фрагментом, поэтому в строке задачи нет
// данных клиента, которого зритель не видит. Автозадачи — tasks/auto.ts, не здесь.
import { scopeSql, scoped } from '@/server/access/scope';
import type { Viewer } from '@/server/access';
import { jsonParam } from '@/server/platform/db/core';
import { newId, type Sql } from '@/server/platform/db';
import type { TaskKind, TaskSource, TaskStatus } from './types';

/** Строка задачи из БД (корзину и `closable` добавляет сервис). */
export type TaskDbRow = {
  id: string;
  clientId: string;
  clientName: string | null;
  cardId: string | null;
  dealId: string | null;
  kind: TaskKind;
  source: TaskSource;
  title: string;
  dueAt: number | null;
  /** `tasks.due_precision`: «день» — срок без времени. */
  duePrecision: 'time' | 'day';
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdBy: string | null;
  comments: number;
  status: TaskStatus;
  doneAt: number | null;
};

/**
 * Режим открытого списка: мои (исполнитель я или владелец карточки, где я временный — D-252), команда (по
 * сотруднику или все), без исполнителя, все видимые задачи клиента (панель карточки).
 */
export type OpenMode = 'mine' | 'team' | 'unassigned' | 'client';

export type OpenQuery = { mode: OpenMode; userId: string | null; clientId: string | null; limit: number };

export async function selectOpenTasks(sql: Sql, viewer: Viewer, q: OpenQuery): Promise<TaskDbRow[]> {
  return scoped(sql)<TaskDbRow>`
    SELECT t.id, t.client_id, t.deal_id, t.kind, t.source, t.title, t.due_at, t.due_precision, t.assignee_user_id, au.name AS assignee_name,
           t.created_by, t.status, t.done_at,
           (SELECT cl.name FROM clients cl WHERE cl.id = t.client_id AND ${scopeSql(viewer, 'client', 'client.read', { alias: 'cl' })}) AS client_name,
           (SELECT cv.id FROM cards cv WHERE cv.client_id = t.client_id AND cv.space_id = t.space_id
               AND ${scopeSql(viewer, 'card', 'card.read', { alias: 'cv' })} LIMIT 1) AS card_id,
           (SELECT count(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comments
      FROM tasks t LEFT JOIN users au ON au.id = t.assignee_user_id
     WHERE t.status = 'open' AND t.space_id = ${viewer.spaceId}
       AND (${q.clientId}::text IS NULL OR t.client_id = ${q.clientId})
       AND CASE ${q.mode}::text
             WHEN 'mine' THEN (t.assignee_user_id = ${viewer.userId}
                               OR EXISTS (SELECT 1 FROM cards ca WHERE ca.space_id = t.space_id AND ca.client_id = t.client_id
                                             AND ca.acting_user_id = ${viewer.userId} AND ca.owner_user_id = t.assignee_user_id))
             WHEN 'team' THEN (${q.userId}::text IS NULL OR t.assignee_user_id = ${q.userId})
             WHEN 'unassigned' THEN t.assignee_user_id IS NULL
             ELSE TRUE
           END
       AND ${scopeSql(viewer, 'task', 'task.read')}
     ORDER BY t.due_at NULLS LAST, t.created_at, t.id
     LIMIT ${q.limit}`;
}

export type BucketCounts = { overdue: number; today: number; tomorrow: number; later: number; none: number };

/** Счётчики корзин с теми же условиями, что у списка (без предела строк). Просрочка — как `bucketOf`: «время» < now, «день» < todayStart. */
export async function countOpenBuckets(
  sql: Sql,
  viewer: Viewer,
  q: Omit<OpenQuery, 'limit'> & { now: number; todayStart: number; tomorrowStart: number; afterTomorrowStart: number },
): Promise<BucketCounts> {
  const rows = await scoped(sql)<BucketCounts>`
    SELECT count(*) FILTER (WHERE ((t.due_precision = 'time' AND t.due_at < ${q.now}) OR (t.due_precision = 'day' AND t.due_at < ${q.todayStart})))::int AS overdue,
           count(*) FILTER (WHERE t.due_at < ${q.tomorrowStart} AND NOT ((t.due_precision = 'time' AND t.due_at < ${q.now}) OR (t.due_precision = 'day' AND t.due_at < ${q.todayStart})))::int AS today,
           count(*) FILTER (WHERE t.due_at >= ${q.tomorrowStart} AND t.due_at < ${q.afterTomorrowStart})::int AS tomorrow,
           count(*) FILTER (WHERE t.due_at >= ${q.afterTomorrowStart})::int AS later,
           count(*) FILTER (WHERE t.due_at IS NULL)::int AS none
      FROM tasks t
     WHERE t.status = 'open' AND t.space_id = ${viewer.spaceId}
       AND (${q.clientId}::text IS NULL OR t.client_id = ${q.clientId})
       AND CASE ${q.mode}::text
             WHEN 'mine' THEN (t.assignee_user_id = ${viewer.userId}
                               OR EXISTS (SELECT 1 FROM cards ca WHERE ca.space_id = t.space_id AND ca.client_id = t.client_id
                                             AND ca.acting_user_id = ${viewer.userId} AND ca.owner_user_id = t.assignee_user_id))
             WHEN 'team' THEN (${q.userId}::text IS NULL OR t.assignee_user_id = ${q.userId})
             WHEN 'unassigned' THEN t.assignee_user_id IS NULL
             ELSE TRUE
           END
       AND ${scopeSql(viewer, 'task', 'task.read')}`;
  return rows[0] ?? { overdue: 0, today: 0, tomorrow: 0, later: 0, none: 0 };
}

/** Выполненные и отменённые мной (или по моим временным карточкам) с момента `since`, новые сверху. */
export async function selectDoneTasks(sql: Sql, viewer: Viewer, q: { since: number; limit: number }): Promise<TaskDbRow[]> {
  return scoped(sql)<TaskDbRow>`
    SELECT t.id, t.client_id, t.deal_id, t.kind, t.source, t.title, t.due_at, t.due_precision, t.assignee_user_id, au.name AS assignee_name,
           t.created_by, t.status, t.done_at,
           (SELECT cl.name FROM clients cl WHERE cl.id = t.client_id AND ${scopeSql(viewer, 'client', 'client.read', { alias: 'cl' })}) AS client_name,
           (SELECT cv.id FROM cards cv WHERE cv.client_id = t.client_id AND cv.space_id = t.space_id
               AND ${scopeSql(viewer, 'card', 'card.read', { alias: 'cv' })} LIMIT 1) AS card_id,
           (SELECT count(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comments
      FROM tasks t LEFT JOIN users au ON au.id = t.assignee_user_id
     WHERE t.status IN ('done', 'cancelled') AND t.space_id = ${viewer.spaceId} AND t.done_at >= ${q.since}
       AND (t.assignee_user_id = ${viewer.userId}
            OR EXISTS (SELECT 1 FROM cards ca WHERE ca.space_id = t.space_id AND ca.client_id = t.client_id
                          AND ca.acting_user_id = ${viewer.userId} AND ca.owner_user_id = t.assignee_user_id))
       AND ${scopeSql(viewer, 'task', 'task.read')}
     ORDER BY t.done_at DESC, t.id
     LIMIT ${q.limit}`;
}

/** Одна задача, видимая зрителю по `task.read`. */
export async function selectTask(sql: Sql, viewer: Viewer, id: string): Promise<TaskDbRow | null> {
  const rows = await scoped(sql)<TaskDbRow>`
    SELECT t.id, t.client_id, t.deal_id, t.kind, t.source, t.title, t.due_at, t.due_precision, t.assignee_user_id, au.name AS assignee_name,
           t.created_by, t.status, t.done_at,
           (SELECT cl.name FROM clients cl WHERE cl.id = t.client_id AND ${scopeSql(viewer, 'client', 'client.read', { alias: 'cl' })}) AS client_name,
           (SELECT cv.id FROM cards cv WHERE cv.client_id = t.client_id AND cv.space_id = t.space_id
               AND ${scopeSql(viewer, 'card', 'card.read', { alias: 'cv' })} LIMIT 1) AS card_id,
           (SELECT count(*) FROM task_comments tc WHERE tc.task_id = t.id)::int AS comments
      FROM tasks t LEFT JOIN users au ON au.id = t.assignee_user_id
     WHERE t.id = ${id} AND ${scopeSql(viewer, 'task', 'task.read')}`;
  return rows[0] ?? null;
}

/** Можно ли писать в задачу (`task.write`): для комментариев и проверки «видна, но нельзя». */
export async function taskWritable(sql: Sql, viewer: Viewer, id: string): Promise<boolean> {
  const rows = await scoped(sql)<{ id: string }>`SELECT t.id FROM tasks t WHERE t.id = ${id} AND ${scopeSql(viewer, 'task', 'task.write')}`;
  return rows.length === 1;
}

/** Кто занял id (повтор `opId` создания): без охвата, только автор и клиент — данных задачи наружу не отдаёт. */
export async function selectTaskOwnerOfId(sql: Sql, id: string): Promise<{ createdBy: string | null; clientId: string } | null> {
  const rows = await sql<{ createdBy: string | null; clientId: string }>`SELECT created_by, client_id FROM tasks WHERE id = ${id}`;
  return rows[0] ?? null;
}

export type ClientCardRef = { cardId: string; ownerUserId: string | null; actingUserId: string | null };

/** Карточка клиента в пространстве зрителя, если она ему видна (`card.read`). */
export async function selectVisibleCard(sql: Sql, viewer: Viewer, clientId: string): Promise<ClientCardRef | null> {
  const rows = await scoped(sql)<ClientCardRef>`
    SELECT c.id AS card_id, c.owner_user_id, c.acting_user_id FROM cards c
     WHERE c.client_id = ${clientId} AND c.space_id = ${viewer.spaceId} AND ${scopeSql(viewer, 'card', 'card.read')}`;
  return rows[0] ?? null;
}

export async function insertManualTask(
  tx: Sql,
  t: { id: string; spaceId: string; clientId: string; dealId: string | null; kind: TaskKind; title: string; dueAt: number | null; assigneeUserId: string; createdBy: string; at: number },
): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    INSERT INTO tasks (id, space_id, client_id, deal_id, kind, source, title, due_at, assignee_user_id, status, source_key, created_by, created_at)
    VALUES (${t.id}, ${t.spaceId}, ${t.clientId}, ${t.dealId}, ${t.kind}, 'manual', ${t.title}, ${t.dueAt}, ${t.assigneeUserId}, 'open', NULL,
            ${t.createdBy}, ${t.at})
    ON CONFLICT (id) DO NOTHING
    RETURNING id`;
  return rows.length === 1;
}

/**
 * Правка открытой задачи по `task.write`. `manualOnly` — срок и заголовок (только ручные); `assignee` — новый
 * исполнитель (`expectUnassigned` — «взять себе» только у задачи без исполнителя). null — 0 строк.
 */
export async function updateOpenTask(
  tx: Sql,
  viewer: Viewer,
  id: string,
  p: {
    setTitle: boolean;
    title: string | null;
    setDue: boolean;
    dueAt: number | null;
    setAssignee: boolean;
    assigneeUserId: string | null;
    expectUnassigned: boolean;
    manualOnly: boolean;
  },
): Promise<{ id: string; clientId: string } | null> {
  const rows = await scoped(tx)<{ id: string; clientId: string }>`
    UPDATE tasks t
       SET title = CASE WHEN ${p.setTitle} THEN ${p.title}::text ELSE t.title END,
           due_at = CASE WHEN ${p.setDue} THEN ${p.dueAt}::bigint ELSE t.due_at END,
           assignee_user_id = CASE WHEN ${p.setAssignee} THEN ${p.assigneeUserId}::text ELSE t.assignee_user_id END
     WHERE t.id = ${id} AND t.status = 'open'
       AND (NOT ${p.manualOnly} OR t.source = 'manual')
       AND (NOT ${p.expectUnassigned} OR t.assignee_user_id IS NULL)
       AND ${scopeSql(viewer, 'task', 'task.write')}
    RETURNING t.id, t.client_id`;
  return rows[0] ?? null;
}

/** «Готово»: только открытая задача закрываемого источника, по `task.write`. */
export async function completeOpenTask(tx: Sql, viewer: Viewer, id: string, sources: readonly TaskSource[], at: number): Promise<{ clientId: string; dealId: string | null; source: TaskSource } | null> {
  const rows = await scoped(tx)<{ clientId: string; dealId: string | null; source: TaskSource }>`
    UPDATE tasks t SET status = 'done', done_at = ${at}
     WHERE t.id = ${id} AND t.status = 'open' AND t.source = ANY(${[...sources]}::text[])
       AND ${scopeSql(viewer, 'task', 'task.write')}
    RETURNING t.client_id, t.deal_id, t.source`;
  return rows[0] ?? null;
}

/** «Отменить»: только ручная открытая задача, по `task.write`; `authorOnly` — только своя (охват уже `space`). */
export async function cancelOpenTask(tx: Sql, viewer: Viewer, id: string, authorOnly: boolean, at: number): Promise<{ clientId: string; dealId: string | null } | null> {
  const rows = await scoped(tx)<{ clientId: string; dealId: string | null }>`
    UPDATE tasks t SET status = 'cancelled', done_at = ${at}
     WHERE t.id = ${id} AND t.status = 'open' AND t.source = 'manual'
       AND (NOT ${authorOnly} OR t.created_by = ${viewer.userId})
       AND ${scopeSql(viewer, 'task', 'task.write')}
    RETURNING t.client_id, t.deal_id`;
  return rows[0] ?? null;
}

export async function selectComments(sql: Sql, viewer: Viewer, taskId: string): Promise<Array<{ id: string; body: string; authorName: string | null; createdAt: number }>> {
  return scoped(sql)<{ id: string; body: string; authorName: string | null; createdAt: number }>`
    SELECT tc.id, tc.body, u.name AS author_name, tc.created_at
      FROM task_comments tc JOIN tasks t ON t.id = tc.task_id LEFT JOIN users u ON u.id = tc.author_id
     WHERE tc.task_id = ${taskId} AND ${scopeSql(viewer, 'task', 'task.read')}
     ORDER BY tc.created_at, tc.id`;
}

/** Комментарий; повтор того же id ничего не пишет (`false`). */
export async function insertComment(tx: Sql, c: { id: string; taskId: string; authorId: string; body: string; at: number }): Promise<boolean> {
  const rows = await tx<{ id: string }>`
    INSERT INTO task_comments (id, task_id, author_id, body, created_at) VALUES (${c.id}, ${c.taskId}, ${c.authorId}, ${c.body}, ${c.at})
    ON CONFLICT (id) DO NOTHING RETURNING id`;
  return rows.length === 1;
}

/** Комментарий по id (для повтора `opId`): задача и автор, чтобы чужой id не вернул чужой текст. */
export async function selectCommentById(sql: Sql, id: string): Promise<{ taskId: string; authorId: string | null; body: string; createdAt: number; authorName: string | null } | null> {
  const rows = await sql<{ taskId: string; authorId: string | null; body: string; createdAt: number; authorName: string | null }>`
    SELECT tc.task_id, tc.author_id, tc.body, tc.created_at, u.name AS author_name
      FROM task_comments tc LEFT JOIN users u ON u.id = tc.author_id WHERE tc.id = ${id}`;
  return rows[0] ?? null;
}

/** Событие ленты клиента о задаче: только коды и id (текста задачи и комментария в ленте нет). */
export async function insertTaskEvent(
  tx: Sql,
  viewer: Viewer,
  e: { clientId: string; dealId: string | null; kind: 'task.created' | 'task.done' | 'task.cancelled' | 'task.comment'; taskId: string; data: Record<string, unknown> },
): Promise<void> {
  await tx`
    INSERT INTO client_events (id, client_id, space_id, deal_id, kind, actor_id, at, ref_type, ref_id, data)
    VALUES (${newId()}, ${e.clientId}, ${viewer.spaceId}, ${e.dealId}, ${e.kind}, ${viewer.userId}, ${viewer.now}, 'task', ${e.taskId}, ${jsonParam(e.data)})`;
}

/** Уведомление сотруднику о задаче: без названия клиента и текста (params пустые), повтор по ключу не пишет. */
export async function insertTaskNotification(tx: Sql, n: { userId: string; kind: 'task_assigned' | 'task_comment'; taskId: string; dedupeKey: string; at: number }): Promise<void> {
  await tx`
    INSERT INTO notifications (id, user_id, kind, entity_type, entity_id, params, dedupe_key, not_before, created_at)
    VALUES (${newId()}, ${n.userId}, ${n.kind}, 'task', ${n.taskId}, ${jsonParam({})}, ${n.dedupeKey}, ${n.at}, ${n.at})
    ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`;
}

export type StaffRow = { userId: string; name: string };

/**
 * Кандидаты в исполнители по клиенту (D-253), кроме «меня»: владелец и временный владелец карточки; активные
 * сотрудники пространства с ролями `staffRoles`; консультанты (роль из `consultants`) с живой индивидуальной
 * записью клиента в своём окне дат. Только активные учётки с активным членством.
 */
export async function selectAssigneeCandidates(
  sql: Sql,
  a: {
    spaceId: string;
    clientId: string;
    cardUserIds: readonly string[];
    staffRoles: readonly string[];
    consultants: ReadonlyArray<{ role: string; from: string; to: string }>;
  },
): Promise<StaffRow[]> {
  const roles = a.consultants.map((c) => c.role);
  const froms = a.consultants.map((c) => c.from);
  const tos = a.consultants.map((c) => c.to);
  return sql<StaffRow>`
    SELECT u.id AS user_id, u.name
      FROM users u JOIN memberships m ON m.user_id = u.id AND m.space_id = ${a.spaceId} AND m.status = 'active'
     WHERE u.status = 'active'
       AND (u.id = ANY(${[...a.cardUserIds]}::text[])
            OR m.role_key = ANY(${[...a.staffRoles]}::text[])
            OR EXISTS (SELECT 1 FROM unnest(${roles}::text[], ${froms}::text[], ${tos}::text[]) AS w(role, d_from, d_to)
                         JOIN bookings b ON b.client_id = ${a.clientId} AND b.space_id = ${a.spaceId} AND b.kind = 'individual'
                                        AND b.status IN ('registered','confirmed','attended','no_show')
                                        AND b.booking_date BETWEEN w.d_from AND w.d_to
                         JOIN resources r ON r.id = b.resource_id AND r.user_id = u.id
                        WHERE w.role = m.role_key))
     ORDER BY u.name, u.id`;
}

/** Сотрудники пространства для фильтра «Команда»: команда зрителя (охват team) или все (space/all). */
export async function selectStaff(sql: Sql, a: { spaceId: string; teamId: string | null }): Promise<StaffRow[]> {
  return sql<StaffRow>`
    SELECT u.id AS user_id, u.name
      FROM users u JOIN memberships m ON m.user_id = u.id AND m.space_id = ${a.spaceId} AND m.status = 'active'
     WHERE u.status = 'active' AND (${a.teamId}::text IS NULL OR m.team_id = ${a.teamId})
     ORDER BY u.name, u.id`;
}

export async function selectUserName(sql: Sql, userId: string): Promise<string | null> {
  const rows = await sql<{ name: string }>`SELECT name FROM users WHERE id = ${userId}`;
  return rows[0]?.name ?? null;
}
