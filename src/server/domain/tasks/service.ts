// Экран задач B7 (docs/tasks-team-design.md §4, D-252, D-253): список по вкладкам и корзинам срока, ручные задачи,
// правка, «Готово», отмена, комментарии, исполнители. Охват — в repo.ts (scopeSql); чужая задача и несуществующая
// отвечают одинаково (404). Автозадачи-проекции вручную не закрываются (409 `auto_task`).
import { access as coreAccess } from '@crm/core';
import { BadRequestError, ForbiddenError, NotFoundError, can, scopeOf, type Viewer } from '@/server/access';
import { DetailedConflictError } from '@/server/domain/clients/errors';
import { isRetryableTxError, MAX_TX_ATTEMPTS } from '@/server/domain/booking/tx';
import { dealOfClientVisible } from '@/server/domain/timeline/repo';
import { getDb, newId, type Sql } from '@/server/platform/db';
import { bucketOf, dayBounds, dueOutsideWork, type DayBounds } from './buckets';
import {
  cancelOpenTask,
  completeOpenTask,
  countOpenBuckets,
  insertComment,
  insertManualTask,
  insertTaskEvent,
  insertTaskNotification,
  selectAssigneeCandidates,
  selectCommentById,
  selectComments,
  selectDoneTasks,
  selectOpenTasks,
  selectStaff,
  selectTask,
  selectTaskOwnerOfId,
  selectUserName,
  selectVisibleCard,
  taskWritable,
  updateOpenTask,
  type OpenMode,
  type StaffRow,
  type TaskDbRow,
} from './repo';
import { loadTasksConfig } from './settings';
import { CLOSABLE_SOURCES, SOURCE_RULES, isClosable } from './sources';
import type {
  AddComment,
  CancelTask,
  CompleteTask,
  CreateTask,
  ListTasks,
  TaskAssignee,
  TaskCommentDto,
  TaskDetail,
  TaskList,
  TaskRow,
  TaskWarning,
  UpdateTask,
} from './types';

export const LIST_LIMIT = 300;
export const DONE_LIMIT = 100;
export const DONE_DAYS = 7;
export const TITLE_MAX = 200;
export const COMMENT_MAX = 2000;
const DAY_MS = 86_400_000;

async function inTasksTx<T>(fn: (tx: Sql) => Promise<T>): Promise<T> {
  const db = await getDb();
  const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  for (let attempt = 1; ; attempt++) {
    try {
      return await db.tx(async (tx) => {
        await tx`SET LOCAL lock_timeout = '10s'`;
        return fn(tx);
      });
    } catch (e) {
      if (attempt >= MAX_TX_ATTEMPTS || !isRetryableTxError(e)) throw e;
      await pause(5 + Math.floor(Math.random() * 20) * attempt);
    }
  }
}

function spaceOf(viewer: Viewer): string {
  if (viewer.spaceId === null) throw new NotFoundError();
  return viewer.spaceId;
}

/** Видит ли зритель задачи шире своих (вкладки «Команда» и «Без исполнителя»). */
export function seesTeam(viewer: Viewer): boolean {
  const s = scopeOf(viewer, 'task.read');
  return s === 'team' || s === 'space' || s === 'all';
}

function boundsOf(viewer: Viewer): DayBounds {
  return dayBounds(viewer.now, viewer.today, viewer.timeZone);
}

function toRow(r: TaskDbRow, b: DayBounds): TaskRow {
  return {
    id: r.id,
    clientId: r.clientId,
    clientName: r.clientName,
    cardId: r.cardId,
    dealId: r.dealId,
    kind: r.kind,
    source: r.source,
    title: r.title,
    dueAt: r.dueAt,
    bucket: r.status === 'open' ? bucketOf(r.dueAt, b) : 'none',
    assigneeUserId: r.assigneeUserId,
    assigneeName: r.assigneeName,
    createdBy: r.createdBy,
    comments: r.comments,
    closable: isClosable(r.source),
    action: SOURCE_RULES[r.source]?.action ?? 'openCard',
    status: r.status,
    doneAt: r.doneAt,
  };
}

const ZERO = { overdue: 0, today: 0, tomorrow: 0, later: 0, none: 0 };

