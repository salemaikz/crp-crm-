// Повторный импорт поверх существующих (PROCESS 12.14, D-048). Чистое решение по паре ключей.

export interface PriorImportRow {
  rowKey: string;
  /** Ключ состояния, с которым строка была применена в прошлый раз. */
  stateKey: string;
  /** Карточку после импорта вели в CRM (есть звонки/правки не от импорта). */
  touchedInCrm: boolean;
  /**
   * Прошлое применение отложило рабочий итог строки (D-115: карточка была без владельца), а теперь его можно
   * применить: карточка не задержана, и владелец у неё есть или находится по слотам/колонке (D-222).
   * Считает вызывающий: ядро не знает ни карточку, ни карту владельцев. Нет поля — false.
   */
  deferredResumable?: boolean;
}

export type ReimportDecision =
  /** Строки нет в прошлых импортах: новая. */
  | 'new'
  /** Та же строка с тем же состоянием: пропуск, 0 изменений. */
  | 'skip'
  /**
   * Состояние изменилось, карточку в CRM не трогали: один импортный звонок, состояние обновлено. Так же —
   * то же состояние, у которого итог был отложен и теперь применим (D-222).
   */
  | 'update_state'
  /** Состояние изменилось, но карточку уже вели в CRM: «оставлено как в CRM», строка на разбор РОП. */
  | 'kept_in_crm';

export function decideReimport(row: { stateKey: string }, prior: PriorImportRow | undefined): ReimportDecision {
  if (!prior) return 'new';
  if (prior.stateKey === row.stateKey) {
    // Отложенный итог — не повтор: иначе он не применится никогда. Тронутую в CRM карточку ведёт CRM.
    return prior.deferredResumable === true && !prior.touchedInCrm ? 'update_state' : 'skip';
  }
  return prior.touchedInCrm ? 'kept_in_crm' : 'update_state';
}
