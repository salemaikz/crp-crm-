// Автозадачи (D-050): создать и закрыть по `source_key` в транзакции события. Реализация — tasks/auto.ts
// (поток calling, C5); экран задач, комментарии и ручные задачи — B7 (поток booking) в остальных файлах
// каталога. Дизайн — docs/calls-design.md §6, решение D-176. Здесь только типы и сигнатуры.
//
// Правила:
// - автозадача создаётся `INSERT … ON CONFLICT (source_key) WHERE source_key IS NOT NULL AND status = 'open'
//   DO NOTHING`: открытая задача с тем же ключом не задваивается, закрытая ключ не держит;
// - заголовок автозадачи пустой (tasks.title = ''): текст строит интерфейс по `source` и `kind` из локали,
//   поэтому в задаче нет ни ПДн, ни строк в коде;
// - вызывающий уже заблокировал карточку и проверил охват: функции auto.ts охват не накладывают.
import type { calling } from '@crm/core';
import type { SystemActor, Viewer } from '@/server/access';
import type { Sql } from '@/server/platform/db';

export type TaskActor = Viewer | SystemActor;
export type TaskSource = calling.TaskSource | 'staff_disabled' | 'stoplist_confirm';
export type TaskKind = calling.TaskKind;

export interface AutoTaskInput {
  spaceId: string;
  clientId: string;
  dealId?: string | null;
  source: TaskSource;
  kind: TaskKind;
  /** Уже разрешённый получатель (`{ role: 'lead' }` разрешает cards/effects.ts по D-176). */
  assigneeUserId: string;
  dueAt: number | null;
  sourceKey: string;
  at: number;
}

export interface AutoTaskRef {
  id: string;
  /** false — открытая задача с этим ключом уже была. */
  created: boolean;
}

/** Создать автозадачу или вернуть открытую с тем же ключом. `created_by` = автор события (NULL для системы). */
export type EnsureAutoTask = (tx: Sql, actor: TaskActor, input: AutoTaskInput) => Promise<AutoTaskRef>;

/** Закрыть открытые задачи клиента в пространстве: по источникам или все. Возвращает число закрытых. */
export type CloseAutoTasks = (
  tx: Sql,
  actor: TaskActor,
  input: { spaceId: string; clientId: string; sources: readonly TaskSource[] | 'all'; at: number },
) => Promise<number>;

/** Закрыть открытую задачу по ключу (если есть). */
export type CloseAutoTaskByKey = (tx: Sql, actor: TaskActor, input: { sourceKey: string; at: number }) => Promise<number>;

/**
 * Передать открытые задачи клиента в пространстве другому исполнителю (передача, слияние, D-066, D-254):
 * только те, исполнитель которых — один из `fromUserIds` (прежний и временный владелец). Задачи РОП без
 * исполнителя и чужие остаются на месте.
 */
export type ReassignOpenTasks = (
  tx: Sql,
  actor: TaskActor,
  input: { spaceId: string; clientId: string; fromUserIds: readonly string[]; toUserId: string; at: number },
) => Promise<number>;

/** Строка «мои открытые» (D-050): для «Мои перезвоны» и колокола; без title и комментариев. */
export interface MyOpenTask {
  id: string;
  clientId: string;
  dealId: string | null;
  source: TaskSource;
  kind: TaskKind;
  dueAt: number | null;
  createdAt: number;
}

/** Мои открытые задачи (scopeSql('task', 'task.read')), по сроку: просроченные сверху, без срока — в конце. */
export type ListMyOpenTasks = (viewer: Viewer, input: { limit: number; sources?: readonly TaskSource[] }) => Promise<MyOpenTask[]>;

// ---------------------------------------------------------------------------
// B7: экран задач, ручные задачи, комментарии (docs/tasks-team-design.md §4, D-252, D-253)
// ---------------------------------------------------------------------------

/** Вкладка списка: мои; команда и без исполнителя — у кого `task.read` шире `own`; выполненные за 7 дней. */
export type TaskView = 'mine' | 'team' | 'unassigned' | 'done';
export const TASK_VIEWS: readonly TaskView[] = ['mine', 'team', 'unassigned', 'done'];

/** Группа по сроку: просрочено (срок прошёл, задача открыта), сегодня, завтра, позже, без срока (PROCESS 6.3). */
export type TaskBucket = 'overdue' | 'today' | 'tomorrow' | 'later' | 'none';
export const TASK_BUCKETS: readonly TaskBucket[] = ['overdue', 'today', 'tomorrow', 'later', 'none'];

export type TaskStatus = 'open' | 'done' | 'cancelled';

/**
 * Строка списка. `title` у автозадач пустой — подпись строит интерфейс по `source`. `clientName` и `cardId` —
 * только если клиент и карточка видны зрителю (иначе null). `closable` — «Готово» доступно по источнику (§4.2).
 */
export interface TaskRow {
  id: string;
  clientId: string;
  clientName: string | null;
  cardId: string | null;
  dealId: string | null;
  kind: TaskKind;
  source: TaskSource;
  title: string;
  dueAt: number | null;
  bucket: TaskBucket;
  assigneeUserId: string | null;
  assigneeName: string | null;
  createdBy: string | null;
  comments: number;
  closable: boolean;
  /** Переход в строке по источнику (§4.2): у закрываемых — рядом с «Готово», у остальных — вместо него. */
  action: 'done' | 'openCard' | 'book' | 'openEvent' | 'openHandoff' | 'bookings';
  status: TaskStatus;
  doneAt: number | null;
}

export interface TaskList {
  items: TaskRow[];
  counts: Record<TaskBucket, number>;
  /** Строк больше предела (300): показаны первые. */
  truncated: boolean;
}

export interface TaskCommentDto {
  id: string;
  body: string;
  authorName: string | null;
  createdAt: number;
}

/** Задача с комментариями и тем, что можно сделать зрителю (считает сервер). */
export interface TaskDetail {
  task: TaskRow;
  comments: TaskCommentDto[];
  can: { done: boolean; cancel: boolean; edit: boolean; assign: boolean; take: boolean; comment: boolean };
}

export interface TaskAssignee {
  userId: string;
  name: string;
  me: boolean;
}

export type TaskWarning = 'due_outside_work_hours';

export type ListTasksQuery = { view: TaskView; userId?: string | null; clientId?: string | null };
export type ListTasks = (viewer: Viewer, q: ListTasksQuery) => Promise<TaskList>;

export type CreateTaskInput = {
  opId: string;
  clientId: string;
  dealId?: string | null;
  kind: Exclude<TaskKind, 'handoff'>;
  title: string;
  dueAt: number | null;
  assigneeUserId: string;
};
export type CreateTask = (viewer: Viewer, b: CreateTaskInput) => Promise<{ task: TaskRow; warnings: TaskWarning[] }>;

/** Правка: срок и заголовок — только у ручных; исполнитель — с `task.assign_others` или «взять себе» без исполнителя. */
export type UpdateTaskInput = { title?: string; dueAt?: number | null; assigneeUserId?: string };
export type UpdateTask = (viewer: Viewer, id: string, b: UpdateTaskInput) => Promise<{ task: TaskRow; warnings: TaskWarning[] }>;

export type CompleteTask = (viewer: Viewer, id: string, b: { comment?: string }) => Promise<{ task: TaskRow; askNext: boolean }>;
export type CancelTask = (viewer: Viewer, id: string) => Promise<{ task: TaskRow }>;
export type AddComment = (viewer: Viewer, taskId: string, b: { opId: string; body: string }) => Promise<TaskCommentDto>;
