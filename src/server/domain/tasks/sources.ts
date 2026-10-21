// Источники задач: что можно сделать вручную (D-253, docs/tasks-team-design.md §4.2). Проекции срока карточки
// (D-050) и инварианты (D-049) вручную не закрываются — вместо «Готово» переход к действию, которое их закроет.
import type { TaskRow, TaskSource } from './types';

/** Переход из строки задачи: куда ведёт главная кнопка, если «Готово» нельзя (или рядом с «Готово»). */
export type TaskAction = TaskRow['action'];

export type SourceRule = {
  /** «Готово» вручную (иначе 409 `auto_task`). */
  closable: boolean;
  /** Переход в строке: у закрываемых — вторичный, у остальных — главная кнопка. */
  action: TaskAction;
};

export const SOURCE_RULES: Readonly<Record<TaskSource, SourceRule>> = {
  manual: { closable: true, action: 'done' },
  // проекции срока карточки (D-050): закрывает итог звонка
  callback: { closable: false, action: 'openCard' },
  no_show: { closable: false, action: 'openCard' },
  rebook: { closable: false, action: 'openCard' },
  clarify_import: { closable: false, action: 'openCard' },
  // инвариант D-049: закрывает запись или итог
  agreement: { closable: false, action: 'book' },
  next_step: { closable: false, action: 'book' },
  attendance_mark: { closable: false, action: 'openEvent' },
  handoff: { closable: false, action: 'openHandoff' },
  grey_unassigned: { closable: false, action: 'bookings' },
  // разбор: закрывается вручную
  inbound_message: { closable: true, action: 'openCard' },
  missed_call: { closable: true, action: 'openCard' },
  dnc_inbound: { closable: true, action: 'openCard' },
  review: { closable: true, action: 'openCard' },
  proposal: { closable: true, action: 'openCard' },
  absent_review: { closable: true, action: 'openCard' },
  staff_disabled: { closable: true, action: 'openCard' },
  stoplist_confirm: { closable: true, action: 'openCard' },
};

export const TASK_SOURCES = Object.keys(SOURCE_RULES) as TaskSource[];

/** Источники, которые закрываются «Готово» (для условия UPDATE). */
export const CLOSABLE_SOURCES: readonly TaskSource[] = TASK_SOURCES.filter((s) => SOURCE_RULES[s].closable);

export function isClosable(source: string): boolean {
  return Object.hasOwn(SOURCE_RULES, source) && SOURCE_RULES[source as TaskSource].closable;
}
