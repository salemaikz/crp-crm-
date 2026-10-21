// Перенос карточки на доске «Обзвон» (PROCESS 4.4, D-266) — это итог, а не отдельная механика: колонка-цель
// задаёт, какие виды итога можно поставить. Чистая логика; решение о переходе принимает ядро на сервере.

/** Колонки доски и плитка «Закрыто». */
export type DropTarget = 'new' | 'retry' | 'callback' | 'agreed' | 'closed';

export type OutcomeKindKey = 'no_answer' | 'bad_number' | 'callback' | 'agreed' | 'not_interested' | 'not_target' | 'do_not_call';

const KINDS: Record<DropTarget, readonly OutcomeKindKey[]> = {
  new: [],
  retry: ['no_answer'],
  callback: ['callback'],
  agreed: ['agreed'],
  closed: ['not_interested', 'not_target', 'do_not_call'],
};

/** Виды итога для переноса из колонки `from` в `to`; пусто — перенос не принимается (в `new` и в ту же колонку нельзя). */
export function dropKinds(from: string, to: DropTarget): readonly OutcomeKindKey[] {
  return from === to ? [] : KINDS[to];
}

export const isDropTarget = (v: string): v is DropTarget => v in KINDS;