/**
 * Список: `mine` — мои и по моим временным карточкам; `team` (фильтр `userId`) и `unassigned` — только у кого
 * `task.read` шире `own` (иначе 403); `done` — закрытые мной за 7 дней. `clientId` — все видимые открытые задачи
 * клиента (панель карточки), вкладка при этом не учитывается.
 */
export const listTasks: ListTasks = async (viewer, q) => {
  spaceOf(viewer);
  const db = await getDb();
  const b = boundsOf(viewer);
  if (q.clientId) {
    const rows = await selectOpenTasks(db.sql, viewer, { mode: 'client', userId: null, clientId: q.clientId, limit: LIST_LIMIT + 1 });
    const counts = await countOpenBuckets(db.sql, viewer, { mode: 'client', userId: null, clientId: q.clientId, ...b });
    return pack(rows, counts, b, LIST_LIMIT);
  }
  if (q.view === 'done') {
    const rows = await selectDoneTasks(db.sql, viewer, { since: viewer.now - DONE_DAYS * DAY_MS, limit: DONE_LIMIT + 1 });
    return pack(rows, ZERO, b, DONE_LIMIT);
  }
  if ((q.view === 'team' || q.view === 'unassigned') && !seesTeam(viewer)) throw new ForbiddenError();
  const mode: OpenMode = q.view;
  const userId = q.view === 'team' ? (q.userId ?? null) : null;
  const rows = await selectOpenTasks(db.sql, viewer, { mode, userId, clientId: null, limit: LIST_LIMIT + 1 });
  const counts = await countOpenBuckets(db.sql, viewer, { mode, userId, clientId: null, ...b });
  return pack(rows, counts, b, LIST_LIMIT);
};

function pack(rows: TaskDbRow[], counts: TaskList['counts'], b: DayBounds, limit: number): TaskList {
  return { items: rows.slice(0, limit).map((r) => toRow(r, b)), counts: { ...counts }, truncated: rows.length > limit };
}

/** Открытые задачи клиента для карточки (тот же список с `clientId`). */
export const listClientTasks = (viewer: Viewer, clientId: string): Promise<TaskList> => listTasks(viewer, { view: 'mine', clientId });

function canCancel(viewer: Viewer, row: TaskDbRow): boolean {
  if (row.source !== 'manual' || row.status !== 'open') return false;
  return row.createdBy === viewer.userId || cancelsAny(viewer);
}

/** Отменить чужую ручную задачу может охват `space`/`all` по записи (D-253). */
function cancelsAny(viewer: Viewer): boolean {
  const s = scopeOf(viewer, 'task.write');
  return !viewer.readOnly && (s === 'space' || s === 'all');
}

/** Задача с комментариями и тем, что можно сделать. Не видна — 404. */
export async function getTask(viewer: Viewer, id: string): Promise<TaskDetail> {
  spaceOf(viewer);
  const db = await getDb();
  const row = await selectTask(db.sql, viewer, id);
  if (!row) throw new NotFoundError();
  const writable = !viewer.readOnly && (await taskWritable(db.sql, viewer, id));
  const comments = await selectComments(db.sql, viewer, id);
  const open = row.status === 'open';
  const assignOthers = !viewer.readOnly && can(viewer, 'task.assign_others');
  return {
    task: toRow(row, boundsOf(viewer)),
    comments: comments.map((c) => ({ id: c.id, body: c.body, authorName: c.authorName, createdAt: c.createdAt })),
    can: {
      done: writable && open && isClosable(row.source),
      cancel: writable && canCancel(viewer, row),
      edit: writable && open && row.source === 'manual',
      assign: writable && open && assignOthers,
      take: writable && open && row.assigneeUserId === null,
      comment: writable,
    },
  };
}

function cleanTitle(raw: string): string {
  const title = raw.trim();
  if (title.length < 1 || title.length > TITLE_MAX) throw new BadRequestError('title');
  return title;
}

function cleanDue(dueAt: number | null): number | null {
  if (dueAt === null) return null;
  if (!Number.isSafeInteger(dueAt) || dueAt < 0) throw new BadRequestError('due');
  return dueAt;
}

/**
 * Кому можно назначить задачу по клиенту (D-253): я; с `task.assign_others` — ещё владелец и временный владелец
 * карточки, сотрудники с `task.read` охвата space/all (не «только чтение») и консультанты с живой записью клиента
 * в своём окне. Так исполнитель всегда видит свою задачу. Карточка не видна — 404.
 */
