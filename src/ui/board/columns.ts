// Роль колонки доски по её состояниям: то же правило, что `roleOf` в ядре (packages/core/src/calling/board.ts).
// Дублирование намеренное: ядро не бандлится в браузер (next.config.ts), а решение о переносе принимает сервер.
import type { ColumnRole } from './types';

const CLOSED = ['not_interested', 'not_target', 'do_not_call', 'written_off'];

export function roleOfStates(states: readonly string[]): ColumnRole {
  if (states.includes('agreed')) return 'agreed';
  if (states.includes('client')) return 'client';
  if (states.some((s) => CLOSED.includes(s))) return 'trash';
  if (states.includes('retry') || states.includes('callback')) return 'callback';
  if (states.includes('new')) return 'new';
  return 'other';
}

/** Колонки, где работают сортировка и перенос «из рабочих» (§9.4): «Новые» и «Перезвон». */
export const isWorkingRole = (r: ColumnRole): boolean => r === 'new' || r === 'callback';
