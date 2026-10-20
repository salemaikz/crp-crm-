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

/** Передать открытые задачи клиента в пространстве другому исполнителю (передача, слияние, D-066). */
export type ReassignOpenTasks = (tx: Sql, actor: TaskActor, input: { spaceId: string; clientId: string; toUserId: string; at: number }) => Promise<number>;

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