export async function listAssignees(viewer: Viewer, clientId: string): Promise<TaskAssignee[]> {
  const db = await getDb();
  return assigneesIn(db.sql, viewer, clientId);
}

async function assigneesIn(sql: Sql, viewer: Viewer, clientId: string): Promise<TaskAssignee[]> {
  const spaceId = spaceOf(viewer);
  const card = await selectVisibleCard(sql, viewer, clientId);
  if (!card) throw new NotFoundError();
  const meName = (await selectUserName(sql, viewer.userId)) ?? '';
  const out: TaskAssignee[] = [{ userId: viewer.userId, name: meName, me: true }];
  if (viewer.readOnly || !can(viewer, 'task.assign_others')) return out;
  const cfg = await loadTasksConfig(spaceId);
  const cardUserIds = [card.ownerUserId, card.actingUserId].filter((u): u is string => u !== null);
  const consultants = cfg.consultantRoles.map((c) => {
    const w = coreAccess.consultantWindowDates(viewer.today, c.window);
    return { role: c.key, from: w.from, to: w.to };
  });
  const rows: StaffRow[] = await selectAssigneeCandidates(sql, { spaceId, clientId, cardUserIds, staffRoles: cfg.staffRoles, consultants });
  for (const r of rows) if (r.userId !== viewer.userId) out.push({ userId: r.userId, name: r.name, me: false });
  return out;
}

/** Сотрудники для фильтра «Команда» (только у кого вкладка есть). */
export async function listTaskStaff(viewer: Viewer): Promise<StaffRow[]> {
  const spaceId = spaceOf(viewer);
  if (!seesTeam(viewer)) throw new ForbiddenError();
  const db = await getDb();
  const teamOnly = scopeOf(viewer, 'task.read') === 'team' ? viewer.teamId : null;
  return selectStaff(db.sql, { spaceId, teamId: teamOnly });
}

async function warningsFor(spaceId: string, dueAt: number | null): Promise<TaskWarning[]> {
  if (dueAt === null) return [];
  const cfg = await loadTasksConfig(spaceId);
  return dueOutsideWork(dueAt, cfg.calendar) ? ['due_outside_work_hours'] : [];
}

/** Перечитать задачу после записи в той же транзакции (видна по охвату). */
async function reread(tx: Sql, viewer: Viewer, id: string): Promise<TaskRow> {
  const row = await selectTask(tx, viewer, id);
  if (!row) throw new NotFoundError();
  return toRow(row, boundsOf(viewer));
}

/**
 * Ручная задача (§4.4). `opId` — id задачи: повтор того же автора и клиента возвращает прежнюю, иначе 400 `op_id`.
 * Клиент не виден — 404; сделка не того клиента — 400 `deal`; другому без `task.assign_others` — 403; исполнитель
 * не из `listAssignees` — 400 `assignee`. Срок вне рабочего времени — предупреждение, не запрет.
 */
export const createTask: CreateTask = async (viewer, b) => {
  const spaceId = spaceOf(viewer);
  // Строки ещё нет, охват записи проверить не на чем: право и «только чтение» — здесь (обёртка тоже отвечает 423)
  if (viewer.readOnly || !can(viewer, 'task.write')) throw new ForbiddenError();
  const title = cleanTitle(b.title);
  const dueAt = cleanDue(b.dueAt);
  const dealId = b.dealId ?? null;
  const task = await inTasksTx(async (tx) => {
    const prior = await selectTaskOwnerOfId(tx, b.opId);
    if (prior) {
      if (prior.createdBy !== viewer.userId || prior.clientId !== b.clientId) throw new BadRequestError('op_id');
      return reread(tx, viewer, b.opId);
    }
    const card = await selectVisibleCard(tx, viewer, b.clientId);
    if (!card) throw new NotFoundError();
    if (dealId !== null && !(await dealOfClientVisible(tx, viewer, b.clientId, dealId))) throw new BadRequestError('deal');
    if (b.assigneeUserId !== viewer.userId) {
      if (!can(viewer, 'task.assign_others')) throw new ForbiddenError();
      const allowed = await assigneesIn(tx, viewer, b.clientId);
      if (!allowed.some((x) => x.userId === b.assigneeUserId)) throw new BadRequestError('assignee');
    }
    const inserted = await insertManualTask(tx, {
      id: b.opId,
      spaceId,
      clientId: b.clientId,
      dealId,
      kind: b.kind,
      title,
      dueAt,
      assigneeUserId: b.assigneeUserId,
      createdBy: viewer.userId,
      at: viewer.now,
    });
    // Гонка двух одинаковых запросов: второй увидит строку первого и ответит ею (или op_id)
    if (!inserted) {
      const again = await selectTaskOwnerOfId(tx, b.opId);
      if (!again || again.createdBy !== viewer.userId || again.clientId !== b.clientId) throw new BadRequestError('op_id');
      return reread(tx, viewer, b.opId);
    }
    await insertTaskEvent(tx, viewer, {
      clientId: b.clientId,
      dealId,
      kind: 'task.created',
      taskId: b.opId,
      data: { taskId: b.opId, kind: b.kind, assigneeUserId: b.assigneeUserId, dueAt },
    });
    if (b.assigneeUserId !== viewer.userId) {
      await insertTaskNotification(tx, { userId: b.assigneeUserId, kind: 'task_assigned', taskId: b.opId, dedupeKey: `task:${b.opId}:assigned`, at: viewer.now });
    }
    return reread(tx, viewer, b.opId);
  });
  return { task, warnings: await warningsFor(spaceId, dueAt) };
};

/** 0 строк у мутации: не видна — 404; закрыта — 409 `closed`; не тот источник — 409 `auto_task`; иначе 403. */
async function explainMiss(tx: Sql, viewer: Viewer, id: string, needManual: boolean, needClosable: boolean): Promise<never> {
  const row = await selectTask(tx, viewer, id);
  if (!row) throw new NotFoundError();
  if (row.status !== 'open') throw new DetailedConflictError('closed');
  if ((needManual && row.source !== 'manual') || (needClosable && !isClosable(row.source))) throw new DetailedConflictError('auto_task');
  throw new ForbiddenError();
}

/**
 * Правка: срок и заголовок — только у ручных (иначе 409 `auto_task`); исполнитель — с `task.assign_others` (из
 * `listAssignees`) или «взять себе» задачу без исполнителя.
 */
export const updateTask: UpdateTask = async (viewer, id, b) => {
  const spaceId = spaceOf(viewer);
  const setTitle = b.title !== undefined;
  const setDue = b.dueAt !== undefined;
  const setAssignee = b.assigneeUserId !== undefined;
  if (!setTitle && !setDue && !setAssignee) throw new BadRequestError('empty');
  const title = setTitle ? cleanTitle(b.title as string) : null;
  const dueAt = setDue ? cleanDue(b.dueAt as number | null) : null;
  const assignee = setAssignee ? (b.assigneeUserId as string) : null;
  const take = setAssignee && assignee === viewer.userId && !can(viewer, 'task.assign_others');
  const task = await inTasksTx(async (tx) => {
    const before = await selectTask(tx, viewer, id);
    if (!before) throw new NotFoundError();
    if (setAssignee && assignee !== viewer.userId && !can(viewer, 'task.assign_others')) throw new ForbiddenError();
    if (setAssignee && assignee !== viewer.userId) {
      const allowed = await assigneesIn(tx, viewer, before.clientId);
      if (!allowed.some((x) => x.userId === assignee)) throw new BadRequestError('assignee');
    }
    const manualOnly = setTitle || setDue;
    const done = await updateOpenTask(tx, viewer, id, {
      setTitle,
      title,
      setDue,
      dueAt,
      setAssignee,
      assigneeUserId: assignee,
      expectUnassigned: take,
      manualOnly,
    });
    if (!done) {
      if (take) {
        const now = await selectTask(tx, viewer, id);
        if (now && now.status === 'open' && now.assigneeUserId !== null && (!manualOnly || now.source === 'manual')) throw new DetailedConflictError('taken');
      }
      return explainMiss(tx, viewer, id, manualOnly, false);
    }
    if (setAssignee && assignee !== null && assignee !== viewer.userId && assignee !== before.assigneeUserId) {
      await insertTaskNotification(tx, { userId: assignee, kind: 'task_assigned', taskId: id, dedupeKey: `task:${id}:assigned:${assignee}:${viewer.now}`, at: viewer.now });
    }
    return reread(tx, viewer, id);
  });
  return { task, warnings: setDue ? await warningsFor(spaceId, dueAt) : [] };
};

/**
 * «Готово»: закрываемый источник по `task.write`; комментарий — в той же транзакции. Повтор по уже выполненной —
 * прежний ответ; отменённая — 409 `closed`; проекция или инвариант — 409 `auto_task`. `askNext` — по
 * `tasks.askNextStep[роль]`.
 */
export const completeTask: CompleteTask = async (viewer, id, b) => {
  const spaceId = spaceOf(viewer);
  const comment = b.comment === undefined ? null : b.comment.trim();
  if (comment !== null && comment.length > COMMENT_MAX) throw new BadRequestError('body');
  const task = await inTasksTx(async (tx) => {
    const closed = await completeOpenTask(tx, viewer, id, CLOSABLE_SOURCES, viewer.now);
    if (!closed) {
      const row = await selectTask(tx, viewer, id);
      if (row && row.status === 'done') return toRow(row, boundsOf(viewer));
      return explainMiss(tx, viewer, id, false, true);
    }
    if (comment) {
      const commentId = newId();
      await insertComment(tx, { id: commentId, taskId: id, authorId: viewer.userId, body: comment, at: viewer.now });
      await insertTaskEvent(tx, viewer, { clientId: closed.clientId, dealId: closed.dealId, kind: 'task.comment', taskId: id, data: { taskId: id, commentId } });
    }
    await insertTaskEvent(tx, viewer, { clientId: closed.clientId, dealId: closed.dealId, kind: 'task.done', taskId: id, data: { taskId: id, source: closed.source } });
    return reread(tx, viewer, id);
  });
  const cfg = await loadTasksConfig(spaceId);
  return { task, askNext: viewer.roleKey !== null && cfg.askNextStep[viewer.roleKey] === true };
};

/** «Отменить»: только ручная; автор или охват `space` по записи. Повтор по уже отменённой — прежний ответ. */
export const cancelTask: CancelTask = async (viewer, id) => {
  spaceOf(viewer);
  const task = await inTasksTx(async (tx) => {
    const closed = await cancelOpenTask(tx, viewer, id, !cancelsAny(viewer), viewer.now);
    if (!closed) {
      const row = await selectTask(tx, viewer, id);
      if (row && row.status === 'cancelled') return toRow(row, boundsOf(viewer));
      return explainMiss(tx, viewer, id, true, false);
    }
    await insertTaskEvent(tx, viewer, { clientId: closed.clientId, dealId: closed.dealId, kind: 'task.cancelled', taskId: id, data: { taskId: id, source: 'manual' } });
    return reread(tx, viewer, id);
  });
  return { task };
};

/**
 * Комментарий (1..2000): пишут все, кто может писать в задачу (`task.write`); видна без записи — 403, не видна —
 * 404. `opId` — id комментария: повтор возвращает прежний. Уведомление исполнителю, если пишет не он.
 */
export const addComment: AddComment = async (viewer, taskId, b) => {
  spaceOf(viewer);
  const body = b.body.trim();
  if (body.length < 1 || body.length > COMMENT_MAX) throw new BadRequestError('body');
  return inTasksTx(async (tx): Promise<TaskCommentDto> => {
    if (!(await taskWritable(tx, viewer, taskId))) {
      throw (await selectTask(tx, viewer, taskId)) ? new ForbiddenError() : new NotFoundError();
    }
    const row = await selectTask(tx, viewer, taskId);
    if (!row) throw new NotFoundError();
    const inserted = await insertComment(tx, { id: b.opId, taskId, authorId: viewer.userId, body, at: viewer.now });
    const saved = await selectCommentById(tx, b.opId);
    if (!saved || saved.taskId !== taskId || saved.authorId !== viewer.userId) throw new BadRequestError('op_id');
    if (inserted) {
      await insertTaskEvent(tx, viewer, { clientId: row.clientId, dealId: row.dealId, kind: 'task.comment', taskId, data: { taskId, commentId: b.opId } });
      if (row.assigneeUserId !== null && row.assigneeUserId !== viewer.userId) {
        await insertTaskNotification(tx, { userId: row.assigneeUserId, kind: 'task_comment', taskId, dedupeKey: `task:${taskId}:comment:${b.opId}`, at: viewer.now });
      }
    }
    return { id: b.opId, body: saved.body, authorName: saved.authorName, createdAt: saved.createdAt };
  });
};
